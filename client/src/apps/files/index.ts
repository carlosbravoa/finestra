import { h } from '../../core/dom';
import { RpcError } from '../../core/rpc';
import type { AppContext, AppInstance, AppManifest, MenuItem } from '../../core/types';
import './files.css';

const FILES_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
</svg>`;

interface DirEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: number;
  mode: number;
  target?: string;
  error?: string;
}

interface Listing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

const KIND_GLYPHS: Record<DirEntry['kind'], string> = {
  directory: '📁',
  file: '📄',
  symlink: '🔗',
  other: '▫',
};

/**
 * A second app, written against the same SDK as the terminal. It exists partly
 * to be useful and partly to keep the extension seams honest: it shares nothing
 * with the terminal but `DesktopAPI`.
 */
async function mount(ctx: AppContext): Promise<AppInstance> {
  const { window: win, root, desktop, params } = ctx;

  let showHidden = desktop.settings.get('files.showHidden', false);
  let current: Listing | null = null;
  let selected: DirEntry | null = null;
  let disposed = false;

  const pathInput = h('input', {
    class: 'files-path',
    attrs: { type: 'text', spellcheck: 'false', 'aria-label': 'Current path' },
  });
  const listEl = h('div', {
    class: 'files-list',
    attrs: { role: 'listbox', tabindex: '0' },
  });

  const upButton = toolButton('↑', 'Parent directory', () => {
    if (current?.parent) void navigate(current.parent);
  });
  const homeButton = toolButton('⌂', 'Home directory', () => {
    void navigate(desktop.host?.home ?? '~');
  });
  const refreshButton = toolButton('⟳', 'Refresh', () => {
    if (current) void navigate(current.path);
  });
  const terminalButton = toolButton('▸_', 'Open a terminal here', () => openTerminalHere());

  pathInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void navigate(pathInput.value);
    if (ev.key === 'Escape' && current) pathInput.value = current.path;
  });

  root.replaceChildren(
    h(
      'div',
      { class: 'files-app' },
      h(
        'div',
        { class: 'files-toolbar' },
        upButton,
        homeButton,
        refreshButton,
        pathInput,
        terminalButton,
      ),
      listEl,
    ),
  );

  /* ---------------------------------------------------------------- */
  /* Uploads into the directory being viewed                           */
  /* ---------------------------------------------------------------- */

  async function uploadHere(files: File[]): Promise<void> {
    if (!current || files.length === 0) return;
    await desktop.uploadFiles(files, current.path);
    if (!disposed && current) await navigate(current.path);
  }

  function pickAndUpload(): void {
    const input = h('input', {
      attrs: { type: 'file', multiple: 'true' },
      style: { display: 'none' },
    }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      input.remove();
      void uploadHere(files);
    });
    document.body.appendChild(input);
    input.click();
  }

  {
    // Dropping onto this window targets the visible directory. stopPropagation
    // keeps the desktop's own drop handler (→ inbox folder) out of it.
    const hasFiles = (ev: DragEvent) => ev.dataTransfer?.types.includes('Files') ?? false;
    const appRoot = root;
    for (const type of ['dragenter', 'dragover'] as const) {
      appRoot.addEventListener(type, (ev: DragEvent) => {
        if (!hasFiles(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        listEl.classList.add('is-drop');
      });
    }
    appRoot.addEventListener('dragleave', (ev: DragEvent) => {
      if (!hasFiles(ev)) return;
      ev.stopPropagation();
      listEl.classList.remove('is-drop');
    });
    appRoot.addEventListener('drop', (ev: DragEvent) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      listEl.classList.remove('is-drop');
      void uploadHere([...(ev.dataTransfer?.files ?? [])]);
    });
  }

  listEl.addEventListener('keydown', (ev) => {
    if (!current) return;
    const entries = current.entries;
    const index = selected ? entries.indexOf(selected) : -1;

    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        selectByIndex(Math.min(entries.length - 1, index + 1));
        break;
      case 'ArrowUp':
        ev.preventDefault();
        selectByIndex(Math.max(0, index - 1));
        break;
      case 'Home':
        ev.preventDefault();
        selectByIndex(0);
        break;
      case 'End':
        ev.preventDefault();
        selectByIndex(entries.length - 1);
        break;
      case 'Enter':
        if (selected) open(selected);
        break;
      case 'Backspace':
        if (current.parent) void navigate(current.parent);
        break;
      case 'Delete':
        if (selected) void remove(selected);
        break;
    }
  });

  listEl.addEventListener('contextmenu', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('.files-row');
    ev.preventDefault();
    const entry = row ? findEntry(row.dataset.name!) : null;
    select(entry);
    desktop.contextMenu(entry ? entryMenu(entry) : backgroundMenu(), {
      x: ev.clientX,
      y: ev.clientY,
    });
  });

  /* ---------------------------------------------------------------- */
  /* Navigation                                                        */
  /* ---------------------------------------------------------------- */

  async function navigate(path: string): Promise<void> {
    win.setStatus('Loading…');
    try {
      const listing = await desktop.rpc.call<Listing>('fs', 'list', { path, showHidden });
      if (disposed) return;
      current = listing;
      selected = null;
      pathInput.value = listing.path;
      win.setTitle(`Files — ${shortenPath(listing.path)}`);
      render();
    } catch (err) {
      if (disposed) return;
      // Keep the previous listing on screen rather than blanking it.
      if (current) pathInput.value = current.path;
      win.setStatus(describeError(err));
      desktop.notify({
        title: 'Could not open folder',
        message: describeError(err),
        kind: 'error',
      });
    }
  }

  function render(): void {
    if (!current) return;
    listEl.replaceChildren();

    if (current.entries.length === 0) {
      listEl.appendChild(h('div', { class: 'files-empty', text: 'This folder is empty.' }));
    }

    for (const entry of current.entries) {
      const row = h(
        'div',
        {
          class: `files-row${entry.error ? ' is-unreadable' : ''}`,
          dataset: { name: entry.name },
          attrs: { role: 'option', title: entry.error ?? entry.target ?? entry.path },
        },
        h('span', { class: 'files-row-icon', text: KIND_GLYPHS[entry.kind] }),
        h('span', { class: 'files-row-name', text: entry.name }),
        h('span', {
          class: 'files-row-size',
          text: entry.kind === 'directory' ? '' : formatBytes(entry.size),
        }),
        h('span', { class: 'files-row-time', text: formatTime(entry.mtime) }),
      );

      row.addEventListener('click', () => select(entry));
      row.addEventListener('dblclick', () => open(entry));
      listEl.appendChild(row);
    }

    const count = current.entries.length;
    win.setStatus(
      `${count} item${count === 1 ? '' : 's'}${showHidden ? '' : ' · hidden files not shown'}`,
    );
  }

  function select(entry: DirEntry | null): void {
    selected = entry;
    for (const row of listEl.querySelectorAll('.files-row')) {
      row.classList.toggle('is-selected', row.getAttribute('data-name') === entry?.name);
    }
  }

  function selectByIndex(index: number): void {
    const entry = current?.entries[index];
    if (!entry) return;
    select(entry);
    listEl
      .querySelector(`.files-row[data-name="${CSS.escape(entry.name)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  function findEntry(name: string): DirEntry | null {
    return current?.entries.find((e) => e.name === name) ?? null;
  }

  function open(entry: DirEntry): void {
    if (entry.kind === 'directory') void navigate(entry.path);
    // openFile explains itself when nothing handles the file.
    else void desktop.openFile(entry.path);
  }

  /** The Open with submenu: handlers first, then every other app. */
  function openWithItems(entry: DirEntry): MenuItem[] {
    const handlers = desktop.fileHandlers(entry.path);
    const handlerIds = new Set(handlers.map((h) => h.app.id));
    const others = desktop
      .apps()
      .filter((app) => !handlerIds.has(app.id) && app.showInLauncher !== false)
      .sort((a, b) => a.name.localeCompare(b.name));

    const items: MenuItem[] = handlers.map((handler) => ({
      label: `${handler.verb} with ${handler.app.name}`,
      icon: handler.app.icon,
      checked: handler.isDefault,
      onSelect: () => void desktop.openFile(entry.path, { appId: handler.app.id }),
    }));

    if (others.length) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ type: 'header', label: 'Other apps' });
      for (const app of others) {
        items.push({
          label: app.name,
          icon: app.icon,
          onSelect: () => void desktop.openFile(entry.path, { appId: app.id }),
        });
      }
    }

    // Only worth offering a default when there is a choice to be made.
    if (handlers.length + others.length > 1) {
      items.push({ type: 'separator' });
      items.push({
        label: 'Always open this kind of file with',
        submenu: () =>
          [...handlers.map((h) => h.app), ...others].map((app) => ({
            label: app.name,
            icon: app.icon,
            checked: desktop.defaultApp(entry.path)?.id === app.id,
            onSelect: () => {
              desktop.setDefaultApp(entry.path, app.id);
              desktop.notify({
                message: `${app.name} will now open files like "${entry.name}".`,
                kind: 'success',
                timeout: 3000,
              });
            },
          })),
      });
    }

    return items;
  }

  function openTerminalHere(): void {
    void desktop.launch('terminal', { params: { cwd: current?.path } });
  }

  /* ---------------------------------------------------------------- */
  /* Operations                                                        */
  /* ---------------------------------------------------------------- */

  async function createFolder(): Promise<void> {
    if (!current) return;
    const name = await desktop.prompt({
      title: 'New folder',
      message: `Create a folder in ${shortenPath(current.path)}`,
      value: 'untitled',
      confirmLabel: 'Create',
    });
    if (!name) return;
    await run(() => desktop.rpc.call('fs', 'mkdir', { path: joinPath(current!.path, name) }));
  }

  async function rename(entry: DirEntry): Promise<void> {
    const name = await desktop.prompt({
      title: 'Rename',
      message: `Rename "${entry.name}" to:`,
      value: entry.name,
      confirmLabel: 'Rename',
    });
    if (!name || name === entry.name) return;
    await run(() =>
      desktop.rpc.call('fs', 'rename', { from: entry.path, to: joinPath(current!.path, name) }),
    );
  }

  async function remove(entry: DirEntry): Promise<void> {
    const ok = await desktop.confirm({
      title: 'Delete',
      message:
        entry.kind === 'directory'
          ? `Delete the folder "${entry.name}" and everything inside it? This cannot be undone.`
          : `Delete "${entry.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await run(() =>
      desktop.rpc.call('fs', 'remove', {
        path: entry.path,
        recursive: entry.kind === 'directory',
      }),
    );
  }

  /** Runs a mutating call, then refreshes — or reports why it failed. */
  async function run(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
      if (current) await navigate(current.path);
    } catch (err) {
      desktop.notify({ title: 'Operation failed', message: describeError(err), kind: 'error' });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Menus                                                             */
  /* ---------------------------------------------------------------- */

  function entryMenu(entry: DirEntry): MenuItem[] {
    const isDirectory = entry.kind === 'directory';
    const openWith = isDirectory ? [] : openWithItems(entry);

    return [
      { label: 'Open', onSelect: () => open(entry) },
      openWith.length
        ? { label: 'Open with', submenu: () => openWithItems(entry) }
        : { label: 'Open with', disabled: true },
      isDirectory
        ? { label: 'Download', disabled: true }
        : { label: 'Download', icon: '⤓', onSelect: () => desktop.downloadFile(entry.path) },
      isDirectory
        ? {
            label: 'Open terminal here',
            onSelect: () => void desktop.launch('terminal', { params: { cwd: entry.path } }),
          }
        : { label: 'Open terminal here', disabled: true },
      { type: 'separator' },
      { label: 'Rename…', onSelect: () => void rename(entry) },
      { label: 'Delete…', danger: true, onSelect: () => void remove(entry) },
      { type: 'separator' },
      {
        label: 'Copy path',
        onSelect: () => {
          void desktop.clipboard
            .write(entry.path)
            .then(() => desktop.notify({ message: 'Path copied.', kind: 'success', timeout: 2000 }));
        },
      },
    ];
  }

  function backgroundMenu(): MenuItem[] {
    return [
      { label: 'New folder…', onSelect: () => void createFolder() },
      { label: 'Upload files here…', onSelect: pickAndUpload },
      { label: 'Open terminal here', onSelect: openTerminalHere },
      { type: 'separator' },
      {
        label: 'Show hidden files',
        checked: showHidden,
        onSelect: () => toggleHidden(),
      },
      { label: 'Refresh', onSelect: () => current && void navigate(current.path) },
    ];
  }

  function toggleHidden(): void {
    showHidden = !showHidden;
    desktop.settings.set('files.showHidden', showHidden);
    if (current) void navigate(current.path);
  }

  const menu: MenuItem[] = [
    {
      label: 'File',
      submenu: () => [
        { label: 'New folder…', onSelect: () => void createFolder() },
        { label: 'Upload files here…', icon: '⤒', onSelect: pickAndUpload },
        { label: 'Open terminal here', onSelect: openTerminalHere },
        { type: 'separator' },
        { label: 'Close', accelerator: 'Alt+F4', danger: true, onSelect: () => win.close() },
      ],
    },
    {
      label: 'View',
      submenu: () => [
        { label: 'Show hidden files', checked: showHidden, onSelect: () => toggleHidden() },
        { label: 'Refresh', onSelect: () => current && void navigate(current.path) },
        { type: 'separator' },
        {
          label: 'Go to parent',
          disabled: !current?.parent,
          onSelect: () => current?.parent && void navigate(current.parent),
        },
        { label: 'Go home', onSelect: () => void navigate(desktop.host?.home ?? '~') },
      ],
    },
  ];

  await navigate((params.path as string) ?? desktop.host?.home ?? '~');

  return {
    menu,
    onFocus: () => {
      // Another window may have changed the directory underneath us.
      if (current) void navigate(current.path);
    },
    saveState: () => ({ path: current?.path ?? (params.path as string | undefined) }),
    destroy: () => {
      disposed = true;
      selected = null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function toolButton(label: string, title: string, onClick: () => void): HTMLElement {
  return h('button', { class: 'files-tool', text: label, title, on: { click: onClick } });
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function shortenPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatTime(ms: number): string {
  if (!ms) return '';
  const date = new Date(ms);
  const sixMonthsAgo = Date.now() - 180 * 24 * 3600 * 1000;
  return ms < sixMonthsAgo
    ? date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function describeError(err: unknown): string {
  if (err instanceof RpcError) {
    if (err.code === 'EACCES' || err.code === 'EPERM') return 'Permission denied.';
    if (err.code === 'ENOENT') return 'That path does not exist.';
    if (err.code === 'ENOTDIR') return 'That is not a folder.';
    if (err.code === 'ENOTEMPTY') return 'The folder is not empty.';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export const filesApp: AppManifest = {
  id: 'files',
  name: 'Files',
  icon: FILES_ICON,
  description: "Browse the server's filesystem",
  category: 'System',
  showOnDesktop: true,
  defaultSize: { width: 760, height: 480 },
  minSize: { width: 380, height: 240 },
  mount,
};
