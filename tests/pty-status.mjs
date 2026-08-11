// Does pty.status tell an idle prompt apart from a busy terminal?
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
    else if (msg.t === 'res') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.d) : p.reject(new Error(`${msg.e?.code}: ${msg.e?.message}`));
    }
  });
});

check('pty advertises the status method',
  hello.services.find((s) => s.name === 'pty').methods.includes('status'));

await call('pty', 'status', { pid: 1 }).then(
  () => check('refuses a pid this session did not spawn', false, 'it answered'),
  (err) => check('refuses a pid this session did not spawn', /ENOPTY/.test(err.message)),
);

const channelId = nextId++;
ws.send(JSON.stringify({ t: 'open', id: channelId, svc: 'pty', m: 'spawn', a: { cols: 80, rows: 24 } }));
await new Promise((r) => setTimeout(r, 900));
const pid = opened.pid;

const send = (text) => {
  const payload = Buffer.from(text, 'utf8');
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0x01;
  frame.writeUInt32BE(channelId, 1);
  payload.copy(frame, 5);
  ws.send(frame, { binary: true });
};
const status = () => call('pty', 'status', { pid });
const settle = () => new Promise((r) => setTimeout(r, 700));

// 1. Sitting at a prompt — the case the whole feature exists for.
{
  const s = await status();
  check('an idle prompt is not busy', s.busy === false, JSON.stringify(s));
  check('no foreground command at a prompt', s.foreground === null);
  check('no background jobs at a prompt', s.jobs.length === 0);
}

// 2. A foreground command.
send('sleep 30\r');
await settle();
{
  const s = await status();
  check('a foreground command marks it busy', s.busy === true);
  check('the foreground command is named', s.foreground?.command === 'sleep', s.foreground?.command);
  check('the foreground job is not double-counted', s.jobs.length === 0, JSON.stringify(s.jobs));
}

// 3. Interrupt it — back to idle.
send('\x03');
await settle();
{
  const s = await status();
  check('interrupting returns it to idle', s.busy === false, JSON.stringify(s));
}

// 4. A background job: nothing in the foreground, but closing still kills it.
send('sleep 30 &\r');
await settle();
{
  const s = await status();
  check('a background job counts as busy', s.busy === true);
  check('nothing is in the foreground', s.foreground === null, JSON.stringify(s.foreground));
  check('the background job is named', s.jobs.some((j) => j.command === 'sleep'),
    JSON.stringify(s.jobs));
}

// 5. Foreground and background at once.
send('sleep 30\r');
await settle();
{
  const s = await status();
  check('foreground and background are reported together',
    s.foreground?.command === 'sleep' && s.jobs.length >= 1,
    `fg=${s.foreground?.command} jobs=${s.jobs.length}`);
}

// 6. Clean up and confirm idle again.
send('\x03');
await settle();
send('kill %1 2>/dev/null; wait 2>/dev/null\r');
await settle();
{
  const s = await status();
  check('killing the job returns it to idle', s.busy === false, JSON.stringify(s));
}

// 7. A vanished shell must not answer.
ws.send(JSON.stringify({ t: 'close', id: channelId }));
await settle();
await status().then(
  () => check('a closed terminal stops answering', false, 'it answered'),
  (err) => check('a closed terminal stops answering', /ENOPTY/.test(err.message)),
);

ws.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
