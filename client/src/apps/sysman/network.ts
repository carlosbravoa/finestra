import { h } from '../../core/dom';
import type { MenuItem } from '../../core/types';
import {
  DataTable,
  describeError,
  filterInput,
  placeholder,
  toolbar,
  type Column,
  type Section,
  type SectionContext,
  type SectionDef,
} from './common';

const POLL_MS = 5000;

interface SocketRow {
  proto: 'tcp' | 'tcp6' | 'udp' | 'udp6';
  local: string;
  localPort: number;
  remote: string;
  remotePort: number;
  state: string;
  uid: number;
  inode: number;
  pid?: number;
  process?: string;
}

type View = 'listening' | 'connections';

interface NetworkParams {
  filter?: string;
  view?: string;
}

/** Wraps a bare IPv6 address in brackets, the way a URL would. */
function address(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

function createNetwork(ctx: SectionContext, params: NetworkParams): Section {
  const { desktop } = ctx;

  let timer: number | null = null;
  let running = false;
  let sockets: SocketRow[] = [];
  let filter = typeof params.filter === 'string' ? params.filter : '';
  let view: View = params.view === 'connections' ? 'connections' : 'listening';

  const columns: Array<Column<SocketRow>> = [
    {
      key: 'proto',
      label: 'Proto',
      width: '64px',
      render: (s) => s.proto,
      sort: (s) => s.proto,
    },
    {
      key: 'local',
      label: 'Local address',
      cls: 'is-mono',
      width: 'minmax(130px, 1.2fr)',
      render: (s) => h('span', { class: 'sysman-ellipsis', text: address(s.local, s.localPort) }),
      sort: (s) => s.localPort,
    },
    {
      key: 'remote',
      label: 'Peer',
      cls: 'is-mono',
      width: 'minmax(130px, 1.2fr)',
      showAbove: 700,
      render: (s) =>
        h('span', {
          class: 'sysman-ellipsis',
          text: s.remotePort === 0 ? '—' : address(s.remote, s.remotePort),
        }),
      sort: (s) => s.remote,
    },
    {
      key: 'state',
      label: 'State',
      width: 'minmax(90px, 0.6fr)',
      showAbove: 560,
      render: (s) => s.state,
      sort: (s) => s.state,
    },
    {
      key: 'process',
      label: 'Process',
      width: 'minmax(110px, 1fr)',
      render: (s) =>
        s.process
          ? h('span', { class: 'sysman-ellipsis', text: `${s.process} (${s.pid})` })
          : h('span', { class: 'sysman-muted', text: `uid ${s.uid}` }),
      sort: (s) => s.process ?? '',
    },
  ];

  const table = new DataTable<SocketRow>({
    columns,
    key: (s) => `${s.proto}:${s.inode}:${s.localPort}:${s.remotePort}`,
    onContext: (row, at) => desktop.contextMenu(rowMenu(row), at),
  });
  table.sortBy('local', false);

  const search = filterInput('Filter by port, address or process', (value) => {
    filter = value;
    render();
  });
  search.value = filter;

  const viewButtons = (['listening', 'connections'] as const).map((id) =>
    h('button', {
      class: `sysman-seg-btn${view === id ? ' is-active' : ''}`,
      text: id === 'listening' ? 'Listening' : 'Connections',
      dataset: { view: id },
      on: {
        click: () => {
          view = id;
          for (const b of viewButtons) b.classList.toggle('is-active', b.dataset.view === view);
          render();
        },
      },
    }),
  );

  const status = h('span', { class: 'sysman-toolbar-note' });
  const banner = h('div', { class: 'sysman-banner' });
  banner.hidden = true;
  const body = h('div', { class: 'sysman-du-body' }, table.element);

  const element = h(
    'div',
    { class: 'sysman-section' },
    toolbar(h('div', { class: 'sysman-seg' }, ...viewButtons), search, status),
    banner,
    body,
  );

  async function load(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const result = await desktop.rpc.call<{ sockets: SocketRow[] }>('net', 'sockets');
      if (ctx.isDisposed()) return;
      banner.hidden = true;
      sockets = result.sockets;
      render();
    } catch (err) {
      if (ctx.isDisposed()) return;
      banner.hidden = false;
      banner.textContent = `${describeError(err)} — retrying.`;
      ctx.setStatus('Could not read sockets');
    } finally {
      running = false;
    }
  }

  function visible(): SocketRow[] {
    const needle = filter.trim().toLowerCase();
    return sockets.filter((s) => {
      const listening = s.state === 'LISTEN' || s.state === 'UNCONN';
      if (view === 'listening' && !listening) return false;
      if (view === 'connections' && listening) return false;
      if (!needle) return true;
      return (
        String(s.localPort) === needle ||
        String(s.remotePort) === needle ||
        s.local.includes(needle) ||
        s.remote.includes(needle) ||
        (s.process ?? '').toLowerCase().includes(needle) ||
        String(s.pid ?? '') === needle
      );
    });
  }

  function render(): void {
    const shown = visible();
    if (shown.length === 0) {
      body.replaceChildren(
        placeholder(
          view === 'listening' ? 'Nothing is listening' : 'No active connections',
          filter ? 'No socket matches this filter.' : undefined,
        ),
      );
    } else {
      if (body.firstChild !== table.element) body.replaceChildren(table.element);
      table.setRows(shown);
    }

    const listening = sockets.filter((s) => s.state === 'LISTEN' || s.state === 'UNCONN').length;
    const unowned = sockets.some((s) => !s.process);
    status.textContent = `${shown.length} shown · ${listening} listening · ${sockets.length - listening} connected`;
    ctx.setStatus(
      unowned
        ? 'Sockets owned by other users show a uid instead of a process name.'
        : `${sockets.length} sockets`,
    );
  }

  function rowMenu(row: SocketRow): MenuItem[] {
    return [
      { type: 'header', label: address(row.local, row.localPort) },
      {
        label: 'Filter to this port',
        onSelect: () => {
          filter = String(row.localPort);
          search.value = filter;
          render();
        },
      },
      {
        label: row.process ? `Find ${row.process} in Processes` : 'Owning process unknown',
        disabled: !row.pid,
        onSelect: () => {
          if (row.pid) ctx.goto('processes', { filter: String(row.pid) });
        },
      },
    ];
  }

  return {
    element,

    activate() {
      void load();
      if (timer === null) timer = window.setInterval(() => void load(), POLL_MS);
    },

    deactivate() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    },

    menu: () => [
      { label: 'Refresh now', accelerator: 'F5', onSelect: () => void load() },
      { type: 'separator' },
      {
        label: 'Listening sockets',
        checked: view === 'listening',
        onSelect: () => {
          view = 'listening';
          for (const b of viewButtons) b.classList.toggle('is-active', b.dataset.view === view);
          render();
        },
      },
      {
        label: 'Active connections',
        checked: view === 'connections',
        onSelect: () => {
          view = 'connections';
          for (const b of viewButtons) b.classList.toggle('is-active', b.dataset.view === view);
          render();
        },
      },
    ],

    saveState: () => ({ filter, view }),

    destroy() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      table.destroy();
    },
  };
}

export const networkSection: SectionDef = {
  id: 'network',
  title: 'Network',
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>
    <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>
  </svg>`,
  requires: ['net'],
  create: createNetwork,
};
