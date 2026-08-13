import { h, iconEl, listen } from '../core/dom';
import { Disposers, Emitter } from '../core/events';
import type { MenuItem, Rect, Size, WindowEvents, WindowHandle, WindowState } from '../core/types';
import { closeAllMenus, isMenuAction, openMenu } from './menu';

/** What the window needs from whoever manages it. */
export interface WindowHost {
  /** Raise this window and give it focus. */
  requestFocus(win: DesktopWindow): void;
  /** Remove it from the desktop entirely. */
  requestClose(win: DesktopWindow): void;
  /** Bounds available for windows, excluding the taskbar. */
  workArea(): Rect;
  notifyState(win: DesktopWindow): void;
}

export interface WindowOptions {
  id: string;
  appId: string;
  title: string;
  icon: string;
  bounds: Rect;
  minSize: Size;
  resizable: boolean;
  startMaximized?: boolean;
  /** Which server the app runs on. Shown as a badge when there is a choice. */
  host?: string;
}

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** How close to an edge a drag must end to snap, in pixels. */
const SNAP_THRESHOLD_PX = 12;
/** Keep at least this much titlebar reachable when dragging off-screen. */
const KEEP_VISIBLE_PX = 48;

export class DesktopWindow implements WindowHandle {
  readonly id: string;
  readonly appId: string;
  readonly element: HTMLElement;
  readonly content: HTMLElement;
  readonly events = new Emitter<WindowEvents>();

  state: WindowState = 'normal';
  focused = false;

  private titleEl: HTMLElement;
  private hostEl: HTMLElement;
  /** Which server this window's app runs on; fixed for its life. */
  readonly hostId: string;
  private iconEl: HTMLElement;
  private menuButton: HTMLElement;
  /** The app's menus, as given; opened from the ☰ button. */
  private menuItems: MenuItem[] = [];
  private statusEl: HTMLElement;
  private snapPreview: HTMLElement | null = null;
  private disposers = new Disposers();
  private bounds: Rect;
  /** Geometry to return to when un-maximizing. */
  private restoreBounds: Rect;
  private minSize: Size;
  private resizable: boolean;
  private destroyed = false;

  constructor(options: WindowOptions, private host: WindowHost) {
    this.id = options.id;
    this.appId = options.appId;
    this.hostId = options.host ?? 'local';
    this.minSize = options.minSize;
    this.resizable = options.resizable;
    // Clamp up front: restored geometry may come from a larger viewport.
    this.bounds = this.clampToWorkArea({ ...options.bounds });
    this.restoreBounds = { ...this.bounds };

    this.iconEl = iconEl(options.icon, 'window-icon');
    this.titleEl = h('span', { class: 'window-title', text: options.title });
    // Empty until the shell says otherwise: with one server there is nothing to
    // disambiguate, and a badge saying "this server" on every window is noise.
    this.hostEl = h('span', { class: 'window-host', attrs: { hidden: 'true' } });
    this.menuButton = this.controlButton('window-menu', '☰', 'Menu', () => this.openAppMenu());
    this.menuButton.hidden = true;
    this.statusEl = h('div', { class: 'window-status', attrs: { hidden: true } });
    this.content = h('div', { class: 'window-content' });

    // The menus live behind one button in the window controls, rather than in
    // a row of their own. That row cost 25px of every window, and a native
    // application was the worst case: its own titlebar is inside its buffer,
    // so the shell's title, the shell's menus and the application's own header
    // stacked into three bands before any content. Nothing is lost — the same
    // items, one press away, in the cluster where window affordances already
    // are.
    const titlebar = h(
      'div',
      { class: 'window-titlebar' },
      this.iconEl,
      this.titleEl,
      this.hostEl,
      // Takes the slack so the controls stay right whatever the title does.
      h('div', { class: 'window-spacer' }),
      h(
        'div',
        { class: 'window-controls' },
        this.menuButton,
        this.controlButton('minimize', '−', 'Minimize', () => this.minimize()),
        this.resizable
          ? this.controlButton('maximize', '□', 'Maximize', () => this.toggleMaximize())
          : null,
        this.controlButton('close', '✕', 'Close', () => this.close()),
      ),
    );

    this.element = h(
      'div',
      {
        class: 'window',
        attrs: { 'data-window-id': this.id, 'data-state': 'normal', role: 'dialog', tabindex: '-1' },
      },
      titlebar,
      this.content,
      this.statusEl,
    );

    if (this.resizable) {
      for (const edge of RESIZE_EDGES) {
        this.element.appendChild(
          h('div', { class: `window-resize window-resize-${edge}`, dataset: { edge } }),
        );
      }
    }

    this.applyBounds();
    this.wireInteractions(titlebar);

    if (options.startMaximized) {
      // Deferred so `restoreBounds` keeps the sensible size it was given.
      queueMicrotask(() => this.maximize());
    }
  }

