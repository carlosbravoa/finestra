import { APP_API_VERSION, type InstalledApp, type PackageManifest } from '../../../shared/protocol';
import { h } from './dom';
import type { AppContext, AppInstance, AppManifest, DesktopAPI, FileAssociation } from './types';

/**
 * App packages: apps installed on the server as a directory, loaded at
 * runtime — Stage 2 of docs/app-installation.md, format in docs/app-packages.md.
 *
 * The shell registers a package from its manifest alone. Its code is fetched
 * and evaluated the first time a window of it is opened, not at boot, which
 * keeps three promises at once: the launcher can list a package without
 * running it; a package that is broken, or written for a newer shell, still
 * has a manifest to register, so session restore keeps its windows instead of
 * silently dropping the records (restore forgets any app it cannot find); and
 * a disabled package costs nothing beyond the listing it already appears in.
 *
 * The code arrives over the RPC socket, not a URL. The static route is
 * unauthenticated, does not exist when the server dials out, and would be a
 * second place to get path handling right. A Blob URL turns the text back into
 * something `import()` accepts, and the browser treats it as same-origin.
 */

/** A module is accepted when it exports `mount`, named or as `default.mount`. */
type PackageModule = { mount?: unknown; default?: { mount?: unknown } };
type Mount = (ctx: AppContext) => AppInstance | Promise<AppInstance>;

/** What loading needs from the outside world — swapped for fakes in tests. */
export interface PackageRuntime {
  /** The text of a file the manifest names. */
  read(id: string, file: string): Promise<string>;
  /** Evaluates module text and returns its namespace. */
  importModule(id: string, text: string): Promise<unknown>;
  /** Puts a stylesheet on the page, once per package. */
  injectStyle(id: string, css: string): void;
}

