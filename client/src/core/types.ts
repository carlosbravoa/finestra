/**
 * The application SDK.
 *
 * An app is a manifest with a `mount` function. The shell hands it a DOM node
 * and a `DesktopAPI`, and it hands back an instance with optional lifecycle
 * hooks. That is the entire contract — an app can be plain DOM, canvas, or any
 * framework it likes, because the shell never looks inside its element.
 */

import type { HostInfo } from '../../../shared/protocol';
import type { Emitter } from './events';
import type { RpcClient } from './rpc';
import type { HostRegistry } from './hosts';
import type { ShortcutRegistry } from './shortcuts';

/* ------------------------------------------------------------------ */
/* Apps                                                                */
/* ------------------------------------------------------------------ */

export interface AppManifest {
  /** Stable, unique. Used in launch calls and persisted state. */
  id: string;
  name: string;
  /** Emoji, or an inline `<svg>` string. */
  icon: string;
  description?: string;
  /** Grouping for the launcher menu. */
  category?: string;
  /** When true, launching again focuses the existing window. */
  singleton?: boolean;
  showOnDesktop?: boolean;
  /** Defaults to true. */
  showInLauncher?: boolean;
  defaultSize?: Size;
  minSize?: Size;
  resizable?: boolean;
  /** Start maximized, e.g. for a full-screen app. */
  startMaximized?: boolean;
  /**
   * Whether windows of this app are reopened after a reload. Defaults to true.
   * Turn it off for anything whose window is meaningless without live state.
   */
  restorable?: boolean;
  /**
   * What this app can open. An app that declares any of these is launched with
   * `params.path` set to the file. See `associations.ts` for how ties resolve.
   */
  handles?: FileAssociation[];
  mount(ctx: AppContext): AppInstance | Promise<AppInstance>;
}

/** A file being opened, as much as the shell knows about it. */
export interface FileRef {
  name: string;
  path: string;
  kind?: 'file' | 'directory' | 'symlink' | 'other';
}

export interface FileAssociation {
  /** Extensions including the dot, matched case-insensitively: ['.txt', '.md']. */
  extensions?: string[];
  /** Exact filenames, matched case-sensitively: ['Makefile', 'Dockerfile']. */
  names?: string[];
  /** For anything the above cannot express. Must not throw; must be cheap. */
  matches?(file: FileRef): boolean;
  /** Claims files nothing else wants — a viewer of last resort. */
  fallback?: boolean;
  /** Shown in the Open with menu: 'Edit', 'View'. Defaults to 'Open'. */
  verb?: string;
  /** Breaks ties between equally specific claims. Higher wins. Default 0. */
  priority?: number;
}

export interface AppContext {
  /** The window hosting this instance. */
  window: WindowHandle;
  /** Render here. The shell owns everything outside it. */
  root: HTMLElement;
  desktop: DesktopAPI;
  /** Whatever `launch()` was called with. */
  params: Record<string, unknown>;
}

export interface AppInstance {
  /** Release timers, sockets and listeners here. Called exactly once. */
  destroy?(): void;
  /** The content box changed size. */
  onResize?(size: Size): void;
  onFocus?(): void;
  onBlur?(): void;
  /** Return false to veto the close, e.g. for unsaved changes. */
  onClose?(): boolean | Promise<boolean>;
  /** Contributed to the window's own menu bar. */
  menu?: MenuItem[];
  /**
   * State to reopen this window with after a reload. The result is handed back
   * as `params` on the next `mount`, so it must be JSON-serialisable.
   *
   * Called synchronously, possibly while the page is unloading — return
   * already-known values rather than starting any async work.
   */
  saveState?(): Record<string, unknown> | undefined;
}

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export type WindowState = 'normal' | 'minimized' | 'maximized';

export interface WindowEvents {
  focus: void;
  blur: void;
  resize: Size;
  move: { x: number; y: number };
  state: WindowState;
  close: void;
}