  private controlButton(
    kind: string,
    glyph: string,
    label: string,
    onClick: () => void,
  ): HTMLElement {
    return h('button', {
      class: kind,
      text: glyph,
      title: label,
      attrs: { 'aria-label': label },
      on: {
        click: (ev: MouseEvent) => {
          // Otherwise the titlebar's dblclick-to-maximize also fires.
          ev.stopPropagation();
          onClick();
        },
        dblclick: (ev: MouseEvent) => ev.stopPropagation(),
      },
    });
  }

  /* -------------------------------------------------------------- */
  /* Public handle API                                               */
  /* -------------------------------------------------------------- */

  setTitle(title: string): void {
    this.titleEl.textContent = title;
    this.titleEl.title = title;
  }

  setIcon(icon: string): void {
    const replacement = iconEl(icon, 'window-icon');
    this.iconEl.replaceWith(replacement);
    this.iconEl = replacement;
  }

  setMenu(items: MenuItem[]): void {
    this.menuItems = items.filter(isMenuAction);
    this.menuButton.hidden = this.menuItems.length === 0;
  }

  /**
   * Everything the application offers, from the ☰ button.
   *
   * An application with several menus (Shell, Edit, View) gets them as
   * submenus. One with a single menu is flattened into its own items instead:
   * the button already says "this window's menu", so a lone "Application ›"
   * inside it would be a level of nesting that names itself twice.
   */
  private openAppMenu(): void {
    if (this.menuItems.length === 0) return;
    const only = this.menuItems.length === 1 ? this.menuItems[0] : null;
    const submenu = only && isMenuAction(only)
      ? typeof only.submenu === 'function' ? only.submenu() : only.submenu
      : null;
    const items = submenu?.length ? submenu : this.menuItems;

    this.menuButton.classList.add('is-open');
    openMenu(items, {
      x: 0,
      y: 0,
      align: 'below',
      anchor: this.menuButton,
      minWidth: 200,
      onClose: () => this.menuButton.classList.remove('is-open'),
    });
  }

  /**
   * Names the server in the titlebar. Called with null when there is only one
   * host, because then the answer is never in doubt and the badge is clutter.
   */
  setHostLabel(label: string | null): void {
    if (!label) {
      this.hostEl.hidden = true;
      this.hostEl.textContent = '';
      return;
    }
    this.hostEl.hidden = false;
    this.hostEl.textContent = label;
  }

  setStatus(text: string | null): void {
    if (text === null) {
      this.statusEl.hidden = true;
      this.statusEl.textContent = '';
      return;
    }
    this.statusEl.hidden = false;
    this.statusEl.textContent = text;
  }

  focus(): void {
    this.host.requestFocus(this);
  }

  close(): void {
    this.host.requestClose(this);
  }

  minimize(): void {
    if (this.state === 'minimized') return;
    if (this.state === 'normal') this.restoreBounds = { ...this.bounds };
    this.setState('minimized');
  }

