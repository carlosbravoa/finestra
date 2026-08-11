import { editorApp } from './apps/editor';
import { terminalApp } from './apps/terminal';
import { filesApp } from './apps/files';
import { settingsApp } from './apps/settings';
import { sysmanApp } from './apps/sysman';
import { registerPinnedApps, waylandApp } from './apps/wayland';
import { Desktop } from './core/desktop';
import type { AppManifest } from './core/types';
import { h } from './core/dom';
import './style/main.css';

const TOKEN_KEY = 'wd:token';

/**
 * Takes the access token from `?t=…`, remembers it, and removes it from the
 * address bar so it does not end up in history, screenshots or shared links.
 */
function claimToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('t') ?? url.searchParams.get('token');

  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // Private mode: the token still works for this page load.
    }
    url.searchParams.delete('t');
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }

  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function socketUrl(token: string | null): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = token ? `?t=${encodeURIComponent(token)}` : '';
  return `${protocol}//${window.location.host}/ws${query}`;
}

function showBootError(mount: HTMLElement, title: string, detail: string, hint?: string): void {
  mount.replaceChildren(
    h(
      'div',
      { class: 'boot-error' },
      h('div', { class: 'boot-error-panel' },
        h('div', { class: 'boot-error-icon', text: '⚠' }),
        h('h1', { text: title }),
        h('p', { text: detail }),
        hint ? h('pre', { class: 'boot-error-hint', text: hint }) : null,
      ),
    ),
  );
}

/**
 * Registers anything dropped into `apps-extra/`. Vite resolves the glob at
 * build time, so an app that is not there is not in the bundle — this is a
 * build-time extension point, not a runtime plugin loader, and deliberately so:
 * fetching code into a root-capable UI at runtime is a different and much worse
 * proposition.
 */
function registerExtraApps(desktop: Desktop): void {
  const modules = import.meta.glob<Record<string, unknown>>(
    './apps-extra/*/index.{ts,js}',
    { eager: true },
  );
  for (const [file, module] of Object.entries(modules)) {
    for (const exported of Object.values(module)) {
      const manifest = exported as Partial<AppManifest> | undefined;
      if (
        manifest &&
        typeof manifest === 'object' &&
        typeof manifest.id === 'string' &&
        typeof manifest.name === 'string' &&
        typeof manifest.mount === 'function'
      ) {
        const app = manifest as AppManifest;
        desktop.register(app);
        console.info(`[extra] registered app "${app.id}" from ${file}`);
      }
    }
  }
}

async function boot(): Promise<void> {
  const mount = document.getElementById('root');
  if (!mount) throw new Error('Missing #root element');

  const token = claimToken();

  // Check credentials up front: a rejected WebSocket upgrade surfaces as a
  // generic close event, which would otherwise look like an outage.
  try {
    const query = token ? `?t=${encodeURIComponent(token)}` : '';
    const response = await fetch(`/api/session${query}`, { credentials: 'same-origin' });

    if (response.status === 401) {
      showBootError(
        mount,
        'Access token required',
        'Open the URL the server printed when it started — it carries the token that lets you in. ' +
          'Reaching this desktop already means you got here over SSH; the token is the second latch on that door.',
        'The URL looks like:\n' +
          '  http://127.0.0.1:7070/?t=…\n\n' +
          'To reach it from your own machine, forward the port over SSH first:\n' +
          '  ssh -L 7070:127.0.0.1:7070 you@server\n\n' +
          'The token is in the server\'s state directory:\n' +
          '  /var/lib/finestra/token          (installed as a service)\n' +
          '  ~/.local/state/finestra/token    (run directly)',
      );
      return;
    }
    if (!response.ok) throw new Error(`Server responded ${response.status}`);
  } catch (err) {
    showBootError(
      mount,
      'Cannot reach the server',
      'The desktop server did not respond. It may not be running.',
      `${err instanceof Error ? err.message : String(err)}\n\nStart it with:\n  npm run dev`,
    );
    return;
  }

  const desktop = new Desktop(mount, socketUrl(token));

  // Every app is registered here. Nothing else in the shell knows they exist,
  // which is what will let this list come from a manifest, or from remote
  // bundles loaded with import(), without touching the framework.
  desktop.register(terminalApp);
  desktop.register(filesApp);
  desktop.register(editorApp);
  desktop.register(sysmanApp);
  desktop.register(waylandApp);
  desktop.register(settingsApp);

  // Apps kept outside this repository — see client/src/apps-extra/README.md.
  // The glob is empty in a plain checkout, so this costs a standalone build
  // nothing at all.
  registerExtraApps(desktop);

  await desktop.start();

  // Pinned native applications become apps in their own right. This has to
  // happen after the connection is up (the list comes from the server) and
  // before restore, or a pinned window has no app to be restored into.
  await registerPinnedApps(desktop);

  // Put back whatever was open. Apps are already registered, and the server is
  // connected, so a restored terminal can spawn its shell immediately.
  const restored = await desktop.restoreSession();

  // Only greet a genuinely first-time visitor. Someone who closed every window
  // and reloaded meant to have an empty desktop.
  if (restored === 0 && !desktop.settings.get('desktop.hasLaunched', false)) {
    desktop.settings.set('desktop.hasLaunched', true);
    void desktop.launch('terminal');
  }
}

void boot().catch((err) => {
  console.error('The desktop failed to start:', err);
});
