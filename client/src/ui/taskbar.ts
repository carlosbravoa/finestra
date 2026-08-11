import { h, iconEl } from '../core/dom';
import type { AppRegistry } from '../core/registry';
import type { ConnectionState, MenuItem } from '../core/types';
import { openMenu } from './menu';
import type { DesktopWindow } from './window';
import type { WindowManager } from './window-manager';

export interface TaskbarDeps {
  registry: AppRegistry;
  windows: WindowManager;
  launch(appId: string): void;
  /** Extra entries appended to the launcher, above the system section. */
  systemMenu(): MenuItem[];
  /** Every server the shell is connected to, for the tray switcher. */
  hosts(): HostSummary[];
  /** Which server new launches go to. */
  targetHost(): string;
  setTargetHost(id: string): void;
  addHost(): void;
  removeHost(id: string): void;
}

/** What the taskbar needs to know about a host, and nothing more. */
export interface HostSummary {
  id: string;
  label: string;
  state: string;
  local: boolean;
}

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
};

/** The bar along the bottom: launcher, open windows, and status. */
export class Taskbar {
  readonly element: HTMLElement;

  private taskList: HTMLElement;
  private clockEl: HTMLElement;
  private statusEl: HTMLElement;
  private hostEl: HTMLElement;
  private buttons = new Map<string, HTMLElement>();
  private localLabel = '';

  constructor(parent: HTMLElement, private deps: TaskbarDeps) {
    const startButton = h(
      'button',
      { class: 'taskbar-start', title: 'Applications' },
      iconEl('◈', 'taskbar-start-icon'),
      h('span', { class: 'taskbar-start-label', text: 'Apps' }),
    );
    startButton.addEventListener('click', () => this.openLauncher(startButton));

    this.taskList = h('div', { class: 'taskbar-tasks' });
    this.clockEl = h('div', { class: 'taskbar-clock' });
    this.statusEl = h('div', { class: 'taskbar-status', title: 'Server connection' });
    // The host readout is also the switcher: with one server it just names it,
    // and with several it is how you say where the next window should open.
    this.hostEl = h('button', {
      class: 'taskbar-host',
      title: 'Servers',
      on: { click: () => this.openHostMenu() },
    });

    // Clicking empty taskbar space clears focus without hiding anything.
    const showDesktop = h('button', {
      class: 'taskbar-show-desktop',
      title: 'Minimize all windows',
      on: { click: () => this.deps.windows.minimizeAll() },
    });

    this.element = h(
      'div',
      { class: 'taskbar', attrs: { role: 'toolbar' } },
      startButton,
      this.taskList,
      h('div', { class: 'taskbar-tray' }, this.hostEl, this.statusEl, this.clockEl, showDesktop),
    );

    parent.appendChild(this.element);

    this.deps.windows.events.on('opened', () => this.renderTasks());
    this.deps.windows.events.on('closed', () => this.renderTasks());
    this.deps.windows.events.on('focused', () => this.renderTasks());
    this.deps.windows.events.on('state', () => this.renderTasks());

    this.startClock();
    this.setConnectionState('connecting');
  }

  get height(): number {
    return this.element.offsetHeight;
  }

  /**
   * The `user@hostname` of the server the page came from. Kept, because with
   * one server it is more use than any name we could invent for it — but it
   * gives way to the switcher as soon as there is a choice to make.
   */
  setHost(label: string): void {
    this.localLabel = label;
    this.refreshHosts();
  }

  setConnectionState(state: ConnectionState): void {
    this.statusEl.dataset.state = state;
    this.statusEl.title = `Server connection: ${CONNECTION_LABELS[state]}`;
    this.statusEl.replaceChildren(
      h('span', { class: 'taskbar-status-dot' }),
      h('span', { class: 'taskbar-status-label', text: CONNECTION_LABELS[state] }),
    );
  }

  /** Re-renders anything that depends on the host set. */
  refreshHosts(): void {
    const hosts = this.deps.hosts();
    const many = hosts.length > 1;
    const target = hosts.find((x) => x.id === this.deps.targetHost()) ?? hosts[0];

    // One server: say which machine you are on, which is what this readout has
    // always been for. Several: say where the next window will open, because
    // that is now the question the tray has to answer.
    this.hostEl.textContent = many ? (target?.label ?? '') : this.localLabel;
    this.hostEl.title = many
      ? `New windows open on ${target?.label ?? 'this server'} — click to change`
      : 'Servers';
    this.hostEl.classList.toggle('is-switcher', many);
    this.renderTasks();
  }

