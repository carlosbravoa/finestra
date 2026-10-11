// App packages, the shell's half: a manifest becomes an app, and its code is
// fetched the first time a window opens — not at boot, and not again.
//
// The runtime (read a file, evaluate a module, inject a style) is injected, so
// this runs under tsx with no server and no browser. The DOM is faked just far
// enough for the error panel to be rendered and read back.

import assert from 'node:assert/strict';
import { manifestFromPackage, packageProblem, registerPackages } from '../client/src/core/packages';
import type { PackageRuntime } from '../client/src/core/packages';
import type { AppContext, AppManifest, DesktopAPI } from '../client/src/core/types';
import type { InstalledApp } from '../shared/protocol';

const results: boolean[] = [];
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}  — ${(err as Error).message}`);
  }
};

/* --- a DOM with exactly what `h` and the error panel touch ---------- */

class FakeElement {
  className = '';
  textContent = '';
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  constructor(public tag: string) {}
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  replaceChildren(...children: FakeElement[]) { this.children = children; }
  addEventListener() {}
  /** All the text under this node, the way a person would read it. */
  get text(): string { return [this.textContent, ...this.children.map((c) => c.text)].join(' '); }
}
const head = new FakeElement('head');
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new FakeElement(tag),
  createTextNode: (text: string) => Object.assign(new FakeElement('#text'), { textContent: text }),
  querySelector: (sel: string) => head.children.find((c) => sel.includes(c.dataset.finestraApp)) ?? null,
  head,
};
(globalThis as unknown as { Node: unknown }).Node = FakeElement;

/* --- fakes ------------------------------------------------------------ */

function fakeRuntime(files: Record<string, string>, module: unknown = { mount: () => ({}) }) {
  const reads: string[] = [];
  const styles: string[] = [];
  const runtime: PackageRuntime = {
    read: async (id, file) => {
      reads.push(`${id}/${file}`);
      const text = files[file];
      if (text === undefined) throw Object.assign(new Error(`no ${file}`), { code: 'ENOENT' });
      return text;
    },
    importModule: async (_id, text) => {
      if (text.includes('throw')) throw new SyntaxError('Unexpected token');
      return module;
    },
    injectStyle: (_id, css) => styles.push(css),
  };
  return { runtime, reads, styles };
}

function fakeDesktop(builtins: string[] = ['terminal', 'settings']) {
  const registered: AppManifest[] = builtins.map((id) => ({ id, name: id, icon: '', mount: () => ({}) }));
  const desktop = {
    apps: () => registered,
    register: (app: AppManifest) => void registered.push(app),
  } as unknown as DesktopAPI;
  return { desktop, registered };
}

function fakeContext(): AppContext & { root: FakeElement; titles: string[] } {
  const root = new FakeElement('div');
  const titles: string[] = [];
  return {
    root: root as unknown as HTMLElement,
    window: { setTitle: (t: string) => void titles.push(t) },
    desktop: { launch: async () => null },
    params: {},
    titles,
  } as unknown as AppContext & { root: FakeElement; titles: string[] };
}

const hello: InstalledApp = {
  id: 'hello',
  dir: '/state/apps/hello',
  manifest: {
    id: 'hello',
    name: 'Hello',
    version: '0.1.0',
    apiVersion: 1,
    entry: 'app.js',
    style: 'app.css',
    icon: '👋',
    description: 'says hello',
    category: 'Utilities',
    singleton: true,
    defaultSize: { width: 500, height: 300 },
    handles: [{ verb: 'View', extensions: ['.hello'], priority: 2 }],
  },
};

/* --- the manifest ------------------------------------------------------ */

await check('a package manifest maps onto an app manifest by name', () => {
  const m = manifestFromPackage(hello, fakeRuntime({}).runtime);
  assert.equal(m.id, 'hello');
  assert.equal(m.name, 'Hello');
  assert.equal(m.icon, '👋');
  assert.equal(m.description, 'says hello');
  assert.equal(m.category, 'Utilities');
  assert.equal(m.singleton, true);
  assert.deepEqual(m.defaultSize, { width: 500, height: 300 });
  assert.deepEqual(m.handles, [{ verb: 'View', extensions: ['.hello'], priority: 2 }]);
  assert.equal(typeof m.mount, 'function');
});

await check('package-only fields do not leak into the app manifest', () => {
  const m = manifestFromPackage(hello, fakeRuntime({}).runtime) as unknown as Record<string, unknown>;
  for (const key of ['entry', 'style', 'version', 'apiVersion', 'dir', 'error']) {
    assert.ok(!(key in m), `${key} came through`);
  }
});

await check('a package for a newer API is a problem the shell can name', () => {
  const future = { ...hello, manifest: { ...hello.manifest!, apiVersion: 2 } };
  assert.match(packageProblem(future) ?? '', /needs a newer Finestra/);
  assert.equal(packageProblem(hello), null);
  assert.equal(packageProblem({ id: 'x', dir: '/x', error: 'app.json is missing' }), 'app.json is missing');
});

await check('a broken package still gets a manifest, with no file associations', () => {
  const broken: InstalledApp = { id: 'broken', dir: '/state/apps/broken', error: 'app.json is not valid JSON' };
  const m = manifestFromPackage(broken, fakeRuntime({}).runtime);
  assert.equal(m.id, 'broken');
  assert.equal(m.name, 'broken');
  assert.match(m.description ?? '', /Cannot start/);
  assert.equal(m.handles, undefined);
});

/* --- loading ----------------------------------------------------------- */

await check('nothing is read until the app is launched', () => {
  const { runtime, reads } = fakeRuntime({ 'app.js': 'x', 'app.css': 'y' });
  manifestFromPackage(hello, runtime);
  assert.deepEqual(reads, []);
});

await check('the first launch reads the entry and the style, and the module mounts', async () => {
  let mounted = 0;
  const { runtime, reads, styles } = fakeRuntime({ 'app.js': 'code', 'app.css': '.hello{}' }, {
    mount: () => { mounted++; return { menu: [] }; },
  });
  const m = manifestFromPackage({ ...hello, id: 'first' }, runtime);
  const instance = await m.mount(fakeContext());
  assert.deepEqual(instance, { menu: [] });
  assert.equal(mounted, 1);
  assert.deepEqual(reads.sort(), ['first/app.css', 'first/app.js']);
  assert.deepEqual(styles, ['.hello{}']);
});

await check('a second window reuses the loaded module', async () => {
  let mounted = 0;
  const { runtime, reads } = fakeRuntime({ 'app.js': 'code', 'app.css': '' }, {
    mount: () => { mounted++; return {}; },
  });
  const m = manifestFromPackage({ ...hello, id: 'twice' }, runtime);
  await m.mount(fakeContext());
  await m.mount(fakeContext());
  assert.equal(mounted, 2);
  assert.equal(reads.length, 2, `read ${reads.length} files for two windows`);
});

await check('`export default { mount }` is accepted too', async () => {
  const { runtime } = fakeRuntime({ 'app.js': 'code', 'app.css': '' }, { default: { mount: () => ({ ok: true }) } });
  const m = manifestFromPackage({ ...hello, id: 'default-export' }, runtime);
  assert.deepEqual(await m.mount(fakeContext()), { ok: true });
});

await check('a module without mount opens as an error panel, not a crash', async () => {
  const { runtime } = fakeRuntime({ 'app.js': 'code', 'app.css': '' }, { nothing: 1 });
  const m = manifestFromPackage({ ...hello, id: 'no-mount' }, runtime);
  const ctx = fakeContext();
  const instance = await m.mount(ctx);
  assert.deepEqual(instance, {});
  assert.match(ctx.root.text, /could not start/);
  assert.match(ctx.root.text, /does not export a mount function/);
  assert.match(ctx.root.text, /\/state\/apps\/hello/);
});

await check('a package for a newer API opens as an error panel without reading anything', async () => {
  const { runtime, reads } = fakeRuntime({ 'app.js': 'code' });
  const m = manifestFromPackage({ ...hello, id: 'future', manifest: { ...hello.manifest!, apiVersion: 7 } }, runtime);
  const ctx = fakeContext();
  await m.mount(ctx);
  assert.match(ctx.root.text, /needs a newer Finestra/);
  assert.deepEqual(reads, []);
});

await check('a failed load is not remembered: fixing the file and relaunching works', async () => {
  const files: Record<string, string> = { 'app.js': 'throw', 'app.css': '' };
  const { runtime } = fakeRuntime(files, { mount: () => ({ fixed: true }) });
  const m = manifestFromPackage({ ...hello, id: 'retry' }, runtime);
  const first = fakeContext();
  await m.mount(first);
  assert.match(first.root.text, /Unexpected token/);
  files['app.js'] = 'fine now';
  assert.deepEqual(await m.mount(fakeContext()), { fixed: true });
});

/* --- registering ------------------------------------------------------- */

await check('every listed package is registered, and broken ones are reported', () => {
  const { desktop, registered } = fakeDesktop();
  const broken: InstalledApp = { id: 'broken', dir: '/b', error: 'app.json is missing' };
  const result = registerPackages(desktop, [hello, broken], fakeRuntime({}).runtime);
  assert.deepEqual(result.registered.map((a) => a.id), ['hello', 'broken']);
  assert.deepEqual(result.broken.map((p) => p.id), ['broken']);
  assert.ok(registered.some((a) => a.id === 'hello'));
});

await check('registering the same listing again adds nothing', () => {
  const { desktop } = fakeDesktop();
  registerPackages(desktop, [hello], fakeRuntime({}).runtime);
  const again = registerPackages(desktop, [hello], fakeRuntime({}).runtime);
  assert.deepEqual(again.registered, []);
  assert.deepEqual(again.broken, []);
});

await check('a package cannot take the id of an app that ships with the shell', () => {
  const { desktop, registered } = fakeDesktop(['terminal']);
  const impostor: InstalledApp = { ...hello, id: 'terminal', manifest: { ...hello.manifest!, id: 'terminal' } };
  const result = registerPackages(desktop, [impostor], fakeRuntime({}).runtime);
  assert.deepEqual(result.registered, []);
  assert.match(result.broken[0]?.error ?? '', /ships with the shell/);
  assert.equal(registered.filter((a) => a.id === 'terminal').length, 1);
});

await check('an empty listing registers nothing and reports nothing', () => {
  const { desktop, registered } = fakeDesktop();
  const before = registered.length;
  const result = registerPackages(desktop, [], fakeRuntime({}).runtime);
  assert.deepEqual(result, { registered: [], broken: [] });
  assert.equal(registered.length, before);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
