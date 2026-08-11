import type { HostInfo } from '../../../shared/protocol';
import { confirmDialog, promptDialog } from '../ui/dialog';
import { DesktopIcons } from '../ui/icons';
import { closeAllMenus, openMenu } from '../ui/menu';
import { NotificationCenter } from '../ui/notifications';
import { Taskbar } from '../ui/taskbar';
import { WindowManager } from '../ui/window-manager';
import { h } from './dom';
import { Emitter } from './events';
import { AppRegistry } from './registry';
import { RpcClient } from './rpc';
import { HostRegistry, LOCAL_HOST_ID, toWebsocketUrl } from './hosts';
import { hostView } from './host-view';
import {
  AssociationOverrides,
  fileRefFor,
  handlersFor,
  resolveHandler,
} from './associations';
import { SessionStore } from './session-store';
import { LocalSettings } from './settings';
import { Shortcuts } from './shortcuts';
import { downloadFile as triggerDownload, uploadTo } from './transfer';
import type {
  AppManifest,
  DesktopAPI,
  DesktopEvents,
  DialogOptions,
  FileHandlerInfo,
  LaunchOptions,
  MenuItem,
  NotifyOptions,
  OpenFileOptions,
  PromptOptions,
  Rect,
  UploadSummary,
  WindowHandle,
} from './types';

/** Long enough that dragging a window is one save, short enough to survive a crash. */
const SESSION_SAVE_DEBOUNCE_MS = 800;

export const WALLPAPERS = [
  { id: 'nebula', name: 'Nebula' },
  { id: 'slate', name: 'Slate' },
  { id: 'grid', name: 'Grid' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'paper', name: 'Paper' },
];

/** Where desktop drops land unless the user changes it in Settings. */
export const DEFAULT_UPLOADS_DIR = '~/Uploads';

/** Shown in About, and nowhere else. */
export const WEBSITE_URL = 'https://finestra.dev';
export const COPYRIGHT = '© 2026 Carlos Bravo';
export const LICENCE = 'Free for personal and internal business use.';

/**
 * The shell. Owns the DOM layers, the app registry, the connection, and the
 * `DesktopAPI` handed to every app.
 */
export class Desktop implements DesktopAPI {
  readonly rpc: RpcClient;
  readonly hosts: HostRegistry;
  /** The shell's own view is the local server's. */
  readonly hostId = LOCAL_HOST_ID;
  readonly registry = new AppRegistry();
  readonly settings = new LocalSettings();
  readonly events = new Emitter<DesktopEvents>();
  readonly shortcuts = new Shortcuts();
  readonly session = new SessionStore(this.settings);

  private rootEl: HTMLElement;
  private wallpaperEl: HTMLElement;
  private windowLayer: HTMLElement;
  private manager: WindowManager;
  private taskbar: Taskbar;
  private icons: DesktopIcons;
  private notifications: NotificationCenter;

  constructor(mount: HTMLElement, wsUrl: string) {
    // The local host owns the shell's own connection, so there is exactly one
    // RpcClient per server and no second path to the page's own.
    this.hosts = new HostRegistry(wsUrl, this.settings);
    this.rpc = this.hosts.local().rpc;

    this.wallpaperEl = h('div', { class: 'wallpaper' });
    this.windowLayer = h('div', { class: 'window-layer' });
    this.rootEl = h('div', { class: 'desktop' }, this.wallpaperEl);
    mount.appendChild(this.rootEl);

    this.manager = new WindowManager(
      this.windowLayer,
      this.registry,
      () => this.workArea(),
      (hostId) => this.viewFor(hostId),
    );

    this.icons = new DesktopIcons(this.rootEl, {
      registry: this.registry,
      settings: this.settings,
      launch: (appId) => void this.launch(appId),
      backgroundMenu: () => this.backgroundMenu(),
    });

    // Windows sit above the icon surface but below the taskbar.
    this.rootEl.appendChild(this.windowLayer);

    this.taskbar = new Taskbar(this.rootEl, {
      registry: this.registry,
      windows: this.manager,
      launch: (appId) => void this.launch(appId),
      systemMenu: () => this.systemMenu(),
      hosts: () =>
        this.hosts.all().map((entry) => ({
          id: entry.id,
          label: entry.label,
          state: entry.state,
          local: entry.local,
        })),
      targetHost: () => this.targetHost,
      setTargetHost: (id) => {
        this.targetHost = id;
        this.taskbar.refreshHosts();
      },
      addHost: () => void this.promptForHost(),
      removeHost: (id) => void this.confirmRemoveHost(id),
    });

    this.notifications = new NotificationCenter(this.rootEl);

    this.applyWallpaper(this.settings.get('desktop.wallpaper', 'nebula'));
    this.applyTheme(this.settings.get('desktop.theme', 'dark'));
    // Settings (the app) writes these keys; the watchers make them take
    // effect immediately without it having to reach into shell internals.
    this.settings.watch<string>('desktop.wallpaper', (v) => {
      this.wallpaperEl.dataset.paper = v ?? 'nebula';
    });
    this.settings.watch<string>('desktop.theme', (v) => this.applyTheme(v ?? 'dark'));

    this.wireManagerEvents();
    this.wireConnection();
    this.wireShortcuts();
    this.wireSessionPersistence();
    this.wireFileDrops();
  }

