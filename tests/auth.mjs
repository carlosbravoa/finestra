// Changing the access token from inside the desktop.
//
// The token is the one secret that turns "a page in your browser" into "a
// shell on this machine", and until now revoking it meant shell access: delete
// a file, restart the service. This is the service that does it from Settings,
// and the checks are about who is cut off — every copy of the old token that
// is not connected, and nobody who is, unless asked — and about the file on
// disk being the truth the next restart reads.
//
// It starts its own servers rather than using the shared one: a suite that
// rotates the token every other suite was handed would be a strange neighbour.
//
//   node tests/auth.mjs [port]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const BASE_PORT = Number(process.argv[2] || 7219);
const SERVER = 'server/dist/server/src/index.js';
const CLOSE_REVOKED = 4401;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A server of our own, on its own state directory. */
async function startServer(port, env = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-auth-'));
  const child = spawn('node', [SERVER], {
    env: { ...process.env, WD_TOKEN: undefined, WD_NO_AUTH: undefined, XDG_STATE_HOME: state, WD_PORT: String(port), ...env },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) break;
    } catch {
      // Not up yet.
    }
    await sleep(100);
  }
  const tokenFile = path.join(state, 'finestra', 'token');
  return {
    port,
    state,
    tokenFile,
    token: () => fs.readFileSync(tokenFile, 'utf8').trim(),
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    },
  };
}

/** A connection that records every event and how it was closed. */
async function connect(port, { token, cookie, userAgent } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `wd_token=${encodeURIComponent(cookie)}`;
  if (userAgent) headers['user-agent'] = userAgent;
  const url = `ws://127.0.0.1:${port}/ws${token ? `?t=${encodeURIComponent(token)}` : ''}`;
  const ws = new WebSocket(url, { headers });
  const events = [];
  const pending = new Map();
  let nextId = 1;
  let closed = null;
  const closedPromise = new Promise((resolve) => {
    ws.on('close', (code, reason) => {
      closed = { code, reason: reason.toString() };
      resolve(closed);
    });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no hello within 10s')), 10000);
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'hello') { clearTimeout(timer); resolve(); }
      else if (msg.t === 'ev') events.push(msg);
      else if (msg.t === 'res') {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); msg.ok ? p.resolve(msg.d) : p.reject(Object.assign(new Error(msg.e?.message), { code: msg.e?.code })); }
      }
    });
  });

  return {
    events,
    get closed() { return closed; },
    closedPromise,
    isOpen: () => ws.readyState === WebSocket.OPEN,
    close: () => ws.close(),
    call: (svc, m, a) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ t: 'req', id, svc, m, a }));
    }),
  };
}

const refused = (port, opts) => connect(port, opts).then(() => false, (err) => /401/.test(String(err.message)));
const sessionStatus = async (port, query = '', headers = {}) =>
  (await fetch(`http://127.0.0.1:${port}/api/session${query}`, { headers })).status;

/* ===================================================================== */
/* A token the server reads from its own file                            */
/* ===================================================================== */

const server = await startServer(BASE_PORT);
const first = server.token();
check('the server minted a token into its state directory', first.length >= 16, server.tokenFile);
check('and the file is readable by nobody else', (fs.statSync(server.tokenFile).mode & 0o777) === 0o600);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const asker = await connect(server.port, { token: first, userAgent: UA });
const laptop = await connect(server.port, { cookie: first, userAgent: 'Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/131.0' });
const cli = await connect(server.port, { token: first });

/* --- who is in --------------------------------------------------------- */

const status = await asker.call('auth', 'status', {});
check('status says a token is in force, from the file', status.enabled === true && status.source === 'file', `${status.enabled} ${status.source}`);
check('and names the file', status.file === server.tokenFile, status.file);
check('it lists every live connection', status.sessions.length === 3, `${status.sessions.length}`);
check('exactly one of them is the asker', status.sessions.filter((s) => s.self).length === 1);
check('the asker is who it says it is', status.sessions.find((s) => s.self)?.userAgent === UA);
check('a connection with no browser has no user agent', status.sessions.some((s) => s.userAgent === null));
check('each says where it came from and since when',
  status.sessions.every((s) => typeof s.since === 'number' && /127\.0\.0\.1|::1/.test(s.address ?? '')),
  JSON.stringify(status.sessions.map((s) => s.address)));
check('oldest first', status.sessions.every((s, i, all) => i === 0 || all[i - 1].since <= s.since));
check('and never says what any of them is doing',
  status.sessions.every((s) => Object.keys(s).sort().join() === 'address,id,self,since,userAgent,viaRelay'),
  Object.keys(status.sessions[0]).join());

/* --- rotating, keeping the others -------------------------------------- */

const rotated = await asker.call('auth', 'rotate', {});
check('rotating returns the new token to the asker', typeof rotated.token === 'string' && rotated.token.length >= 16 && rotated.token !== first);
check('and says it kept the other two', rotated.kept === 2 && rotated.disconnected === 0, JSON.stringify(rotated));
await sleep(200);
const second = rotated.token;

