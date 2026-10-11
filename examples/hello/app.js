// A Finestra app package, in plain JavaScript. There is no build step: this
// file is served as-is and `mount` is called with everything the app can
// reach. The format is in docs/app-packages.md; the types it refers to are
// in client/src/core/types.ts (AppContext, AppInstance, DesktopAPI).
//
// Nothing may be imported from the shell. `h` below is the one helper worth
// having, and it is shorter than a dependency.

/** @typedef {import('../../client/src/core/types').AppContext} AppContext */
/** @typedef {import('../../client/src/core/types').AppInstance} AppInstance */

/**
 * @param {string} tag
 * @param {{ class?: string, text?: string, on?: Record<string, (ev: Event) => void> } | null} [props]
 * @param {...(Node | string)} children
 */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props?.class) el.className = props.class;
  if (props?.text != null) el.textContent = props.text;
  for (const [name, fn] of Object.entries(props?.on ?? {})) el.addEventListener(name, fn);
  el.append(...children);
  return el;
}

/**
 * @param {AppContext} ctx
 * @returns {Promise<AppInstance>}
 */
export async function mount({ window: win, root, desktop, params }) {
  let disposed = false;
  // Opened from Files, or restored: `params.path` is whatever was saved.
  let path = typeof params.path === 'string' ? params.path : (desktop.host?.home ?? '~');

  const list = h('ul', { class: 'hello-list' });
  const where = h('div', { class: 'hello-where' });
  root.replaceChildren(
    h(
      'div',
      { class: 'hello-app' },
      h('h1', { text: `Hello from ${desktop.host?.hostname ?? 'somewhere'}` }),
      h('p', { text: 'This window is an app package: a directory with app.json and app.js in it.' }),
      where,
      list,
    ),
  );

  async function load() {
    win.setStatus('Loading…');
    try {
      const result = await desktop.rpc.call('fs', 'list', { path });
      if (disposed) return;
      path = result.path;
      where.textContent = result.path;
      list.replaceChildren(
        ...result.entries.slice(0, 50).map((e) => h('li', { text: e.name })),
      );
      win.setTitle(`Hello — ${result.path}`);
      win.setStatus(`${result.entries.length} entries`);
    } catch (err) {
      if (disposed) return;
      // Server errors carry a code; there is no class to check against.
      const reason = err && err.code === 'EACCES' ? 'Permission denied.' : String(err?.message ?? err);
      where.textContent = reason;
      win.setStatus(null);
    }
  }
  await load();

  return {
    menu: [
      {
        label: 'Hello',
        submenu: () => [
          { label: 'Reload', onSelect: () => void load() },
          { label: 'Open a terminal here', onSelect: () => void desktop.launch('terminal', { params: { cwd: path } }) },
          { type: 'separator' },
          { label: 'Close', onSelect: () => win.close() },
        ],
      },
    ],
    saveState: () => ({ path }),
    destroy: () => {
      disposed = true;
    },
  };
}
