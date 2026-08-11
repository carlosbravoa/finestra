// Checks pty.cwd: correctness, and that it cannot be aimed at other processes.
import WebSocket from 'ws';

const PORT = Number(process.argv[3] || 7099);
const TOKEN = process.argv[2];
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`);
let nextId = 1;
const pending = new Map();
let opened = null;
let closed = null;

const call = (svc, m, a) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: 'req', id, svc, m, a }));
  });

const hello = await new Promise((resolve, reject) => {
  ws.on('error', reject);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.t === 'hello') resolve(msg);
    else if (msg.t === 'opened') opened = msg.d;
    else if (msg.t === 'close') closed = msg.e;
    else if (msg.t === 'res') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.d) : p.reject(new Error(`${msg.e?.code}: ${msg.e?.message}`));
    }
  });
});

check('pty advertises the cwd method', hello.services.find((s) => s.name === 'pty').methods.includes('cwd'));

// A shell we did not start must be refused, even though /proc would answer.
await call('pty', 'cwd', { pid: 1 }).then(
  () => check('refuses a pid this session did not spawn', false, 'it answered'),
  (err) => check('refuses a pid this session did not spawn', /ENOPTY/.test(err.message), err.message),
);

const channelId = nextId++;
ws.send(JSON.stringify({ t: 'open', id: channelId, svc: 'pty', m: 'spawn', a: { cols: 80, rows: 24 } }));
await new Promise((r) => setTimeout(r, 700));

const pid = opened.pid;
const start = await call('pty', 'cwd', { pid });
check('reports the spawn directory', start.cwd === hello.host.home, start.cwd);

const sendToPty = (text) => {
  const payload = Buffer.from(text, 'utf8');
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0x01;
  frame.writeUInt32BE(channelId, 1);
  payload.copy(frame, 5);
  ws.send(frame, { binary: true });
};

// The whole point: follow the user's `cd`, which no shell tells us about.
const dir = `/tmp/wd-cwd-${process.pid}`;
sendToPty(`mkdir -p ${dir} && cd ${dir}\r`);
await new Promise((r) => setTimeout(r, 800));

const moved = await call('pty', 'cwd', { pid });
check('follows the shell after cd', moved.cwd === dir, moved.cwd);

// Once the shell is gone the pid must stop being answerable, so a recycled
// pid belonging to some other process can never be read.
ws.send(JSON.stringify({ t: 'close', id: channelId }));
await new Promise((r) => setTimeout(r, 600));
await call('pty', 'cwd', { pid }).then(
  () => check('forgets the pid once the shell exits', false, 'it answered'),
  (err) => check('forgets the pid once the shell exits', /ENOPTY/.test(err.message), err.message),
);

ws.close();
const { rmSync } = await import('node:fs');
rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
