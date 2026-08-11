// The outbound mode: a server that dials a relay instead of listening, and a
// client that reaches it from the other side.
//
// What this has to prove is that nothing about the session cares which way the
// connection was opened — requests, responses, channels and *binary* frames all
// have to survive being relayed. Binary matters most: PTY output and every
// Wayland frame ride opcode-prefixed binary messages, and a relay that quietly
// coerces them to text would pass a naive test and break everything real.
//
//   node tests/outbound.mjs [relay-port]

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PORT = Number(process.argv[2] || 7311);
const SESSION = `test-${process.pid}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
const stop = () => children.forEach((c) => { try { c.kill('SIGKILL'); } catch {} });
process.on('exit', stop);

/* --- the relay and a server that dials it --------------------------- */

const relay = spawn('node', [path.join(HERE, 'relay.mjs'), String(PORT)],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
children.push(relay);
let relayLog = '';
relay.stdout.on('data', (d) => { relayLog += d; });
relay.stderr.on('data', (d) => { relayLog += d; });

for (let i = 0; i < 40 && !relayLog.includes('listening'); i++) await sleep(100);
check('the relay starts', relayLog.includes('listening'), relayLog.trim().split('\n')[0]);

const server = spawn('node', ['server/dist/server/src/index.js'], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WD_DIAL: `ws://127.0.0.1:${PORT}/host?session=${SESSION}`,
    WD_DIAL_TICKET: 'a-ticket-nothing-checks-yet',
    XDG_STATE_HOME: process.env.XDG_STATE_HOME || '/tmp',
  },
});
children.push(server);
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

for (let i = 0; i < 60 && !serverLog.includes('connected'); i++) await sleep(100);
check('the server dials out and connects', serverLog.includes('connected'),
  serverLog.match(/dialling.*/)?.[0] ?? serverLog.trim().slice(-90));
check('it says it is not listening', /not listening on any port/.test(serverLog));
check('the relay saw the ticket', /ticket a-ticket/.test(relayLog),
  relayLog.match(/host connected.*/)?.[0] ?? '');

/* --- join from the other side --------------------------------------- */

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/join?session=${SESSION}`);
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
}).catch((err) => { check('a browser joins and gets hello', false, err.message); return null; });

if (!hello) {
  console.log(`\nrelay log:\n${relayLog}\nserver log:\n${serverLog}`);
  stop();
  process.exit(1);
}

const call = (svc, m, a) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ t: 'req', id, svc, m, a }));
});

check('a browser joins and gets hello', hello.v === 1);
check('every service is advertised through the relay',
  ['pty', 'fs', 'sys'].every((n) => hello.services.some((s) => s.name === n)),
  hello.services.map((s) => s.name).join(', '));
check('host info survives the relay', Boolean(hello.host?.hostname));

const listing = await call('fs', 'list', { path: hello.host.home });
check('a request and its response cross the relay', Array.isArray(listing.entries),
  `${listing.entries?.length} entries`);

await call('fs', 'list', { path: '/definitely/not/here' }).then(
  () => check('an error crosses the relay as an error', false, 'it resolved'),
  (err) => check('an error crosses the relay as an error', Boolean(err.message), err.message.slice(0, 40)),
);

/* --- binary, which is the part a relay is most likely to break ------- */

const marker = `relayed-${Date.now()}`;
const chan = nextId++;
ws.send(JSON.stringify({ t: 'open', id: chan, svc: 'pty', m: 'spawn', a: { cols: 80, rows: 24 } }));
await sleep(1500);
check('a channel opens through the relay', opened !== null);

ws.send(JSON.stringify({ t: 'data', id: chan, d: `echo ${marker}\n` }));
for (let i = 0; i < 40 && !ptyOut.includes(marker); i++) await sleep(250);
check('binary frames survive the relay intact', ptyOut.includes(marker),
  ptyOut.includes(marker) ? 'PTY output arrived byte for byte' : ptyOut.slice(-100));

/* --- the host must notice the far end leaving ----------------------- */

ws.close();
// The first retry is a second out, so give it room; the point of the check is
// that it comes back at all, not how fast.
await sleep(3500);
check('the host sees the browser go away and re-dials',
  /closed/.test(serverLog) && /connecting/.test(serverLog.slice(serverLog.indexOf('closed'))),
  serverLog.trim().split('\n').slice(-2).join(' | '));

stop();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