  /* -------------------------------------------------------------- */
  /* DesktopAPI                                                      */
  /* -------------------------------------------------------------- */

  get host(): HostInfo | null {
    return this.rpc.host;
  }

  /**
   * The API an app on `hostId` should be handed. Falls back to the local
   * server when the host has been removed, so a stale window degrades to
   * something usable rather than throwing on every call.
   */
  /**
   * Where a launch goes when nothing says otherwise. Chosen from the tray, and
   * deliberately *not* remembered across reloads: opening a terminal on the
   * wrong machine because of a choice made yesterday is the kind of mistake
   * this should never make on someone's behalf.
   */
  private targetHost: string = LOCAL_HOST_ID;

  /** Asks for an address, and connects if it looks like one. */
  private async promptForHost(): Promise<void> {
    const answer = await this.prompt({
      title: 'Add a server',
      message:
        'Paste the address you would open in a browser, token and all — ' +
        'for example http://box:7070/?t=abc123',
      placeholder: 'http://hostname:7070/?t=…',
      confirmLabel: 'Add',
    });
    if (!answer) return;

    const url = toWebsocketUrl(answer);
    if (!url) {
      this.notify({ kind: 'error', title: 'That is not an address I can use', message: answer });
      return;
    }

    const entry = this.hosts.add(url);
    this.notify({ message: `Connecting to ${entry.label}…`, timeout: 3000 });
  }