export function browserRuntime(desktop: DesktopAPI): PackageRuntime {
  return {
    async read(id, file) {
      const { text } = await desktop.rpc.call<{ text: string }>('apps', 'read', { id, file });
      return text;
    },
    async importModule(id, text) {
      // The sourceURL is what devtools shows instead of a blob: hash, and it
      // is the only name an author will recognise in a stack trace.
      const blob = new Blob([`${text}\n//# sourceURL=finestra-app://${id}/app.js\n`], {
        type: 'text/javascript',
      });
      const url = URL.createObjectURL(blob);
      try {
        return await import(/* @vite-ignore */ url);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    injectStyle(id, css) {
      if (document.querySelector(`style[data-finestra-app="${id}"]`)) return;
      document.head.appendChild(h('style', { dataset: { finestraApp: id }, text: css }));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/**
 * One load per package per page. A rejection is not kept: the author fixes
 * the file, relaunches, and gets the fixed one rather than the cached error.
 */
const loads = new Map<string, Promise<Mount>>();

function loadMount(id: string, manifest: PackageManifest, runtime: PackageRuntime): Promise<Mount> {
  const cached = loads.get(id);
  if (cached) return cached;

  const load = (async () => {
    const [text, css] = await Promise.all([
      runtime.read(id, manifest.entry),
      manifest.style ? runtime.read(id, manifest.style) : Promise.resolve(null),
    ]);
    if (css !== null) runtime.injectStyle(id, css);
    const module = (await runtime.importModule(id, text)) as PackageModule | null;
    const mount = module?.mount ?? module?.default?.mount;
    if (typeof mount !== 'function') {
      throw new Error(`${manifest.entry} does not export a mount function`);
    }
    return mount as Mount;
  })();
  loads.set(id, load);
  load.catch(() => loads.delete(id));
  return load;
}

/** The window a package gets when it cannot run: the reason, and where to look. */
function renderLoadError(ctx: AppContext, pkg: InstalledApp, reason: string): AppInstance {
  ctx.window.setTitle(pkg.manifest?.name ?? pkg.id);
  ctx.root.replaceChildren(
    h(
      'div',
      { class: 'package-error' },
      h('h2', { text: `${pkg.manifest?.name ?? pkg.id} could not start` }),
      h('p', { text: reason }),
      h('p', { class: 'package-error-where', text: `Package: ${pkg.dir}` }),
      h('button', {
        class: 'package-error-settings',
        text: 'Open Settings',
        on: { click: () => void ctx.desktop.launch('settings') },
      }),
    ),
  );
  return {};
}

/** Why a listed package cannot be run, or null when it can. */
export function packageProblem(pkg: InstalledApp): string | null {
  if (pkg.error) return pkg.error;
  if (!pkg.manifest) return 'the package has no manifest';
  if (pkg.manifest.apiVersion > APP_API_VERSION) {
    return `it needs a newer Finestra (app API ${pkg.manifest.apiVersion}; this one offers ${APP_API_VERSION})`;
  }
  return null;
}

/**
 * The manifest the registry sees. Only fields `app.json` is allowed to carry
 * come through, by name, and everything the shell calls arrives through
 * `ctx` — so a package built against the published types needs nothing from
 * this bundle at run time.
 */
export function manifestFromPackage(pkg: InstalledApp, runtime: PackageRuntime): AppManifest {
  const problem = packageProblem(pkg);
  const m = pkg.manifest;

  const manifest: AppManifest = {
    id: pkg.id,
    name: m?.name ?? pkg.id,
    icon: m?.icon ?? '📦',
    description: m?.description ?? (problem ? `Cannot start: ${problem}` : undefined),
    category: m?.category ?? 'Applications',
    mount: async (ctx) => {
      if (problem || !m) return renderLoadError(ctx, pkg, problem ?? 'no manifest');
      let mount: Mount;
      try {
        mount = await loadMount(pkg.id, m, runtime);
      } catch (err) {
        return renderLoadError(ctx, pkg, err instanceof Error ? err.message : String(err));
      }
      return mount(ctx);
    },
  };

  if (!m) return manifest;
  if (m.singleton !== undefined) manifest.singleton = m.singleton;
  if (m.showOnDesktop !== undefined) manifest.showOnDesktop = m.showOnDesktop;
  if (m.showInLauncher !== undefined) manifest.showInLauncher = m.showInLauncher;
  if (m.restorable !== undefined) manifest.restorable = m.restorable;
  if (m.resizable !== undefined) manifest.resizable = m.resizable;
  if (m.startMaximized !== undefined) manifest.startMaximized = m.startMaximized;
  if (m.defaultSize) manifest.defaultSize = { ...m.defaultSize };
  if (m.minSize) manifest.minSize = { ...m.minSize };
  if (m.handles && !problem) {
    manifest.handles = m.handles.map((a): FileAssociation => ({ ...a }));
  }
  return manifest;
}

/**
 * Registers every listed package the registry does not already have. Safe to
 * call again with a fresh listing — Settings does, so a package dropped in
 * after boot is launchable without a reload. Returns what was new.
 */
export function registerPackages(
  desktop: DesktopAPI,
  installed: InstalledApp[],
  runtime: PackageRuntime = browserRuntime(desktop),
): { registered: AppManifest[]; broken: InstalledApp[] } {
  const known = new Set(desktop.apps().map((a) => a.id));
  const registered: AppManifest[] = [];
  const broken: InstalledApp[] = [];
  for (const pkg of installed) {
    if (known.has(pkg.id)) {
      // A package cannot shadow a built-in: the id is taken, and the launcher
      // would show whichever registered last, which is nobody's intention.
      if (!ours.has(pkg.id)) {
        broken.push({ ...pkg, error: `the id "${pkg.id}" belongs to an app that ships with the shell` });
      }
      continue;
    }
    if (packageProblem(pkg)) broken.push(pkg);
    const manifest = manifestFromPackage(pkg, runtime);
    desktop.register(manifest);
    known.add(pkg.id);
    ours.add(pkg.id);
    registered.push(manifest);
  }
  return { registered, broken };
}

/** Ids this module registered, to tell "already ours" from "a built-in's". */
const ours = new Set<string>();
