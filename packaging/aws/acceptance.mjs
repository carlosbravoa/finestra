// Acceptance checks, run ON the freshly installed machine against the installed
// service. It imports `ws` from the installed tree by absolute path, so it is
// exercising the runtime and the dependencies that were actually shipped rather
// than anything on the build host.
//
//   node acceptance.mjs <token> [prefix]

import { readFileSync } from 'node:fs';

const TOKEN = process.argv[2];
const PREFIX = process.argv[3] || '/opt/finestra/current';
const BASE = 'http://127.0.0.1:7070';

const { default: WebSocket } = await import(`${PREFIX}/app/node_modules/ws/index.js`);

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- what was shipped ------------------------------------------------ */

const manifest = readFileSync(`${PREFIX}/MANIFEST`, 'utf8');
console.log(manifest.trim().split('\n').map((l) => `      ${l}`).join('\n'));
check('the package carries a manifest', /version=/.test(manifest));
// execPath has the symlinks resolved, so it reads /opt/finestra/<version>/…
// rather than /opt/finestra/current/… — compare against the install root.
check('it runs on the runtime it shipped with',
  process.execPath.startsWith(PREFIX.replace(/\/current$/, '')),
  process.execPath);

/* --- HTTP ------------------------------------------------------------ */

const health = await fetch(`${BASE}/healthz`);
check('healthz answers', health.status === 200, `status ${health.status}`);

const noToken = await fetch(`${BASE}/api/session`);
check('a request with no token is refused', noToken.status === 401, `status ${noToken.status}`);

const badToken = await fetch(`${BASE}/api/session?t=definitely-not-the-token`);
check('a wrong token is refused', badToken.status === 401, `status ${badToken.status}`);

const good = await fetch(`${BASE}/api/session?t=${TOKEN}`);
check('the installed token is accepted', good.status === 200, `status ${good.status}`);

const index = await fetch(`${BASE}/`);
const html = await index.text();
check('the built client is served', index.status === 200 && html.includes('<div id="root">'));
check('the client bundle is reachable', /src="[^"]*assets\/[^"]+\.js"/.test(html));

/* --- WebSocket, services, and a real PTY ----------------------------- */

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?t=${TOKEN}`);
let nextId = 1;
const pending = new Map();
let ptyOut = '';
let opened = null;
const decoder = new TextDecoder();

const hello = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no hello within 15s')), 15000);
  ws.on('error', reject);
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(data);
      if (buf[0] === 0x01) ptyOut += decoder.decode(buf.subarray(5));
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.t === 'hello') { clearTimeout(timer); resolve(msg); }
    else if (msg.t === 'res') {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.ok ? p.resolve(msg.d) : p.reject(new Error(msg.e?.message)); }
    } else if (msg.t === 'opened') opened = msg.d ?? {};
  });
});

const call = (svc, m, a) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ t: 'req', id, svc, m, a }));
});

check('the socket authenticates and says hello', hello.v === 1);
const names = hello.services.map((s) => s.name);
check('every service is advertised',
  ['pty', 'fs', 'sys', 'wayland'].every((n) => names.includes(n)), names.join(', '));
check('host info is populated', Boolean(hello.host?.hostname && hello.host?.home));

// node-pty is the native module with no Linux prebuild, so this single check is
// the one that proves the compiled-against-the-shipped-runtime approach worked.
const marker = `wd-ok-${Date.now()}`;
const chanId = nextId++;
ws.send(JSON.stringify({ t: 'open', id: chanId, svc: 'pty', m: 'spawn', a: { cols: 80, rows: 24 } }));
await sleep(1500);
check('a PTY channel opens', opened !== null, opened ? JSON.stringify(opened).slice(0, 60) : 'never opened');

ws.send(JSON.stringify({ t: 'data', id: chanId, d: `echo ${marker}\n` }));
for (let i = 0; i < 40 && !ptyOut.includes(marker); i++) await sleep(250);
check('the PTY runs a command and returns its output', ptyOut.includes(marker),
  ptyOut.includes(marker) ? 'node-pty works on the shipped runtime' : ptyOut.slice(-120));

const listing = await call('fs', 'list', { path: hello.host.home });
check('the fs service lists a directory', Array.isArray(listing.entries));

const sys = await call('sys', 'info', {});
check('the sys service reports the host', Boolean(sys && (sys.hostname || sys.platform)));

/* --- the account it runs as ------------------------------------------ */
// Everything below is about the one decision install.sh asks: who this runs as.
// A desktop that cannot open a home directory, cannot read the journal and
// cannot do anything privileged is not a desktop, and every one of those
// failures is invisible from the outside — the service is up, healthy, and
// useless. They are checked here because only a real install has an answer.

const MODE = process.argv[4] || 'privileged';

// The system account's home is /var/lib/finestra, which is not somewhere
// anyone would put a file; every other account has a home worth opening.
check('it has a home directory worth having',
  MODE === 'system' ? hello.host.home === '/var/lib/finestra'
                    : hello.host.home.startsWith('/home/'),
  `${hello.host.user} at ${hello.host.home}`);

if (MODE !== 'system') {
  const probe = `${hello.host.home}/.wd-acceptance-${process.pid}`;
  let wrote = false;
  try {
    await call('fs', 'write', { path: probe, content: 'upload\n' });
    const back = await call('fs', 'read', { path: probe, encoding: 'utf8' });
    wrote = back?.content === 'upload\n';
    await call('fs', 'remove', { path: probe });
  } catch (e) {
    wrote = e.message;
  }
  check('it can write to that home — an upload has somewhere to land',
    wrote === true, typeof wrote === 'string' ? wrote : probe);
}

// The log viewer reads the whole journal, which is a group membership, not a
// permission the service can ask for. Without it the app opens empty.
const boots = await call('journal', 'boots', {}).catch((e) => ({ error: e.message }));
check('it can read the journal',
  Array.isArray(boots?.boots) && boots.boots.length > 0,
  boots?.error ?? `${boots?.boots?.length ?? 0} boots visible`);

// The privileged/unprivileged choice, asked of the thing that actually decides:
// a setuid binary in a real PTY. NoNewPrivileges makes sudo fail however
// complete the sudoers entry is, and `systemctl show` will not tell you which
// way it went — this will.
//
// The markers are split by a quote so that the terminal echoing the command
// back does not itself satisfy the match: `wd-sudo-y"es"` reaches the shell as
// one word but never appears whole on the line the PTY echoes.
ptyOut = '';
ws.send(JSON.stringify({ t: 'data', id: chanId, d: 'sudo -n true && echo wd-sudo-y"es" || echo wd-sudo-n"o"\n' }));
for (let i = 0; i < 40 && !/wd-sudo-(yes|no)/.test(ptyOut); i++) await sleep(250);
const sudoWorks = /wd-sudo-yes/.test(ptyOut);
check(MODE === 'privileged'
        ? 'sudo works in the terminal, as the privileged install promised'
        : 'sudo is refused, as the unprivileged install promised',
  MODE === 'privileged' ? sudoWorks : !sudoWorks,
  ptyOut.replace(/\s+/g, ' ').slice(-90));

// Honesty check: on a bare server this may legitimately be unavailable, but it
// must say so with a reason rather than throwing.
const wayland = await call('wayland', 'available', {}).catch((e) => ({ error: e.message }));
check('the wayland service answers about itself',
  typeof wayland?.available === 'boolean',
  wayland?.available ? 'compositor usable' : `unavailable: ${wayland?.reason ?? wayland?.error}`);

ws.close();
await sleep(200);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