check('every other live session is handed the new token',
  [laptop, cli].every((c) => c.events.some((e) => e.svc === 'auth' && e.e === 'rotated' && e.d?.token === second)));
check('the asker is not told what it already knows',
  !asker.events.some((e) => e.svc === 'auth'));
check('nobody was hung up on', asker.isOpen() && laptop.isOpen() && cli.isOpen());

check('the old token no longer opens the door', await sessionStatus(server.port, `?t=${first}`) === 401);
check('the new one does', await sessionStatus(server.port, `?t=${second}`) === 200);
const exchange = await fetch(`http://127.0.0.1:${server.port}/api/session?t=${second}`);
check('and is exchanged for a cookie carrying it',
  /wd_token=/.test(exchange.headers.get('set-cookie') ?? '') && exchange.headers.get('set-cookie').includes(encodeURIComponent(second)));
check('an old cookie is refused too', await sessionStatus(server.port, '', { cookie: `wd_token=${first}` }) === 401);
check('a socket with the old token is refused', await refused(server.port, { token: first }));
const byCookie = await connect(server.port, { cookie: second });
check('a socket carrying only the new cookie gets in — the browser relies on this', byCookie.isOpen());
byCookie.close();
await byCookie.closedPromise;

check('the file on disk holds the new token', server.token() === second);
check('still readable by nobody else', (fs.statSync(server.tokenFile).mode & 0o777) === 0o600);
check('and no half-written file was left behind',
  fs.readdirSync(path.dirname(server.tokenFile)).every((f) => !f.endsWith('.tmp')),
  fs.readdirSync(path.dirname(server.tokenFile)).join());

/* --- rotating and signing the others out ------------------------------- */

const dropped = await asker.call('auth', 'rotate', { keepOthers: false });
check('rotating without keeping reports who was signed out', dropped.kept === 0 && dropped.disconnected === 2, JSON.stringify(dropped));
const third = dropped.token;
const [laptopClose, cliClose] = await Promise.all([
  Promise.race([laptop.closedPromise, sleep(3000).then(() => null)]),
  Promise.race([cli.closedPromise, sleep(3000).then(() => null)]),
]);
check('the others are hung up on with the revoked close code',
  laptopClose?.code === CLOSE_REVOKED && cliClose?.code === CLOSE_REVOKED,
  `${laptopClose?.code} ${cliClose?.code}`);
check('and told why, in words', /token was changed/.test(laptopClose?.reason ?? ''), laptopClose?.reason);
check('they were not handed the token they were cut off from',
  !laptop.events.some((e) => e.svc === 'auth' && e.d?.token === third));
check('the asker is still connected', asker.isOpen() && (await asker.call('auth', 'status', {})).sessions.length === 1);
check('the token file moved on again', server.token() === third);

/* --- the file is what the next start reads ----------------------------- */

asker.close();
await server.stop();
const again = await startServer(BASE_PORT, { XDG_STATE_HOME: server.state });
check('after a restart the latest token is the one accepted', await sessionStatus(again.port, `?t=${third}`) === 200);
check('and the first one is still dead', await sessionStatus(again.port, `?t=${first}`) === 401);
await again.stop();
fs.rmSync(server.state, { recursive: true, force: true });

/* ===================================================================== */
/* A token the environment set                                           */
/* ===================================================================== */

const envServer = await startServer(BASE_PORT + 1, { WD_TOKEN: 'from-the-environment-0001' });
const envClient = await connect(envServer.port, { token: 'from-the-environment-0001' });
const envStatus = await envClient.call('auth', 'status', {});
check('with WD_TOKEN set, status says the environment owns it', envStatus.enabled === true && envStatus.source === 'env', envStatus.source);
await envClient.call('auth', 'rotate', {}).then(
  () => check('and rotating is refused', false, 'it agreed'),
  (err) => check('and rotating is refused', err.code === 'EPERM' && /WD_TOKEN/.test(err.message), err.message),
);
check('nothing was written to the state directory', !fs.existsSync(envServer.tokenFile));
envClient.close();
await envServer.stop();
fs.rmSync(envServer.state, { recursive: true, force: true });

/* ===================================================================== */
/* No token at all                                                       */
/* ===================================================================== */

const openServer = await startServer(BASE_PORT + 2, { WD_NO_AUTH: '1' });
const openClient = await connect(openServer.port, {});
const openStatus = await openClient.call('auth', 'status', {});
check('with WD_NO_AUTH, status says so', openStatus.enabled === false && openStatus.source === 'none', `${openStatus.enabled} ${openStatus.source}`);
await openClient.call('auth', 'rotate', {}).then(
  () => check('and there is nothing to rotate', false, 'it agreed'),
  (err) => check('and there is nothing to rotate', err.code === 'EPERM', err.message),
);
openClient.close();
await openServer.stop();
fs.rmSync(openServer.state, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'all' : failures} access-token check(s) ${failures === 0 ? 'passed' : 'FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
