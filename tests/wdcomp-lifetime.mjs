// The compositor's lifetime rule, tested without installing anything: a
// Wayland client here is a bare unix-socket connection (libwayland creates a
// wl_client on accept), and a launcher is /bin/true — the shape of VS Code's
// `codium` script, which starts the editor in the background and exits 0.
// The rule under test: connected clients keep the session alive, the child's
// exit alone does not end it, and teardown reaches clients that setsid'd out
// of the process group. Runs wdcomp directly; no server, no display, no app.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WDCOMP = path.join(here, '..', 'compositor', 'build', 'wdcomp');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

if (!fs.existsSync(WDCOMP)) {
  console.log('SKIP — compositor not built (make -C compositor)');
  process.exit(0);
}

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdcomp-life-'));
fs.chmodSync(runtimeDir, 0o700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextSocket = 9750;
function compositor(...command) {
  const socket = `wayland-${nextSocket++}`;
  const child = spawn(WDCOMP, ['-s', socket, '-o', runtimeDir, '--', ...command], {
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const state = { child, socket, stderr: '', exited: null };
  child.stderr.on('data', (d) => (state.stderr += d.toString()));
  state.done = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve((state.exited = { code, signal }))),
  );
  return state;
}

/* A client in its own session (detached = setsid), the way a launcher's
 * grandchild arrives: outside wdcomp's process group, reachable only by the
 * pid the display connection carries. Exits 0 on SIGTERM, so how it ended
 * tells us which signal found it. */
function client(socket) {
  const script = `
    const net = require('net');
    const s = net.connect(process.env.WD_SOCK, () => console.log('up'));
    s.on('error', () => process.exit(3));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, WD_SOCK: path.join(runtimeDir, socket) },
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  const state = { child, exited: null };
  state.connected = new Promise((resolve) => child.stdout.on('data', () => resolve()));
  state.done = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve((state.exited = { code, signal }))),
  );
  return state;
}

/* -------------------------------------------------------------------- */
/* A launcher that forks and returns does not end the session           */
/* -------------------------------------------------------------------- */
{
  const comp = compositor('/bin/true');
  await sleep(1500); // /bin/true is long gone; the grace is holding the door
  check('a launcher exiting 0 leaves the session waiting, not dead',
    comp.exited === null && comp.stderr.includes('waiting for a client'),
    comp.exited ? `exited ${JSON.stringify(comp.exited)}` : '');

  const app = client(comp.socket);
  await app.connected;
  await sleep(1500);
  check('a client arriving in the grace keeps it alive',
    comp.exited === null && comp.stderr.includes('client connected'),
    comp.exited ? `exited ${JSON.stringify(comp.exited)}` : '');

  app.child.kill('SIGTERM');
  const ended = await Promise.race([comp.done, sleep(5000)]);
  check('the last client leaving ends the session',
    ended && comp.stderr.includes('last client disconnected'),
    ended ? '' : 'still running 5s after the client left');
}

/* -------------------------------------------------------------------- */
/* A child that fails is still an immediate, honest exit                */
/* -------------------------------------------------------------------- */
{
  const started = Date.now();
  const comp = compositor('/bin/false');
  const ended = await Promise.race([comp.done, sleep(5000)]);
  check('a child exiting non-zero ends the session at once',
    ended && Date.now() - started < 5000 && comp.stderr.includes('status 1'),
    ended ? `${Date.now() - started}ms` : 'still running');
}

/* -------------------------------------------------------------------- */
/* Nothing ever connects: the grace runs out rather than idling forever */
/* -------------------------------------------------------------------- */
{
  const comp = compositor('/bin/true');
  const ended = await Promise.race([comp.done, sleep(9000)]);
  check('no client within the grace ends the session',
    ended && comp.stderr.includes('no client ever connected'),
    ended ? '' : 'still running 9s after an instant exit');
}

/* -------------------------------------------------------------------- */
/* Teardown reaches a client outside the process group                  */
/* -------------------------------------------------------------------- */
{
  const comp = compositor('/bin/true');
  const app = client(comp.socket);
  await app.connected;
  comp.child.kill('SIGTERM');
  await Promise.race([app.done, sleep(5000)]);
  check('stopping the compositor politely stops a setsid\'d client',
    app.exited?.code === 0,
    app.exited ? `exited ${JSON.stringify(app.exited)}` : 'client outlived the compositor');
  await Promise.race([comp.done, sleep(5000)]);
  if (comp.exited === null) comp.child.kill('SIGKILL');
  if (app.exited === null) app.child.kill('SIGKILL');
}

fs.rmSync(runtimeDir, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
