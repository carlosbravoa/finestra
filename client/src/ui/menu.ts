import { h, iconEl, listen } from '../core/dom';
import type { MenuAction, MenuItem } from '../core/types';

/** Narrows a menu entry to a selectable row, excluding separators and headers. */
export function isMenuAction(item: MenuItem): item is MenuAction {
  return !('type' in item) || item.type === 'action';
}

export interface MenuOptions {
  /** Viewport coordinates the menu should appear at. */
  x: number;
  y: number;
  /**
   * `point` opens at (x, y) — a context menu.
   * `below` opens under the anchor, aligned to its left edge — a menu bar.
   * `above` opens over the anchor — the taskbar launcher.
   */
  align?: 'point' | 'below' | 'above';
  /** Used by `below`/`above` to align and size the panel. */
  anchor?: HTMLElement;
  minWidth?: number;
  onClose?(): void;
}

export interface MenuController {
  close(): void;
  readonly element: HTMLElement;
}

/** Only one menu tree is open at a time; opening another dismisses it. */
let current: MenuRoot | null = null;

export function openMenu(items: MenuItem[], options: MenuOptions): MenuController {
  closeAllMenus();
  const root = new MenuRoot(items, options);
  current = root;
  return root;
}

export function closeAllMenus(): void {
  current?.close();
  current = null;
}

export function isMenuOpen(): boolean {
  return current !== null;
}

const SUBMENU_OPEN_DELAY_MS = 120;

class MenuRoot implements MenuController {
  private overlay: HTMLElement;
  private panels: Panel[] = [];
  private cleanup: Array<() => void> = [];
  private closed = false;

  constructor(items: MenuItem[], private options: MenuOptions) {
    // A full-viewport overlay both catches dismissal clicks and stops them
    // reaching whatever is underneath.
    this.overlay = h('div', { class: 'menu-overlay' });
    document.body.appendChild(this.overlay);

    this.cleanup.push(
      listen(this.overlay, 'pointerdown', (ev: PointerEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.close();
      }),
      listen(this.overlay, 'contextmenu', (ev: Event) => {
        ev.preventDefault();
        this.close();
      }),
      listen(window, 'keydown', (ev: KeyboardEvent) => this.onKeyDown(ev), true),
      listen(window, 'blur', () => this.close()),
      listen(window, 'resize', () => this.close()),
    );

    this.pushPanel(items, null);
  }

  get element(): HTMLElement {
    return this.panels[0]?.el ?? this.overlay;
  }

  /** Adds a panel; `parent` is the row that spawned it, for submenus. */
  private pushPanel(items: MenuItem[], parent: PanelParent | null): Panel {
    const panel = new Panel(items, this, this.options.minWidth ?? 0);
    this.overlay.appendChild(panel.el);

    if (!parent) this.positionRoot(panel);
    else this.positionSubmenu(panel, parent.rowEl);

    this.panels.push(panel);
    return panel;
  }

