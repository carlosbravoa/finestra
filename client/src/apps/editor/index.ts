import { h } from '../../core/dom';
import { RpcError } from '../../core/rpc';
import type { AppContext, AppInstance, AppManifest, MenuItem } from '../../core/types';
import './editor.css';

const EDITOR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/>
  <path d="M14 3l5 5v3"/>
  <path d="M20.4 13.6a1.4 1.4 0 0 1 0 2L15 21l-2.8.6.6-2.8 5.4-5.2a1.4 1.4 0 0 1 2.2 0z"/>
</svg>`;

const FONT_SIZES = [11, 12, 13, 14, 16, 18, 20, 24];
const DEFAULT_FONT_SIZE = 13;
const TAB_SIZES = [2, 4, 8];

/** Past this, one element per line costs more than the numbers are worth. */
const WRAPPED_GUTTER_LINE_LIMIT = 20000;
/** An unsaved buffer larger than this is not carried across a reload. */
const MAX_DRAFT_CHARS = 256 * 1024;
/** Enough matches to navigate; more would just be a runaway scan. */
const MAX_MATCHES = 5000;

/** Params come from `launch()` or from our own `saveState()`; validate them. */
interface EditorParams {
  path?: unknown;
  /** The unsaved buffer from the last session, when it was small enough. */
  draft?: unknown;
  selectionStart?: unknown;
  scrollTop?: unknown;
}

interface ReadResult {
  path: string;
  size: number;
  content: string;
}

interface StatResult {
  path: string;
  mtime: number;
  size: number;
}

interface FindState {
  query: string;
  caseSensitive: boolean;
  /** null when the matches need recomputing. */
  matches: number[] | null;
  index: number;
}

async function mount(ctx: AppContext): Promise<AppInstance> {
  const { window: win, root, desktop, params } = ctx;
  const options = params as EditorParams;

  /** Set in destroy; every continuation after an await must check it. */
  let disposed = false;
  /** Teardown functions, run in reverse on destroy. */
  const cleanup: Array<() => void> = [];

  /** null while the buffer has never been given a name. */
  let path: string | null = str(options.path) ?? null;
  /** What is believed to be on disk, so `dirty` is a comparison and not a flag. */
  let savedContent = '';
  let dirty = false;
  /** Set for binary files and for files that could not be read at all. */
  let readOnly = false;
  /** A named buffer with nothing on disk behind it yet. */
  let missing = false;
  let knownMtime: number | null = null;

  let fontSize = DEFAULT_FONT_SIZE;
  let wordWrap = false;
  let lineNumbers = true;
  let tabSize = 4;
  let insertSpaces = true;
  /** Kept in step with --editor-line-height, for scroll arithmetic. */
  let lineHeight = 20;
  /** The textarea's top padding, the origin scrollTop measures from. */
  let padY = 8;

  /** null forces a full gutter rebuild, e.g. after the wrap mode changed. */
  let gutterMode: 'plain' | 'wrapped' | null = null;
  let gutterCount = -1;
  /** The lines the wrapped gutter currently shows, for diffing against. */
  let gutterLines: string[] | null = null;
  let layoutFrame = 0;

  const find: FindState = { query: '', caseSensitive: false, matches: null, index: -1 };

  /* ---------------------------------------------------------------- */
  /* UI                                                                */
  /* ---------------------------------------------------------------- */

  const textarea = h('textarea', {
    class: 'editor-text',
    attrs: {
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      'aria-label': 'File contents',
    },
  });

  const gutterInner = h('div', { class: 'editor-gutter-inner' });
  const gutter = h('div', { class: 'editor-gutter', attrs: { 'aria-hidden': 'true' } }, gutterInner);

  const saveButton = toolButton('Save', 'Save this file (Ctrl+S)', () => void save());
  const toolbar = h(
    'div',
    { class: 'editor-toolbar' },
    toolButton('New', 'Start an empty buffer', () => void newFile()),
    toolButton('Open…', 'Open a file by path (Ctrl+O)', () => void openPrompt()),
    saveButton,
    toolButton('Save as…', 'Save under another name (Ctrl+Shift+S)', () => void saveAs()),
    h('div', { class: 'editor-spacer' }),
    toolButton('Find', 'Find and replace (Ctrl+F)', () => openFind(false)),
  );

  const banner = h('div', { class: 'editor-banner', attrs: { hidden: '' } });

  const findInput = h('input', {
    class: 'editor-find-input',
    attrs: { type: 'text', placeholder: 'Find', spellcheck: 'false', 'aria-label': 'Find' },
  });
  const replaceInput = h('input', {
    class: 'editor-find-input',
    attrs: {
      type: 'text',
      placeholder: 'Replace with',
      spellcheck: 'false',
      'aria-label': 'Replace with',
    },
  });
  const findCount = h('span', { class: 'editor-find-count' });
  const caseButton = h('button', {
    class: 'editor-find-toggle',
    text: 'Aa',
    title: 'Match case',
    on: {
      click: () => {
        find.caseSensitive = !find.caseSensitive;
        caseButton.classList.toggle('is-active', find.caseSensitive);
        find.matches = null;
        updateFindCount();
      },
    },
  });

  const replaceRow = h(
    'div',
    { class: 'editor-find-row', attrs: { hidden: '' } },
    replaceInput,
    findButton('Replace', () => replaceCurrent()),
    findButton('All', () => replaceAll()),
  );

  const findBar = h(
    'div',
    { class: 'editor-find', attrs: { hidden: '' } },
    h(
      'div',
      { class: 'editor-find-row' },
      findInput,
      caseButton,
      findButton('‹', () => step(-1), 'Previous match (Shift+Enter)'),
      findButton('›', () => step(1), 'Next match (Enter)'),
      findCount,
      h('div', { class: 'editor-spacer' }),
      findButton('✕', () => closeFind(), 'Close (Escape)'),
    ),
    replaceRow,
  );

  const app = h(
    'div',
    { class: 'editor-app' },
    toolbar,
    banner,
    findBar,
    h('div', { class: 'editor-main' }, gutter, textarea),
  );
  root.replaceChildren(app);

  /* ---------------------------------------------------------------- */
  /* Preferences                                                       */
  /* ---------------------------------------------------------------- */

  function applyPreferences(): void {
    // Settings are user-editable localStorage, so every value is checked
    // against what this app actually supports.
    const storedSize = desktop.settings.get('editor.fontSize', DEFAULT_FONT_SIZE);
    fontSize = FONT_SIZES.includes(storedSize) ? storedSize : DEFAULT_FONT_SIZE;
    wordWrap = desktop.settings.get<unknown>('editor.wordWrap', false) === true;
    lineNumbers = desktop.settings.get<unknown>('editor.lineNumbers', true) !== false;
    const storedTab = desktop.settings.get('editor.tabSize', 4);
    tabSize = TAB_SIZES.includes(storedTab) ? storedTab : 4;
    insertSpaces = desktop.settings.get<unknown>('editor.insertSpaces', true) !== false;

    // An integer line height keeps the gutter from drifting out of step with
    // the textarea over a few hundred lines of sub-pixel rounding.
    lineHeight = Math.round(fontSize * 1.55);
    app.style.setProperty('--editor-font-size', `${fontSize}px`);
    app.style.setProperty('--editor-line-height', `${lineHeight}px`);
    app.style.setProperty('--editor-tab-size', String(tabSize));
    app.classList.toggle('is-wrapped', wordWrap);
    // CSS drives the wrapping; the attribute keeps the textarea's own soft-wrap
    // behaviour in agreement with it.
    textarea.wrap = wordWrap ? 'soft' : 'off';

    gutterMode = null;
    scheduleLayout();
  }

  for (const key of [
    'editor.fontSize',
    'editor.wordWrap',
    'editor.lineNumbers',
    'editor.tabSize',
    'editor.insertSpaces',
  ]) {
    // Preferences are shared, so a change made in one window reaches the rest.
    cleanup.push(desktop.settings.watch(key, () => !disposed && applyPreferences()));
  }

  applyPreferences();

  /* ---------------------------------------------------------------- */
  /* Layout: gutter, metrics, status                                   */
  /* ---------------------------------------------------------------- */

  function scheduleLayout(): void {
    if (layoutFrame || disposed) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      if (disposed) return;
      // A minimized window measures as zero; onFocus reruns this once it has a
      // size again.
      if (textarea.clientWidth > 0 && textarea.clientHeight > 0) {
        syncMetrics();
        renderGutter();
      }
      updateStatus();
      if (!findBar.hidden) updateFindCount();
    });
  }

  function syncMetrics(): void {
    const style = getComputedStyle(textarea);
    padY = parseFloat(style.paddingTop) || 0;
    // The gutter's invisible rows have to wrap at exactly the width the
    // textarea wraps at, which excludes its padding and its scrollbar.
    const width =
      textarea.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    app.style.setProperty('--editor-wrap-width', `${Math.max(0, width)}px`);
  }

  function renderGutter(): void {
    const value = textarea.value;
    const count = countLines(value);

    // With wrapping on, every line needs its own element to inherit the right
    // height — which is too much DOM for a very large file.
    if (!lineNumbers || (wordWrap && count > WRAPPED_GUTTER_LINE_LIMIT)) {
      gutter.hidden = true;
      gutterMode = null;
      gutterLines = null;
      return;
    }
    gutter.hidden = false;

    // The number column is inset from the left and stops 10px short of the
    // text, so the digits stay right-aligned as the file grows past a decade.
    const digits = Math.max(2, String(count).length);
    app.style.setProperty('--editor-number-width', `calc(${digits}ch + 10px)`);
    app.style.setProperty('--editor-gutter-width', `calc(${digits}ch + 20px)`);

    if (!wordWrap) {
      if (gutterMode !== 'plain' || gutterCount !== count) {
        gutterMode = 'plain';
        gutterCount = count;
        gutterLines = null;
        gutterInner.classList.remove('is-wrapped');
        // One text node: unwrapped lines are all exactly one line high, so
        // there is nothing to measure and nothing to keep in sync.
        const numbers: string[] = [];
        for (let i = 1; i <= count; i++) numbers.push(String(i));
        gutterInner.textContent = numbers.join('\n');
      }
      return;
    }

    if (gutterMode !== 'wrapped') {
      gutterMode = 'wrapped';
      gutterLines = null;
      gutterInner.classList.add('is-wrapped');
    }
    patchRows(value.split('\n'));
  }

  /**
   * Each row carries its line's own text, invisibly, at the same width the
   * textarea wraps at — so it comes out exactly as tall as the line it labels,
   * with no measurement anywhere. The number itself is drawn over the text by
   * CSS, which also does the counting, so inserting a line renumbers nothing.
   */
  function patchRows(lines: string[]): void {
    const previous = gutterLines;
    gutterLines = lines;

    if (!previous) {
      const fragment = document.createDocumentFragment();
      for (const line of lines) fragment.appendChild(rowFor(line));
      gutterInner.replaceChildren(fragment);
      return;
    }

    // Typing changes one line, so patch the span that actually differs rather
    // than rebuilding thousands of rows on every keystroke.
    const shorter = Math.min(previous.length, lines.length);
    let head = 0;
    while (head < shorter && previous[head] === lines[head]) head++;
    let tail = 0;
    while (
      tail < shorter - head &&
      previous[previous.length - 1 - tail] === lines[lines.length - 1 - tail]
    ) {
      tail++;
    }

    const removals = previous.length - tail - head;
    const children = gutterInner.children;
    for (let i = 0; i < removals; i++) gutterInner.removeChild(children[head]);

    const additions = lines.slice(head, lines.length - tail);
    if (additions.length) {
      const fragment = document.createDocumentFragment();
      for (const line of additions) fragment.appendChild(rowFor(line));
      gutterInner.insertBefore(fragment, children[head] ?? null);
    }
  }

  function rowFor(line: string): HTMLElement {
    return h('div', { class: 'editor-gutter-row', text: line });
  }

  textarea.addEventListener('scroll', () => {
    gutterInner.style.transform = `translateY(${-textarea.scrollTop}px)`;
  });

  function updateStatus(): void {
    const value = textarea.value;
    const start = textarea.selectionStart;
    const line = lineIndexAt(value, start) + 1;
    const column = start - (value.lastIndexOf('\n', start - 1) + 1) + 1;
    const selected = textarea.selectionEnd - start;

    const parts = [
      path ?? 'Untitled',
      `Ln ${line}, Col ${column}`,
      selected > 0 ? `${selected} selected` : null,
      `${countLines(value)} lines`,
      readOnly ? 'read-only' : null,
      missing ? 'new file' : null,
    ].filter(Boolean);
    win.setStatus(parts.join('  ·  '));
  }

  /* ---------------------------------------------------------------- */
  /* Buffer state                                                      */
  /* ---------------------------------------------------------------- */

  function setBanner(message: string | null, action?: { label: string; run(): void }): void {
    if (message === null) {
      banner.hidden = true;
      banner.replaceChildren();
    } else {
      banner.hidden = false;
      banner.replaceChildren(h('span', { class: 'editor-banner-text', text: message }));
      if (action) {
        banner.appendChild(
          h('button', {
            class: 'editor-banner-action',
            text: action.label,
            on: { click: action.run },
          }),
        );
      }
    }
    // Showing or hiding the banner changes how much room the text has.
    scheduleLayout();
  }

  function refreshDirty(): void {
    const next = textarea.value !== savedContent;
    if (next === dirty) return;
    dirty = next;
    saveButton.disabled = readOnly;
    updateTitle();
  }

  function updateTitle(): void {
    const name = path ? basename(path) : 'Untitled';
    win.setTitle(`${dirty ? '• ' : ''}${name} — Text Editor`);
  }

  function setReadOnly(value: boolean): void {
    readOnly = value;
    textarea.readOnly = value;
    saveButton.disabled = value;
  }

  /** Replaces the buffer and treats the result as what is on disk. */
  function setContent(content: string): void {
    textarea.value = content;
    savedContent = content;
    dirty = false;
    gutterMode = null;
    gutterCount = -1;
    gutterLines = null;
    find.matches = null;
    updateTitle();
    scheduleLayout();
  }

  function onInput(): void {
    refreshDirty();
    find.matches = null;
    scheduleLayout();
  }

  textarea.addEventListener('input', onInput);
  for (const event of ['keyup', 'click', 'select', 'focus']) {
    textarea.addEventListener(event, () => scheduleLayout());
  }

  /* ---------------------------------------------------------------- */
  /* Editing primitives                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Replaces a range through `insertText`, which is the only way to change a
   * textarea without throwing away the browser's own undo history.
   */
  function replaceRange(start: number, end: number, text: string): void {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    if (document.execCommand('insertText', false, text)) return;

    // Some browsers refuse; the edit still has to happen, undo or no undo.
    const value = textarea.value;
    textarea.value = value.slice(0, start) + text + value.slice(end);
    textarea.setSelectionRange(start + text.length, start + text.length);
    onInput();
  }

  function insert(text: string): void {
    replaceRange(textarea.selectionStart, textarea.selectionEnd, text);
  }

  function indentUnit(): string {
    return insertSpaces ? ' '.repeat(tabSize) : '\t';
  }

  function shiftLines(direction: 1 | -1): void {
    const value = textarea.value;
    const start = value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
    const lineEnd = value.indexOf('\n', textarea.selectionEnd);
    const end = lineEnd === -1 ? value.length : lineEnd;
    const unit = indentUnit();

    const next = value
      .slice(start, end)
      .split('\n')
      .map((line) => {
        if (direction === 1) return unit + line;
        if (line.startsWith(unit)) return line.slice(unit.length);
        if (line.startsWith('\t')) return line.slice(1);
        return line.replace(new RegExp(`^ {1,${tabSize}}`), '');
      })
      .join('\n');

    replaceRange(start, end, next);
    textarea.setSelectionRange(start, start + next.length);
  }

  textarea.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    if (ev.key === 'Tab') {
      // In a buffer that cannot be edited there is nothing to indent, so Tab
      // keeps its usual meaning and moves on.
      if (readOnly) return;
      // Otherwise Tab indents rather than moving focus; Escape below is the way
      // out for anyone navigating by keyboard.
      ev.preventDefault();
      if (ev.shiftKey || textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).includes('\n')) {
        shiftLines(ev.shiftKey ? -1 : 1);
      } else {
        insert(indentUnit());
      }
      return;
    }

    if (ev.key === 'Escape') {
      // Leaves the text, so Tab reaches the rest of the window again.
      ev.preventDefault();
      textarea.blur();
      return;
    }

    if (ev.key === 'Enter' && !ev.shiftKey && !readOnly) {
      const value = textarea.value;
      const start = textarea.selectionStart;
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(lineStart, start))?.[0] ?? '';
      // An unindented line is left to the browser, keeping undo granular.
      if (!indent) return;
      ev.preventDefault();
      insert(`\n${indent}`);
    }
  });

  /* ---------------------------------------------------------------- */
  /* Scrolling                                                         */
  /* ---------------------------------------------------------------- */

  function scrollOffsetIntoView(offset: number): void {
    const index = lineIndexAt(textarea.value, offset);
    const row = gutterInner.children[index] as HTMLElement | undefined;
    // In wrapped mode the gutter row already knows where the line landed;
    // otherwise every line is exactly one line high.
    const top =
      gutterMode === 'wrapped' && row ? row.offsetTop : padY + index * lineHeight;

    const view = textarea.clientHeight;
    if (view === 0) return;
    if (top < textarea.scrollTop || top > textarea.scrollTop + view - lineHeight * 2) {
      textarea.scrollTop = Math.max(0, top - Math.floor(view / 3));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Find and replace                                                  */
  /* ---------------------------------------------------------------- */

  /** Offsets of every match, up to `limit`. */
  function scan(limit: number): number[] {
    const found: number[] = [];
    if (!find.query) return found;
    const haystack = find.caseSensitive ? textarea.value : textarea.value.toLowerCase();
    const needle = find.caseSensitive ? find.query : find.query.toLowerCase();
    let at = haystack.indexOf(needle);
    while (at !== -1 && found.length < limit) {
      found.push(at);
      at = haystack.indexOf(needle, at + needle.length);
    }
    return found;
  }

  /** The navigable matches, which are capped — see `scan` for the full set. */
  function matches(): number[] {
    if (!find.matches) find.matches = scan(MAX_MATCHES);
    return find.matches;
  }

  function updateFindCount(): void {
    const all = matches();
    if (!find.query) findCount.textContent = '';
    else if (all.length === 0) findCount.textContent = 'No results';
    else {
      const total = all.length === MAX_MATCHES ? `${MAX_MATCHES}+` : String(all.length);
      findCount.textContent = `${find.index >= 0 ? find.index + 1 : '–'} of ${total}`;
    }
  }

  function selectMatch(index: number): void {
    const all = matches();
    if (!all.length) return;
    find.index = ((index % all.length) + all.length) % all.length;
    const start = all[find.index];
    textarea.focus();
    textarea.setSelectionRange(start, start + find.query.length);
    scrollOffsetIntoView(start);
    updateFindCount();
    // Keep typing in the find field rather than in the document.
    if (!findBar.hidden) findInput.focus();
  }

  /** Moves to the next or previous match, starting from the caret. */
  function step(direction: 1 | -1): void {
    const all = matches();
    if (!all.length) {
      updateFindCount();
      return;
    }
    if (find.index === -1) {
      const from = textarea.selectionStart;
      const forward = all.findIndex((at) => at >= from);
      selectMatch(direction === 1 ? (forward === -1 ? 0 : forward) : (forward === -1 ? all.length - 1 : forward - 1));
      return;
    }
    selectMatch(find.index + direction);
  }

  function replaceCurrent(): void {
    if (readOnly) return;
    const all = matches();
    if (find.index < 0 || find.index >= all.length) {
      step(1);
      return;
    }
    const start = all[find.index];
    const at = find.index;
    replaceRange(start, start + find.query.length, replaceInput.value);
    find.matches = null;
    // The replacement may itself contain the query, so resume after it.
    const resumed = matches().findIndex((offset) => offset >= start + replaceInput.value.length);
    find.index = -1;
    if (resumed !== -1) selectMatch(resumed);
    else if (matches().length) selectMatch(Math.min(at, matches().length - 1));
    else updateFindCount();
  }

  function replaceAll(): void {
    if (readOnly) return;
    // Uncapped: the navigation list is limited, but "all" has to mean all.
    const all = scan(Number.POSITIVE_INFINITY);
    if (!all.length) return;

    const value = textarea.value;
    const replacement = replaceInput.value;
    let out = '';
    let cursor = 0;
    for (const at of all) {
      out += value.slice(cursor, at) + replacement;
      cursor = at + find.query.length;
    }
    out += value.slice(cursor);

    const scrollTop = textarea.scrollTop;
    replaceRange(0, value.length, out);
    textarea.scrollTop = scrollTop;
    find.matches = null;
    find.index = -1;
    updateFindCount();
    desktop.notify({
      message: `Replaced ${all.length} occurrence${all.length === 1 ? '' : 's'}.`,
      kind: 'success',
      timeout: 2500,
    });
  }

  function openFind(replace: boolean): void {
    const selection = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    if (selection && !selection.includes('\n')) {
      findInput.value = selection;
      find.query = selection;
      find.matches = null;
      find.index = -1;
    }
    findBar.hidden = false;
    replaceRow.hidden = !replace;
    scheduleLayout();
    findInput.focus();
    findInput.select();
    updateFindCount();
  }

  function closeFind(): void {
    findBar.hidden = true;
    scheduleLayout();
    textarea.focus();
  }

  findInput.addEventListener('input', () => {
    find.query = findInput.value;
    find.matches = null;
    find.index = -1;
    updateFindCount();
    if (find.query) step(1);
  });

  for (const input of [findInput, replaceInput]) {
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeFind();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        if (input === replaceInput) replaceCurrent();
        else step(ev.shiftKey ? -1 : 1);
      }
    });
  }

  async function goToLine(): Promise<void> {
    const answer = await desktop.prompt({
      title: 'Go to line',
      message: `Line number (1–${countLines(textarea.value)}):`,
      value: String(lineIndexAt(textarea.value, textarea.selectionStart) + 1),
      confirmLabel: 'Go',
    });
    if (answer === null || disposed) return;
    const wanted = Number.parseInt(answer.trim(), 10);
    if (!Number.isFinite(wanted) || wanted < 1) return;

    const value = textarea.value;
    let offset = 0;
    for (let i = 1; i < wanted; i++) {
      const next = value.indexOf('\n', offset);
      if (next === -1) {
        offset = value.length;
        break;
      }
      offset = next + 1;
    }
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    scrollOffsetIntoView(offset);
    scheduleLayout();
  }

  /* ---------------------------------------------------------------- */
  /* Files                                                             */
  /* ---------------------------------------------------------------- */

  async function load(target: string): Promise<void> {
    win.setStatus('Opening…');
    try {
      const result = await desktop.rpc.call<ReadResult>('fs', 'read', {
        path: target,
        encoding: 'utf8',
      });
      if (disposed) return;

      path = result.path;
      missing = false;
      setContent(result.content);

      if (looksBinary(result.content)) {
        setReadOnly(true);
        setBanner('This file contains binary data. Editing is disabled so it cannot be corrupted.');
      } else {
        setReadOnly(false);
        setBanner(null);
      }
      void refreshMtime();
    } catch (err) {
      if (disposed) return;

      if (err instanceof RpcError && err.code === 'ENOENT') {
        // Opening a path that does not exist yet is a reasonable way to start
        // a new file, so keep it editable and say what will happen on save.
        path = target;
        missing = true;
        knownMtime = null;
        setReadOnly(false);
        setContent('');
        setBanner('Nothing is at this path yet. Saving will create it.');
        return;
      }

      path = target;
      // Refuse to edit what could not be read: saving would replace it with an
      // empty buffer.
      setReadOnly(true);
      setContent('');
      setBanner(describeError(err), { label: 'Try again', run: () => void load(target) });
      updateTitle();
    }
  }

  /** Keeps our own writes from looking like somebody else's change. */
  async function refreshMtime(): Promise<void> {
    if (!path) return;
    try {
      const stat = await desktop.rpc.call<StatResult>('fs', 'stat', { path });
      if (!disposed) knownMtime = stat.mtime;
    } catch {
      // Not knowing the mtime only costs us the external-change check.
    }
  }

  async function checkExternalChange(): Promise<void> {
    if (!path || knownMtime === null || readOnly || disposed) return;
    let stat: StatResult;
    try {
      stat = await desktop.rpc.call<StatResult>('fs', 'stat', { path });
    } catch {
      return;
    }
    if (disposed || stat.mtime === knownMtime) return;
    knownMtime = stat.mtime;

    if (!dirty) {
      const at = textarea.selectionStart;
      const scrollTop = textarea.scrollTop;
      await load(path);
      if (disposed) return;
      textarea.setSelectionRange(at, at);
      textarea.scrollTop = scrollTop;
      desktop.notify({ message: 'Reloaded: the file changed on disk.', kind: 'info', timeout: 3000 });
      return;
    }

    setBanner('This file changed on disk. Saving will overwrite those changes.', {
      label: 'Discard mine and reload',
      run: () => void revert(),
    });
  }

  async function save(): Promise<boolean> {
    if (readOnly) return false;
    if (!path) return saveAs();

    const content = textarea.value;
    try {
      await desktop.rpc.call('fs', 'write', { path, content, encoding: 'utf8' });
      if (disposed) return true;
      savedContent = content;
      missing = false;
      refreshDirty();
      updateTitle();
      setBanner(null);
      await refreshMtime();
      if (!disposed) updateStatus();
      return true;
    } catch (err) {
      if (!disposed) {
        desktop.notify({ title: 'Could not save', message: describeError(err), kind: 'error' });
      }
      return false;
    }
  }

  async function saveAs(): Promise<boolean> {
    const suggestion = path ?? joinPath(desktop.host?.home ?? '~', 'untitled.txt');
    const answer = await desktop.prompt({
      title: 'Save as',
      message: 'Save this file to:',
      value: suggestion,
      confirmLabel: 'Save',
    });
    if (answer === null || disposed) return false;
    const target = answer.trim();
    if (!target) return false;

    // Warn about clobbering anything but the file already being edited — and
    // about that one too when it never loaded, since the buffer is not it.
    if (target !== path || readOnly) {
      const existing = await desktop.rpc
        .call<StatResult>('fs', 'stat', { path: target })
        .catch(() => null);
      if (disposed) return false;
      if (existing) {
        const ok = await desktop.confirm({
          title: 'Replace file',
          message: `"${basename(target)}" already exists. Replace it?`,
          confirmLabel: 'Replace',
          danger: true,
        });
        if (!ok || disposed) return false;
      }
    }

    path = target;
    knownMtime = null;
    setReadOnly(false);
    updateTitle();
    return save();
  }

  async function revert(): Promise<void> {
    if (!path) return;
    if (dirty) {
      const ok = await desktop.confirm({
        title: 'Discard changes',
        message: `Reload "${basename(path)}" from disk and lose the changes made here?`,
        confirmLabel: 'Discard and reload',
        danger: true,
      });
      if (!ok || disposed) return;
    }
    await load(path);
  }

  /** True when it is safe to throw the current buffer away. */
  async function confirmDiscard(): Promise<boolean> {
    if (!dirty) return true;
    return desktop.confirm({
      title: 'Unsaved changes',
      message: `"${path ? basename(path) : 'Untitled'}" has unsaved changes. They will be lost.`,
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      danger: true,
    });
  }

  async function newFile(): Promise<void> {
    if (!(await confirmDiscard()) || disposed) return;
    path = null;
    missing = false;
    knownMtime = null;
    setReadOnly(false);
    setBanner(null);
    setContent('');
    textarea.focus();
  }

  async function openPrompt(): Promise<void> {
    const answer = await desktop.prompt({
      title: 'Open file',
      message: 'Path of the file to open:',
      value: path ? dirname(path) + '/' : joinPath(desktop.host?.home ?? '~', ''),
      placeholder: '/home/you/notes.txt',
      confirmLabel: 'Open',
    });
    if (answer === null || disposed) return;
    const target = answer.trim();
    if (!target) return;
    if (!(await confirmDiscard()) || disposed) return;
    await load(target);
  }

  /* ---------------------------------------------------------------- */
  /* Clipboard                                                         */
  /* ---------------------------------------------------------------- */

  // The desktop's clipboard, not the browser's: over plain http the browser
  // refuses, and the cut text still has to reach the terminal next door.
  async function copySelection(cut: boolean): Promise<void> {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) return;
    await desktop.clipboard.write(textarea.value.slice(start, end));
    if (cut && !readOnly && !disposed) replaceRange(start, end, '');
  }

  async function pasteClipboard(): Promise<void> {
    if (readOnly) return;
    const text = await desktop.clipboard.read();
    if (text && !disposed) insert(text);
  }

  // A plain Ctrl+V inserts whatever the *browser* holds, which is the stale
  // copy whenever the last one was made in another window of this desktop and
  // the browser would not take it. Substitute, and leave the event alone when
  // the two agree so the browser's own undo entry is kept.
  textarea.addEventListener('paste', (ev) => {
    const text = desktop.clipboard.fromEvent(ev);
    if (readOnly || !text || text === ev.clipboardData?.getData('text/plain')) return;
    ev.preventDefault();
    insert(text);
  });

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  // Bound to this window's own subtree rather than the global registry, so the
  // shortcuts act on the editor the user is actually typing in.
  //
  // There is deliberately no Ctrl+N: the browser reserves it for a new window
  // and a page cannot take it back, so New is a button and a menu item only.
  root.addEventListener('keydown', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    const key = ev.key.toLowerCase();

    if (key === 's') {
      ev.preventDefault();
      void (ev.shiftKey ? saveAs() : save());
    } else if (key === 'o' && !ev.shiftKey) {
      ev.preventDefault();
      void openPrompt();
    } else if (key === 'f' && !ev.shiftKey) {
      ev.preventDefault();
      openFind(false);
    } else if (key === 'h' && !ev.shiftKey) {
      ev.preventDefault();
      openFind(true);
    } else if (key === 'g' && !ev.shiftKey) {
      ev.preventDefault();
      void goToLine();
    }
  });

  // Ctrl+wheel zooms, as everywhere else.
  textarea.addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      stepFontSize(ev.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  function setFontSize(next: number): void {
    desktop.settings.set('editor.fontSize', next);
  }

  function stepFontSize(direction: 1 | -1): void {
    const index = FONT_SIZES.indexOf(fontSize);
    const base = index >= 0 ? index : FONT_SIZES.indexOf(DEFAULT_FONT_SIZE);
    setFontSize(FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, base + direction))]);
  }

  /* ---------------------------------------------------------------- */
  /* Connection                                                        */
  /* ---------------------------------------------------------------- */

  cleanup.push(
    desktop.rpc.events.on('state', (state) => {
      if (disposed) return;
      if (state === 'open') {
        if (banner.textContent?.startsWith('Disconnected')) setBanner(null);
        void checkExternalChange();
      } else if (dirty) {
        // Silence would look like a working editor that just cannot save.
        setBanner('Disconnected from the server — changes cannot be saved until it is back.');
      }
    }),
  );

  /* ---------------------------------------------------------------- */
  /* Menus                                                             */
  /* ---------------------------------------------------------------- */

  function contextItems(): MenuItem[] {
    const hasSelection = textarea.selectionStart !== textarea.selectionEnd;
    return [
      { label: 'Cut', accelerator: 'Ctrl+X', disabled: !hasSelection || readOnly, onSelect: () => void copySelection(true) },
      { label: 'Copy', accelerator: 'Ctrl+C', disabled: !hasSelection, onSelect: () => void copySelection(false) },
      { label: 'Paste', accelerator: 'Ctrl+V', disabled: readOnly, onSelect: () => void pasteClipboard() },
      { type: 'separator' },
      { label: 'Select all', accelerator: 'Ctrl+A', onSelect: () => textarea.select() },
      { type: 'separator' },
      { label: 'Find…', accelerator: 'Ctrl+F', onSelect: () => openFind(false) },
      { label: 'Replace…', accelerator: 'Ctrl+H', disabled: readOnly, onSelect: () => openFind(true) },
      { label: 'Go to line…', accelerator: 'Ctrl+G', onSelect: () => void goToLine() },
    ];
  }

  textarea.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    desktop.contextMenu(contextItems(), { x: ev.clientX, y: ev.clientY });
  });

  const menu: MenuItem[] = [
    {
      label: 'File',
      submenu: () => [
        { label: 'New', onSelect: () => void newFile() },
        { label: 'New window', onSelect: () => void desktop.launch('editor') },
        { label: 'Open…', accelerator: 'Ctrl+O', onSelect: () => void openPrompt() },
        {
          label: 'Browse files…',
          onSelect: () =>
            void desktop.launch('files', { params: { path: path ? dirname(path) : undefined } }),
        },
        { type: 'separator' },
        { label: 'Save', accelerator: 'Ctrl+S', disabled: readOnly, onSelect: () => void save() },
        { label: 'Save as…', accelerator: 'Ctrl+Shift+S', onSelect: () => void saveAs() },
        { label: 'Revert to saved', disabled: !path || missing, onSelect: () => void revert() },
        {
          label: 'Download a copy',
          // Sends what is on disk, so an unsaved buffer would be misleading.
          disabled: !path || missing || dirty,
          onSelect: () => path && desktop.downloadFile(path),
        },
        { type: 'separator' },
        { label: 'Close', accelerator: 'Alt+F4', danger: true, onSelect: () => win.close() },
      ],
    },
    { label: 'Edit', submenu: () => contextItems() },
    {
      label: 'View',
      submenu: () => [
        {
          label: 'Word wrap',
          checked: wordWrap,
          onSelect: () => desktop.settings.set('editor.wordWrap', !wordWrap),
        },
        {
          label: 'Line numbers',
          checked: lineNumbers,
          onSelect: () => desktop.settings.set('editor.lineNumbers', !lineNumbers),
        },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'Ctrl+Wheel', onSelect: () => stepFontSize(1) },
        { label: 'Zoom out', onSelect: () => stepFontSize(-1) },
        { label: 'Reset zoom', onSelect: () => setFontSize(DEFAULT_FONT_SIZE) },
        { type: 'separator' },
        {
          label: 'Indentation',
          submenu: () => [
            { type: 'header', label: 'Tab width' },
            ...TAB_SIZES.map((size) => ({
              label: `${size} spaces`,
              checked: tabSize === size,
              onSelect: () => desktop.settings.set('editor.tabSize', size),
            })),
            { type: 'separator' as const },
            {
              label: 'Insert spaces',
              checked: insertSpaces,
              onSelect: () => desktop.settings.set('editor.insertSpaces', !insertSpaces),
            },
          ],
        },
      ],
    },
  ];

  /* ---------------------------------------------------------------- */
  /* Start                                                             */
  /* ---------------------------------------------------------------- */

  updateTitle();
  if (path) await load(path);
  else setContent('');

  // A buffer that was still unsaved when the page reloaded, put back on top of
  // whatever is on disk so the comparison for `dirty` stays honest.
  const draft = str(options.draft);
  if (draft !== undefined && draft !== textarea.value && !readOnly) {
    textarea.value = draft;
    refreshDirty();
    gutterMode = null;
    gutterLines = null;
    scheduleLayout();
  }

  const restoredSelection = num(options.selectionStart);
  if (restoredSelection !== undefined) {
    const at = Math.min(restoredSelection, textarea.value.length);
    textarea.setSelectionRange(at, at);
  }
  const restoredScroll = num(options.scrollTop);
  if (restoredScroll !== undefined) textarea.scrollTop = restoredScroll;

  return {
    menu,

    onResize: (size) => {
      // Minimized windows measure as zero; onFocus redoes this.
      if (size.width === 0) return;
      scheduleLayout();
    },

    onFocus: () => {
      // The window may have been resized while minimized, so measure again
      // before anything relies on the geometry.
      scheduleLayout();
      if (findBar.hidden) textarea.focus();
      void checkExternalChange();
    },

    onClose: () => confirmDiscard(),

    saveState: () => ({
      path: path ?? undefined,
      // Carrying the buffer across a reload is worth some storage, but not an
      // unbounded amount of it.
      draft: dirty && textarea.value.length <= MAX_DRAFT_CHARS ? textarea.value : undefined,
      selectionStart: textarea.selectionStart,
      scrollTop: textarea.scrollTop,
    }),

    destroy: () => {
      disposed = true;
      if (layoutFrame) cancelAnimationFrame(layoutFrame);
      for (const fn of cleanup.reverse()) fn();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function toolButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  return h('button', { class: 'editor-tool', text: label, title, on: { click: onClick } });
}

function findButton(label: string, onClick: () => void, title?: string): HTMLButtonElement {
  return h('button', { class: 'editor-find-button', text: label, title: title ?? label, on: { click: onClick } });
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function countLines(value: string): number {
  let lines = 1;
  for (let at = value.indexOf('\n'); at !== -1; at = value.indexOf('\n', at + 1)) lines++;
  return lines;
}

function lineIndexAt(value: string, offset: number): number {
  let index = 0;
  for (let at = value.indexOf('\n'); at !== -1 && at < offset; at = value.indexOf('\n', at + 1)) {
    index++;
  }
  return index;
}

/**
 * A NUL byte, or a run of replacement characters left behind by decoding
 * non-UTF-8 bytes, means editing this as text would corrupt it.
 */
function looksBinary(content: string): boolean {
  const sample = content.slice(0, 8192);
  // A NUL byte is the one unambiguous sign that this is not text.
  if (sample.includes('\u0000')) return true;
  let replacements = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0xfffd) replacements++;
  }
  return sample.length > 0 && replacements / sample.length > 0.02;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/');
  if (at <= 0) return at === 0 ? '/' : path;
  return path.slice(0, at);
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function describeError(err: unknown): string {
  if (err instanceof RpcError) {
    if (err.code === 'EACCES' || err.code === 'EPERM') return 'Permission denied.';
    if (err.code === 'ENOENT') return 'That path does not exist.';
    if (err.code === 'EISDIR' || err.code === 'ENOTFILE') return 'That is not a regular file.';
    if (err.code === 'ETOOBIG') return err.message;
    if (err.code === 'EOFFLINE') return 'Not connected to the server.';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export const editorApp: AppManifest = {
  id: 'editor',
  name: 'Text Editor',
  icon: EDITOR_ICON,
  description: 'Read and edit text files on the server',
  category: 'Utilities',
  showOnDesktop: true,
  defaultSize: { width: 820, height: 560 },
  minSize: { width: 380, height: 240 },
  handles: [
    {
      verb: 'Edit',
      extensions: [
        '.txt', '.text', '.md', '.markdown', '.rst', '.adoc', '.log', '.csv', '.tsv',
        '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
        '.env', '.properties', '.diff', '.patch', '.service', '.desktop',
        '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.vue', '.svelte',
        '.html', '.htm', '.xhtml', '.xml', '.svg', '.css', '.scss', '.sass', '.less',
        '.py', '.rb', '.php', '.pl', '.lua', '.go', '.rs', '.java', '.kt', '.kts',
        '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.m', '.mm', '.scala',
        '.sql', '.graphql', '.proto', '.tf', '.hcl', '.nix', '.gradle', '.cmake',
        '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.mk', '.am',
      ],
    },
    {
      // Dotfiles have no extension at all — `.bashrc` is a name, not a type —
      // so the common ones are claimed by name, case-sensitively.
      verb: 'Edit',
      names: [
        'Makefile', 'makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'Vagrantfile',
        'Rakefile', 'Gemfile', 'Justfile', 'justfile', 'Procfile', 'CMakeLists.txt',
        'LICENSE', 'COPYING', 'README', 'CHANGELOG', 'AUTHORS', 'NOTICE', 'TODO',
      ],
    },
    {
      // Everything else beginning with a dot: rc files, ignore files, configs.
      verb: 'Edit',
      matches: (file) => file.name.startsWith('.') && file.name.length > 1,
    },
    {
      // A text editor is a reasonable last resort; binary content is detected
      // on load and the buffer is made read-only rather than corruptible.
      verb: 'Edit',
      fallback: true,
    },
  ],
  mount,
};
