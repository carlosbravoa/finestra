import type { Channel } from '../../core/rpc';
import { h } from '../../core/dom';
import type { MenuItem } from '../../core/types';
import {
  DataTable,
  button,
  describeError,
  filterInput,
  placeholder,
  toolbar,
  type Column,
  type Section,
  type SectionContext,
  type SectionDef,
} from './common';

/** Units change on their own; a slow poll keeps the list roughly honest. */
const POLL_MS = 10_000;
/** Journal lines kept in the log panel. */
const MAX_LOG_LINES = 2000;

interface UnitRow {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  file?: string;
}

type Filter = 'all' | 'failed' | 'active' | 'inactive';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'failed', label: 'Failed' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
  { id: 'all', label: 'All' },
];

/** Failed first: that is the unit someone opened this list to find. */
function stateRank(unit: UnitRow): number {
  if (unit.active === 'failed' || unit.sub === 'failed') return 0;
  if (unit.active === 'activating' || unit.active === 'deactivating') return 1;
  if (unit.active === 'active') return 2;
  if (unit.active === 'inactive') return 3;
  return 4;
}

/**
 * Which systemd manager to talk to. The system manager needs root or a polkit
 * rule before anything can be changed; your own user manager needs neither, so
 * the toggle is the difference between reading and doing.
 */
type Scope = 'system' | 'user';

const SCOPES: Array<{ id: Scope; label: string; hint: string }> = [
  { id: 'system', label: 'System', hint: 'Machine-wide units. Changing these needs root or a polkit rule.' },
  { id: 'user', label: 'User', hint: 'Your own session units. No privileges needed.' },
];

interface UnitsParams {
  filter?: string;
  state?: string;
  unit?: string;
  scope?: string;
}