  maximize(): void {
    if (!this.resizable || this.state === 'maximized') return;
    if (this.state === 'normal') this.restoreBounds = { ...this.bounds };
    this.setState('maximized');
    this.bounds = { ...this.host.workArea() };
    this.applyBounds();
  }

  restore(): void {
    if (this.state === 'normal') return;

    // A window minimized while maximized returns to maximized. This cannot go
    // through maximize(), which would capture the current full-screen bounds
    // as the restore geometry and lose the real one.
    if (this.state === 'minimized' && this.wasMaximizedBeforeMinimize) {
      this.wasMaximizedBeforeMinimize = false;
      this.setState('maximized');
      this.bounds = { ...this.host.workArea() };
      this.applyBounds();
      return;
    }

    this.wasMaximizedBeforeMinimize = false;
    this.setState('normal');
    this.bounds = this.clampToWorkArea(this.restoreBounds);
    this.applyBounds();
  }

  toggleMaximize(): void {
    if (this.state === 'maximized') this.restore();
    else this.maximize();
  }

  setBounds(next: Partial<Rect>): void {
    this.bounds = this.clampToWorkArea({ ...this.bounds, ...next });
    if (this.state === 'maximized') this.setState('normal');
    this.applyBounds();
  }

  getBounds(): Rect {
    return { ...this.bounds };
  }

  on<K extends keyof WindowEvents>(
    event: K,
    fn: (payload: WindowEvents[K]) => void,
  ): () => void {
    return this.events.on(event, fn);
  }

  /* -------------------------------------------------------------- */
  /* Manager-facing internals                                        */
  /* -------------------------------------------------------------- */

  private wasMaximizedBeforeMinimize = false;