  private openHostMenu(): void {
    const hosts = this.deps.hosts();
    const target = this.deps.targetHost();
    const items: MenuItem[] = [];

    if (hosts.length > 1) {
      items.push({ type: 'header', label: 'Open new windows on' });
      for (const host of hosts) {
        items.push({
          label: `${host.label}${host.state === 'open' ? '' : `  (${host.state})`}`,
          checked: host.id === target,
          // An unreachable server can still be chosen: it may come back, and
          // refusing to select it would be a worse answer than a window that
          // says it is waiting.
          onSelect: () => this.deps.setTargetHost(host.id),
        });
      }
      items.push({ type: 'separator' });
    }

    items.push({ label: 'Add a server…', onSelect: () => this.deps.addHost() });

    const removable = hosts.filter((x) => !x.local);
    if (removable.length) {
      items.push({
        label: 'Remove a server',
        submenu: () =>
          removable.map((host) => ({
            label: host.label,
            danger: true,
            onSelect: () => this.deps.removeHost(host.id),
          })),
      });
    }

    openMenu(items, { x: 0, y: 0, align: 'above', anchor: this.hostEl, minWidth: 200 });
  }

  private openLauncher(anchor: HTMLElement): void {
    const groups = this.deps.registry.byCategory();
    const items: MenuItem[] = [];

    for (const group of groups) {
      if (groups.length > 1) items.push({ type: 'header', label: group.category });
      for (const app of group.apps) {
        items.push({
          label: app.name,
          icon: app.icon,
          onSelect: () => this.deps.launch(app.id),
        });
      }
      items.push({ type: 'separator' });
    }

    items.push(...this.deps.systemMenu());

    anchor.classList.add('is-open');
    openMenu(items, {
      x: 0,
      y: 0,
      align: 'above',
      anchor,
      minWidth: 220,
      onClose: () => anchor.classList.remove('is-open'),
    });
  }

  private renderTasks(): void {
    const windows = this.deps.windows.all();
    const seen = new Set<string>();

    for (const win of windows) {
      seen.add(win.id);
      let button = this.buttons.get(win.id);

      if (!button) {
        button = this.createTaskButton(win);
        this.buttons.set(win.id, button);
        this.taskList.appendChild(button);
      }

      button.classList.toggle('is-focused', win.focused);
      button.classList.toggle('is-minimized', win.state === 'minimized');
      const label = button.querySelector('.taskbar-task-label');
      const title = win.element.querySelector('.window-title')?.textContent ?? '';
      if (label && label.textContent !== title) label.textContent = title;
      button.title = title;
    }

    for (const [id, button] of this.buttons) {
      if (seen.has(id)) continue;
      button.remove();
      this.buttons.delete(id);
    }
  }

  private createTaskButton(win: DesktopWindow): HTMLElement {
    const manifest = this.deps.registry.get(win.appId);
    const button = h(
      'button',
      { class: 'taskbar-task', dataset: { windowId: win.id } },
      iconEl(manifest?.icon ?? '▢', 'taskbar-task-icon'),
      h('span', { class: 'taskbar-task-label' }),
    );

    button.addEventListener('click', () => {
      // Clicking the focused window's button minimizes it, as desktops do.
      if (win.focused && win.state !== 'minimized') win.minimize();
      else win.focus();
    });

    button.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openMenu(
        [
          { label: 'Restore', disabled: win.state === 'normal', onSelect: () => win.restore() },
          { label: 'Minimize', onSelect: () => win.minimize() },
          { label: 'Maximize', onSelect: () => win.maximize() },
          { type: 'separator' },
          { label: 'Close', danger: true, onSelect: () => win.close() },
        ],
        { x: ev.clientX, y: ev.clientY, minWidth: 160 },
      );
    });

    return button;
  }

  private startClock(): void {
    const tick = () => {
      const now = new Date();
      this.clockEl.replaceChildren(
        h('div', {
          class: 'taskbar-time',
          text: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }),
        h('div', {
          class: 'taskbar-date',
          text: now.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        }),
      );
      this.clockEl.title = now.toLocaleString();
    };
    tick();
    // Re-align to the next minute boundary rather than drifting on an interval.
    const schedule = () => {
      const msToNextMinute = 60_000 - (Date.now() % 60_000);
      window.setTimeout(() => {
        tick();
        schedule();
      }, msToNextMinute + 50);
    };
    schedule();
  }
}