function createUnits(ctx: SectionContext, params: UnitsParams): Section {
  const { desktop } = ctx;

  let timer: number | null = null;
  let running = false;
  let units: UnitRow[] = [];
  let filter = typeof params.filter === 'string' ? params.filter : '';
  let state: Filter =
    params.state === 'all' || params.state === 'failed' || params.state === 'active' || params.state === 'inactive'
      ? params.state
      : 'all';
  let selectedUnit: string | null = typeof params.unit === 'string' ? params.unit : null;
  let scope: Scope = params.scope === 'user' ? 'user' : 'system';
  let tab: 'info' | 'logs' = 'info';

  let logChannel: Channel | null = null;
  let logUnit: string | null = null;
  const decoder = new TextDecoder();

  const columns: Array<Column<UnitRow>> = [
    {
      key: 'unit',
      label: 'Unit',
      width: 'minmax(140px, 1.4fr)',
      render: (u) => h('span', { class: 'sysman-ellipsis', text: u.unit, title: u.unit }),
      sort: (u) => u.unit,
    },
    {
      key: 'state',
      label: 'State',
      width: 'minmax(120px, 0.7fr)',
      render: (u) =>
        h(
          'span',
          { class: 'sysman-state' },
          h('span', { class: `sysman-dot state-${u.active || 'unknown'}` }),
          // The dot is decoration; the words carry the meaning.
          h('span', { text: u.active ? `${u.active} (${u.sub})` : 'not loaded' }),
        ),
      sort: (u) => stateRank(u),
    },
    {
      key: 'file',
      label: 'Startup',
      width: 'minmax(76px, 0.5fr)',
      // Narrow, and enabled-vs-disabled is half of why this list gets opened.
      showAbove: 440,
      render: (u) => u.file ?? '—',
      sort: (u) => u.file ?? '',
    },
    {
      key: 'description',
      label: 'Description',
      width: 'minmax(140px, 2fr)',
      showAbove: 720,
      render: (u) => h('span', { class: 'sysman-ellipsis', text: u.description, title: u.description }),
      sort: (u) => u.description,
    },
  ];

  const table = new DataTable<UnitRow>({
    columns,
    key: (u) => u.unit,
    onSelect: (row) => {
      selectedUnit = row?.unit ?? null;
      renderDetail();
    },
    onContext: (row, at) => desktop.contextMenu(unitMenu(row), at),
  });
  table.sortBy('state', false);

  const search = filterInput('Filter units', (value) => {
    filter = value;
    render();
  });
  search.value = filter;

  const stateButtons = FILTERS.map((f) =>
    h('button', {
      class: `sysman-seg-btn${state === f.id ? ' is-active' : ''}`,
      text: f.label,
      dataset: { state: f.id },
      on: {
        click: () => {
          state = f.id;
          for (const b of stateButtons) b.classList.toggle('is-active', b.dataset.state === state);
          render();
        },
      },
    }),
  );

  const scopeButtons = SCOPES.map((s) =>
    h('button', {
      class: `sysman-seg-btn${scope === s.id ? ' is-active' : ''}`,
      text: s.label,
      title: s.hint,
      dataset: { scope: s.id },
      on: { click: () => setScope(s.id) },
    }),
  );

  const status = h('span', { class: 'sysman-toolbar-note' });
  const banner = h('div', { class: 'sysman-banner' });
  banner.hidden = true;

  const detailTitle = h('span', { class: 'sysman-detail-title', text: 'No unit selected' });
  const infoTab = h('button', { class: 'sysman-tab is-active', text: 'Info', on: { click: () => setTab('info') } });
  const logsTab = h('button', { class: 'sysman-tab', text: 'Logs', on: { click: () => setTab('logs') } });
  const detailBody = h('div', { class: 'sysman-detail-body' });
  const logNote = h('span', { class: 'sysman-log-note' });
  const logView = h('pre', { class: 'sysman-log' });
  const logWrap = h('div', { class: 'sysman-log-wrap' }, logView);
  logWrap.hidden = true;

  const detailPanel = h(
    'aside',
    { class: 'sysman-detail is-wide' },
    h(
      'div',
      { class: 'sysman-detail-head' },
      detailTitle,
      h('div', { class: 'sysman-tabs' }, infoTab, logsTab),
    ),
    detailBody,
    logWrap,
  );

  const element = h(
    'div',
    { class: 'sysman-section' },
    toolbar(
      h('div', { class: 'sysman-seg' }, ...scopeButtons),
      search,
      h('div', { class: 'sysman-seg' }, ...stateButtons),
      status,
    ),
    banner,
    h('div', { class: 'sysman-split' }, table.element, detailPanel),
  );

  /* ---------------------------------------------------------------- */
  /* List                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Switching manager invalidates everything on screen: the unit lists do not
   * overlap, so the selection, its detail and its log stream all belong to the
   * scope that was showing.
   */
  function setScope(next: Scope): void {
    if (scope === next) return;
    scope = next;
    for (const b of scopeButtons) b.classList.toggle('is-active', b.dataset.scope === scope);
    closeLogs();
    selectedUnit = null;
    table.select(null);
    units = [];
    table.setRows([]);
    renderDetail();
    void load();
  }

  async function load(): Promise<void> {
    if (running) return;
    running = true;
    const requested = scope;
    try {
      const result = await desktop.rpc.call<{ units: UnitRow[] }>('systemd', 'units', { scope });
      // The user may have flipped the toggle while this was in flight; those
      // units belong to the other manager now.
      if (ctx.isDisposed() || requested !== scope) return;
      banner.hidden = true;
      units = result.units;
      render();
      const failed = units.filter((u) => u.active === 'failed').length;
      ctx.setStatus(
        `${units.length} ${scope} units${failed > 0 ? ` · ${failed} failed` : ''}`,
      );
    } catch (err) {
      if (ctx.isDisposed() || requested !== scope) return;
      banner.hidden = false;
      banner.classList.remove('is-info');
      banner.textContent = describeError(err);
      ctx.setStatus(`Could not list ${scope} units`);
    } finally {
      running = false;
    }
  }

  function visible(): UnitRow[] {
    const needle = filter.trim().toLowerCase();
    return units.filter((u) => {
      if (state === 'failed' && u.active !== 'failed') return false;
      if (state === 'active' && u.active !== 'active') return false;
      if (state === 'inactive' && (u.active === 'active' || u.active === 'failed')) return false;
      if (!needle) return true;
      return (
        u.unit.toLowerCase().includes(needle) || u.description.toLowerCase().includes(needle)
      );
    });
  }

  function render(): void {
    const shown = visible();
    table.setRows(shown);
    const failed = units.filter((u) => u.active === 'failed').length;
    status.textContent =
      shown.length === units.length
        ? `${units.length} units${failed ? ` · ${failed} failed` : ''}`
        : `${shown.length} of ${units.length} units`;
  }

  /* ---------------------------------------------------------------- */
  /* Detail                                                            */
  /* ---------------------------------------------------------------- */

  function setTab(next: 'info' | 'logs'): void {
    tab = next;
    infoTab.classList.toggle('is-active', tab === 'info');
    logsTab.classList.toggle('is-active', tab === 'logs');
    detailBody.hidden = tab !== 'info';
    logWrap.hidden = tab !== 'logs';
    if (tab === 'logs') openLogs();
    else closeLogs();
  }

  const INTERESTING: Array<[string, string]> = [
    ['Description', 'Description'],
    ['LoadState', 'Load'],
    ['ActiveState', 'Active'],
    ['SubState', 'Sub'],
    ['UnitFileState', 'Startup'],
    ['Result', 'Result'],
    ['MainPID', 'Main PID'],
    ['ExecMainStartTimestamp', 'Started'],
    ['FragmentPath', 'Unit file'],
    ['Restart', 'Restart'],
    ['TriggeredBy', 'Triggered by'],
  ];

  function renderDetail(): void {
    if (!selectedUnit) {
      // With nothing selected there is nothing to follow, and the Logs tab
      // would be a blank panel with no explanation — so fall back to Info,
      // which is where the hint lives.
      if (tab === 'logs') setTab('info');
      detailTitle.textContent = 'No unit selected';
      detailBody.replaceChildren(
        placeholder('Select a unit', 'Its state, unit file and logs appear here.'),
      );
      closeLogs();
      return;
    }
    detailTitle.textContent = selectedUnit;
    if (tab === 'logs') {
      openLogs();
      return;
    }
    void loadUnitDetail(selectedUnit);
  }

  async function loadUnitDetail(unit: string): Promise<void> {
    detailBody.replaceChildren(placeholder('Loading…'));
    const requested = scope;
    try {
      const props = await desktop.rpc.call<Record<string, string>>('systemd', 'unit', {
        unit,
        scope,
      });
      if (ctx.isDisposed() || selectedUnit !== unit || requested !== scope) return;

      const fields = INTERESTING.filter(([key]) => props[key] && props[key] !== '0').map(
        ([key, label]) =>
          h(
            'div',
            { class: 'sysman-field' },
            h('div', { class: 'sysman-field-label', text: label }),
            h('div', { class: 'sysman-field-value', text: props[key] }),
          ),
      );

      detailBody.replaceChildren(
        ...fields,
        h(
          'div',
          { class: 'sysman-detail-actions' },
          button('Start', () => void control(unit, 'start')),
          button('Stop', () => void control(unit, 'stop'), { danger: true }),
          button('Restart', () => void control(unit, 'restart'), { danger: true }),
          props.UnitFileState === 'enabled'
            ? button('Disable', () => void control(unit, 'disable'), { danger: true })
            : button('Enable', () => void control(unit, 'enable')),
        ),
      );
    } catch (err) {
      if (ctx.isDisposed() || selectedUnit !== unit || requested !== scope) return;
      detailBody.replaceChildren(placeholder('Could not inspect this unit', describeError(err)));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Control                                                           */
  /* ---------------------------------------------------------------- */

  const DESTRUCTIVE = new Set(['stop', 'restart', 'disable']);

  async function control(unit: string, action: string): Promise<void> {
    if (DESTRUCTIVE.has(action)) {
      const ok = await desktop.confirm({
        title: `${action[0].toUpperCase()}${action.slice(1)} ${unit}?`,
        message:
          action === 'disable'
            ? `${unit} will not start at boot any more. It keeps running until stopped.`
            : `${unit} will be ${action === 'stop' ? 'stopped' : 'restarted'} now.`,
        confirmLabel: action[0].toUpperCase() + action.slice(1),
        danger: true,
      });
      if (!ok || ctx.isDisposed()) return;
    }

    try {
      const result = await desktop.rpc.call<{
        unit: string;
        action: string;
        active: string;
        sub: string;
        file: string;
        result: string;
      }>('systemd', 'control', { unit, action, scope });
      if (ctx.isDisposed()) return;

      // A zero exit is not the same as the unit doing what was asked, so the
      // state it actually landed in decides what the user is told.
      const wanted =
        action === 'start' || action === 'restart' || action === 'reload' ? 'active' : null;
      if (wanted && result.active !== wanted) {
        desktop.notify({
          kind: 'warning',
          title: `${unit} did not come up`,
          message: `systemctl ${action} returned success but the unit is ${result.active} (${result.sub}). Check its logs.`,
          timeout: 0,
          actions: [
            {
              label: 'Show logs',
              onSelect: () => {
                selectedUnit = unit;
                table.select(unit);
                setTab('logs');
              },
            },
          ],
        });
      } else {
        desktop.notify({
          kind: 'success',
          message: `${unit}: ${action} done — now ${result.active || result.file || 'updated'}.`,
          timeout: 3000,
        });
      }

      await load();
      if (!ctx.isDisposed() && selectedUnit === unit) renderDetail();
    } catch (err) {
      if (ctx.isDisposed()) return;
      // polkit's refusal is the useful part; show it verbatim.
      desktop.notify({
        kind: 'error',
        title: `Could not ${action} ${unit}`,
        message: describeError(err),
        timeout: 0,
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Logs                                                              */
  /* ---------------------------------------------------------------- */

  function appendLog(text: string): void {
    const atBottom = logView.scrollHeight - logView.scrollTop - logView.clientHeight < 40;
    // Drop the waiting note as soon as there is something real to show.
    if (logView.firstChild === logNote) logView.replaceChildren();
    logView.appendChild(document.createTextNode(text));
    // Keep the node count bounded: a busy unit would otherwise grow forever.
    while (logView.childNodes.length > MAX_LOG_LINES) {
      logView.removeChild(logView.firstChild!);
    }
    if (atBottom) logView.scrollTop = logView.scrollHeight;
  }

  function openLogs(): void {
    if (!selectedUnit) {
      logView.textContent = '';
      return;
    }
    if (logChannel && logUnit === selectedUnit) return;
    closeLogs();

    const unit = selectedUnit;
    logUnit = unit;
    // Plenty of units have never written a line. An empty black panel cannot
    // be told apart from a broken one, so say which it is.
    logNote.textContent = `Following ${unit}. Nothing logged yet.`;
    logView.replaceChildren(logNote);

    logChannel = desktop.rpc.openChannel(
      'systemd',
      'logs',
      { unit, lines: 300, scope },
      {
        onBinary: (bytes) => {
          if (ctx.isDisposed() || logUnit !== unit) return;
          appendLog(decoder.decode(bytes, { stream: true }));
        },
        onClose: (error) => {
          if (ctx.isDisposed() || logUnit !== unit) return;
          logChannel = null;
          appendLog(`\n— ${error ?? 'log stream ended'} —\n`);
        },
      },
    );
  }

  function closeLogs(): void {
    logChannel?.close();
    logChannel = null;
    logUnit = null;
    logView.replaceChildren();
  }

  function unitMenu(row: UnitRow): MenuItem[] {
    return [
      { type: 'header', label: row.unit },
      { label: 'Start', onSelect: () => void control(row.unit, 'start') },
      { label: 'Stop', danger: true, onSelect: () => void control(row.unit, 'stop') },
      { label: 'Restart', danger: true, onSelect: () => void control(row.unit, 'restart') },
      { type: 'separator' },
      {
        label: row.file === 'enabled' ? 'Disable' : 'Enable',
        danger: row.file === 'enabled',
        onSelect: () => void control(row.unit, row.file === 'enabled' ? 'disable' : 'enable'),
      },
      { type: 'separator' },
      {
        label: 'Show logs',
        onSelect: () => {
          selectedUnit = row.unit;
          table.select(row.unit);
          setTab('logs');
        },
      },
      // The panel follows this unit; the Journal can put it beside everything
      // else that happened at the same moment.
      ...(desktop.rpc.hasService('journal')
        ? [
            {
              label: 'Open in Journal',
              onSelect: () => ctx.goto('journal', { unit: row.unit }),
            },
          ]
        : []),
    ];
  }

  renderDetail();

  return {
    element,

    /** "Manage this unit", arriving from an entry in the Journal. */
    applyParams(next: UnitsParams) {
      if (next.scope === 'user' || next.scope === 'system') setScope(next.scope);
      if (typeof next.unit === 'string') {
        // Selecting a key the table does not hold reports "nothing selected",
        // so the field is set afterwards: the unit may not be in the list yet,
        // and the detail panel does not need it to be.
        table.select(next.unit);
        selectedUnit = next.unit;
        renderDetail();
      }
    },

    activate() {
      void load();
      if (timer === null) timer = window.setInterval(() => void load(), POLL_MS);
      if (tab === 'logs') openLogs();
    },

    deactivate() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      // journalctl on the host should not outlive a panel nobody is watching.
      closeLogs();
    },

    menu: () => [
      { label: 'Refresh now', accelerator: 'F5', onSelect: () => void load() },
      { type: 'separator' },
      ...SCOPES.map((s) => ({
        label: `${s.label} units`,
        checked: scope === s.id,
        onSelect: () => setScope(s.id),
      })),
      { type: 'separator' },
      ...FILTERS.map((f) => ({
        label: `Show ${f.label.toLowerCase()}`,
        checked: state === f.id,
        onSelect: () => {
          state = f.id;
          for (const b of stateButtons) b.classList.toggle('is-active', b.dataset.state === state);
          render();
        },
      })),
    ],

    saveState: () => ({ filter, state, scope, unit: selectedUnit ?? undefined }),

    destroy() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      closeLogs();
      table.destroy();
    },
  };
}

export const unitsSection: SectionDef = {
  id: 'services',
  title: 'Services',
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/>
    <path d="M7 7h.01M7 17h.01"/>
  </svg>`,
  requires: ['systemd'],
  create: createUnits,
};
