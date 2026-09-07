// Does a terminal survive its window, and can a window pick it back up?
//
// The scenario this exists for: a long job running in a terminal, the tab
// closed (or the laptop shut), and the desktop opened again later — the job
// must still be running, and the terminal must show it. The suite runs the
// server with WD_TERMINAL_GRACE=3 so the "nobody came back" case is checkable.
import WebSocket from 'ws';

const PORT = Number(process.argv[3] || 7099);
const TOKEN = process.argv[2];
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** One browser connection, as the shell would make it. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`);
  let nextId = 1;
  const pending = new Map();
  const channels = new Map();
  const conn = {
    ws,
    hello: null,
    call: (svc, m, a) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ t: 'req', id, svc, m, a }));
      }),
    /** Opens a channel; resolves to {id, info, output(), closed} once the server answers. */
    open: (m, a) =>
      new Promise((resolve) => {
        const id = nextId++;
        const ch = { id, info: null, bytes: [], closed: null, output: () => Buffer.concat(ch.bytes).toString('utf8') };
        ch.resolveOpen = resolve;
        channels.set(id, ch);
        ws.send(JSON.stringify({ t: 'open', id, svc: 'pty', m, a }));
      }),
    type: (ch, text) => {
      const payload = Buffer.from(text, 'utf8');
      const frame = Buffer.alloc(5 + payload.length);
      frame[0] = 0x01;
      frame.writeUInt32BE(ch.id, 1);
      payload.copy(frame, 5);
      ws.send(frame, { binary: true });
    },
    close: (ch) => ws.send(JSON.stringify({ t: 'close', id: ch.id })),
  };
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const ch = channels.get(data.readUInt32BE(1));
        if (ch && data[0] === 0x01) ch.bytes.push(Buffer.from(data.subarray(5)));
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.t === 'hello') { conn.hello = msg; resolve(); }
      else if (msg.t === 'opened') { const ch = channels.get(msg.id); ch.info = msg.d; ch.resolveOpen(ch); }
      else if (msg.t === 'close') {
        const ch = channels.get(msg.id);
        if (!ch) return;
        ch.closed = msg.e ?? 'closed';
        if (!ch.info) ch.resolveOpen(ch);
      } else if (msg.t === 'res') {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.ok ? p.resolve(msg.d) : p.reject(new Error(`${msg.e?.code}: ${msg.e?.message}`));
      }
    });
  });
  return conn;
}

const a = await connect();
check('pty advertises the attach channel',
  a.hello.services.find((s) => s.name === 'pty').channels.includes('attach'));

// --- A job outlives the connection that started it ------------------------

const first = await a.open('spawn', { cols: 80, rows: 24 });
await settle(900);
const { id, pid } = first.info;
check('spawn names the terminal', typeof id === 'string' && id.length > 0, id);
check('a fresh shell starts its output at zero', first.info.offset === 0 && first.info.replay === 'partial');

a.type(first, 'echo ATTACH-MARK-1\r');
await settle();
a.type(first, 'sleep 300\r');
await settle();
const seenByA = Buffer.concat(first.bytes).length;
check('the marker was drawn', first.output().includes('ATTACH-MARK-1'));

// The tab goes away without a word — no channel close, no websocket close frame.
a.ws.terminate();
await settle();
check('the shell survives its connection', alive(pid), `pid ${pid}`);

// --- Another connection picks it up ----------------------------------------

const b = await connect();
const wrong = await b.open('attach', { id: 'not-a-terminal', since: 0 });
check('attaching to an unknown id is refused', wrong.closed !== null && wrong.info === null, wrong.closed ?? '');

const second = await b.open('attach', { id, since: seenByA });
await settle();
check('attaching by id gets the same shell', second.info?.pid === pid, `pid ${second.info?.pid}`);
check('a window that saw everything gets only what followed',
  second.info.replay === 'partial' && second.info.offset === seenByA && !second.output().includes('ATTACH-MARK-1'),
  `${second.info.replay} from ${second.info.offset}, ${Buffer.concat(second.bytes).length} bytes`);

const status = await b.call('pty', 'status', { pid });
check('the job kept running across the disconnect',
  status.foreground?.command === 'sleep', JSON.stringify(status.foreground));

// --- A third window takes it over; the second is told ----------------------

const c = await connect();
const third = await c.open('attach', { id, since: 0 });
await settle();
check('a window with nothing drawn is shown the scrollback',
  third.output().includes('ATTACH-MARK-1'), `${Buffer.concat(third.bytes).length} bytes`);
check('the displaced window is told', /another window/i.test(second.closed ?? ''), second.closed ?? 'still open');
check('the displaced window can no longer ask about it',
  await b.call('pty', 'status', { pid }).then(() => false, (e) => /ENOPTY/.test(e.message)));
check('being displaced did not kill the shell', alive(pid));

// Typing reaches the job through the new window.
c.type(third, '\x03');
await settle();
c.type(third, 'echo ATTACH-MARK-3\r');
await settle();
check('input through the new window reaches the shell', third.output().includes('ATTACH-MARK-3'));

// --- Closing the window still hangs the shell up ---------------------------

c.close(third);
await settle(1000);
check('closing the terminal hangs the shell up', !alive(pid), `pid ${pid}`);

// --- Nobody comes back: the grace period ends it ---------------------------

const d = await connect();
const orphan = await d.open('spawn', { cols: 80, rows: 24 });
await settle(900);
d.ws.terminate();
await settle(1000);
check('an unclaimed shell is kept through the grace period', alive(orphan.info.pid));
await settle(3500);
check('and hung up when it ends', !alive(orphan.info.pid), `pid ${orphan.info.pid}`);

// --- Marked to be kept: it waits past the grace period, and is listed --------

const g = await connect();
const kept = await g.open('spawn', { cols: 80, rows: 24 });
await settle(900);
g.type(kept, 'sleep 300\r');
await settle();
check('a terminal advertises whether it is kept', kept.info.keep === false);
check('keep needs the id', await g.call('pty', 'keep', { id: 'nope', keep: true }).then(() => false, (e) => /ENOPTY/.test(e.message)));
const marked = await g.call('pty', 'keep', { id: kept.info.id, keep: true });
check('its window can mark it kept', marked.keep === true);

const stranger = await connect();
check('another connection cannot change that',
  await stranger.call('pty', 'keep', { id: kept.info.id, keep: false }).then(() => false, (e) => /ENOPTY/.test(e.message)));
let listed = (await stranger.call('pty', 'list')).find((t) => t.id === kept.info.id);
check('any connection can list it', Boolean(listed), JSON.stringify(listed));
check('the list says it is open elsewhere and what it is running',
  listed?.attached === true && listed?.running === 'sleep' && listed?.keep === true, JSON.stringify(listed));

g.ws.terminate();
await settle(4500);
check('a kept shell outlives the grace period', alive(kept.info.pid), `pid ${kept.info.pid}`);
listed = (await stranger.call('pty', 'list')).find((t) => t.id === kept.info.id);
check('the list now says it is alone, and since when',
  listed?.attached === false && typeof listed?.detachedAt === 'number' && Date.now() - listed.detachedAt < 10000,
  JSON.stringify(listed));

const pickup = await stranger.open('attach', { id: kept.info.id, since: 0 });
await settle();
check('a stranger with the id picks it up, still kept', pickup.info?.pid === kept.info.pid && pickup.info.keep === true);
const unmarked = await stranger.call('pty', 'keep', { id: kept.info.id, keep: false });
check('the new window can unmark it', unmarked.keep === false);
stranger.ws.terminate();
await settle(4500);
check('unmarked, the grace period applies again', !alive(kept.info.pid), `pid ${kept.info.pid}`);

// --- More output than the buffer holds -------------------------------------

const e = await connect();
const loud = await e.open('spawn', { cols: 200, rows: 24 });
await settle(900);
e.type(loud, "echo BEGIN-MARK; seq 1 250000; echo END-MARK\r");
for (let i = 0; i < 60 && !loud.output().includes('END-MARK'); i++) await settle(250);
check('the loud shell finished', loud.output().includes('END-MARK'));
e.ws.terminate();
await settle();

const f = await connect();
const late = await f.open('attach', { id: loud.info.id, since: 0 });
await settle(1500);
check('a window too far behind gets a full replay instead',
  late.info.replay === 'full' && late.info.offset > 0, `${late.info.replay} from ${late.info.offset}`);
const replayed = late.output();
check('the replay is the newest output', replayed.includes('END-MARK') && !replayed.includes('BEGIN-MARK'),
  `${replayed.length} chars`);
check('the replay begins on a line boundary', /^\d+\r?\n/.test(replayed), JSON.stringify(replayed.slice(0, 12)));
check('the replay is bounded', Buffer.byteLength(replayed) <= 1024 * 1024, `${Buffer.byteLength(replayed)} bytes`);
f.close(late);
await settle();

for (const conn of [b, c, d, e, f]) conn.ws.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
