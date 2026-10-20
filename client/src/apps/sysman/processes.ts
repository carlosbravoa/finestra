import { h } from '../../core/dom';
import type { MenuItem } from '../../core/types';
import {
  DataTable,
  button,
  describeError,
  filterInput,
  formatBytes,
  formatPercent,
  placeholder,
  toolbar,
  type Column,
  type Section,
  type SectionContext,
  type SectionDef,
} from './common';

const POLL_MS = 2000;

interface ProcRow {
  pid: number;
  ppid: number;
  name: string;
  state: string;
  ticks: number;
  rss: number;
  threads: number;
  uid: number;
  user: string;
  cmdline: string;
}

interface ProcList {
  time: number;
  hertz: number;
  cores: number;
  memTotal: number;
  self: number;
  rows: ProcRow[];
}

interface ProcDetail extends ProcRow {
  cwd: string | null;
  exe: string | null;
  fds: Array<{ fd: number; target: string }> | null;
  fdCount: number | null;
}

/** A row plus what only two consecutive snapshots can tell us. */
interface Row extends ProcRow {
  /** Fraction of one core, 1 = a fully busy core. */
  cpu: number;
  memShare: number;
  /** Part of the desktop's own process tree. */
  own: boolean;
}

const STATES: Record<string, string> = {
  R: 'running',
  S: 'sleeping',
  D: 'disk wait',
  Z: 'zombie',
  T: 'stopped',
  t: 'traced',
  I: 'idle',
};

/**
 * Signals in the words of what they do, with the name second. "Terminate" and
 * "Kill" side by side say nothing about which is the gentle one, and the
 * person choosing is often not the person who knows.
 */
const SIGNALS: Array<{ label: string; what: string; signal: string; danger?: boolean }> = [
  { label: 'Terminate', what: 'asks it to exit, so it can save its work and clean up', signal: 'SIGTERM' },
  { label: 'Kill', what: 'ends it at once; it cannot save anything', signal: 'SIGKILL', danger: true },
  { label: 'Interrupt', what: 'what Ctrl+C sends in a terminal', signal: 'SIGINT' },
  { label: 'Hang up', what: 'many services reload their configuration on this', signal: 'SIGHUP' },
  { label: 'Pause', what: 'freezes it until it is resumed', signal: 'SIGSTOP' },
  { label: 'Resume', what: 'lets a paused process continue', signal: 'SIGCONT' },
];
const bySignal = (name: string) => SIGNALS.find((s) => s.signal === name)!;

/** How long a terminated process gets before the panel suggests Kill. */
const TERMINATE_PATIENCE_MS = 5000;

interface ProcessParams {
  filter?: string;
  sortKey?: string;
  sortDesc?: boolean;
}

