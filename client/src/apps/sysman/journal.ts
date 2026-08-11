import type { Channel } from '../../core/rpc';
import { h } from '../../core/dom';
import type { MenuItem } from '../../core/types';
import {
  button,
  describeError,
  placeholder,
  toolbar,
  type Section,
  type SectionContext,
  type SectionDef,
} from './common';

/**
 * The journal: everything the machine has said, narrowed until the answer is
 * on screen.
 *
 * Filtering happens on the server — journalctl reads indexes, and shipping a
 * boot's worth of entries to grep them in the browser would be both slower and
 * heavier. So every filter change tears the stream down and opens a new one.
 */

/** Rows kept in the DOM. Beyond this the oldest are dropped. */
const MAX_ROWS = 5000;
/** Typing pause before a filter change costs a new journalctl. */
const DEBOUNCE_MS = 350;

const PRIORITIES = [
  { value: 0, label: 'Emergency' },
  { value: 1, label: 'Alert' },
  { value: 2, label: 'Critical' },
  { value: 3, label: 'Error' },
  { value: 4, label: 'Warning' },
  { value: 5, label: 'Notice' },
  { value: 6, label: 'Info' },
  { value: 7, label: 'Debug' },
];

const SCOPES = [
  { id: 'all', label: 'All', hint: 'Everything this server is allowed to read.' },
  { id: 'system', label: 'System', hint: 'System services and the kernel.' },
  { id: 'user', label: 'User', hint: "The server user's own session." },
] as const;

type Scope = (typeof SCOPES)[number]['id'];

interface Entry {
  cursor: string;
  time: number;
  priority: number;
  message: string;
  unit?: string;
  identifier?: string;
  pid?: number;
  host?: string;
  transport?: string;
}

interface Boot {
  index: number;
  id: string;
  first: number;
  last: number;
}

interface JournalParams {
  scope?: string;
  boot?: string;
  priority?: number;
  unit?: string;
  identifier?: string;
  grep?: string;
  follow?: boolean;
}

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--:--';
  return TIME.format(new Date(ms));
}

function formatBootLabel(boot: Boot): string {
  const when = new Date(boot.first).toLocaleString();
  if (boot.index === 0) return `Current boot — ${when}`;
  return `${boot.index} — ${when}`;
}

