import { h } from '../core/dom';
import { Emitter } from '../core/events';
import { LOCAL_HOST_ID } from '../core/hosts';
import type { AppRegistry } from '../core/registry';
import type { WindowRecord } from '../core/session-store';
import type {
  AppInstance,
  AppManifest,
  DesktopAPI,
  LaunchOptions,
  Rect,
  WindowHandle,
} from '../core/types';
import { DesktopWindow, type WindowHost } from './window';

export interface WindowManagerEvents {
  opened: DesktopWindow;
  closed: DesktopWindow;
  focused: DesktopWindow | null;
  state: DesktopWindow;
}

const DEFAULT_SIZE = { width: 820, height: 540 };
const DEFAULT_MIN_SIZE = { width: 260, height: 160 };
const CASCADE_STEP_PX = 28;
const CASCADE_POSITIONS = 8;
const BASE_Z_INDEX = 100;

interface Entry {
  window: DesktopWindow;
  manifest: AppManifest;
  instance: AppInstance | null;
  /** What the window was launched with, and the fallback for session state. */
  params: Record<string, unknown>;
  /** Set while `close()` is awaiting the app's veto, to avoid re-entry. */
  closing: boolean;
  /** Which server it runs on. Fixed for the life of the window. */
  host: string;
}

/**
 * Owns the lifecycle of every window: creation, stacking, focus and teardown.
 *
 * Apps never construct windows themselves — they are launched by id, which is
 * what keeps the taskbar, the launcher and session restore all consistent.
 */
export class WindowManager implements WindowHost {
  readonly events = new Emitter<WindowManagerEvents>();

  private entries = new Map<string, Entry>();
  /** Most-recently-focused last; index in this array is the stacking order. */
  private stack: DesktopWindow[] = [];
  private focusedWindow: DesktopWindow | null = null;
  private sequence = 0;

  constructor(
    private layer: HTMLElement,
    private registry: AppRegistry,
    private getWorkArea: () => Rect,
    /** The API an app gets, scoped to the host its window belongs to. */
    private getDesktop: (hostId: string) => DesktopAPI,
  ) {
    window.addEventListener('resize', () => {
      for (const entry of this.entries.values()) entry.window.reflow();
    });
  }

  async launch(appId: string, options: LaunchOptions = {}): Promise<WindowHandle | null> {
    const manifest = this.registry.get(appId);
    if (!manifest) {
      console.error(`No such app: ${appId}`);
      return null;
    }

    if (manifest.singleton) {
      const existing = this.byApp(appId)[0];
      if (existing) {
        existing.restore();
        existing.focus();
        return existing;
      }
    }

    const id = `win-${++this.sequence}`;
    const size = { ...DEFAULT_SIZE, ...manifest.defaultSize };
    const minSize = { ...DEFAULT_MIN_SIZE, ...manifest.minSize };

    const params = options.params ?? {};
    // A window belongs to one host for its whole life. Deciding it here, once,
    // is what keeps every other part of this free of host plumbing.
    const host = options.host ?? LOCAL_HOST_ID;

    const win = new DesktopWindow(
      {
        id,
        appId,
        title: options.title ?? manifest.name,
        icon: manifest.icon,
        bounds: { ...this.nextPosition(size), ...size, ...options.bounds },
        minSize,
        resizable: manifest.resizable !== false,
        host,
        // An explicit state wins, so a restored window is not forced back to
        // maximized by the manifest's default.
        startMaximized: options.state ? options.state === 'maximized' : manifest.startMaximized,
      },
      this,
    );

    const entry: Entry = { window: win, manifest, instance: null, params, closing: false, host };
    this.entries.set(id, entry);
    this.layer.appendChild(win.element);
    this.stack.push(win);
    this.restack();
    this.setFocus(win);
    this.events.emit('opened', win);

    try {
      const instance = await manifest.mount({
        window: win,
        root: win.content,
        desktop: this.getDesktop(host),
        params,
      });
      // The user may have closed the window while `mount` was still running.
      if (!this.entries.has(id)) {
        instance.destroy?.();
        return null;
      }
      entry.instance = instance;
      if (instance.menu) win.setMenu(instance.menu);

      win.on('resize', (size) => instance.onResize?.(size));
      win.on('focus', () => instance.onFocus?.());
      win.on('blur', () => instance.onBlur?.());

      // Mounting happened after the window was focused, so deliver it now.
      if (win.focused) instance.onFocus?.();
    } catch (err) {
      console.error(`App "${appId}" failed to start:`, err);
      this.showMountError(win, manifest, err);
    }

    // Applied after mount so the app has laid itself out at a real size first.
    if (options.state === 'minimized') win.minimize();

    return win;
  }