export interface WindowHandle {
  readonly id: string;
  readonly appId: string;
  /** Which server this window's app is running on. */
  readonly hostId: string;
  readonly element: HTMLElement;
  readonly content: HTMLElement;
  readonly state: WindowState;
  readonly focused: boolean;

  setTitle(title: string): void;
  setIcon(icon: string): void;
  /** Replaces the window's menu bar. Pass an empty array to hide it. */
  setMenu(items: MenuItem[]): void;
  /** Small text in the window's status strip; null hides the strip. */
  setStatus(text: string | null): void;

  focus(): void;
  close(): void;
  minimize(): void;
  maximize(): void;
  restore(): void;
  toggleMaximize(): void;
  setBounds(bounds: Partial<Rect>): void;
  getBounds(): Rect;

  on<K extends keyof WindowEvents>(event: K, fn: (payload: WindowEvents[K]) => void): () => void;
}

export interface LaunchOptions {
  params?: Record<string, unknown>;
  /** Which server to run it on. Defaults to the page's own. */
  host?: string;
  /** Overrides the manifest's default geometry. */
  bounds?: Partial<Rect>;
  title?: string;
  /** Overrides the manifest's `startMaximized`. Used by session restore. */
  state?: WindowState;
}

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

export type MenuItem = MenuAction | MenuSeparator | MenuHeader;

export interface MenuAction {
  type?: 'action';
  label: string;
  icon?: string;
  /** Display-only hint such as "Ctrl+C"; the shell does not bind it. */
  accelerator?: string;
  disabled?: boolean;
  checked?: boolean;
  /** Renders in the destructive style. */
  danger?: boolean;
  submenu?: MenuItem[] | (() => MenuItem[]);
  onSelect?(): void;
}

export interface MenuSeparator {
  type: 'separator';
}

export interface MenuHeader {
  type: 'header';
  label: string;
}

/* ------------------------------------------------------------------ */
/* Shell services available to apps                                    */
/* ------------------------------------------------------------------ */

export interface DesktopAPI {
  /**
   * Talk to the server: `rpc.call('fs', 'list', { path })`.
   *
   * In an app this is *its own window's* host, not a global one — see
   * core/host-view.ts. Apps never name a machine and never need to.
   */
  rpc: RpcClient;
  /** Facts about the machine, once connected. */
  readonly host: HostInfo | null;
  /** Which host this view is bound to. `local` for the page's own server. */
  readonly hostId: string;
  /** Every server this shell is connected to. */
  hosts: HostRegistry;

  launch(appId: string, options?: LaunchOptions): Promise<WindowHandle | null>;
  register(app: AppManifest): void;
  apps(): AppManifest[];

  /**
   * Opens a file with the app registered for it. Returns null when nothing
   * handles it, having already told the user so.
   */
  openFile(path: string, options?: OpenFileOptions): Promise<WindowHandle | null>;
  /** Apps that claim this file, best match first — for an Open with menu. */
  fileHandlers(path: string): FileHandlerInfo[];
  /** Remembers which app should open files of this kind from now on. */
  setDefaultApp(path: string, appId: string | null): void;
  /** The app currently chosen for this file, if any. */
  defaultApp(path: string): AppManifest | null;

  windows: {
    all(): WindowHandle[];
    byApp(appId: string): WindowHandle[];
    focused(): WindowHandle | null;
    minimizeAll(): void;
  };

  notify(options: NotifyOptions): void;
  /** Modal confirmation. Resolves false if dismissed. */
  confirm(options: DialogOptions): Promise<boolean>;
  /** Modal text input. Resolves null if dismissed. */
  prompt(options: PromptOptions): Promise<string | null>;
  /** Opens a context menu at viewport coordinates. */
  contextMenu(items: MenuItem[], at: { x: number; y: number }): void;