  private async confirmRemoveHost(id: string): Promise<void> {
    const entry = this.hosts.get(id);
    if (!entry) return;

    const open = this.manager.all().filter((w) => w.hostId === id).length;
    const ok = await this.confirm({
      title: `Remove ${entry.label}?`,
      message: open
        ? `${open} window${open === 1 ? '' : 's'} on it will lose their connection. ` +
          'Nothing on the server itself is changed.'
        : 'Nothing on the server itself is changed.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;

    this.hosts.remove(id);
    if (this.targetHost === id) this.targetHost = LOCAL_HOST_ID;
    this.refreshHostLabels();
  }

  /** Re-labels every open window after the host set changes. */
  private refreshHostLabels(): void {
    const single = this.hosts.isSingle;
    for (const win of this.manager.all()) {
      const entry = this.hosts.get(win.hostId);
      win.setHostLabel(single ? null : (entry?.label ?? 'unreachable'));
    }
    this.taskbar.refreshHosts();
  }

  viewFor(hostId: string): DesktopAPI {
    const entry = this.hosts.get(hostId);
    if (!entry || entry.id === LOCAL_HOST_ID) return this;
    return hostView(this, entry);
  }

  register(app: AppManifest): void {
    this.registry.register(app);
    this.icons.render();
    this.events.emit('app:registered', app);
  }

  apps(): AppManifest[] {
    return this.registry.all();
  }

  /* -------------------------------------------------------------- */
  /* File transfer                                                   */
  /* -------------------------------------------------------------- */

  downloadFile(path: string): void {
    triggerDownload(path);
  }

  async uploadFiles(files: File[] | FileList, dir?: string): Promise<UploadSummary> {
    const list = [...files];
    const target = dir ?? this.settings.get('transfer.uploadsDir', DEFAULT_UPLOADS_DIR);
    const summary = await uploadTo(target, list);

    if (summary.ok.length > 0) {
      this.notify({
        kind: 'success',
        message: `Uploaded ${summary.ok.length} file${summary.ok.length === 1 ? '' : 's'} to ${target}`,
        actions: [
          {
            label: 'Open folder',
            onSelect: () => void this.launch('files', { params: { path: target } }),
          },
        ],
      });
    }
    for (const failure of summary.failed.slice(0, 3)) {
      this.notify({
        kind: 'error',
        title: `Could not upload ${failure.name}`,
        message: failure.error,
      });
    }
    if (summary.failed.length > 3) {
      this.notify({ kind: 'error', message: `…and ${summary.failed.length - 3} more failed.` });
    }
    return summary;
  }

  /** Drag-and-drop from the host OS onto the desktop → the inbox folder. */
  private dropDepth = 0;

  private wireFileDrops(): void {
    const hasFiles = (ev: DragEvent) => ev.dataTransfer?.types.includes('Files') ?? false;
    const root = this.rootEl;

    root.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      if (++this.dropDepth === 1) root.classList.add('is-dropping');
    });
    root.addEventListener('dragover', (ev) => {
      if (hasFiles(ev)) ev.preventDefault();
    });
    root.addEventListener('dragleave', (ev) => {
      if (!hasFiles(ev)) return;
      if (--this.dropDepth <= 0) {
        this.dropDepth = 0;
        root.classList.remove('is-dropping');
      }
    });
    root.addEventListener('drop', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      this.dropDepth = 0;
      root.classList.remove('is-dropping');
      const files = [...(ev.dataTransfer?.files ?? [])];
      if (files.length) void this.uploadFiles(files);
    });
  }

  /* -------------------------------------------------------------- */
  /* Enabled apps                                                    */
  /* -------------------------------------------------------------- */

  isAppEnabled(appId: string): boolean {
    return this.registry.isEnabled(appId);
  }

  async setAppEnabled(appId: string, enabled: boolean): Promise<void> {
    // Persist first: if the server refuses (e.g. disabling Settings), the
    // local state never diverges from what will come back on next boot.
    if (this.rpc.hasService('apps')) {
      await this.rpc.call('apps', 'setEnabled', { id: appId, enabled });
    }
    this.registry.setAppDisabled(appId, !enabled);
    this.icons.render();
    if (!enabled) {
      for (const win of this.manager.byApp(appId)) win.close();
    }
  }

  /* -------------------------------------------------------------- */
  /* File associations                                               */
  /* -------------------------------------------------------------- */

  private overrides = new AssociationOverrides(this.settings);

  async openFile(path: string, options: OpenFileOptions = {}): Promise<WindowHandle | null> {
    const file = fileRefFor(path);

    const app = options.appId
      ? this.registry.get(options.appId)
      : resolveHandler(this.registry.enabledApps(), file, this.overrides);

    if (!app) {
      this.reportNoHandler(file.name, path);
      return null;
    }

    if (options.remember && options.appId) this.overrides.set(file, options.appId);

    return this.launch(app.id, { params: { ...options.params, path } });
  }

  fileHandlers(path: string): FileHandlerInfo[] {
    const file = fileRefFor(path);
    const defaultApp = resolveHandler(this.registry.enabledApps(), file, this.overrides);
    return handlersFor(this.registry.enabledApps(), file).map((match) => ({
      app: match.app,
      verb: match.verb,
      isDefault: match.app.id === defaultApp?.id,
    }));
  }

  setDefaultApp(path: string, appId: string | null): void {
    const file = fileRefFor(path);
    if (appId === null) this.overrides.clear(file);
    else this.overrides.set(file, appId);
  }

  defaultApp(path: string): AppManifest | null {
    return resolveHandler(this.registry.enabledApps(), fileRefFor(path), this.overrides);
  }

  /** No app claims this file — offer to force one rather than dead-ending. */
  private reportNoHandler(name: string, path: string): void {
    const others = this.registry
      .enabledApps()
      .filter((a) => a.showInLauncher !== false)
      .sort((a, b) => a.name.localeCompare(b.name));

    this.notify({
      title: 'No app for this file',
      message: `Nothing is registered to open "${name}".`,
      kind: 'info',
      actions: others.length
        ? [
            {
              label: 'Open with…',
              onSelect: () => {
                const centre = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
                this.contextMenu(
                  [
                    { type: 'header', label: `Open ${name} with` },
                    ...others.map((app) => ({
                      label: app.name,
                      icon: app.icon,
                      onSelect: () =>
                        void this.openFile(path, { appId: app.id, remember: true }),
                    })),
                  ],
                  centre,
                );
              },
            },
          ]
        : undefined,
    });
  }

  launch(appId: string, options?: LaunchOptions): Promise<WindowHandle | null> {
    // An explicit host wins — session restore names one, and so does anything
    // launching on a machine other than the one the tray is pointed at.
    options = { ...options, host: options?.host ?? this.targetHost };

    if (!this.registry.isEnabled(appId)) {
      const name = this.registry.get(appId)?.name ?? appId;
      this.notify({
        message: `"${name}" is disabled. Enable it in Settings.`,
        kind: 'warning',
        actions: [{ label: 'Open Settings', onSelect: () => void this.launch('settings') }],
      });
      return Promise.resolve(null);
    }
    return this.manager.launch(appId, options);
  }

  windows = {
    all: (): WindowHandle[] => this.manager.all(),
    byApp: (appId: string): WindowHandle[] => this.manager.byApp(appId),
    focused: (): WindowHandle | null => this.manager.focused(),
    minimizeAll: (): void => this.manager.minimizeAll(),
  };

  notify(options: NotifyOptions): void {
    this.notifications.show(options);
  }

  confirm(options: DialogOptions): Promise<boolean> {
    return confirmDialog(options);
  }

  prompt(options: PromptOptions): Promise<string | null> {
    return promptDialog(options);
  }

  contextMenu(items: MenuItem[], at: { x: number; y: number }): void {
    openMenu(items, { x: at.x, y: at.y, minWidth: 180 });
  }

  /* -------------------------------------------------------------- */
  /* Layout                                                          */
  /* -------------------------------------------------------------- */

  /** Screen area windows may occupy: everything above the taskbar. */
  private workArea(): Rect {
    const taskbarHeight = this.taskbar?.height ?? 0;
    return {
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: Math.max(120, window.innerHeight - taskbarHeight),
    };
  }

  /* -------------------------------------------------------------- */
  /* Wiring                                                          */
  /* -------------------------------------------------------------- */

  private wireManagerEvents(): void {
    this.manager.events.on('opened', (w) => {
      this.events.emit('window:opened', w);
      // Geometry changes are per-window; these listeners die with the window.
      w.on('move', () => this.scheduleSessionSave());
      w.on('resize', () => this.scheduleSessionSave());
      this.scheduleSessionSave();
    });
    this.manager.events.on('closed', (w) => {
      this.events.emit('window:closed', w);
      this.scheduleSessionSave();
    });
    this.manager.events.on('focused', (w) => {
      this.events.emit('window:focused', w);
      this.scheduleSessionSave();
    });
    this.manager.events.on('state', (w) => {
      this.events.emit('window:state', w);
      this.scheduleSessionSave();
    });
  }

  /* -------------------------------------------------------------- */
  /* Session restore                                                 */
  /* -------------------------------------------------------------- */

  private saveTimer: number | null = null;
  /** Suppresses saves while restoring, so a partial stack is never written. */
  private restoring = false;

  private scheduleSessionSave(): void {
    if (this.restoring || !this.session.enabled) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveSessionNow();
    }, SESSION_SAVE_DEBOUNCE_MS);
  }

  private saveSessionNow(): void {
    if (this.restoring) return;
    this.session.save(this.manager.serialize());
  }

  private wireSessionPersistence(): void {
    // `pagehide` fires for reloads, navigations and bfcache alike, where
    // `beforeunload` is unreliable and `unload` is increasingly ignored.
    window.addEventListener('pagehide', () => {
      if (this.saveTimer !== null) clearTimeout(this.saveTimer);
      this.saveSessionNow();
    });

    // Backstop for a tab that is closed without ever firing pagehide.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveSessionNow();
    });
  }

  /**
   * Reopens the previous session. Returns how many windows came back, so the
   * caller can decide whether to launch anything by default instead.
   */
  async restoreSession(): Promise<number> {
    const records = this.session.load();
    if (records.length === 0) return 0;

    this.restoring = true;
    try {
      return await this.manager.restoreSession(records);
    } catch (err) {
      console.error('Session restore failed:', err);
      return 0;
    } finally {
      this.restoring = false;
      // Write back what actually reopened, dropping any records we skipped.
      this.saveSessionNow();
    }
  }

  private wireConnection(): void {
    // One host means no badges: the answer is never in doubt, so saying it on
    // every window and every taskbar button is pure noise. The moment a second
    // server exists, every window has to say which one it is.
    this.hosts.events.on('changed', () => this.refreshHostLabels());

    this.rpc.events.on('state', (state) => {
      this.taskbar.setConnectionState(state);
      this.rootEl.dataset.connection = state;
      this.events.emit('connection:state', state);

      if (state === 'reconnecting') {
        this.notify({
          title: 'Disconnected',
          message: 'Lost the connection to the server. Retrying…',
          kind: 'warning',
          timeout: 4000,
        });
      }
    });

    this.rpc.events.on('hello', ({ host }) => {
      this.taskbar.setHost(`${host.user}@${host.hostname}`);
      document.title = `${host.user}@${host.hostname} — Finestra`;
    });

    // `finestra open …`, typed in a terminal on the server. A shell has no
    // window and no display to draw into — every native application here gets
    // its own compositor, which lives exactly as long as its window — so the
    // command asks, and this is the answering half.
    this.rpc.events.on('event', ({ svc, e, d }) => {
      if (svc !== 'shell' || e !== 'open') return;
      const req = (d ?? {}) as { app?: string; name?: string; file?: string };
      if (req.file) {
        void this.openFile(req.file);
        return;
      }
      if (!req.app) return;
      // A pinned application has a manifest of its own; every other installed
      // one is opened through the wrapper, which is what the picker does with
      // the same parameter. Only pinning creates the manifest, so requiring one
      // here meant `finestra open` worked for pinned applications and silently
      // did nothing for the rest — which is most of them.
      const pinned = `wayland:${req.app}`;
      if (this.registry.get(pinned)) {
        void this.launch(pinned);
      } else if (this.registry.get('wayland')) {
        void this.launch('wayland', { params: { appId: req.app }, title: req.name });
      } else {
        this.notify({
          kind: 'error',
          title: 'Could not open it',
          message: `This desktop cannot run native applications.`,
        });
      }
    });
  }

  private wireShortcuts(): void {
    this.shortcuts.register(
      'Alt+Tab',
      () => this.manager.cycleFocus(1),
      'Switch between windows',
    );
    this.shortcuts.register(
      'Alt+Shift+Tab',
      () => this.manager.cycleFocus(-1),
      'Switch between windows, backwards',
    );
    this.shortcuts.register(
      'Ctrl+Alt+T',
      () => void this.launch('terminal'),
      'Open a new terminal',
    );
    this.shortcuts.register(
      'Ctrl+Alt+D',
      () => this.manager.minimizeAll(),
      'Show the desktop',
    );
    this.shortcuts.register(
      'Alt+F4',
      () => this.manager.focused()?.close(),
      'Close the focused window',
    );
    this.shortcuts.register(
      'Ctrl+Alt+M',
      () => this.manager.focused()?.toggleMaximize(),
      'Maximize or restore the focused window',
    );
  }

  /* -------------------------------------------------------------- */
  /* Menus                                                           */
  /* -------------------------------------------------------------- */

  private backgroundMenu(): MenuItem[] {
    const launchable = this.registry
      .all()
      .filter((a) => a.showInLauncher !== false)
      .sort((a, b) => a.name.localeCompare(b.name));

    return [
      ...launchable.slice(0, 3).map((app) => ({
        label: `New ${app.name}`,
        icon: app.icon,
        onSelect: () => void this.launch(app.id),
      })),
      { type: 'separator' as const },
      {
        label: 'Wallpaper',
        icon: '🖼',
        submenu: () =>
          WALLPAPERS.map((paper) => ({
            label: paper.name,
            checked: this.settings.get('desktop.wallpaper', 'nebula') === paper.id,
            onSelect: () => this.applyWallpaper(paper.id),
          })),
      },
      { label: 'Minimize all windows', accelerator: 'Ctrl+Alt+D', onSelect: () => this.manager.minimizeAll() },
      { type: 'separator' as const },
      { label: 'Settings', icon: '⚙', onSelect: () => void this.launch('settings') },
      { label: 'Keyboard shortcuts', icon: '⌨', onSelect: () => this.showShortcuts() },
      { label: 'About this desktop', icon: 'ℹ', onSelect: () => this.showAbout() },
    ];
  }

  private systemMenu(): MenuItem[] {
    return [
      { type: 'header', label: 'Desktop' },
      { label: 'Settings', icon: '⚙', onSelect: () => void this.launch('settings') },
      {
        label: 'Reopen windows on reload',
        checked: this.session.enabled,
        onSelect: () => {
          this.session.setEnabled(!this.session.enabled);
          if (this.session.enabled) this.saveSessionNow();
        },
      },
      { label: 'Keyboard shortcuts', icon: '⌨', onSelect: () => this.showShortcuts() },
      { label: 'About', icon: 'ℹ', onSelect: () => this.showAbout() },
      {
        label: 'Close all windows',
        icon: '✕',
        danger: true,
        onSelect: async () => {
          const count = this.manager.all().length;
          if (count === 0) return;
          const ok = await this.confirm({
            title: 'Close all windows',
            message: `Close ${count} window${count === 1 ? '' : 's'}? Anything running in them will be terminated.`,
            confirmLabel: 'Close all',
            danger: true,
          });
          if (ok) this.manager.closeAll();
        },
      },
      ...this.powerItems(),
    ];
  }

  /**
   * Only offered where it could work: without systemd there is nothing to ask.
   * Whether the *account* is allowed to is a different question, answered by
   * the server when asked — a menu cannot tell, and hiding these on a machine
   * that simply needs a more privileged install would hide the explanation too.
   */
  private powerItems(): MenuItem[] {
    const view = this.viewFor(this.targetHost);
    if (!view.rpc.hasService('systemd')) return [];
    const name = view.host?.hostname ?? '';
    return [
      { type: 'separator' as const },
      { type: 'header' as const, label: name ? `Machine — ${name}` : 'Machine' },
      { label: 'Restart…', icon: '⟳', danger: true, onSelect: () => void this.power('reboot') },
      { label: 'Shut down…', icon: '⏻', danger: true, onSelect: () => void this.power('poweroff') },
    ];
  }

  private applyTheme(theme: string): void {
    const resolved = theme === 'light' ? 'light' : 'dark';
    // Tokens key off this attribute; color-scheme fixes form controls and
    // scrollbars that the tokens do not reach.
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }

  private applyWallpaper(id: string): void {
    this.wallpaperEl.dataset.paper = id;
    this.settings.set('desktop.wallpaper', id);
    closeAllMenus();
  }

  private showShortcuts(): void {
    // No column padding: the dialog uses a proportional font, so it would not
    // line up anyway.
    const lines = this.shortcuts
      .list()
      .map((s) => `${s.combo} — ${s.description ?? ''}`)
      .join('\n');
    void this.confirm({
      title: 'Keyboard shortcuts',
      message: lines || 'No shortcuts are registered.',
      confirmLabel: 'Close',
      cancelLabel: null,
    });
  }

  /**
   * Two version numbers, not one. The shell is whatever the browser loaded and
   * the server is whatever that machine has installed, and after an update they
   * disagree until the page is reloaded — which looks exactly like an update
   * that did nothing. Showing both, named, is what makes that diagnosable.
   *
   * It reports the *target* host rather than the local one, for the same reason
   * restart and shut down do: with several servers in one shell, an answer that
   * does not say which machine it is about is worse than no answer.
   */
  private showAbout(): void {
    const view = this.viewFor(this.targetHost);
    const host = view.host ?? this.rpc.host;
    const shell = __FINESTRA_VERSION__;
    const lines = ['A desktop environment for a headless server.', ''];

    lines.push(`Desktop   ${shell}`);

    if (host) {
      // Optional at runtime though the type says otherwise: a server from
      // before this existed connects fine and simply does not say.
      const build = host.build as HostInfo['build'] | undefined;
      lines.push(`Server    ${build?.version ?? 'unknown'}   on ${host.hostname}`);
      if (build?.builtAt) lines.push(`Built     ${build.builtAt}`);
      if (build && build.version !== shell) {
        lines.push('', 'The desktop and the server are different builds. Reload the page.');
      }
      lines.push('', `${host.user}@${host.hostname}`, `${host.platform}/${host.arch}`, `Home: ${host.home}`);
    } else {
      lines.push('', 'Not connected to a server.');
    }

    lines.push('', LICENCE, COPYRIGHT);

    void this.confirm({
      title: 'Finestra',
      message: lines.join('\n'),
      link: { href: WEBSITE_URL },
      confirmLabel: 'Close',
      cancelLabel: null,
    });
  }

  /* -------------------------------------------------------------- */
  /* Restart and shut down                                           */
  /* -------------------------------------------------------------- */

  /**
   * The machine, not the desktop. Both of these end the connection that asked
   * for them, which is why the confirmation names the host: with several
   * servers in one shell, the only thing distinguishing "restart" from
   * "restart the wrong one" is reading that line.
   */
  private async power(action: 'reboot' | 'poweroff'): Promise<void> {
    const view = this.viewFor(this.targetHost);
    const name = view.host?.hostname ?? this.hosts.get(this.targetHost)?.label ?? 'this server';
    const verb = action === 'reboot' ? 'Restart' : 'Shut down';

    const ok = await this.confirm({
      title: `${verb} ${name}?`,
      message:
        `Everything running on ${name} stops, including anything unsaved in a ` +
        `terminal or an editor, and this desktop loses its connection` +
        (action === 'reboot'
          ? ' until the machine comes back.'
          : '. Nothing here can turn it on again.'),
      confirmLabel: verb,
      danger: true,
    });
    if (!ok) return;

    const going = () =>
      this.notify({
        title: `${action === 'reboot' ? 'Restarting' : 'Shutting down'} ${name}`,
        message:
          action === 'reboot'
            ? 'The desktop will reconnect by itself once it is back.'
            : 'Nothing here can turn it on again.',
        timeout: 10000,
      });

    // Nothing is announced before the server has accepted the job: a refusal
    // arrives in well under a second, and saying "restarting" first would be a
    // claim retracted by the very next dialog.
    try {
      await view.rpc.call('systemd', 'power', { action });
      going();
    } catch (err) {
      // The machine going down can close the socket before the reply lands.
      // That is the request being carried out, not failing, and reporting it as
      // an error would tell the user the opposite of what just happened.
      if ((err as { code?: string }).code === 'EOFFLINE') {
        going();
        return;
      }
      void this.confirm({
        title: `Could not ${verb.toLowerCase()} ${name}`,
        message: (err as Error).message,
        confirmLabel: 'Close',
        cancelLabel: null,
      });
    }
  }

  /** Opens the connection and waits for the handshake. */
  async start(): Promise<void> {
    this.rpc.connect();
    // Remote servers connect alongside, and are never waited for: one of them
    // being unreachable must not hold up the desktop you are looking at.
    this.hosts.connectRemotes();
    this.refreshHostLabels();
    await this.rpc.ready();

    // Which apps are enabled lives on the server; fetch it before session
    // restore so a disabled app's saved windows are skipped, not reopened.
    if (this.rpc.hasService('apps')) {
      try {
        const { disabled } = await this.rpc.call<{ disabled: string[] }>('apps', 'list');
        this.registry.setDisabled(disabled.filter((id) => id !== 'settings'));
        this.icons.render();
      } catch (err) {
        console.warn('Could not load app state:', err);
      }
    }
  }
}