  private showMountError(win: DesktopWindow, manifest: AppManifest, err: unknown): void {
    win.content.replaceChildren(
      h(
        'div',
        { class: 'app-error' },
        h('div', { class: 'app-error-icon', text: '⚠' }),
        h('h2', { text: `${manifest.name} could not start` }),
        h('pre', { text: err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err) }),
      ),
    );
  }

  /* -------------------------------------------------------------- */
  /* WindowHost                                                      */
  /* -------------------------------------------------------------- */

  requestFocus(win: DesktopWindow): void {
    this.setFocus(win);
  }

  requestClose(win: DesktopWindow): void {
    void this.close(win);
  }

  workArea(): Rect {
    return this.getWorkArea();
  }

  notifyState(win: DesktopWindow): void {
    if (win.state === 'minimized' && this.focusedWindow === win) {
      this.setFocus(this.topmostVisible());
    }
    this.events.emit('state', win);
  }

  /* -------------------------------------------------------------- */
  /* Queries and operations                                          */
  /* -------------------------------------------------------------- */

  /** Bottom-to-top stacking order. */
  all(): DesktopWindow[] {
    return [...this.stack];
  }

  byApp(appId: string): DesktopWindow[] {
    return this.stack.filter((w) => w.appId === appId);
  }

  focused(): DesktopWindow | null {
    return this.focusedWindow;
  }

  minimizeAll(): void {
    for (const win of this.stack) win.minimize();
  }

  /** Cycles focus through non-minimized windows, like Alt+Tab. */
  cycleFocus(direction: 1 | -1 = 1): void {
    const visible = this.stack.filter((w) => w.state !== 'minimized');
    if (visible.length < 2) return;
    const currentIndex = this.focusedWindow ? visible.indexOf(this.focusedWindow) : -1;
    const next = (currentIndex + direction + visible.length) % visible.length;
    this.setFocus(visible[next]);
  }

  async close(win: DesktopWindow): Promise<void> {
    const entry = this.entries.get(win.id);
    if (!entry || entry.closing) return;
    entry.closing = true;

    try {
      const allowed = await entry.instance?.onClose?.();
      if (allowed === false) {
        entry.closing = false;
        return;
      }
    } catch (err) {
      // A throwing veto handler must not leave the window unclosable.
      console.error(`onClose for "${entry.manifest.id}" threw:`, err);
    }

    try {
      entry.instance?.destroy?.();
    } catch (err) {
      console.error(`destroy for "${entry.manifest.id}" threw:`, err);
    }

    this.entries.delete(win.id);
    this.stack = this.stack.filter((w) => w !== win);
    win.destroy();

    if (this.focusedWindow === win) this.setFocus(this.topmostVisible());
    this.restack();
    this.events.emit('closed', win);
  }

  closeAll(): void {
    for (const entry of [...this.entries.values()]) void this.close(entry.window);
  }

  /* -------------------------------------------------------------- */
  /* Session persistence                                             */
  /* -------------------------------------------------------------- */

  /** Snapshots every restorable window, bottom of the stack first. */
  serialize(): WindowRecord[] {
    const records: WindowRecord[] = [];

    for (const win of this.stack) {
      const entry = this.entries.get(win.id);
      if (!entry || entry.manifest.restorable === false) continue;

      // Fall back to the launch params when the app offers nothing better, so
      // an app without `saveState` still reopens roughly where it was.
      let params = entry.params;
      try {
        params = entry.instance?.saveState?.() ?? params;
      } catch (err) {
        console.error(`saveState for "${entry.manifest.id}" threw:`, err);
      }

      const snapshot = win.snapshot();
      records.push({
        appId: win.appId,
        host: entry.host,
        params,
        bounds: snapshot.bounds,
        state: snapshot.state,
        title: snapshot.title,
        focused: win.focused,
      });
    }

    return records;
  }

  /**
   * Reopens saved windows in order, so stacking survives. Returns how many
   * actually came back — apps that are no longer registered are skipped.
   */
  async restoreSession(records: WindowRecord[]): Promise<number> {
    let restored = 0;
    let focusTarget: DesktopWindow | null = null;

    for (const record of records) {
      if (!this.registry.get(record.appId)) continue;

      const win = await this.launch(record.appId, {
        host: record.host,
        params: record.params,
        bounds: record.bounds,
        title: record.title,
        state: record.state,
      });
      if (!win) continue;

      restored++;
      if (record.focused) focusTarget = win as DesktopWindow;
    }

    // Each launch stole focus; hand it back to whoever had it.
    focusTarget?.focus();
    return restored;
  }

  /* -------------------------------------------------------------- */
  /* Stacking                                                        */
  /* -------------------------------------------------------------- */

  private setFocus(win: DesktopWindow | null): void {
    if (win && win.state === 'minimized') win.restore();
    if (this.focusedWindow === win) return;

    this.focusedWindow?.setFocused(false);
    this.focusedWindow = win;

    if (win) {
      // Raise to the top of the stack, then re-derive every z-index from it.
      this.stack = this.stack.filter((w) => w !== win);
      this.stack.push(win);
      win.setFocused(true);
      this.restack();
    }
    this.events.emit('focused', win);
  }

  private topmostVisible(): DesktopWindow | null {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].state !== 'minimized') return this.stack[i];
    }
    return null;
  }

  private restack(): void {
    this.stack.forEach((win, index) => win.setZIndex(BASE_Z_INDEX + index));
  }

  /** Cascades new windows so they do not land exactly on top of each other. */
  private nextPosition(size: { width: number; height: number }): { x: number; y: number } {
    const area = this.getWorkArea();
    const step = (this.sequence - 1) % CASCADE_POSITIONS;
    const baseX = area.x + Math.max(0, (area.width - size.width) / 2);
    const baseY = area.y + Math.max(0, (area.height - size.height) / 3);
    const offset = step * CASCADE_STEP_PX - (CASCADE_POSITIONS * CASCADE_STEP_PX) / 2;

    return {
      x: Math.max(area.x, Math.min(baseX + offset, area.x + area.width - size.width)),
      y: Math.max(area.y, Math.min(baseY + offset, area.y + area.height - size.height)),
    };
  }
}
