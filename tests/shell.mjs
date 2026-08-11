// `finestra open …`: the one thing that crosses between connections.
//
// A terminal on the server has no window and no display — every native
// application runs under its own compositor, which exists only for the window
// it draws — so opening one means asking the browsers that have a window. This
// is that path: one connection announces, the others hear it.
//
// What matters here is the shape of the failures. A command that exits zero
// having opened nothing is worse than one that fails, because the person typing
// it has already looked away.

import WebSocket from 'ws';

const TOKEN = process.argv[2];
const PORT = process.argv[3] || '7199';
const BASE = `ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A connection that records every event it is told about. */
async function connect() {
  const ws = new WebSocket(BASE);
  const events = [];
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no hello within 10s')), 10000);
    ws.on('error', reject);
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'hello') { clearTimeout(timer); resolve(); }
      else if (msg.t === 'ev') events.push(msg);
      else if (msg.t === 'res') {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.ok ? p.resolve(msg.d) : p.reject(new Error(msg.e?.message)); }
      }
    });
  });

  return {
    events,
    close: () => ws.close(),
    call: (svc, m, a) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ t: 'req', id, svc, m, a }));
    }),
  };
}

const terminal = await connect();   // stands in for the CLI
const desktop = await connect();    // stands in for a browser
const other = await connect();      // and a second tab

/* --- who is listening ------------------------------------------------ */

const status = await terminal.call('shell', 'desktops', {});
check('it counts the other connections, not itself', status.desktops === 2, `${status.desktops}`);

/* --- opening a file -------------------------------------------------- */

const target = new URL(import.meta.url).pathname;
const opened = await terminal.call('shell', 'open', { file: target });
check('opening a file reports how many heard it', opened.desktops === 2, `${opened.desktops}`);

await sleep(200);
const heard = desktop.events.filter((e) => e.svc === 'shell' && e.e === 'open');
check('a desktop is told to open it', heard.length === 1, JSON.stringify(heard[0]?.d ?? null));
check('and told which file', heard[0]?.d?.file === target);
check('every desktop hears it, not just the first',
  other.events.some((e) => e.svc === 'shell' && e.e === 'open'));
check('the caller is not told to open its own request',
  !terminal.events.some((e) => e.svc === 'shell' && e.e === 'open'));

/* --- the failures, which are the point ------------------------------- */

await terminal.call('shell', 'open', { file: '/no/such/file/at/all' }).then(
  () => check('a file that does not exist is refused', false, 'it agreed'),
  (err) => check('a file that does not exist is refused', /ENOENT|No such file/.test(err.message)),
);

await terminal.call('shell', 'open', { app: 'definitely-not-installed-anywhere' }).then(
  () => check('an application nobody has is refused', false, 'it agreed'),
  (err) => check('an application nobody has is refused', /No application matches/.test(err.message)),
);

await terminal.call('shell', 'open', {}).then(
  () => check('naming nothing is refused', false, 'it agreed'),
  (err) => check('naming nothing is refused', /EINVAL|Name an application/.test(err.message)),
);

// The check that stops a silent success: with nobody listening, `open` must
// still say so, because the CLI turns a count of zero into a non-zero exit.
desktop.close();
other.close();
await sleep(300);
const alone = await terminal.call('shell', 'open', { file: target });
check('with no desktop connected it reports zero', alone.desktops === 0, `${alone.desktops}`);

/* --- the list a caller with no picker needs -------------------------- */

const { apps } = await terminal.call('shell', 'apps', {});
check('it can list what is openable', Array.isArray(apps));
check('entries carry an id and a name',
  apps.length === 0 || (typeof apps[0].id === 'string' && typeof apps[0].name === 'string'));
// argv is what the browser is never given; a terminal has no more right to it.
check('and never the command behind them',
  apps.every((a) => !('argv' in a)));

terminal.close();
await sleep(100);

console.log(`\n${failures === 0 ? 'all' : failures} shell check(s) ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
