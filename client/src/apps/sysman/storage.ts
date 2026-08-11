import type { Channel } from '../../core/rpc';
import { h } from '../../core/dom';
import type { MenuItem } from '../../core/types';
import {
  DataTable,
  button,
  formatBytes,
  meter,
  placeholder,
  toolbar,
  type Column,
  type Section,
  type SectionContext,
  type SectionDef,
} from './common';

/** Redraw rate while results stream in. Fast enough to feel live, slow
 *  enough that a directory of thousands does not thrash the DOM. */
const RENDER_MS = 150;

interface ChildRow {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  bytes: number;
  entries: number;
  errors: number;
}

type ScanMessage =
  | { type: 'start'; path: string; children: number }
  | { type: 'progress'; name: string; bytes: number; entries: number }
  | ({ type: 'child' } & ChildRow)
  | { type: 'done'; bytes: number; entries: number; errors: number };

interface StorageParams {
  path?: string;
}

function parentOf(path: string): string | null {
  if (path === '/') return null;
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) return null;
  return cut === 0 ? '/' : trimmed.slice(0, cut);
}

function createStorage(ctx: SectionContext, params: StorageParams): Section {
  const { desktop } = ctx;

  let channel: Channel | null = null;
  let currentPath = typeof params.path === 'string' ? params.path : '/';
  let children: ChildRow[] = [];
  let total = 0;
  let scanning = false;
  let pendingRender: number | null = null;
  let progressText = '';
  let expected = 0;

  const columns: Array<Column<ChildRow>> = [
    {
      key: 'name',
      label: 'Name',
      width: 'minmax(140px, 1.6fr)',
      render: (row) =>
        h(
          'span',
          { class: 'sysman-du-name' },
          h('span', {
            class: 'sysman-du-icon',
            text: row.kind === 'directory' ? '📁' : row.kind === 'symlink' ? '🔗' : '📄',
          }),
          h('span', { class: 'sysman-ellipsis', text: row.name, title: row.path }),
        ),
      sort: (row) => row.name,
    },
    {
      key: 'bytes',
      label: 'Size',
      cls: 'is-num',
      width: '96px',
      render: (row) => formatBytes(row.bytes),
      sort: (row) => row.bytes,
      desc: true,
    },
    {
      key: 'share',
      label: 'Share',
      width: 'minmax(70px, 0.8fr)',
      showAbove: 520,
      render: (row) => meter(total > 0 ? row.bytes / total : 0, 'ok'),
    },
    {
      key: 'entries',
      label: 'Items',
      cls: 'is-num',
      width: '80px',
      showAbove: 640,
      render: (row) => row.entries.toLocaleString(),
      sort: (row) => row.entries,
      desc: true,
    },
    {
      key: 'errors',
      label: 'Unreadable',
      cls: 'is-num',
      width: '90px',
      showAbove: 760,
      render: (row) => (row.errors > 0 ? row.errors.toLocaleString() : '—'),
      sort: (row) => row.errors,
      desc: true,
    },
  ];

  const table = new DataTable<ChildRow>({
    columns,
    key: (row) => row.path,
    onActivate: (row) => {
      if (row.kind === 'directory') scan(row.path);
    },
    onContext: (row, at) => desktop.contextMenu(rowMenu(row), at),
  });
  table.sortBy('bytes', true);

  const pathLabel = h('span', { class: 'sysman-path' });
  const upButton = button('Up', () => {
    const parent = parentOf(currentPath);
    if (parent) scan(parent);
  });
  const rescanButton = button('Rescan', () => scan(currentPath));
  const stopButton = button('Stop', () => stop(), { danger: true });
  const totalLabel = h('span', { class: 'sysman-toolbar-note' });
  const progressBar = h('div', { class: 'sysman-progress' });
  progressBar.hidden = true;

  const banner = h('div', { class: 'sysman-banner' });
  banner.hidden = true;

  const body = h('div', { class: 'sysman-du-body' }, table.element);

  const element = h(
    'div',
    { class: 'sysman-section' },
    toolbar(upButton, rescanButton, stopButton, pathLabel, totalLabel),
    progressBar,
    banner,
    body,
  );

  /* ---------------------------------------------------------------- */
  /* Scanning                                                          */
  /* ---------------------------------------------------------------- */

  function scheduleRender(): void {
    if (pendingRender !== null) return;
    pendingRender = window.setTimeout(() => {
      pendingRender = null;
      render();
    }, RENDER_MS);
  }

  function render(): void {
    if (ctx.isDisposed()) return;
    pathLabel.textContent = currentPath;
    totalLabel.textContent = `${formatBytes(total)} in ${children.length} items`;
    stopButton.disabled = !scanning;
    rescanButton.disabled = scanning;

    progressBar.hidden = !scanning;
    if (scanning) {
      const pct = expected > 0 ? Math.min(100, (children.length / expected) * 100) : 0;
      progressBar.textContent = progressText || 'Scanning…';
      progressBar.style.setProperty('--progress', `${pct}%`);
    }

    if (children.length === 0 && !scanning) {
      body.replaceChildren(placeholder('Nothing here', `${currentPath} is empty.`));
      return;
    }
    if (body.firstChild !== table.element) body.replaceChildren(table.element);
    table.setRows(children);
  }

  function stop(): void {
    if (channel) {
      channel.close();
      channel = null;
    }
    if (scanning) {
      scanning = false;
      progressText = '';
      render();
    }
  }

  function scan(path: string): void {
    stop();
    currentPath = path;
    children = [];
    total = 0;
    expected = 0;
    scanning = true;
    progressText = 'Starting…';
    banner.hidden = true;
    table.setRows([]);
    upButton.disabled = parentOf(path) === null;
    render();

    channel = desktop.rpc.openChannel(
      'fs',
      'scan',
      { path },
      {
        onData: (raw) => {
          if (ctx.isDisposed()) return;
          const msg = raw as ScanMessage;
          switch (msg.type) {
            case 'start':
              expected = msg.children;
              progressText = `Scanning ${msg.children} items…`;
              break;
            case 'progress':
              progressText = `${msg.name} — ${formatBytes(msg.bytes)} so far`;
              break;
            case 'child': {
              const { type, ...row } = msg;
              void type;
              children.push(row);
              total += row.bytes;
              break;
            }
            case 'done':
              scanning = false;
              progressText = '';
              ctx.setStatus(
                `${currentPath}: ${formatBytes(msg.bytes)} across ${msg.entries.toLocaleString()} items` +
                  (msg.errors > 0 ? ` · ${msg.errors.toLocaleString()} unreadable` : ''),
              );
              break;
          }
          scheduleRender();
        },
        onClose: (error) => {
          if (ctx.isDisposed()) return;
          channel = null;
          const wasScanning = scanning;
          scanning = false;
          if (error) {
            banner.hidden = false;
            banner.textContent = error;
            ctx.setStatus('Scan failed');
          } else if (wasScanning) {
            // Closed without a `done`: the connection dropped mid-scan.
            banner.hidden = false;
            banner.textContent = 'The scan stopped before it finished.';
          }
          render();
        },
      },
    );
  }

  function rowMenu(row: ChildRow): MenuItem[] {
    return [
      { type: 'header', label: row.name },
      {
        label: 'Scan this folder',
        disabled: row.kind !== 'directory',
        onSelect: () => scan(row.path),
      },
      {
        label: 'Open in Files',
        onSelect: () => {
          void desktop.launch('files', {
            params: { path: row.kind === 'directory' ? row.path : currentPath },
          });
        },
      },
      {
        label: 'Open terminal here',
        disabled: row.kind !== 'directory',
        onSelect: () => void desktop.launch('terminal', { params: { cwd: row.path } }),
      },
    ];
  }

  render();

  return {
    element,

    activate() {
      // A scan is expensive; start it on the first visit, not on every return.
      if (children.length === 0 && !scanning) scan(currentPath);
    },

    deactivate() {
      // A scan of / must not keep walking the disk for a panel nobody sees.
      stop();
    },

    menu: () => [
      { label: 'Rescan', accelerator: 'F5', disabled: scanning, onSelect: () => scan(currentPath) },
      { label: 'Stop scan', disabled: !scanning, onSelect: () => stop() },
      { type: 'separator' },
      { label: 'Scan /', onSelect: () => scan('/') },
      {
        label: 'Scan home',
        onSelect: () => scan(desktop.host?.home ?? '~'),
      },
      {
        label: 'Scan a path…',
        onSelect: () => {
          void desktop
            .prompt({
              title: 'Scan a directory',
              message: 'Which directory should be measured?',
              value: currentPath,
            })
            .then((value) => {
              if (value && !ctx.isDisposed()) scan(value);
            });
        },
      },
    ],

    saveState: () => ({ path: currentPath }),

    destroy() {
      stop();
      if (pendingRender !== null) window.clearTimeout(pendingRender);
      pendingRender = null;
      table.destroy();
    },
  };
}

export const storageSection: SectionDef = {
  id: 'storage',
  title: 'Disk usage',
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/>
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>
  </svg>`,
  requires: ['fs'],
  create: createStorage,
};
