import { h } from '../../core/dom';
import type { DesktopAPI } from '../../core/types';

/*
 * The file dialog a confined application asked the portal for, drawn by the
 * shell over the application's window. It browses the server through the fs
 * service and answers with file:// URIs, which is what the portal promised.
 */

export interface ChooserRequest {
  kind: 'open' | 'save' | 'save-files';
  title: string;
  acceptLabel: string | null;
  multiple: boolean;
  directory: boolean;
  currentName: string | null;
  currentFolder: string | null;
  filters: Array<{ name: string; patterns: string[] }>;
  files: string[];
}

interface DirEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
}

interface Listing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

export interface Chooser {
  readonly element: HTMLElement;
  /** Chosen URIs, or null when cancelled or closed. */
  readonly result: Promise<string[] | null>;
  /** Take it down without an answer. */
  close(): void;
}

/** Where the last dialog was left, so the next one opens there. */
let lastFolder: string | null = null;

/** `*.txt` → a test on the file name; the portal only sends globs we can use. */
function globMatcher(patterns: string[]): (name: string) => boolean {
  if (patterns.length === 0) return () => true;
  const tests = patterns.map(
    (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'),
  );
  return (name) => tests.some((t) => t.test(name));
}

function fileUri(path: string): string {
  return `file://${encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/** GTK writes mnemonics as `_Open`; the underscore is not part of the word. */
function label(text: string | null, fallback: string): string {
  return text ? text.replace(/_(.)/g, '$1') : fallback;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function fileChooser(desktop: DesktopAPI, request: ChooserRequest): Chooser {
  const saving = request.kind !== 'open';
  const pickingFolder = request.directory || request.kind === 'save-files';
  let resolve!: (value: string[] | null) => void;
  const result = new Promise<string[] | null>((r) => (resolve = r));
  let done = false;

  let cwd = request.currentFolder ?? lastFolder ?? desktop.host?.home ?? '/';
  let listing: Listing | null = null;
  let filterIndex = 0;
  const selected = new Set<string>();

  const title = h('h2', {
    class: 'wayland-chooser-title',
    text:
      request.title ||
      (request.kind === 'save' ? 'Save file' : pickingFolder ? 'Choose a folder' : 'Open file'),
  });
  const pathInput = h('input', {
    class: 'wayland-chooser-path',
    attrs: { type: 'text', spellcheck: 'false', 'aria-label': 'Folder' },
  });
  const upButton = h('button', { class: 'wayland-button', text: 'Up', title: 'Parent folder' });
  const homeButton = h('button', { class: 'wayland-button', text: 'Home' });
  const list = h('div', { class: 'wayland-chooser-list', attrs: { tabindex: '0', role: 'listbox' } });
  const status = h('div', { class: 'wayland-chooser-status' });
  const nameInput = h('input', {
    class: 'wayland-chooser-name',
    attrs: { type: 'text', spellcheck: 'false', placeholder: 'File name' },
  });
  nameInput.value = request.currentName ?? '';
  const filterSelect = h('select', { class: 'wayland-chooser-filter' });
  for (const f of request.filters) filterSelect.appendChild(h('option', { text: f.name }));
  filterSelect.addEventListener('change', () => {
    filterIndex = filterSelect.selectedIndex;
    render();
  });
  const cancelButton = h('button', { class: 'wayland-button', text: 'Cancel' });
  const acceptButton = h('button', {
    class: 'wayland-button is-primary',
    text: label(request.acceptLabel, saving ? 'Save' : pickingFolder ? 'Select' : 'Open'),
  });

  const box = h(
    'div',
    { class: 'wayland-chooser', attrs: { role: 'dialog', 'aria-modal': 'true' } },
    h('div', { class: 'wayland-chooser-head' }, title),
    h('div', { class: 'wayland-chooser-bar' }, upButton, homeButton, pathInput),
    list,
    request.kind === 'save' ? h('div', { class: 'wayland-chooser-bar' }, nameInput) : null,
    request.kind === 'save-files' && request.files.length > 0
      ? h('div', {
          class: 'wayland-chooser-note',
          text: `Will save: ${request.files.join(', ')}`,
        })
      : null,
    h(
      'div',
      { class: 'wayland-chooser-foot' },
      status,
      request.filters.length > 1 ? filterSelect : null,
      cancelButton,
      acceptButton,
    ),
  );
  const element = h('div', { class: 'wayland-backdrop wayland-chooser-backdrop' }, box);

  function finish(value: string[] | null): void {
    if (done) return;
    done = true;
    if (listing) lastFolder = listing.path;
    resolve(value);
  }

  async function navigate(path: string): Promise<void> {
    status.textContent = 'Loading…';
    try {
      const got = await desktop.rpc.call<Listing>('fs', 'list', { path });
      if (done) return;
      listing = got;
      cwd = got.path;
      selected.clear();
      pathInput.value = cwd;
      upButton.disabled = got.parent === null;
      render();
    } catch (err) {
      if (done) return;
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  function visibleEntries(): DirEntry[] {
    if (!listing) return [];
    const accept = globMatcher(request.filters[filterIndex]?.patterns ?? []);
    return listing.entries.filter((e) => {
      if (e.kind === 'directory') return true;
      if (pickingFolder) return false;
      return accept(e.name);
    });
  }

  function render(): void {
    const entries = visibleEntries();
    list.replaceChildren(
      ...entries.map((e) => {
        const row = h(
          'div',
          {
            class: `wayland-chooser-row${selected.has(e.path) ? ' is-selected' : ''}`,
            dataset: { path: e.path, kind: e.kind },
            attrs: { role: 'option', 'aria-selected': selected.has(e.path) ? 'true' : 'false' },
          },
          h('span', { class: 'wayland-chooser-icon', text: e.kind === 'directory' ? '📁' : '📄' }),
          h('span', { class: 'wayland-chooser-rowname', text: e.name }),
          h('span', { class: 'wayland-chooser-size', text: e.kind === 'directory' ? '' : formatSize(e.size) }),
        );
        row.addEventListener('click', (ev) => pick(e, ev.ctrlKey || ev.metaKey));
        row.addEventListener('dblclick', () => {
          if (e.kind === 'directory') void navigate(e.path);
          else void accept();
        });
        return row;
      }),
    );
    if (entries.length === 0) {
      list.appendChild(h('div', { class: 'wayland-chooser-empty', text: 'Nothing here' }));
    }
    status.textContent = `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`;
  }

  function pick(entry: DirEntry, extend: boolean): void {
    const multi = request.multiple && extend;
    if (!multi) selected.clear();
    if (selected.has(entry.path) && multi) selected.delete(entry.path);
    else selected.add(entry.path);
    if (request.kind === 'save' && entry.kind !== 'directory') nameInput.value = entry.name;
    for (const row of list.querySelectorAll<HTMLElement>('.wayland-chooser-row')) {
      const on = selected.has(row.dataset.path ?? '');
      row.classList.toggle('is-selected', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  async function accept(): Promise<void> {
    if (done || !listing) return;
    const chosen = [...selected];
    const byPath = new Map(listing.entries.map((e) => [e.path, e]));

    if (request.kind === 'save') {
      const name = nameInput.value.trim();
      if (!name || name.includes('/')) {
        nameInput.focus();
        return;
      }
      const target = `${cwd === '/' ? '' : cwd}/${name}`;
      const existing = byPath.get(target);
      if (existing?.kind === 'directory') {
        void navigate(target);
        return;
      }
      if (existing) {
        const ok = await desktop.confirm({
          title: `Replace ${name}?`,
          message: `${name} already exists in ${cwd}. Replacing it overwrites its contents.`,
          confirmLabel: 'Replace',
          danger: true,
        });
        if (!ok || done) return;
      }
      finish([fileUri(target)]);
      return;
    }

    if (pickingFolder) {
      const dir = chosen.find((p) => byPath.get(p)?.kind === 'directory') ?? cwd;
      finish([fileUri(dir)]);
      return;
    }

    const files = chosen.filter((p) => byPath.get(p)?.kind !== 'directory');
    if (files.length === 0) {
      // One folder selected and nothing else: go into it, which is what the
      // double-click would have done.
      const dir = chosen.find((p) => byPath.get(p)?.kind === 'directory');
      if (dir) void navigate(dir);
      return;
    }
    finish(files.map(fileUri));
  }

  upButton.addEventListener('click', () => {
    if (listing?.parent) void navigate(listing.parent);
  });
  homeButton.addEventListener('click', () => void navigate(desktop.host?.home ?? '/'));
  pathInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void navigate(pathInput.value.trim() || '/');
    }
  });
  nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void accept();
    }
  });
  cancelButton.addEventListener('click', () => finish(null));
  acceptButton.addEventListener('click', () => void accept());
  box.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
    } else if (ev.key === 'Enter' && ev.target === list) {
      ev.preventDefault();
      void accept();
    }
  });
  // Clicks on the dialog must not reach the application's canvas under it.
  element.addEventListener('mousedown', (ev) => ev.stopPropagation());
  element.addEventListener('click', (ev) => {
    if (ev.target === element) finish(null);
  });

  void navigate(cwd);
  queueMicrotask(() => (request.kind === 'save' ? nameInput : list).focus());

  return {
    element,
    result,
    close: () => finish(null),
  };
}
