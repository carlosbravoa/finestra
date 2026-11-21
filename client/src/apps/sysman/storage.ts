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
  /** A directory whose total is not in yet. */
  pending?: boolean;
  /** A mount the scan stayed out of, by filesystem type. */
  mount?: string;
}

type ScanMessage =
  | { type: 'start'; path: string; children: number }
  | { type: 'progress'; at: string; bytes: number; entries: number }
  | ({ type: 'child' } & ChildRow)
  | { type: 'done'; bytes: number; entries: number; errors: number }
  | { type: 'stopped' };

/** What the server says about the scan a folder belongs to. */
interface ScanInfo {
  root: string;
  state: 'scanning' | 'done' | 'stopped';
  startedAt: number;
  finishedAt: number | null;
}

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
  // Keyed by path: a directory's row arrives once as a name and again when
  // its total is in.
  const rows = new Map<string, ChildRow>();
  let total = 0;
  let scanning = false;
  /** This folder's listing is whole: nothing to ask the server again. */
  let complete = false;
  let measuredAt: number | null = null;
  /** Counts folders shown, so a late message from the last one is ignored. */
  let watching = 0;
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
      render: (row) =>
        row.mount
          ? h('span', {
              class: 'sysman-du-note',
              text: row.mount,
              title: `A ${row.mount} filesystem mounted here, not space on this disk. Open it to measure it anyway.`,
            })
          : row.pending
            ? '…'
            : formatBytes(row.bytes),
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
  const rescanButton = button('Rescan', () => scan(currentPath, true), {
    title: 'Measure this folder again',
  });
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
    const children = [...rows.values()];
    total = children.reduce((sum, row) => sum + row.bytes, 0);
    totalLabel.textContent =
      `${formatBytes(total)} in ${children.length} items` +
      (complete && measuredAt
        ? ` · measured ${new Date(measuredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : '');
    stopButton.disabled = !scanning;
    rescanButton.disabled = scanning;

    progressBar.hidden = !scanning;
    if (scanning) {
      const settled = children.filter((row) => !row.pending).length;
      const pct = expected > 0 ? Math.min(100, (settled / expected) * 100) : 0;
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

  /** Stop looking. The scan itself belongs to the server and carries on. */
  function detach(): void {
    const open = channel;
    channel = null;
    // What a closed channel still has to say is about a folder left behind.
    watching++;
    open?.close();
  }

  /** Stop the scan itself. The server answers `stopped`, and what it has stays. */
  function stop(): void {
    channel?.send({ type: 'stop' });
  }

  /**
   * Show a folder. Whatever the server has already measured comes back at
   * once; `fresh` asks for it to be measured again.
   */
  function scan(path: string, fresh = false): void {
    detach();
    currentPath = path;
    rows.clear();
    total = 0;
    expected = 0;
    complete = false;
    measuredAt = null;
    scanning = true;
    progressText = 'Starting…';
    banner.hidden = true;
    table.setRows([]);
    upButton.disabled = parentOf(path) === null;
    render();

    const mine = watching;
    channel = desktop.rpc.openChannel(
      'fs',
      'scan',
      { path, fresh },
      {
        onOpen: (info) => {
          if (mine !== watching) return;
          const scanInfo = info as ScanInfo | null;
          // Asked to measure again, the time of the last answer is not this one's.
          measuredAt = fresh ? null : (scanInfo?.finishedAt ?? null);
        },
        onData: (raw) => {
          if (ctx.isDisposed() || mine !== watching) return;
          const msg = raw as ScanMessage;
          switch (msg.type) {
            case 'start':
              expected = msg.children;
              progressText = `Measuring ${msg.children} items…`;
              break;
            case 'progress':
              progressText = `${msg.at} — ${formatBytes(msg.bytes)} so far`;
              break;
            case 'child': {
              const { type, ...row } = msg;
              void type;
              rows.set(row.path, row);
              break;
            }
            case 'stopped':
              scanning = false;
              progressText = '';
              banner.hidden = false;
              banner.textContent =
                'The scan was stopped. Sizes shown as … were not measured; Rescan carries on.';
              break;
            case 'done':
              scanning = false;
              complete = true;
              measuredAt ??= Date.now();
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
          if (ctx.isDisposed() || mine !== watching) return;
          channel = null;
          const wasScanning = scanning;
          scanning = false;
          if (error) {
            banner.hidden = false;
            banner.textContent = error;
            ctx.setStatus('Scan failed');
          } else if (wasScanning) {
            // Closed without a `done`: the connection dropped. The scan
            // did not — it is the server's — so coming back picks it up.
            banner.hidden = false;
            banner.textContent =
              'Lost the connection. The scan carries on; this will catch up when it is back.';
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
      // The first visit, or a return after the connection was lost. A return
      // from another tab finds the channel still open and has nothing to do.
      if (!channel && !complete) scan(currentPath);
    },

    // No deactivate: a scan that stopped whenever the panel was left never
    // finished on a large disk. It runs on the server until it is done, and
    // the rows arriving for a hidden panel cost nothing.

    menu: () => [
      {
        label: 'Rescan',
        accelerator: 'F5',
        disabled: scanning,
        onSelect: () => scan(currentPath, true),
      },
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
      detach();
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