function createProcesses(ctx: SectionContext, params: ProcessParams): Section {
  const { desktop } = ctx;

  let timer: number | null = null;
  let running = false;
  let previous: ProcList | null = null;
  let rows: Row[] = [];
  let filter = typeof params.filter === 'string' ? params.filter : '';
  let ownOnly = false;
  let selectedPid: number | null = null;
  /** The selected process's name, for the sentence that says it has ended. */
  let selectedName = '';
  /** A pid handed over by another section, selected once the list has it. */
  let wantSelect: number | null = null;
  /** When Terminate was sent to the selected process, if it is still there. */
  let terminatedAt: number | null = null;

  const detailBody = h('div', { class: 'sysman-detail-body' });
  const detailPanel = h(
    'aside',
    { class: 'sysman-detail' },
    h(
      'div',
      { class: 'sysman-detail-head' },
      h('span', { class: 'sysman-detail-title', text: 'No process selected' }),
      h(
        'div',
        { class: 'sysman-detail-tools' },
        button('Refresh', () => void loadDetail(selectedPid, true)),
        // The list is still there beside the panel, but nothing said how to
        // put the panel away; this does, as does Escape or a second click.
        button('✕', () => table.select(null), { title: 'Deselect' }),
      ),
    ),
    detailBody,
  );

  const columns: Array<Column<Row>> = [
    {
      key: 'pid',
      label: 'PID',
      cls: 'is-num',
      width: '70px',
      render: (r) => String(r.pid),
      sort: (r) => r.pid,
    },
    {
      key: 'name',
      label: 'Name',
      width: 'minmax(90px, 1.2fr)',
      render: (r) =>
        h(
          'span',
          { class: 'sysman-procname', title: r.cmdline || r.name },
          h('span', { text: r.name }),
          r.own ? h('span', { class: 'sysman-tag', text: 'desktop' }) : null,
        ),
      sort: (r) => r.name,
    },
    {
      key: 'user',
      label: 'User',
      width: 'minmax(64px, 0.5fr)',
      showAbove: 520,
      render: (r) => r.user,
      sort: (r) => r.user,
    },
    {
      key: 'cpu',
      label: 'CPU',
      cls: 'is-num',
      width: '72px',
      render: (r) => formatPercent(r.cpu),
      sort: (r) => r.cpu,
      desc: true,
    },
    {
      key: 'rss',
      label: 'Memory',
      cls: 'is-num',
      width: '86px',
      render: (r) => formatBytes(r.rss),
      sort: (r) => r.rss,
      desc: true,
    },
    {
      key: 'threads',
      label: 'Thr',
      cls: 'is-num',
      width: '52px',
      showAbove: 700,
      render: (r) => String(r.threads),
      sort: (r) => r.threads,
      desc: true,
    },
    {
      key: 'state',
      label: 'State',
      width: 'minmax(78px, 0.6fr)',
      showAbove: 620,
      render: (r) => STATES[r.state] ?? r.state,
      sort: (r) => r.state,
    },
    {
      key: 'cmdline',
      label: 'Command',
      cls: 'is-mono',
      width: 'minmax(120px, 2fr)',
      showAbove: 880,
      render: (r) => h('span', { class: 'sysman-ellipsis', text: r.cmdline || `[${r.name}]`, title: r.cmdline }),
      sort: (r) => r.cmdline,
    },
  ];

  const table = new DataTable<Row>({
    columns,
    key: (r) => String(r.pid),
    onSelect: (row) => {
      selectedPid = row?.pid ?? null;
      selectedName = row?.name ?? '';
      terminatedAt = null;
      void loadDetail(selectedPid, false);
    },
    onContext: (row, at) => desktop.contextMenu(rowMenu(row), at),
  });
  table.sortBy(
    typeof params.sortKey === 'string' ? params.sortKey : 'cpu',
    params.sortDesc !== undefined ? Boolean(params.sortDesc) : true,
  );

  const search = filterInput('Filter by name, command, user or pid', (value) => {
    filter = value;
    render();
  });
  search.value = filter;

  const ownToggle = button('Desktop only', () => {
    ownOnly = !ownOnly;
    ownToggle.classList.toggle('is-active', ownOnly);
    render();
  }, { title: "Show only the desktop server's own processes" });

  const status = h('span', { class: 'sysman-toolbar-note' });
  const banner = h('div', { class: 'sysman-banner' });
  banner.hidden = true;

  // Arriving from Network or the Journal puts one pid in the search box and
  // one row in the list, and a number in a search box does not read as the
  // thing to clear. The way back has to be a button that says so.
  const showAll = h('button', {
    class: 'sysman-jchip',
    text: 'Show all ✕',
    title: 'Clear the filter',
    on: { click: () => setFilter('') },
  });

  const element = h(
    'div',
    { class: 'sysman-section' },
    toolbar(search, ownToggle, showAll, status),
    banner,
    h('div', { class: 'sysman-split' }, table.element, detailPanel),
  );

  function setFilter(value: string): void {
    filter = value;
    search.value = value;
    render();
  }

  /* ---------------------------------------------------------------- */
  /* Data                                                              */
  /* ---------------------------------------------------------------- */

  /** pids belonging to the desktop server's own tree, for the badge. */
  function ownTree(list: ProcList): Set<number> {
    const byParent = new Map<number, number[]>();
    for (const row of list.rows) {
      const kids = byParent.get(row.ppid);
      if (kids) kids.push(row.pid);
      else byParent.set(row.ppid, [row.pid]);
    }
    const own = new Set<number>();
    const queue = [list.self];
    while (queue.length > 0) {
      const pid = queue.pop()!;
      if (own.has(pid)) continue;
      own.add(pid);
      for (const child of byParent.get(pid) ?? []) queue.push(child);
    }
    return own;
  }

  async function poll(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const list = await desktop.rpc.call<ProcList>('proc', 'list');
      if (ctx.isDisposed()) return;

      banner.hidden = true;

      const own = ownTree(list);
      const before = new Map(previous?.rows.map((r) => [r.pid, r]) ?? []);
      const seconds = previous ? (list.time - previous.time) / 1000 : 0;

      rows = list.rows.map((row) => {
        const was = before.get(row.pid);
        // Without a previous sample there is no rate to report; 0 is honest
        // for one poll, and every later poll has one.
        const cpu =
          was && seconds > 0 ? Math.max(0, (row.ticks - was.ticks) / list.hertz / seconds) : 0;
        return {
          ...row,
          cpu,
          memShare: list.memTotal > 0 ? row.rss / list.memTotal : 0,
          own: own.has(row.pid),
        };
      });

      previous = list;
      render();
      ctx.setStatus(`${list.rows.length} processes · ${list.cores} cores`);
      afterPoll();
    } catch (err) {
      if (ctx.isDisposed()) return;
      banner.hidden = false;
      banner.textContent = `${describeError(err)} — retrying.`;
      ctx.setStatus('Disconnected');
      previous = null;
    } finally {
      running = false;
    }
  }

  function visible(): Row[] {
    const needle = filter.trim().toLowerCase();
    return rows.filter((row) => {
      if (ownOnly && !row.own) return false;
      if (!needle) return true;
      return (
        row.name.toLowerCase().includes(needle) ||
        row.cmdline.toLowerCase().includes(needle) ||
        row.user.toLowerCase().includes(needle) ||
        String(row.pid) === needle
      );
    });
  }

  function render(): void {
    const shown = visible();
    table.setRows(shown);
    showAll.hidden = filter.trim() === '';
    status.textContent =
      shown.length === rows.length
        ? `${rows.length} processes`
        : `${shown.length} of ${rows.length} processes`;
  }

  /**
   * What a fresh list means for the selection. A pid handed over by another
   * section is selected as soon as it is in the list. A selected process that
   * is no longer there has ended — usually because the button beside it was
   * just pressed — so the panel is put away, a filter that showed only that
   * pid is cleared, and the full list is back without anyone asking for it.
   */
  function afterPoll(): void {
    if (wantSelect !== null && rows.some((r) => r.pid === wantSelect)) {
      table.select(String(wantSelect));
      wantSelect = null;
    }
    if (selectedPid === null) return;
    const live = rows.find((r) => r.pid === selectedPid);
    if (live) {
      if (terminatedAt !== null && Date.now() - terminatedAt >= TERMINATE_PATIENCE_MS) {
        showStillRunning();
      }
      return;
    }
    const ended = `${selectedName} (${selectedPid})`;
    if (filter.trim() === String(selectedPid)) setFilter('');
    table.select(null);
    desktop.notify({ kind: 'info', message: `${ended} has ended.`, timeout: 3000 });
  }

  /** Terminate was sent and politely ignored; say so where the buttons are. */
  function showStillRunning(): void {
    if (detailBody.querySelector('.sysman-detail-note')) return;
    const actions = detailBody.querySelector('.sysman-detail-actions');
    actions?.before(
      h('div', {
        class: 'sysman-detail-note',
        text: 'Still running after being asked to terminate. Kill ends it at once.',
      }),
    );
  }

  async function loadDetail(pid: number | null, force: boolean): Promise<void> {
    const title = detailPanel.querySelector('.sysman-detail-title') as HTMLElement;
    if (pid === null) {
      title.textContent = 'No process selected';
      detailBody.replaceChildren(
        placeholder('Select a process', 'Its command line, working directory and open files appear here.'),
      );
      return;
    }
    if (!force) detailBody.replaceChildren(placeholder('Loading…'));

    try {
      const detail = await desktop.rpc.call<ProcDetail>('proc', 'detail', { pid });
      if (ctx.isDisposed() || selectedPid !== pid) return;

      title.textContent = `${detail.name} (${detail.pid})`;
      const fields: Array<[string, Node | string]> = [
        ['Command', h('code', { class: 'sysman-code', text: detail.cmdline || `[${detail.name}]` })],
        ['Executable', detail.exe ?? 'not readable'],
        ['Working dir', detail.cwd ?? 'not readable'],
        ['User', `${detail.user} (uid ${detail.uid})`],
        ['State', STATES[detail.state] ?? detail.state],
        ['Parent', String(detail.ppid)],
        ['Threads', String(detail.threads)],
        ['Memory', formatBytes(detail.rss)],
        ['Open files', detail.fdCount === null ? 'not readable' : String(detail.fdCount)],
      ];

      const openFiles = detail.fds?.length
        ? h(
            'div',
            { class: 'sysman-detail-list' },
            ...detail.fds.map((fd) =>
              h(
                'div',
                { class: 'sysman-detail-fd' },
                h('span', { class: 'sysman-detail-fdnum', text: String(fd.fd) }),
                h('span', { class: 'sysman-ellipsis', text: fd.target, title: fd.target }),
              ),
            ),
          )
        : null;

      const parts: Node[] = fields.map(([label, value]) =>
        h(
          'div',
          { class: 'sysman-field' },
          h('div', { class: 'sysman-field-label', text: label }),
          typeof value === 'string'
            ? h('div', { class: 'sysman-field-value', text: value })
            : h('div', { class: 'sysman-field-value' }, value),
        ),
      );
      if (openFiles) {
        parts.push(h('div', { class: 'sysman-field-label', text: 'File descriptors' }), openFiles);
      }
      const terminate = bySignal('SIGTERM');
      const kill = bySignal('SIGKILL');
      parts.push(
        h(
          'div',
          { class: 'sysman-detail-actions' },
          button(terminate.label, () => void signal(detail.pid, detail.name, 'SIGTERM'), {
            danger: true,
            title: `${terminate.signal}: ${terminate.what}`,
          }),
          button(kill.label, () => void signal(detail.pid, detail.name, 'SIGKILL'), {
            danger: true,
            title: `${kill.signal}: ${kill.what}`,
          }),
        ),
        // The one sentence that tells the two buttons apart, where they are.
        h('div', {
          class: 'sysman-detail-hint',
          text: 'Terminate asks it to exit. Kill ends it at once, with nothing saved.',
        }),
      );
      detailBody.replaceChildren(...parts);
      if (terminatedAt !== null && Date.now() - terminatedAt >= TERMINATE_PATIENCE_MS) {
        showStillRunning();
      }
    } catch (err) {
      if (ctx.isDisposed() || selectedPid !== pid) return;
      detailBody.replaceChildren(placeholder('Could not inspect this process', describeError(err)));
    }
  }

  async function signal(pid: number, name: string, sig: string): Promise<void> {
    const which = bySignal(sig);
    const destructive = sig !== 'SIGCONT';
    if (destructive) {
      const ok = await desktop.confirm({
        title: `${which.label} ${name}?`,
        message:
          sig === 'SIGTERM'
            ? `${name} (pid ${pid}) will be asked to exit. It can save its work and clean up first. If it does not go, Kill ends it at once.`
            : sig === 'SIGKILL'
              ? `${name} (pid ${pid}) will be ended at once. It cannot save its work or clean up.`
              : `${name} (pid ${pid}) will be sent ${sig}: ${which.what}.`,
        confirmLabel: which.label,
        danger: true,
      });
      if (!ok || ctx.isDisposed()) return;
    }

    try {
      await desktop.rpc.call('proc', 'kill', { pid, signal: sig });
      if (ctx.isDisposed()) return;
      if (sig === 'SIGTERM' && pid === selectedPid) terminatedAt = Date.now();
      desktop.notify({
        kind: 'success',
        message:
          sig === 'SIGTERM'
            ? `${name} (${pid}) was asked to exit.`
            : sig === 'SIGKILL'
              ? `${name} (${pid}) was killed.`
              : `Sent ${sig} to ${name} (${pid}).`,
        timeout: 2500,
      });
      void poll();
    } catch (err) {
      if (ctx.isDisposed()) return;
      desktop.notify({
        kind: 'error',
        title: `Could not signal ${name}`,
        message: describeError(err),
      });
    }
  }

  function rowMenu(row: Row): MenuItem[] {
    return [
      { type: 'header', label: `${row.name} (${row.pid})` },
      ...SIGNALS.map((s) => ({
        // "Terminate (SIGTERM)" told nobody which of the two to press; the
        // plain words are the label and the signal name is the detail.
        label: `${s.label} — ${s.what}`,
        danger: s.danger,
        onSelect: () => void signal(row.pid, row.name, s.signal),
      })),
      { type: 'separator' },
      {
        label: 'Copy command line',
        disabled: !row.cmdline,
        onSelect: () => void copy(row.cmdline),
      },
      {
        label: 'Filter to this process',
        onSelect: () => setFilter(String(row.pid)),
      },
    ];
  }

  async function copy(text: string): Promise<void> {
    // A command line copied here is usually on its way to the terminal in the
    // next window, which the desktop's own clipboard serves whatever the
    // browser decides about the machine's.
    await desktop.clipboard.write(text);
    desktop.notify({ kind: 'success', message: 'Copied to the clipboard.', timeout: 1800 });
  }

  void loadDetail(null, false);

  return {
    element,

    /** "Show me this pid", from Network or the Journal. */
    applyParams(next: ProcessParams) {
      if (typeof next.filter === 'string') {
        setFilter(next.filter);
        // The row the filter was made for is what they came to see, so it is
        // selected too, once a poll has brought it in.
        const pid = Number(next.filter);
        wantSelect = Number.isInteger(pid) && pid > 0 ? pid : null;
        afterPoll();
      }
    },

    activate() {
      void poll();
      if (timer === null) timer = window.setInterval(() => void poll(), POLL_MS);
    },

    deactivate() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      // Rates need two adjacent samples; a stale one would invent a spike.
      previous = null;
    },

    menu: () => [
      { label: 'Refresh now', accelerator: 'F5', onSelect: () => void poll() },
      { type: 'separator' },
      {
        label: 'Desktop processes only',
        checked: ownOnly,
        onSelect: () => {
          ownOnly = !ownOnly;
          ownToggle.classList.toggle('is-active', ownOnly);
          render();
        },
      },
      {
        label: 'Clear filter',
        disabled: filter === '',
        onSelect: () => setFilter(''),
      },
    ],

    saveState: () => ({
      filter,
      sortKey: table.sorting.key ?? undefined,
      sortDesc: table.sorting.desc,
    }),

    destroy() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      table.destroy();
    },
  };
}

export const processesSection: SectionDef = {
  id: 'processes',
  title: 'Processes',
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/>
    <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>
  </svg>`,
  requires: ['proc'],
  create: createProcesses,
};