function createJournal(ctx: SectionContext, params: JournalParams): Section {
  const { desktop } = ctx;

  let scope: Scope =
    params.scope === 'system' || params.scope === 'user' ? params.scope : 'all';
  let boot = typeof params.boot === 'string' ? params.boot : 'this';
  let priority = typeof params.priority === 'number' ? params.priority : 7;
  let unit = typeof params.unit === 'string' ? params.unit : '';
  /** Only reachable from an entry's menu: a syslog tag with no unit behind it. */
  let identifier = typeof params.identifier === 'string' ? params.identifier : '';
  let grep = typeof params.grep === 'string' ? params.grep : '';
  let follow = params.follow !== false;

  let stream: Channel | null = null;
  /** Bumped on every restart; late messages from an old stream are ignored. */
  let generation = 0;
  let active = false;
  let debounce: number | null = null;

  let shown = 0;
  let matched = 0;
  let dropped = 0;
  let backlogDone = false;
  let selected: string | null = null;
  const entries = new Map<string, Entry>();

  /* ---------------------------------------------------------------- */
  /* Chrome                                                            */
  /* ---------------------------------------------------------------- */

  const scopeButtons = SCOPES.map((s) =>
    h('button', {
      class: `sysman-seg-btn${scope === s.id ? ' is-active' : ''}`,
      text: s.label,
      title: s.hint,
      dataset: { scope: s.id },
      on: {
        click: () => {
          if (scope === s.id) return;
          scope = s.id;
          for (const b of scopeButtons) b.classList.toggle('is-active', b.dataset.scope === scope);
          // Unit names do not carry across scopes, and the completions behind
          // the box belong to the scope that was showing.
          void loadUnits();
          restart();
        },
      },
    }),
  );

  const bootSelect = h('select', { class: 'sysman-select', title: 'Which boot to read' });
  bootSelect.addEventListener('change', () => {
    boot = bootSelect.value;
    void loadUnits();
    restart();
  });

  const prioritySelect = h('select', {
    class: 'sysman-select',
    title: 'Show this priority and everything more severe',
  });
  for (const p of PRIORITIES) {
    prioritySelect.appendChild(
      h('option', { attrs: { value: String(p.value) }, text: `${p.label} and above` }),
    );
  }
  prioritySelect.value = String(priority);
  prioritySelect.addEventListener('change', () => {
    priority = Number(prioritySelect.value);
    restart();
  });

  // A datalist rather than a drop-down: a machine can have hundreds of units,
  // and the useful gesture is typing three letters of the one you want.
  const unitList = h('datalist', { id: `sysman-journal-units-${Math.random().toString(36).slice(2)}` });
  const unitInput = h('input', {
    class: 'sysman-filter',
    attrs: {
      type: 'search',
      placeholder: 'Unit (e.g. ssh.service)',
      spellcheck: 'false',
      list: unitList.id,
    },
  });
  unitInput.value = unit;
  unitInput.addEventListener('input', () => schedule(() => {
    unit = unitInput.value.trim();
    restart();
  }));

  const grepInput = h('input', {
    class: 'sysman-filter',
    attrs: { type: 'search', placeholder: 'Search text or /regex/', spellcheck: 'false' },
  });
  grepInput.value = grep;
  grepInput.addEventListener('input', () => schedule(() => {
    grep = grepInput.value.trim();
    restart();
  }));

  // An identifier has no box of its own: it is picked from an entry, never
  // typed, so it shows up as something to take off again.
  const identChip = h('button', {
    class: 'sysman-jchip',
    title: 'Stop filtering by this identifier',
    on: {
      click: () => {
        identifier = '';
        syncIdentChip();
        restart();
      },
    },
  });

  const followButton = button('Follow', () => {
    follow = !follow;
    syncFollowButton();
    restart();
  }, { title: 'Keep the newest entries arriving as they are written' });

  const note = h('span', { class: 'sysman-toolbar-note' });
  const banner = h('div', { class: 'sysman-banner' });
  banner.hidden = true;

  const rows = h('div', { class: 'sysman-jrows', attrs: { role: 'log', tabindex: '0' } });
  const list = h('div', { class: 'sysman-jlist' }, rows);

  // "Jump to newest" only appears once scrolling up has actually parked the
  // view; a follow that yanks you back to the bottom mid-read is the thing
  // people hate most about log windows.
  const jump = h('button', {
    class: 'sysman-jjump',
    text: 'Jump to newest',
    on: { click: () => scrollToEnd() },
  });
  jump.hidden = true;
  list.appendChild(jump);

  const detailTitle = h('span', { class: 'sysman-detail-title', text: 'No entry selected' });
  const detailBody = h('div', { class: 'sysman-detail-body' });
  const detail = h(
    'aside',
    { class: 'sysman-detail' },
    h('div', { class: 'sysman-detail-head' }, detailTitle),
    detailBody,
  );

  const element = h(
    'div',
    { class: 'sysman-section' },
    toolbar(
      h('div', { class: 'sysman-seg' }, ...scopeButtons),
      bootSelect,
      prioritySelect,
      unitInput,
      identChip,
      grepInput,
      followButton,
      note,
    ),
    banner,
    h('div', { class: 'sysman-split' }, list, detail),
    unitList,
  );

  syncFollowButton();
  syncIdentChip();
  detailBody.replaceChildren(
    placeholder('Select an entry', 'Every field the journal recorded for it appears here.'),
  );

  function syncFollowButton(): void {
    followButton.classList.toggle('is-active', follow);
    followButton.textContent = follow ? 'Following' : 'Follow';
  }

  function syncIdentChip(): void {
    identChip.hidden = identifier === '';
    identChip.textContent = identifier ? `${identifier} ✕` : '';
  }

  function schedule(fn: () => void): void {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      if (!ctx.isDisposed()) fn();
    }, DEBOUNCE_MS);
  }

  /* ---------------------------------------------------------------- */
  /* Boots and unit completions                                        */
  /* ---------------------------------------------------------------- */

  function renderBoots(boots: Boot[]): void {
    const options: Array<{ value: string; label: string }> = [
      { value: 'this', label: 'This boot' },
    ];
    // Newest first: an older boot is a deliberate choice, the current one is
    // the default.
    for (const b of [...boots].reverse()) {
      if (b.index === 0) continue;
      options.push({ value: b.id, label: formatBootLabel(b) });
    }
    options.push({ value: 'all', label: 'All boots' });

    bootSelect.replaceChildren(
      ...options.map((o) => h('option', { attrs: { value: o.value }, text: o.label })),
    );
    // A saved boot id may belong to a boot that has since been rotated out.
    if (!options.some((o) => o.value === boot)) boot = 'this';
    bootSelect.value = boot;
  }

  async function loadBoots(): Promise<void> {
    renderBoots([]);
    try {
      const result = await desktop.rpc.call<{ boots: Boot[] }>('journal', 'boots', {});
      if (ctx.isDisposed()) return;
      renderBoots(result.boots);
    } catch {
      // Not fatal: "this boot" and "all boots" still work without the list.
    }
  }

  async function loadUnits(): Promise<void> {
    try {
      const field = scope === 'user' ? '_SYSTEMD_USER_UNIT' : '_SYSTEMD_UNIT';
      const result = await desktop.rpc.call<{ values: string[] }>('journal', 'fields', {
        field,
        scope,
        boot,
      });
      if (ctx.isDisposed()) return;
      unitList.replaceChildren(
        ...result.values.map((v) => h('option', { attrs: { value: v } })),
      );
    } catch {
      // Completions are a convenience; typing the name still works.
    }
  }

  /* ---------------------------------------------------------------- */
  /* The stream                                                        */
  /* ---------------------------------------------------------------- */

  function atBottom(): boolean {
    return rows.scrollHeight - rows.scrollTop - rows.clientHeight < 24;
  }

  function scrollToEnd(): void {
    rows.scrollTop = rows.scrollHeight;
    jump.hidden = true;
  }

  rows.addEventListener('scroll', () => {
    if (atBottom()) jump.hidden = true;
  });

  function restart(): void {
    if (!active) {
      // Nothing is on screen to update. Reopening happens on activate().
      close();
      return;
    }
    open();
  }

  function open(): void {
    close();
    generation++;
    const mine = generation;

    shown = 0;
    matched = 0;
    dropped = 0;
    backlogDone = false;
    entries.clear();
    rows.replaceChildren();
    jump.hidden = true;
    banner.hidden = true;
    updateNote('Reading…');

    stream = desktop.rpc.openChannel(
      'journal',
      'stream',
      {
        scope,
        boot,
        priority,
        unit: unit || undefined,
        identifier: identifier || undefined,
        grep: grep || undefined,
        lines: 1000,
        follow,
      },
      {
        onData: (data) => {
          if (ctx.isDisposed() || mine !== generation) return;
          handle(data as Record<string, unknown>);
        },
        onClose: (error) => {
          if (ctx.isDisposed() || mine !== generation) return;
          stream = null;
          if (error) {
            banner.hidden = false;
            banner.classList.remove('is-info');
            banner.textContent = error;
            updateNote('Stopped');
          } else {
            backlogDone = true;
            updateNote(follow ? 'Stream ended' : null);
          }
        },
      },
    );
  }

  function close(): void {
    stream?.close();
    stream = null;
  }

  function handle(data: Record<string, unknown>): void {
    if (data.type === 'entries') {
      const batch = (data.entries ?? []) as Entry[];
      if (typeof data.dropped === 'number') dropped += data.dropped;
      append(batch);
      return;
    }
    if (data.type === 'backlog') {
      backlogDone = true;
      // The backlog arrives oldest-first; land at the newest, which is what
      // the eye wants first.
      scrollToEnd();
      if (matched === 0) showEmpty();
      updateNote(null);
      return;
    }
    if (data.type === 'note' && typeof data.text === 'string') {
      // journalctl's own words — usually the hint that an unprivileged reader
      // is only being shown its own messages, which explains a short journal.
      banner.hidden = false;
      banner.classList.add('is-info');
      banner.textContent = data.text;
    }
  }

  function showEmpty(): void {
    rows.replaceChildren(
      placeholder(
        'Nothing matched',
        follow
          ? 'No entry in the journal matches these filters yet. Anything new that does will appear here.'
          : 'No entry in the journal matches these filters.',
      ),
    );
  }

  function append(batch: Entry[]): void {
    if (batch.length === 0) return;
    // The first real entry replaces whatever placeholder was standing in.
    if (matched === 0) rows.replaceChildren();

    const stick = atBottom();
    const frag = document.createDocumentFragment();
    for (const entry of batch) {
      matched++;
      entries.set(entry.cursor, entry);
      frag.appendChild(row(entry));
    }
    rows.appendChild(frag);
    shown += batch.length;

    // Trim from the front. A DOM with a whole boot in it scrolls like tar.
    while (shown > MAX_ROWS && rows.firstChild) {
      const gone = (rows.firstChild as HTMLElement).dataset?.cursor;
      if (gone) entries.delete(gone);
      rows.removeChild(rows.firstChild);
      shown--;
    }

    if (stick) scrollToEnd();
    else if (backlogDone) jump.hidden = false;
    updateNote(backlogDone ? null : 'Reading…');
  }

  function row(entry: Entry): HTMLElement {
    const source = entry.unit ?? entry.identifier ?? entry.transport ?? '';
    const el = h(
      'div',
      {
        class: `sysman-jrow prio-${entry.priority}${entry.cursor === selected ? ' is-selected' : ''}`,
        dataset: { cursor: entry.cursor },
        attrs: { tabindex: '-1' },
      },
      h('span', {
        class: 'sysman-jtime',
        text: formatTime(entry.time),
        title: new Date(entry.time).toLocaleString(),
      }),
      h('span', { class: 'sysman-jsource', text: source, title: source }),
      h('span', { class: 'sysman-jmsg', text: entry.message }),
    );
    el.addEventListener('click', () => select(entry.cursor));
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      select(entry.cursor);
      desktop.contextMenu(entryMenu(entry), { x: ev.clientX, y: ev.clientY });
    });
    return el;
  }

  function updateNote(text: string | null): void {
    const bits: string[] = [];
    if (text) bits.push(text);
    bits.push(`${matched.toLocaleString()} entries`);
    if (dropped > 0) bits.push(`${dropped.toLocaleString()} dropped`);
    note.textContent = bits.join(' · ');
    ctx.setStatus(
      `${matched.toLocaleString()} journal entries${follow ? ' · following' : ''}${
        dropped > 0 ? ` · ${dropped} dropped, faster than the browser could take them` : ''
      }`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Detail                                                            */
  /* ---------------------------------------------------------------- */

  function select(cursor: string | null): void {
    selected = cursor;
    for (const el of rows.querySelectorAll('.sysman-jrow')) {
      el.classList.toggle('is-selected', (el as HTMLElement).dataset.cursor === cursor);
    }
    if (!cursor) {
      detailTitle.textContent = 'No entry selected';
      detailBody.replaceChildren(
        placeholder('Select an entry', 'Every field the journal recorded for it appears here.'),
      );
      return;
    }
    void loadEntry(cursor);
  }

  /** Shown first, in this order; everything else follows alphabetically. */
  const LEADING = [
    'MESSAGE',
    'PRIORITY',
    '_SYSTEMD_UNIT',
    '_SYSTEMD_USER_UNIT',
    'SYSLOG_IDENTIFIER',
    '_PID',
    '_UID',
    '_COMM',
    '_EXE',
    '_CMDLINE',
    '_HOSTNAME',
    '_TRANSPORT',
    '_BOOT_ID',
  ];

  async function loadEntry(cursor: string): Promise<void> {
    const known = entries.get(cursor);
    detailTitle.textContent = known ? formatTime(known.time) : 'Entry';
    detailBody.replaceChildren(placeholder('Loading…'));
    try {
      const result = await desktop.rpc.call<{ fields: Record<string, string> }>(
        'journal',
        'entry',
        { cursor },
      );
      if (ctx.isDisposed() || selected !== cursor) return;

      const names = Object.keys(result.fields)
        // The double-underscore fields are journalctl's own bookkeeping, and
        // the cursor is already on screen as the timestamp.
        .filter((k) => !k.startsWith('__'))
        .sort((a, b) => {
          const ai = LEADING.indexOf(a);
          const bi = LEADING.indexOf(b);
          if (ai >= 0 && bi >= 0) return ai - bi;
          if (ai >= 0) return -1;
          if (bi >= 0) return 1;
          return a.localeCompare(b);
        });

      detailBody.replaceChildren(
        ...names.map((name) =>
          h(
            'div',
            { class: 'sysman-field' },
            h('div', { class: 'sysman-field-label', text: name }),
            h('div', { class: 'sysman-field-value', text: result.fields[name] }),
          ),
        ),
        h(
          'div',
          { class: 'sysman-detail-actions' },
          button('Copy entry', () => void copyEntry(result.fields)),
          known?.unit
            ? button(`Only ${known.unit}`, () => {
                unit = known.unit!;
                unitInput.value = unit;
                restart();
              })
            : null,
        ),
      );
    } catch (err) {
      if (ctx.isDisposed() || selected !== cursor) return;
      detailBody.replaceChildren(placeholder('Could not read that entry', describeError(err)));
    }
  }

  async function copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      desktop.notify({ kind: 'success', message: `${what} copied.`, timeout: 2000 });
    } catch {
      // Clipboard access needs a secure context; over plain http it is refused.
      desktop.notify({
        kind: 'error',
        title: 'Could not copy',
        message: 'The browser refused clipboard access. This needs an https connection.',
        timeout: 0,
      });
    }
  }

  function copyEntry(fields: Record<string, string>): Promise<void> {
    const text = Object.entries(fields)
      .filter(([k]) => !k.startsWith('__'))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    return copy(text, 'Entry');
  }

  function visibleText(): string {
    return [...rows.querySelectorAll('.sysman-jrow')]
      .map((el) => {
        const entry = entries.get((el as HTMLElement).dataset.cursor ?? '');
        if (!entry) return '';
        const source = entry.unit ?? entry.identifier ?? '';
        return `${new Date(entry.time).toISOString()} ${source}${
          entry.pid ? `[${entry.pid}]` : ''
        }: ${entry.message}`;
      })
      .filter((line) => line.length > 0)
      .join('\n');
  }

  function save(): void {
    const blob = new Blob([`${visibleText()}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = h('a', { attrs: { href: url, download: 'journal.txt' } });
    anchor.click();
    // Revoked on the next turn: doing it immediately can beat the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function entryMenu(entry: Entry): MenuItem[] {
    const source = entry.unit ?? entry.identifier;
    return [
      { type: 'header', label: formatTime(entry.time) },
      { label: 'Copy message', onSelect: () => void copy(entry.message, 'Message') },
      ...(source
        ? [
            { type: 'separator' as const },
            {
              label: `Show only ${source}`,
              onSelect: () => {
                if (entry.unit) {
                  unit = entry.unit;
                  unitInput.value = unit;
                } else {
                  identifier = source;
                  syncIdentChip();
                }
                restart();
              },
            },
          ]
        : []),
      ...(entry.unit
        ? [
            {
              label: `Manage ${entry.unit}`,
              onSelect: () => ctx.goto('services', { unit: entry.unit, scope }),
            },
          ]
        : []),
      ...(entry.pid
        ? [
            {
              label: `Show process ${entry.pid}`,
              onSelect: () => ctx.goto('processes', { filter: String(entry.pid) }),
            },
          ]
        : []),
    ];
  }

  /* ---------------------------------------------------------------- */
  /* Section                                                           */
  /* ---------------------------------------------------------------- */

  void loadBoots().then(() => loadUnits());

  return {
    element,

    applyParams(next: Record<string, unknown>) {
      let changed = false;
      if (typeof next.unit === 'string') {
        unit = next.unit;
        unitInput.value = unit;
        changed = true;
      }
      if (typeof next.identifier === 'string') {
        identifier = next.identifier;
        syncIdentChip();
        changed = true;
      }
      if (typeof next.grep === 'string') {
        grep = next.grep;
        grepInput.value = grep;
        changed = true;
      }
      if (typeof next.priority === 'number') {
        priority = next.priority;
        prioritySelect.value = String(priority);
        changed = true;
      }
      if (changed) restart();
    },

    activate() {
      active = true;
      open();
    },

    deactivate() {
      active = false;
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = null;
      // journalctl on the host must not outlive a panel nobody is watching.
      close();
    },

    menu: () => [
      { label: 'Refresh now', accelerator: 'F5', onSelect: () => restart() },
      {
        label: 'Follow new entries',
        checked: follow,
        onSelect: () => {
          follow = !follow;
          syncFollowButton();
          restart();
        },
      },
      { type: 'separator' },
      ...PRIORITIES.map((p) => ({
        label: `${p.label} and above`,
        checked: priority === p.value,
        onSelect: () => {
          priority = p.value;
          prioritySelect.value = String(priority);
          restart();
        },
      })),
      { type: 'separator' },
      { label: 'Copy visible entries', onSelect: () => void copy(visibleText(), 'Entries') },
      { label: 'Save visible entries…', onSelect: () => save() },
      {
        label: 'Clear filters',
        disabled:
          !unit && !identifier && !grep && priority === 7 && scope === 'all' && boot === 'this',
        onSelect: () => {
          unit = '';
          identifier = '';
          grep = '';
          priority = 7;
          scope = 'all';
          boot = 'this';
          unitInput.value = '';
          grepInput.value = '';
          prioritySelect.value = '7';
          bootSelect.value = 'this';
          syncIdentChip();
          for (const b of scopeButtons) b.classList.toggle('is-active', b.dataset.scope === 'all');
          restart();
        },
      },
    ],

    saveState: () => ({ scope, boot, priority, unit, identifier, grep, follow }),

    destroy() {
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = null;
      close();
    },
  };
}

export const journalSection: SectionDef = {
  id: 'journal',
  title: 'Journal',
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 4h13l3 3v13H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>
  </svg>`,
  requires: ['journal'],
  create: createJournal,
};