  private positionRoot(panel: Panel): void {
    const { x, y, align = 'point', anchor } = this.options;
    const size = panel.el.getBoundingClientRect();
    const margin = 6;

    let left = x;
    let top = y;

    if (anchor && (align === 'below' || align === 'above')) {
      const a = anchor.getBoundingClientRect();
      left = a.left;
      top = align === 'below' ? a.bottom + 2 : a.top - size.height - 2;
      panel.el.style.minWidth = `${Math.max(a.width, this.options.minWidth ?? 0)}px`;
    }

    // Flip or clamp so the panel always lands fully on screen.
    if (left + size.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - size.width - margin);
    }
    if (top + size.height > window.innerHeight - margin) {
      top = Math.max(margin, y - size.height);
    }
    panel.el.style.left = `${Math.max(margin, left)}px`;
    panel.el.style.top = `${Math.max(margin, top)}px`;
  }

  private positionSubmenu(panel: Panel, rowEl: HTMLElement): void {
    const row = rowEl.getBoundingClientRect();
    const size = panel.el.getBoundingClientRect();
    const margin = 6;

    // Prefer the right of the parent row; fall back to its left when tight.
    let left = row.right - 2;
    if (left + size.width > window.innerWidth - margin) {
      left = Math.max(margin, row.left - size.width + 2);
    }
    let top = row.top - 4;
    if (top + size.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - size.height - margin);
    }
    panel.el.style.left = `${left}px`;
    panel.el.style.top = `${top}px`;
  }

  /** @internal Opens `items` as a child of `row`, replacing any deeper panels. */
  openSubmenu(row: PanelParent, items: MenuItem[]): void {
    this.closeBelow(row.panel);
    if (items.length === 0) return;
    this.pushPanel(items, row);
  }

  /** @internal Drops every panel deeper than `panel`. */
  closeBelow(panel: Panel): void {
    const index = this.panels.indexOf(panel);
    if (index < 0) return;
    for (const removed of this.panels.splice(index + 1)) removed.destroy();
  }

  /** @internal */
  get deepest(): Panel | undefined {
    return this.panels[this.panels.length - 1];
  }

  /** @internal Called when an action runs. */
  select(action: () => void): void {
    this.close();
    // Run after teardown so the handler can open another menu.
    queueMicrotask(action);
  }

  private onKeyDown(ev: KeyboardEvent): void {
    const panel = this.deepest;
    if (!panel) return;

    switch (ev.key) {
      case 'Escape':
        ev.preventDefault();
        ev.stopPropagation();
        if (this.panels.length > 1) {
          const parent = this.panels[this.panels.length - 2];
          this.closeBelow(parent);
          parent.focusCurrent();
        } else {
          this.close();
        }
        break;
      case 'ArrowDown':
        ev.preventDefault();
        panel.move(1);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        panel.move(-1);
        break;
      case 'ArrowRight':
        ev.preventDefault();
        panel.expandCurrent();
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        if (this.panels.length > 1) {
          const parent = this.panels[this.panels.length - 2];
          this.closeBelow(parent);
          parent.focusCurrent();
        }
        break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        panel.activateCurrent();
        break;
      case 'Home':
        ev.preventDefault();
        panel.moveTo(0);
        break;
      case 'End':
        ev.preventDefault();
        panel.moveTo(-1);
        break;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.cleanup) fn();
    for (const panel of this.panels) panel.destroy();
    this.panels = [];
    this.overlay.remove();
    if (current === this) current = null;
    this.options.onClose?.();
  }
}

interface PanelParent {
  panel: Panel;
  rowEl: HTMLElement;
}

interface Row {
  el: HTMLElement;
  item: import('../core/types').MenuAction;
}

class Panel {
  readonly el: HTMLElement;
  private rows: Row[] = [];
  private index = -1;
  private hoverTimer: number | null = null;

  constructor(items: MenuItem[], private root: MenuRoot, minWidth: number) {
    this.el = h('div', {
      class: 'menu-panel',
      attrs: { role: 'menu', tabindex: '-1' },
      style: minWidth ? { minWidth: `${minWidth}px` } : undefined,
      on: {
        // Keep dismissal clicks on the overlay from firing for panel clicks.
        pointerdown: (ev: PointerEvent) => ev.stopPropagation(),
        contextmenu: (ev: Event) => ev.preventDefault(),
      },
    });

    for (const item of items) this.el.appendChild(this.renderItem(item));
  }

