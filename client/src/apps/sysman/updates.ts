import { h } from '../../core/dom';
import type { MenuItem } from '../../core/types';
import {
  DataTable,
  button,
  describeError,
  filterInput,
  formatDuration,
  placeholder,
  toolbar,
  type Column,
  type Section,
  type SectionContext,
  type SectionDef,
} from './common';

interface PendingUpdate {
  name: string;
  arch?: string;
  current: string;
  available: string;
  origin?: string;
  security: boolean;
}

interface UpdateSource {
  id: string;
  name: string;
  packages: PendingUpdate[];
  fresh: boolean;
  listsAt?: number;
  knowsSecurity: boolean;
  note?: string;
  error?: string;
  command: string;
}

interface UpdateReport {
  checkedAt: number;
  sources: UpdateSource[];
  reboot: { needed: boolean; reasons: string[] };
}

/** One row of the table: an update, and the source it belongs to. */
interface Row extends PendingUpdate {
  source: UpdateSource;
}

/** Lists older than this are said to be old, not just dated. */
const STALE_MS = 2 * 86_400_000;

const clock = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function createUpdates(ctx: SectionContext): Section {
  const { desktop } = ctx;

  let report: UpdateReport | null = null;
  let checking = false;
  let asked = false;
  let filter = '';
  let securityOnly = false;

  const columns: Array<Column<Row>> = [
    {
      key: 'name',
      label: 'Package',
      width: 'minmax(160px, 1.5fr)',
      render: (row) =>
        h(
          'span',
          { class: 'sysman-ellipsis', title: row.arch ? `${row.name} (${row.arch})` : row.name },
          h('span', { text: row.name }),
          row.security ? h('span', { class: 'sysman-badge tone-warn sysman-update-sec', text: 'security' }) : null,
        ),
      sort: (row) => row.name,
    },
    {
      key: 'current',
      label: 'Installed',
      cls: 'is-mono',
      width: 'minmax(90px, 1fr)',
      showAbove: 620,
      render: (row) => h('span', { class: 'sysman-ellipsis', text: row.current || '—', title: row.current }),
    },
    {
      key: 'available',
      label: 'Available',
      cls: 'is-mono',
      width: 'minmax(90px, 1fr)',
      render: (row) => h('span', { class: 'sysman-ellipsis', text: row.available, title: row.available }),
    },
    {
      key: 'origin',
      label: 'From',
      width: 'minmax(90px, 0.9fr)',
      showAbove: 820,
      render: (row) => h('span', { class: 'sysman-ellipsis', text: row.origin ?? '—', title: row.origin ?? '' }),
      sort: (row) => row.origin ?? '',
    },
    {
      key: 'source',
      label: 'Kind',
      width: '120px',
      showAbove: 480,
      render: (row) => row.source.name,
      sort: (row) => row.source.name,
    },
    {
      // Hidden as a column; exists so "security first" is a sort like any other.
      key: 'security',
      label: 'Sec',
      width: '0px',
      showAbove: 100_000,
      render: () => '',
      sort: (row) => (row.security ? 0 : 1),
    },
  ];

  const table = new DataTable<Row>({
    columns,
    key: (row) => `${row.source.id}:${row.name}:${row.arch ?? ''}`,
    onContext: (row, at) => desktop.contextMenu(rowMenu(row), at),
  });
  table.sortBy('name', false);

  const checkButton = button('Check for updates', () => void check(), {
    title: 'Ask this machine’s package managers what they could update. Nothing is installed.',
  });
  const securityButton = button('Security only', () => {
    securityOnly = !securityOnly;
    securityButton.classList.toggle('is-active', securityOnly);
    render();
  });
  const filterBox = filterInput('Filter packages', (value) => {
    filter = value.trim().toLowerCase();
    render();
  });
  const status = h('span', { class: 'sysman-toolbar-note' });
  const banner = h('div', { class: 'sysman-banner' });
  banner.hidden = true;
  const sources = h('div', { class: 'sysman-update-sources' });
  const body = h('div', { class: 'sysman-du-body' });

  const element = h(
    'div',
    { class: 'sysman-section' },
    toolbar(checkButton, securityButton, filterBox, status),
    banner,
    sources,
    body,
  );

  const copy = async (text: string, what: string): Promise<void> => {
    await desktop.clipboard.write(text);
    desktop.notify({ kind: 'success', message: `${what} copied.`, timeout: 2000 });
  };
  const openTerminal = (): void => void desktop.launch('terminal', {});

  function sourceLine(source: UpdateSource): HTMLElement {
    const n = source.packages.length;
    const sec = source.packages.filter((p) => p.security).length;
    const parts: string[] = [];
    if (source.error) parts.push(source.error);
    else {
      parts.push(n === 0 ? 'up to date' : `${n} ${n === 1 ? 'update' : 'updates'}`);
      if (sec > 0) parts.push(`${sec} security`);
      if (!source.fresh && source.listsAt) {
        const age = Date.now() - source.listsAt;
        parts.push(`lists fetched ${formatDuration(age / 1000)} ago`);
      }
      if (source.note) parts.push(source.note);
    }
    const stale = !source.fresh && (!source.listsAt || Date.now() - source.listsAt > STALE_MS);
    return h(
      'div',
      { class: `sysman-update-source${source.error ? ' is-error' : stale ? ' is-stale' : ''}` },
      h('span', { class: 'sysman-update-source-name', text: source.name }),
      h('span', { class: 'sysman-update-source-detail', text: parts.join(' · '), title: parts.join(' · ') }),
      n > 0 || stale
        ? h('button', {
            class: 'sysman-button sysman-update-copy',
            text: 'Copy command',
            title: source.command,
            on: { click: () => void copy(source.command, 'Command') },
          })
        : null,
    );
  }

  function render(): void {
    if (ctx.isDisposed()) return;
    checkButton.disabled = checking;
    checkButton.textContent = checking ? 'Checking…' : 'Check for updates';

    if (!report) {
      banner.hidden = true;
      sources.replaceChildren();
      status.textContent = '';
      body.replaceChildren(
        checking
          ? placeholder('Checking for updates…', 'Asking the package managers. A first check can take a minute.')
          : placeholder(
              'Not checked yet',
              'Updates are looked for when you ask, never in the background. Nothing is installed from here.',
            ),
      );
      return;
    }

    const all: Row[] = report.sources.flatMap((source) => source.packages.map((p) => ({ ...p, source })));
    const security = all.filter((r) => r.security).length;
    const shown = all.filter(
      (r) =>
        (!securityOnly || r.security) &&
        (!filter || r.name.toLowerCase().includes(filter) || (r.origin ?? '').toLowerCase().includes(filter)),
    );

    banner.hidden = !report.reboot.needed;
    if (report.reboot.needed) {
      banner.classList.remove('is-info');
      banner.textContent = `This machine needs a restart. ${report.reboot.reasons.join(' ')}`;
    }
    sources.replaceChildren(...report.sources.map(sourceLine));
    status.textContent = `Checked ${clock(report.checkedAt)}`;

    if (report.sources.length === 0) {
      body.replaceChildren(
        placeholder('No package manager found', 'Looked for apt, dnf, zypper, pacman, snap and flatpak.'),
      );
    } else if (all.length === 0) {
      body.replaceChildren(
        report.sources.some((s) => s.error)
          ? placeholder('Nothing to show', 'A source could not be asked — see above.')
          : placeholder('Everything is up to date', `Checked at ${clock(report.checkedAt)}.`),
      );
    } else if (shown.length === 0) {
      body.replaceChildren(placeholder('No update matches', 'Clear the filter to see the rest.'));
    } else {
      if (body.firstChild !== table.element) body.replaceChildren(table.element);
      table.setRows(shown);
    }

    ctx.setStatus(
      all.length === 0
        ? 'No updates waiting'
        : `${all.length} ${all.length === 1 ? 'update' : 'updates'} waiting` +
            (security > 0 ? ` · ${security} security` : '') +
            (report.reboot.needed ? ' · restart needed' : ''),
    );
  }

  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    render();
    try {
      report = await desktop.rpc.call<UpdateReport>('updates', 'check');
    } catch (err) {
      if (ctx.isDisposed()) return;
      banner.hidden = false;
      banner.textContent = describeError(err);
    } finally {
      checking = false;
      render();
    }
  }

  /** What the server already knows: a check made earlier, or by another desktop. */
  async function recall(): Promise<void> {
    try {
      const known = await desktop.rpc.call<{ report: UpdateReport | null }>('updates', 'last');
      if (ctx.isDisposed() || checking || report) return;
      report = known.report;
      render();
    } catch {
      // Nothing remembered is the same as nothing asked.
    }
  }

  function commands(): string {
    return (report?.sources ?? [])
      .filter((s) => s.packages.length > 0)
      .map((s) => s.command)
      .join('\n');
  }

  function rowMenu(row: Row): MenuItem[] {
    return [
      { type: 'header', label: row.name },
      { label: 'Copy package name', onSelect: () => void copy(row.name, 'Name') },
      {
        label: `Copy the ${row.source.name.toLowerCase()} command`,
        onSelect: () => void copy(row.source.command, 'Command'),
      },
      { type: 'separator' },
      { label: 'Open a terminal', onSelect: openTerminal },
    ];
  }

  render();

  return {
    element,

    activate() {
      // Looking is free; asking is not. The first visit shows what a check
      // made earlier found, and starts none.
      if (!asked) {
        asked = true;
        void recall();
      }
    },

    menu: () => [
      { label: 'Check for updates', accelerator: 'F5', disabled: checking, onSelect: () => void check() },
      { type: 'separator' },
      {
        label: 'Security updates first',
        onSelect: () => {
          table.sortBy('security', false);
          render();
        },
      },
      {
        label: 'Copy install commands',
        disabled: commands() === '',
        onSelect: () => void copy(commands(), 'Commands'),
      },
      { label: 'Open a terminal', onSelect: openTerminal },
    ],

    destroy() {
      table.destroy();
    },
  };
}

export const updatesSection: SectionDef = {
  id: 'updates',
  title: 'Updates',
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/><path d="M12 8v6m-3-3 3 3 3-3"/>
  </svg>`,
  requires: ['updates'],
  create: createUpdates,
};