  /** Streams a file to the browser's download UI. No size cap. */
  downloadFile(path: string): void;
  /**
   * Uploads to a server directory (defaults to the configured inbox folder)
   * and notifies the user of the outcome. Resolves with what happened.
   */
  uploadFiles(files: File[] | FileList, dir?: string): Promise<UploadSummary>;

  /** False when the app has been turned off in Settings. */
  isAppEnabled(appId: string): boolean;
  /** Persists server-side when the server supports it. */
  setAppEnabled(appId: string, enabled: boolean): Promise<void>;

  /**
   * Copy and paste. Prefer this to `navigator.clipboard`: the browser refuses
   * that outside a secure context, and this desktop is usually plain http.
   */
  clipboard: ClipboardAPI;

  session: SessionControls;
  settings: SettingsStore;
  events: Emitter<DesktopEvents>;
  /** Desktop-wide keyboard accelerators. */
  shortcuts: ShortcutRegistry;
}

export interface UploadedFile {
  name: string;
  path: string;
  size: number;
}

export interface UploadSummary {
  /** Directory the files were sent to, as requested (may contain `~`). */
  dir: string;
  ok: UploadedFile[];
  failed: Array<{ name: string; error: string }>;
}

/** Where a copy landed: the machine's own clipboard, or only this desktop's. */
export type ClipboardScope = 'system' | 'local';

/**
 * The desktop's clipboard, which is the system's when the browser allows it
 * and its own otherwise. See `core/clipboard.ts` for why both exist.
 */
export interface ClipboardAPI {
  /** Copies text, and says where it reached. Never rejects. */
  write(text: string): Promise<ClipboardScope>;
  /** The text to paste — the system clipboard when readable, ours otherwise. */
  read(): Promise<string>;
  /** The same answer without asking the browser, for a synchronous path. */
  readonly text: string;
  /** True once the browser has refused the system clipboard this session. */
  readonly blocked: boolean;
  /**
   * What a real `paste` event should paste. The event's own text is the
   * system clipboard, which may be older than what this desktop last copied.
   */
  fromEvent(ev: ClipboardEvent): string;
  /** Fires when the desktop's own copy changes. */
  watch(fn: (text: string) => void): () => void;
}

/** Session-restore controls, surfaced so a settings UI can manage them. */
export interface SessionControls {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  /** Forgets the saved windows without changing the toggle. */
  clear(): void;
}

export interface OpenFileOptions {
  /** Force a specific app instead of the registered one. */
  appId?: string;
  /** Also make that app the default for this kind of file. */
  remember?: boolean;
  /** Passed through to the app alongside `path`. */
  params?: Record<string, unknown>;
}

export interface FileHandlerInfo {
  app: AppManifest;
  /** 'Edit', 'View', … */
  verb: string;
  /** True for the app that would be used if the file were simply opened. */
  isDefault: boolean;
}

export interface NotifyOptions {
  title?: string;
  message: string;
  kind?: 'info' | 'success' | 'warning' | 'error';
  /** Milliseconds; 0 keeps it until dismissed. */
  timeout?: number;
  actions?: Array<{ label: string; onSelect(): void }>;
}

export interface DialogOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  /** `null` hides the cancel button, making the dialog purely informational. */
  cancelLabel?: string | null;
  danger?: boolean;
  /** Rendered under the message as the one clickable thing in the dialog. */
  link?: { href: string; label?: string };
}

export interface PromptOptions extends DialogOptions {
  value?: string;
  placeholder?: string;
}

export interface DesktopEvents {
  'app:registered': AppManifest;
  'window:opened': WindowHandle;
  'window:closed': WindowHandle;
  'window:focused': WindowHandle | null;
  'window:state': WindowHandle;
  'connection:state': ConnectionState;
  'settings:changed': { key: string; value: unknown };
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SettingsStore {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  /** Fires whenever `key` changes, including from another tab. */
  watch<T>(key: string, fn: (value: T | undefined) => void): () => void;
}