  private renderItem(item: MenuItem): HTMLElement {
    if ('type' in item && item.type === 'separator') {
      return h('div', { class: 'menu-separator', attrs: { role: 'separator' } });
    }
    if ('type' in item && item.type === 'header') {
      return h('div', { class: 'menu-header', text: item.label });
    }

    const action = item as import('../core/types').MenuAction;
    const submenu = resolveSubmenu(action);

    const row = h('div', {
      class: [
        'menu-item',
        action.disabled ? 'is-disabled' : '',
        action.danger ? 'is-danger' : '',
        action.checked ? 'is-checked' : '',
        submenu ? 'has-submenu' : '',
      ]
        .filter(Boolean)
        .join(' '),
      attrs: {
        role: 'menuitem',
        'aria-disabled': action.disabled ? 'true' : null,
      },
    });

    row.appendChild(
      action.icon
        ? iconEl(action.icon, 'menu-item-icon')
        : h('span', { class: 'menu-item-icon', text: action.checked ? '✓' : '' }),
    );
    row.appendChild(h('span', { class: 'menu-item-label', text: action.label }));
    if (action.accelerator) {
      row.appendChild(h('span', { class: 'menu-item-accel', text: action.accelerator }));
    }
    if (submenu) row.appendChild(h('span', { class: 'menu-item-arrow', text: '›' }));

    if (!action.disabled) {
      const index = this.rows.length;
      this.rows.push({ el: row, item: action });

      row.addEventListener('pointerenter', () => {
        this.moveTo(index, false);
        this.scheduleSubmenu(row, action);
      });
      row.addEventListener('pointerleave', () => this.cancelSubmenuTimer());
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.activate(index);
      });
    }

    return row;
  }

  private scheduleSubmenu(rowEl: HTMLElement, action: import('../core/types').MenuAction): void {
    this.cancelSubmenuTimer();
    const submenu = resolveSubmenu(action);
    // Hovering a leaf still collapses any sibling's open submenu.
    if (!submenu) {
      this.hoverTimer = window.setTimeout(
        () => this.root.closeBelow(this),
        SUBMENU_OPEN_DELAY_MS,
      );
      return;
    }
    this.hoverTimer = window.setTimeout(() => {
      this.root.openSubmenu({ panel: this, rowEl }, submenu);
    }, SUBMENU_OPEN_DELAY_MS);
  }

  private cancelSubmenuTimer(): void {
    if (this.hoverTimer !== null) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  move(delta: number): void {
    if (this.rows.length === 0) return;
    const next = this.index < 0 && delta < 0 ? this.rows.length - 1 : this.index + delta;
    this.moveTo(((next % this.rows.length) + this.rows.length) % this.rows.length);
  }

  /** `-1` selects the last row. */
  moveTo(index: number, scroll = true): void {
    if (this.rows.length === 0) return;
    const target = index < 0 ? this.rows.length - 1 : index;
    this.rows[this.index]?.el.classList.remove('is-active');
    this.index = target;
    const row = this.rows[target];
    row.el.classList.add('is-active');
    if (scroll) row.el.scrollIntoView({ block: 'nearest' });
  }

  focusCurrent(): void {
    if (this.index >= 0) this.rows[this.index]?.el.classList.add('is-active');
  }

  expandCurrent(): void {
    const row = this.rows[this.index];
    if (!row) return;
    const submenu = resolveSubmenu(row.item);
    if (submenu) this.root.openSubmenu({ panel: this, rowEl: row.el }, submenu);
  }

  activateCurrent(): void {
    if (this.index >= 0) this.activate(this.index);
  }

  private activate(index: number): void {
    const row = this.rows[index];
    if (!row || row.item.disabled) return;

    const submenu = resolveSubmenu(row.item);
    if (submenu) {
      this.root.openSubmenu({ panel: this, rowEl: row.el }, submenu);
      return;
    }
    const handler = row.item.onSelect;
    if (handler) this.root.select(handler);
    else this.root.close();
  }

  destroy(): void {
    this.cancelSubmenuTimer();
    this.el.remove();
  }
}

/** Submenus may be a lazy function, so their contents can reflect live state. */
function resolveSubmenu(action: import('../core/types').MenuAction): MenuItem[] | null {
  if (!action.submenu) return null;
  const items = typeof action.submenu === 'function' ? action.submenu() : action.submenu;
  return items.length ? items : null;
}
