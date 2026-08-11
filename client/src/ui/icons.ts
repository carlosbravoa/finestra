import { h, iconEl, listen } from '../core/dom';
import type { AppRegistry } from '../core/registry';
import type { AppManifest, MenuItem, SettingsStore } from '../core/types';
import { openMenu } from './menu';

const CELL_WIDTH = 92;
const CELL_HEIGHT = 96;
const GRID_MARGIN = 12;
/** Movement past this many pixels turns a click into a drag. */
const DRAG_THRESHOLD_PX = 4;

interface GridPosition {
  col: number;
  row: number;
}

export interface DesktopIconsDeps {
  registry: AppRegistry;
  settings: SettingsStore;
  launch(appId: string): void;
  /** Menu shown when right-clicking empty desktop. */
  backgroundMenu(): MenuItem[];
}

/**
 * The icon surface. Icons live on a snapping grid whose layout is persisted,
 * so rearranging them survives a reload.
 */
export class DesktopIcons {
  readonly element: HTMLElement;

  private positions: Record<string, GridPosition>;
  private tiles = new Map<string, HTMLElement>();
  private selected: string | null = null;

  constructor(parent: HTMLElement, private deps: DesktopIconsDeps) {
    this.positions = deps.settings.get<Record<string, GridPosition>>('desktop.iconPositions', {});

    this.element = h('div', { class: 'desktop-icons' });
    parent.appendChild(this.element);

    this.element.addEventListener('pointerdown', (ev) => {
      if (ev.target === this.element) this.select(null);
    });

    this.element.addEventListener('contextmenu', (ev) => {
      if (ev.target !== this.element) return;
      ev.preventDefault();
      this.select(null);
      openMenu(this.deps.backgroundMenu(), { x: ev.clientX, y: ev.clientY, minWidth: 200 });
    });

    window.addEventListener('resize', () => this.layout());
    this.render();
  }

  /** Rebuilds tiles from the registry; call after apps are (un)registered. */
  render(): void {
    const apps = this.deps.registry.desktopApps();
    const wanted = new Set(apps.map((a) => a.id));

    for (const [id, tile] of this.tiles) {
      if (wanted.has(id)) continue;
      tile.remove();
      this.tiles.delete(id);
    }

    for (const app of apps) {
      if (this.tiles.has(app.id)) continue;
      const tile = this.createTile(app);
      this.tiles.set(app.id, tile);
      this.element.appendChild(tile);
    }

    this.layout();
  }

