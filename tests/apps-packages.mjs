// App packages on disk: what the server lists, what it refuses to serve.
//
// The fixtures are written by tests/run.sh into the scratch state directory
// before the server starts: the real examples/hello, and one package for each
// way a package goes wrong. The rule under test is that a wrong package is
// *reported* — listed with an error so Settings can show it — and that nothing
// leaves the host except files the manifest names, from inside the package.
import WebSocket from 'ws';

const TOKEN = process.argv[2];
const PORT = Number(process.argv[3] || 7099);
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`);
let nextId = 1;
const pending = new Map();
const call = (svc, m, a) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: 'req', id, svc, m, a }));
  });
const refused = (promise) => promise.then(() => null, (err) => err.message);

await new Promise((resolve, reject) => {
  ws.on('error', reject);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.t === 'hello') resolve(msg);
    else if (msg.t === 'res') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.d) : p.reject(new Error(`${msg.e?.code}: ${msg.e?.message}`));
    }
  });
});

/* ---------------- listing ---------------- */

const list = await call('apps', 'list');
const byId = Object.fromEntries((list.installed ?? []).map((p) => [p.id, p]));

check('the listing still answers the Stage 1 shape', Array.isArray(list.disabled));
check('the listing names the packages directory', typeof list.dir === 'string' && list.dir.endsWith('/finestra/apps'), list.dir);

const hello = byId.hello;
check('the example package is listed with its manifest',
  hello?.manifest?.name === 'Hello' && hello.manifest.version === '0.1.0' && hello.manifest.entry === 'app.js',
  JSON.stringify(hello));
check('its optional fields come through by name',
  hello?.manifest?.style === 'app.css' && hello.manifest.defaultSize?.width === 520 && hello.manifest.handles?.[0]?.extensions?.[0] === '.hello');
check('the package directory is absolute', hello?.dir?.startsWith('/'), hello?.dir);

check('unparseable app.json is listed with an error, not dropped',
  byId.broken && !byId.broken.manifest && /not valid JSON/.test(byId.broken.error ?? ''), byId.broken?.error);
check('a manifest whose id is not the directory name is refused',
  /id: is "other" but the directory is "mismatch"/.test(byId.mismatch?.error ?? ''), byId.mismatch?.error);
check('a directory that cannot be an id is reported under its own name',
  /lower-case letters/.test(byId['Bad Name']?.error ?? ''), byId['Bad Name']?.error);
check('a package for a newer API is listed — the shell decides what to do with it',
  byId.future?.manifest?.apiVersion === 99);
check('a package whose entry is a symlink out of the package lists fine (the file exists)',
  Boolean(byId.escape?.manifest), byId.escape?.error);

/* ---------------- reading ---------------- */

const entry = await call('apps', 'read', { id: 'hello', file: 'app.js' });
check('the entry is served', /export async function mount/.test(entry.text));
const style = await call('apps', 'read', { id: 'hello', file: 'app.css' });
check('the stylesheet is served', /\.hello-app/.test(style.text));

check('a file the manifest does not name is refused',
  /EINVAL/.test(await refused(call('apps', 'read', { id: 'hello', file: 'app.json' })) ?? ''));
check('a path is refused even when it would resolve to a named file',
  /EINVAL/.test(await refused(call('apps', 'read', { id: 'hello', file: './app.js' })) ?? ''));
check('an id with a slash is refused',
  /EINVAL/.test(await refused(call('apps', 'read', { id: 'hello/../broken', file: 'app.js' })) ?? ''));
check('an id with dots is refused',
  /EINVAL/.test(await refused(call('apps', 'read', { id: '..', file: 'app.js' })) ?? ''));
check('an unknown package is ENOENT',
  /ENOENT/.test(await refused(call('apps', 'read', { id: 'nope', file: 'app.js' })) ?? ''));
check('a broken package cannot be read from',
  /EINVAL/.test(await refused(call('apps', 'read', { id: 'broken', file: 'app.js' })) ?? ''));

const escape = await refused(call('apps', 'read', { id: 'escape', file: 'app.js' }));
check('an entry symlinked outside the package is refused, not served', /EACCES/.test(escape ?? ''), escape ?? 'served');

const huge = await refused(call('apps', 'read', { id: 'huge', file: 'app.js' }));
check('an entry over the size cap is refused', /EFBIG/.test(huge ?? ''), huge ?? 'served');

ws.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
