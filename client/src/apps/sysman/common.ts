import { h } from '../../core/dom';
import { RpcError } from '../../core/rpc';
import type { DesktopAPI, MenuItem, Size, WindowHandle } from '../../core/types';

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

export interface SectionContext {
  desktop: DesktopAPI;
  window: WindowHandle;
  /** True once the app has been destroyed. Check after every await. */
  isDisposed(): boolean;
  /** Writes this section's line in the window's status strip. */
  setStatus(text: string | null): void;
  /** Switch to another section, handing it params — "show me this pid". */
  goto(sectionId: string, params?: Record<string, unknown>): void;
}

export interface Section {
  readonly element: HTMLElement;
  /** Params handed over by another section, after this one already exists. */
  applyParams?(params: Record<string, unknown>): void;
  /** Became visible: start polling. */
  activate?(): void;
  /** Hidden, blurred or minimized: stop polling and cancel any live work. */
  deactivate?(): void;
  resize?(size: Size): void;
  /** Contributed to the window menu while this section is showing. */
  menu?(): MenuItem[];
  saveState?(): Record<string, unknown> | undefined;
  destroy?(): void;
}

export interface SectionDef {
  id: string;
  title: string;
  icon: string;
  /** Server services this section needs; it is disabled without them. */
  requires: string[];
  create(ctx: SectionContext, params: Record<string, unknown>): Section;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(n: number, digits?: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  let value = Math.abs(n);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const places = digits ?? (unit === 0 ? 0 : value < 10 ? 1 : 0);
  return `${sign}${value.toFixed(places)} ${BYTE_UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(fraction >= 0.995 ? 0 : 1)}%`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
}

/** "in 12 days" / "3 days ago", for certificate expiry. */
export function formatUntil(epochMs: number): string {
  const deltaDays = Math.round((epochMs - Date.now()) / 86_400_000);
  if (!Number.isFinite(deltaDays)) return '—';
  const abs = Math.abs(deltaDays);
  const unit = abs === 1 ? 'day' : 'days';
  if (deltaDays < 0) return `${abs} ${unit} ago`;
  if (deltaDays === 0) return 'today';
  return `in ${deltaDays} ${unit}`;
}

export function formatDate(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '—';
  return new Date(epochMs).toLocaleString();
}

/** Turns a server error into a sentence someone can act on. */
export function describeError(err: unknown): string {
  if (err instanceof RpcError) {
    switch (err.code) {
      case 'EACCES':
      case 'EPERM':
        return err.message || 'Permission denied.';
      case 'ENOENT':
        return 'That path does not exist.';
      case 'ESRCH':
        return 'That process is no longer running.';
      case 'EOFFLINE':
        return 'Not connected to the server.';
      case 'EUNSUPPORTED':
        return err.message || 'This host does not support that.';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ */
/* Shared UI pieces                                                    */
/* ------------------------------------------------------------------ */

export function toolbar(...children: Array<Node | null>): HTMLElement {
  return h('div', { class: 'sysman-toolbar' }, ...children);
}

export function button(
  label: string,
  onClick: () => void,
  options: { danger?: boolean; title?: string } = {},
): HTMLButtonElement {
  return h('button', {
    class: `sysman-button${options.danger ? ' is-danger' : ''}`,
    text: label,
    title: options.title ?? '',
    on: { click: onClick },
  });
}

export function filterInput(placeholder: string, onInput: (value: string) => void): HTMLInputElement {
  const el = h('input', {
    class: 'sysman-filter',
    attrs: { type: 'search', placeholder, spellcheck: 'false' },
  });
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

/** A message that replaces the content: empty results, errors, missing service. */
export function placeholder(title: string, detail?: string, action?: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'sysman-placeholder' },
    h('div', { class: 'sysman-placeholder-title', text: title }),
    detail ? h('div', { class: 'sysman-placeholder-detail', text: detail }) : null,
    action ?? null,
  );
}

/** A proportion bar, used for filesystem fill and disk-usage shares. */
export function meter(fraction: number, tone?: 'ok' | 'warn' | 'danger'): HTMLElement {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const level = tone ?? (clamped >= 0.9 ? 'danger' : clamped >= 0.75 ? 'warn' : 'ok');
  return h(
    'div',
    { class: `sysman-meter tone-${level}`, attrs: { role: 'presentation' } },
    h('div', { class: 'sysman-meter-fill', style: { width: `${clamped * 100}%` } }),
  );
}

/* ------------------------------------------------------------------ */
/* Sortable tables                                                     */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  label: string;
  /** Extra classes on both the header cell and the body cells. */
  cls?: string;
  /** Column width, as a grid track. */
  width: string;
  /** Cell contents. A string becomes a text node. */
  render(row: T): Node | string;
  /** Sort key. Columns without one are not sortable. */
  sort?(row: T): number | string;
  /** Sorting this column starts descending (counts, sizes, percentages). */
  desc?: boolean;
  /**
   * Table width, in pixels, below which this column is dropped entirely.
   * Squeezing eight columns into 500px leaves every one of them an unreadable
   * sliver; dropping the least important is what a person would do. Omit for
   * columns that must always be there.
   */
  showAbove?: number;
}

export interface TableOptions<T> {
  columns: Array<Column<T>>;
  key(row: T): string;
  onSelect?(row: T | null): void;
  onActivate?(row: T): void;
  onContext?(row: T, at: { x: number; y: number }): void;
}

/**
 * A sortable, keyboard-navigable table over a CSS grid.
 *
 * Rows are rebuilt on every `setRows`; the selection is preserved by key so
 * that a refresh underneath the user does not lose their place.
 */
export class DataTable<T> {
  readonly element: HTMLElement;

  private readonly head: HTMLElement;
  private readonly body: HTMLElement;
  private observer: ResizeObserver | null;

  private rows: T[] = [];
  private sortKey: string | null = null;
  private sortDesc = false;
  private selectedKey: string | null = null;
  /** Measured width; 0 until the table is in the tree with a real size. */
  private width = 0;

  constructor(private readonly options: TableOptions<T>) {
    this.head = h('div', { class: 'sysman-thead' });
    this.body = h('div', { class: 'sysman-tbody' });
    this.element = h('div', { class: 'sysman-table' }, this.head, this.body);
    this.renderHead();

    this.body.addEventListener('keydown', (ev) => this.onKeyDown(ev));

    // Which columns fit is a function of the table's own width, not the
    // window's, so it is measured here rather than driven from onResize.
    this.observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next < 1) return;
      const before = this.columns().length;
      this.width = next;
      if (this.columns().length !== before) {
        this.renderHead();
        this.setRows(this.rows);
      }
    });
    this.observer.observe(this.element);
  }

  /** The columns that fit at the current width, in order. */
  private columns(): Array<Column<T>> {
    // Before the first measurement, show everything: a table that starts empty
    // and fills in is worse than one that settles once.
    if (this.width === 0) return this.options.columns;
    return this.options.columns.filter((c) => !c.showAbove || this.width >= c.showAbove);
  }

  private template(): string {
    return this.columns()
      .map((c) => c.width)
      .join(' ');
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  get selected(): T | null {
    if (this.selectedKey === null) return null;
    return this.rows.find((r) => this.options.key(r) === this.selectedKey) ?? null;
  }

  sortBy(key: string, desc: boolean): void {
    this.sortKey = key;
    this.sortDesc = desc;
    this.renderHead();
  }

  get sorting(): { key: string | null; desc: boolean } {
    return { key: this.sortKey, desc: this.sortDesc };
  }

  /**
   * Selecting the row that is already selected is a no-op: a refresh must not
   * re-fire `onSelect` and send the detail panel back to its loading state.
   */
  select(key: string | null): void {
    if (key === this.selectedKey) return;
    this.selectedKey = key;
    for (const el of this.body.querySelectorAll('.sysman-tr')) {
      el.classList.toggle('is-selected', (el as HTMLElement).dataset.key === key);
    }
    this.options.onSelect?.(this.selected);
  }

  setRows(rows: T[]): void {
    this.rows = this.sorted(rows);
    const frag = document.createDocumentFragment();
    const columns = this.columns();
    const template = this.template();

    for (const row of this.rows) {
      const key = this.options.key(row);
      const tr = h('div', {
        class: `sysman-tr${key === this.selectedKey ? ' is-selected' : ''}`,
        style: { gridTemplateColumns: template },
        dataset: { key },
        attrs: { tabindex: '-1' },
      });

      for (const col of columns) {
        const content = col.render(row);
        tr.appendChild(
          h(
            'div',
            { class: `sysman-td${col.cls ? ` ${col.cls}` : ''}` },
            typeof content === 'string' ? document.createTextNode(content) : content,
          ),
        );
      }

      tr.addEventListener('click', () => this.select(key));
      tr.addEventListener('dblclick', () => this.options.onActivate?.(row));
      tr.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.select(key);
        this.options.onContext?.(row, { x: ev.clientX, y: ev.clientY });
      });

      frag.appendChild(tr);
    }

    this.body.replaceChildren(frag);
    // A selection that is filtered out or gone stays remembered: the owning
    // section decides what that means, and blanking its panel mid-read is
    // rarely what was wanted.
  }

  private sorted(rows: T[]): T[] {
    const col = this.options.columns.find((c) => c.key === this.sortKey);
    if (!col?.sort) return rows.slice();
    const dir = this.sortDesc ? -1 : 1;
    return rows.slice().sort((a, b) => {
      const av = col.sort!(a);
      const bv = col.sort!(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' }) * dir;
    });
  }

  private renderHead(): void {
    this.head.style.gridTemplateColumns = this.template();
    this.head.replaceChildren(
      ...this.columns().map((col) => {
        const active = col.key === this.sortKey;
        const cell = h('div', {
          class: `sysman-th${col.cls ? ` ${col.cls}` : ''}${col.sort ? ' is-sortable' : ''}${
            active ? ' is-active' : ''
          }`,
          text: col.label,
        });
        if (active) {
          cell.appendChild(h('span', { class: 'sysman-sort', text: this.sortDesc ? ' ▾' : ' ▴' }));
        }
        if (col.sort) {
          cell.addEventListener('click', () => {
            if (this.sortKey === col.key) this.sortDesc = !this.sortDesc;
            else {
              this.sortKey = col.key;
              this.sortDesc = Boolean(col.desc);
            }
            this.renderHead();
            this.setRows(this.rows);
          });
        }
        return cell;
      }),
    );
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const index = this.rows.findIndex((r) => this.options.key(r) === this.selectedKey);
    const next = ev.key === 'ArrowDown' ? index + 1 : index - 1;
    if (next < 0 || next >= this.rows.length) return;
    const key = this.options.key(this.rows[next]);
    this.select(key);
    (this.body.querySelector(`[data-key="${CSS.escape(key)}"]`) as HTMLElement | null)?.focus();
  }
}