  /** @internal */
  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.element.classList.toggle('is-focused', focused);
    this.events.emit(focused ? 'focus' : 'blur', undefined);
  }

  /**
   * @internal Geometry and state for persistence.
   *
   * Reports the *normal* geometry even when maximized or minimized, so a
   * restored window un-maximizes to where the user last had it rather than to
   * a full-screen rectangle.
   */
  snapshot(): { bounds: Rect; state: WindowState; title: string } {
    return {
      bounds: { ...(this.state === 'normal' ? this.bounds : this.restoreBounds) },
      state: this.state,
      title: this.titleEl.textContent ?? '',
    };
  }

  /** @internal */
  setZIndex(z: number): void {
    this.element.style.zIndex = String(z);
  }

  /** @internal Re-clamp after the viewport or taskbar changed. */
  reflow(): void {
    if (this.state === 'maximized') {
      this.bounds = { ...this.host.workArea() };
    } else {
      this.bounds = this.clampToWorkArea(this.bounds);
    }
    this.applyBounds();
  }

  /** @internal */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearSnapPreview();
    this.disposers.dispose();
    this.events.emit('close', undefined);
    this.events.clear();
    this.element.remove();
  }

  /* -------------------------------------------------------------- */
  /* Geometry                                                        */
  /* -------------------------------------------------------------- */

  private setState(state: WindowState): void {
    if (this.state === state) return;
    if (state === 'minimized') this.wasMaximizedBeforeMinimize = this.state === 'maximized';
    this.state = state;
    this.element.dataset.state = state;
    this.element.classList.toggle('is-minimized', state === 'minimized');
    this.element.classList.toggle('is-maximized', state === 'maximized');
    this.events.emit('state', state);
    this.host.notifyState(this);
  }

  private applyBounds(): void {
    const { x, y, width, height } = this.bounds;
    this.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.element.style.width = `${Math.round(width)}px`;
    this.element.style.height = `${Math.round(height)}px`;
  }

  private clampToWorkArea(rect: Rect): Rect {
    const area = this.host.workArea();
    const width = Math.max(this.minSize.width, Math.min(rect.width, area.width));
    const height = Math.max(this.minSize.height, Math.min(rect.height, area.height));
    return {
      width,
      height,
      // Never let the titlebar leave the work area entirely.
      x: Math.min(Math.max(rect.x, area.x - width + KEEP_VISIBLE_PX), area.x + area.width - KEEP_VISIBLE_PX),
      y: Math.min(Math.max(rect.y, area.y), area.y + area.height - KEEP_VISIBLE_PX),
    };
  }

  /* -------------------------------------------------------------- */
  /* Pointer interaction                                             */
  /* -------------------------------------------------------------- */

  private wireInteractions(titlebar: HTMLElement): void {
    // Focus on any press inside the window, before the app sees the event.
    this.disposers.add(
      listen(this.element, 'pointerdown', () => this.host.requestFocus(this), true),
    );

    // The buttons sit on a drag surface, so pressing one must not also start a
    // drag, and double-clicking one must not maximize.
    const isChrome = (ev: Event) =>
      Boolean((ev.target as HTMLElement).closest('.window-controls'));

    this.disposers.add(
      listen(titlebar, 'pointerdown', (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        if (isChrome(ev)) return;
        this.beginDrag(ev, titlebar);
      }),
    );

    this.disposers.add(
      listen(titlebar, 'dblclick', (ev: MouseEvent) => {
        if (isChrome(ev)) return;
        this.toggleMaximize();
      }),
    );

    this.disposers.add(
      listen(titlebar, 'contextmenu', (ev: MouseEvent) => {
        ev.preventDefault();
        this.openSystemMenu(ev.clientX, ev.clientY);
      }),
    );

    if (this.resizable) {
      this.disposers.add(
        listen(this.element, 'pointerdown', (ev: PointerEvent) => {
          const handle = (ev.target as HTMLElement).closest<HTMLElement>('.window-resize');
          if (!handle || ev.button !== 0) return;
          this.beginResize(ev, handle.dataset.edge as ResizeEdge);
        }),
      );
    }

    // Tell the app whenever its content box changes, however it changed.
    const observer = new ResizeObserver(() => {
      this.events.emit('resize', {
        width: this.content.clientWidth,
        height: this.content.clientHeight,
      });
    });
    observer.observe(this.content);
    this.disposers.add(() => observer.disconnect());
  }

  private beginDrag(ev: PointerEvent, titlebar: HTMLElement): void {
    closeAllMenus();
    const area = this.host.workArea();

    // Dragging a maximized window restores it under the cursor, keeping the
    // grab point at the same relative position along the titlebar.
    if (this.state === 'maximized') {
      const ratio = (ev.clientX - this.bounds.x) / this.bounds.width;
      this.restore();
      this.bounds.x = ev.clientX - this.bounds.width * ratio;
      this.bounds.y = Math.max(area.y, ev.clientY - 16);
      this.applyBounds();
    }

    const offsetX = ev.clientX - this.bounds.x;
    const offsetY = ev.clientY - this.bounds.y;
    let snapTarget: Rect | null = null;

    titlebar.setPointerCapture(ev.pointerId);
    this.element.classList.add('is-dragging');

    const onMove = (move: PointerEvent) => {
      this.bounds = this.clampToWorkArea({
        ...this.bounds,
        x: move.clientX - offsetX,
        y: move.clientY - offsetY,
      });
      this.applyBounds();

      snapTarget = this.resizable ? this.snapTargetFor(move.clientX, move.clientY, area) : null;
      this.showSnapPreview(snapTarget);
      this.events.emit('move', { x: this.bounds.x, y: this.bounds.y });
    };

    const onUp = () => {
      cleanup();
      this.element.classList.remove('is-dragging');
      this.clearSnapPreview();
      if (snapTarget) {
        if (snapTarget.width === area.width && snapTarget.height === area.height) {
          this.maximize();
        } else {
          this.bounds = snapTarget;
          this.applyBounds();
        }
      }
    };

    const cleanup = this.capturePointer(titlebar, ev.pointerId, onMove, onUp);
  }

  private beginResize(ev: PointerEvent, edge: ResizeEdge): void {
    ev.preventDefault();
    ev.stopPropagation();
    closeAllMenus();
    if (this.state === 'maximized') this.restore();

    const start = { ...this.bounds };
    const startX = ev.clientX;
    const startY = ev.clientY;
    const area = this.host.workArea();

    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    this.element.classList.add('is-resizing');

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      let { x, y, width, height } = start;

      if (edge.includes('e')) width = start.width + dx;
      if (edge.includes('s')) height = start.height + dy;
      if (edge.includes('w')) {
        // Growing leftwards moves the origin, so clamp against min width here.
        const proposed = Math.max(this.minSize.width, start.width - dx);
        x = start.x + (start.width - proposed);
        width = proposed;
      }
      if (edge.includes('n')) {
        const proposed = Math.max(this.minSize.height, start.height - dy);
        y = start.y + (start.height - proposed);
        height = proposed;
      }

      this.bounds = {
        x: Math.max(area.x, x),
        y: Math.max(area.y, y),
        width: Math.max(this.minSize.width, Math.min(width, area.x + area.width - x)),
        height: Math.max(this.minSize.height, Math.min(height, area.y + area.height - y)),
      };
      this.applyBounds();
    };

    const onUp = () => {
      cleanup();
      this.element.classList.remove('is-resizing');
      this.restoreBounds = { ...this.bounds };
    };

    const cleanup = this.capturePointer(target, ev.pointerId, onMove, onUp);
  }

  /** Wires move/up/cancel for a captured pointer and returns the teardown. */
  private capturePointer(
    target: HTMLElement,
    pointerId: number,
    onMove: (ev: PointerEvent) => void,
    onUp: () => void,
  ): () => void {
    const offMove = listen(target, 'pointermove', onMove);
    const offUp = listen(target, 'pointerup', onUp);
    const offCancel = listen(target, 'pointercancel', onUp);

    return () => {
      offMove();
      offUp();
      offCancel();
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // The pointer may already be released; nothing to undo.
      }
    };
  }

  /** Which half/full-screen region the cursor is hovering, if any. */
  private snapTargetFor(clientX: number, clientY: number, area: Rect): Rect | null {
    if (clientY <= area.y + SNAP_THRESHOLD_PX) return { ...area };
    if (clientX <= area.x + SNAP_THRESHOLD_PX) {
      return { x: area.x, y: area.y, width: Math.round(area.width / 2), height: area.height };
    }
    if (clientX >= area.x + area.width - SNAP_THRESHOLD_PX) {
      const width = Math.round(area.width / 2);
      return { x: area.x + area.width - width, y: area.y, width, height: area.height };
    }
    return null;
  }

  private showSnapPreview(rect: Rect | null): void {
    if (!rect) {
      this.clearSnapPreview();
      return;
    }
    if (!this.snapPreview) {
      this.snapPreview = h('div', { class: 'snap-preview' });
      this.element.parentElement?.appendChild(this.snapPreview);
    }
    Object.assign(this.snapPreview.style, {
      transform: `translate(${rect.x}px, ${rect.y}px)`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  private clearSnapPreview(): void {
    this.snapPreview?.remove();
    this.snapPreview = null;
  }

  private openSystemMenu(x: number, y: number): void {
    openMenu(
      [
        { label: 'Restore', disabled: this.state === 'normal', onSelect: () => this.restore() },
        { label: 'Minimize', onSelect: () => this.minimize() },
        {
          label: 'Maximize',
          disabled: !this.resizable || this.state === 'maximized',
          onSelect: () => this.maximize(),
        },
        { type: 'separator' },
        { label: 'Close', accelerator: 'Alt+F4', danger: true, onSelect: () => this.close() },
      ],
      { x, y, minWidth: 160 },
    );
  }
}
