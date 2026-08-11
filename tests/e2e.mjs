// End-to-end check: auth gate, handshake, fs service, and a real PTY session.
import WebSocket from 'ws';

const PORT = Number(process.argv[3] || 7099);
const TOKEN = process.argv[2];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// --- HTTP auth gate -------------------------------------------------
const noToken = await fetch(`http://127.0.0.1:${PORT}/api/session`);
check('rejects request with no token', noToken.status === 401, `status ${noToken.status}`);

const badToken = await fetch(`http://127.0.0.1:${PORT}/api/session?t=wrong-token-value`);
check('rejects wrong token', badToken.status === 401, `status ${badToken.status}`);

const good = await fetch(`http://127.0.0.1:${PORT}/api/session?t=${TOKEN}`);
check('accepts correct token', good.status === 200, `status ${good.status}`);
check('sets session cookie', Boolean(good.headers.get('set-cookie')));

const index = await fetch(`http://127.0.0.1:${PORT}/`);
const html = await index.text();
check('serves the built client', index.status === 200 && html.includes('<div id="root">'));

// --- WebSocket auth gate --------------------------------------------
await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('open', () => { check('rejects unauthenticated socket', false, 'it opened'); ws.close(); resolve(); });
  ws.on('error', (err) => { check('rejects unauthenticated socket', /401/.test(String(err)), String(err.message)); resolve(); });
});

// --- Authenticated session ------------------------------------------
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`);
const decoder = new TextDecoder();
let nextId = 1;
const pending = new Map();
let ptyOutput = '';
let ptyChannel = null;
let ptyClosed = null;

const call = (svc, m, a) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: 'req', id, svc, m, a }));
  });

const helloSeen = new Promise((resolve) => {
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary frame: [opcode][4-byte channel id][payload]
      if (data[0] === 0x01) ptyOutput += decoder.decode(data.subarray(5));
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.t === 'hello') resolve(msg);
    else if (msg.t === 'res') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.d) : p.reject(new Error(msg.e?.message));
    } else if (msg.t === 'opened') ptyChannel = msg.d;
    else if (msg.t === 'close') ptyClosed = msg.e ?? 'closed';
  });
});

await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});

const hello = await helloSeen;
check('authenticated socket receives hello', hello.v === 1);
check(
  'hello advertises every service',
  ['pty', 'fs', 'sys'].every((n) => hello.services.some((s) => s.name === n)),
  hello.services.map((s) => s.name).join(', '),
);
check('hello carries host info', Boolean(hello.host.hostname && hello.host.home));
check('pty advertises a spawn channel', hello.services.find((s) => s.name === 'pty').channels.includes('spawn'));

// --- fs service ------------------------------------------------------
const listing = await call('fs', 'list', { path: hello.host.home });
check('fs.list returns entries', Array.isArray(listing.entries) && listing.entries.length > 0,
  `${listing.entries.length} entries in ${listing.path}`);
check('fs.list sorts directories first', (() => {
  const kinds = listing.entries.map((e) => e.kind === 'directory');
  return kinds.indexOf(false) === -1 || !kinds.slice(kinds.indexOf(false)).includes(true);
})());
check('fs.list hides dotfiles by default', !listing.entries.some((e) => e.name.startsWith('.')));

const withHidden = await call('fs', 'list', { path: hello.host.home, showHidden: true });
check('fs.list can show dotfiles', withHidden.entries.length >= listing.entries.length);

await call('fs', 'remove', { path: '/' }).then(
  () => check('fs.remove refuses to delete /', false, 'it did not refuse'),
  (err) => check('fs.remove refuses to delete /', /Refusing/.test(err.message), err.message),
);

await call('fs', 'stat', { path: '/definitely/not/here' }).then(
  () => check('fs.stat reports missing paths', false),
  (err) => check('fs.stat reports missing paths', true, err.message),
);

const stats = await call('sys', 'stats');
check('sys.stats reports memory and cores', stats.memTotal > 0 && stats.cores > 0,
  `${stats.cores} cores, ${(stats.memTotal / 1e9).toFixed(1)} GB`);

// --- PTY: a real shell touching the real filesystem -------------------
const channelId = nextId++;
ws.send(JSON.stringify({ t: 'open', id: channelId, svc: 'pty', m: 'spawn', a: { cols: 100, rows: 30 } }));
await new Promise((r) => setTimeout(r, 700));
check('pty channel opens with a pid', ptyChannel?.pid > 0, `pid ${ptyChannel?.pid}, shell ${ptyChannel?.shell}`);

const sendToPty = (text) => {
  const payload = Buffer.from(text, 'utf8');
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0x01;
  frame.writeUInt32BE(channelId, 1);
  payload.copy(frame, 5);
  ws.send(frame, { binary: true });
};

// Prove the shell is really on this filesystem, not a simulation.
const marker = `wd-probe-${process.pid}`;
sendToPty(`mkdir -p /tmp/${marker} && cd /tmp/${marker} && echo hello-from-pty > proof.txt\r`);
await new Promise((r) => setTimeout(r, 500));
sendToPty('pwd && cat proof.txt && whoami && echo "COLS=$COLUMNS" && echo TERM=$TERM\r');
await new Promise((r) => setTimeout(r, 900));

check('pty output reaches the client', ptyOutput.length > 0, `${ptyOutput.length} bytes`);
check('shell ran in the created directory', ptyOutput.includes(`/tmp/${marker}`));
check('file written by the shell is readable', ptyOutput.includes('hello-from-pty'));
check('shell runs as the server user', ptyOutput.includes(hello.host.user));
check('pty honours the requested width', /COLS=100/.test(ptyOutput), (ptyOutput.match(/COLS=\d+/) ?? [])[0]);
check('TERM is set for full-screen apps', ptyOutput.includes('TERM=xterm-256color'));

// The file must exist on the actual disk, verified outside the socket.
const { existsSync, readFileSync, rmSync } = await import('node:fs');
const proofPath = `/tmp/${marker}/proof.txt`;
check('shell wrote to the real filesystem', existsSync(proofPath) &&
  readFileSync(proofPath, 'utf8').trim() === 'hello-from-pty', proofPath);

// Resize control, then confirm the shell notices.
ws.send(JSON.stringify({ t: 'ctl', id: channelId, m: 'resize', a: { cols: 42, rows: 12 } }));
await new Promise((r) => setTimeout(r, 300));
ptyOutput = '';
sendToPty('echo "RESIZED=$COLUMNS"\r');
await new Promise((r) => setTimeout(r, 700));
check('resize reaches the shell', /RESIZED=42/.test(ptyOutput), (ptyOutput.match(/RESIZED=\d+/) ?? [])[0]);

// Exiting the shell must close the channel.
ptyOutput = '';
sendToPty('exit\r');
await new Promise((r) => setTimeout(r, 700));
check('channel closes when the shell exits', ptyClosed !== null, ptyClosed ?? '');

// Closing the socket must not leave the PTY process behind.
const pid = ptyChannel.pid;
ws.close();
await new Promise((r) => setTimeout(r, 500));
let stillAlive = true;
try { process.kill(pid, 0); } catch { stillAlive = false; }
check('no orphaned shell process', !stillAlive, `pid ${pid}`);

rmSync(`/tmp/${marker}`, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