  private createTile(app: AppManifest): HTMLElement {
    const tile = h(
      'button',
      {
        class: 'desktop-icon',
        dataset: { appId: app.id },
        title: app.description ?? app.name,
      },
      iconEl(app.icon, 'desktop-icon-glyph'),
      h('span', { class: 'desktop-icon-label', text: app.name }),
    );

    tile.addEventListener('pointerdown', (ev) => this.beginDrag(ev, app.id, tile));
    tile.addEventListener('click', () => this.select(app.id));
    tile.addEventListener('dblclick', () => this.deps.launch(app.id));

    tile.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this.deps.launch(app.id);
      }
    });

    tile.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.select(app.id);
      openMenu(
        [
          { label: 'Open', icon: app.icon, onSelect: () => this.deps.launch(app.id) },
          { type: 'separator' },
          { label: 'Tidy icons', onSelect: () => this.resetPositions() },
        ],
        { x: ev.clientX, y: ev.clientY, minWidth: 180 },
      );
    });

    return tile;
  }

  private select(appId: string | null): void {
    if (this.selected === appId) return;
    if (this.selected) this.tiles.get(this.selected)?.classList.remove('is-selected');
    this.selected = appId;
    if (appId) this.tiles.get(appId)?.classList.add('is-selected');
  }

  private beginDrag(ev: PointerEvent, appId: string, tile: HTMLElement): void {
    if (ev.button !== 0) return;
    this.select(appId);

    const startX = ev.clientX;
    const startY = ev.clientY;
    const origin = tile.getBoundingClientRect();
    const surface = this.element.getBoundingClientRect();
    let dragging = false;

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;

      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        tile.setPointerCapture(ev.pointerId);
        tile.classList.add('is-dragging');
      }
      tile.style.left = `${origin.left - surface.left + dx}px`;
      tile.style.top = `${origin.top - surface.top + dy}px`;
    };

    const onUp = (up: PointerEvent) => {
      offMove();
      offUp();
      offCancel();
      if (!dragging) return;

      tile.classList.remove('is-dragging');
      try {
        tile.releasePointerCapture(ev.pointerId);
      } catch {
        // Already released.
      }

      const cell = this.nearestFreeCell(
        up.clientX - surface.left,
        up.clientY - surface.top,
        appId,
      );
      this.positions[appId] = cell;
      this.deps.settings.set('desktop.iconPositions', this.positions);
      this.layout();
    };

    const offMove = listen(tile, 'pointermove', onMove);
    const offUp = listen(tile, 'pointerup', onUp);
    const offCancel = listen(tile, 'pointercancel', onUp);
  }

  /** Snaps to the cell under (x, y), then spirals outward if it is taken. */
  private nearestFreeCell(x: number, y: number, movingAppId: string): GridPosition {
    const cols = this.columns();
    const rows = this.rows();
    const targetCol = clamp(Math.round((x - GRID_MARGIN) / CELL_WIDTH), 0, cols - 1);
    const targetRow = clamp(Math.round((y - GRID_MARGIN) / CELL_HEIGHT), 0, rows - 1);

    const taken = new Set(
      Object.entries(this.positions)
        .filter(([id]) => id !== movingAppId && this.tiles.has(id))
        .map(([, pos]) => `${pos.col},${pos.row}`),
    );

    if (!taken.has(`${targetCol},${targetRow}`)) return { col: targetCol, row: targetRow };

    for (let radius = 1; radius < Math.max(cols, rows); radius++) {
      for (let dc = -radius; dc <= radius; dc++) {
        for (let dr = -radius; dr <= radius; dr++) {
          const col = targetCol + dc;
          const row = targetRow + dr;
          if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
          if (!taken.has(`${col},${row}`)) return { col, row };
        }
      }
    }
    return { col: targetCol, row: targetRow };
  }

  /**
   * Places every tile, auto-assigning cells to any the user has not moved.
   *
   * Auto positions are recomputed on every layout rather than stored, so a
   * first pass that runs before the surface has been measured cannot leave
   * the icons permanently stacked in one row.
   */
  private layout(): void {
    const rows = this.rows();
    const taken = new Set<string>();

    // Honour saved positions first, so auto-placement fills around them.
    for (const id of this.tiles.keys()) {
      const pos = this.positions[id];
      if (pos) taken.add(`${pos.col},${pos.row}`);
    }

    let cursor = 0;
    for (const [id, tile] of this.tiles) {
      let pos = this.positions[id];
      if (!pos) {
        // Fill down each column, then across, like a conventional desktop.
        while (taken.has(`${Math.floor(cursor / rows)},${cursor % rows}`)) cursor++;
        pos = { col: Math.floor(cursor / rows), row: cursor % rows };
        taken.add(`${pos.col},${pos.row}`);
        cursor++;
      }
      tile.style.left = `${GRID_MARGIN + pos.col * CELL_WIDTH}px`;
      tile.style.top = `${GRID_MARGIN + pos.row * CELL_HEIGHT}px`;
    }
  }

  private resetPositions(): void {
    this.positions = {};
    this.deps.settings.remove('desktop.iconPositions');
    this.layout();
  }

  private columns(): number {
    return Math.max(1, Math.floor((this.element.clientWidth - GRID_MARGIN) / CELL_WIDTH));
  }

  private rows(): number {
    return Math.max(1, Math.floor((this.element.clientHeight - GRID_MARGIN) / CELL_HEIGHT));
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
