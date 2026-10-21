// One socket carries everything a desktop says, so the question is what a
// large payload does to everything else on it. Before this, a half-megabyte
// window frame went out as one message and the terminal's next byte, the
// browser's next keystroke and the server's own keepalive all waited behind
// it — on a slow link, for longer than the keepalive was prepared to wait,
// at which point the server cut the connection and killed the application
// that had drawn the frame.
//
// Driven through a stand-in socket that hands bytes over at a chosen pace,
// so the checks are about the rule and not about this machine's loopback.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Session } from '../server/src/session.js';
import type { Service } from '../server/src/service.js';
import type { Config } from '../server/src/config.js';
import {
  decodeBinaryFrame,
  SLICE_BYTES,
  SliceAssembler,
  type ServerMessage,
} from '../shared/protocol.js';

const results: boolean[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}  — ${(err as Error).message}`);
  }
}

/**
 * A WebSocket as the Session sees it: `send` with an optional completion
 * callback, `ping`, `terminate`, and the events it listens for. Every write
 * is recorded in the order it was *accepted*, which on a real socket is the
 * order the wire sees. `delayPerByte` is the link: a callback waits that long
 * per byte before reporting the write done, so a slow link is a number.
 */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly wire: Array<{ text?: ServerMessage; bytes?: Uint8Array }> = [];
  pings = 0;
  terminated = false;
  delayPerByte = 0;
  /** The link has died: nothing written is ever reported taken. */
  stalled = false;
  /** Writes whose callback has not yet fired. */
  inFlight = 0;

  send(data: string | Uint8Array, optsOrCb?: unknown, cb?: (err?: Error) => void): void {
    const done = typeof optsOrCb === 'function' ? (optsOrCb as (err?: Error) => void) : cb;
    if (typeof data === 'string') {
      this.wire.push({ text: JSON.parse(data) as ServerMessage });
      done?.();
      return;
    }
    this.wire.push({ bytes: data });
    if (!done) return;
    this.inFlight++;
    if (this.stalled) return;
    const ms = Math.ceil(data.length * this.delayPerByte);
    setTimeout(() => {
      this.inFlight--;
      done();
    }, ms);
  }

  ping(): void {
    this.pings++;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }

  close(): void {
    this.terminate();
  }

  /** The browser sent this. */
  receive(msg: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)), false);
  }

  pong(): void {
    this.emit('pong');
  }
}

/** A service whose channel sends whatever the test hands it. */
function makeHarness(delayPerByte = 0) {
  const ws = new FakeSocket();
  ws.delayPerByte = delayPerByte;
  type Ctx = { send(d: unknown): void; sendBinary(d: Uint8Array): void; close(e?: string): void };
  const contexts = new Map<number, Ctx>();
  const service: Service = {
    name: 'echo',
    methods: {},
    channels: {
      open: (args: unknown, ctx: unknown) => {
        const c = ctx as Ctx & { id: number };
        contexts.set(c.id, c);
        return { info: { ok: true } };
      },
    },
  } as unknown as Service;
  const config = { terminalGrace: 0 } as unknown as Config;
  new Session(ws as never, new Map([['echo', service]]), config, { name: 'test' } as never);
  return { ws, contexts };
}

/** Everything written to the wire, decoded, in order. */
function written(ws: FakeSocket) {
  return ws.wire.map((w) => (w.text ? { text: w.text } : { frame: decodeBinaryFrame(w.bytes!)! }));
}

await check('a small payload goes out whole, as before', async () => {
  const { ws, contexts } = makeHarness();
  ws.receive({ t: 'open', id: 1, svc: 'echo', m: 'open' });
  await sleep(10);
  contexts.get(1)!.sendBinary(new Uint8Array(100).fill(7));
  const frames = written(ws).filter((w) => 'frame' in w);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].frame!.partial, false);
  assert.equal(frames[0].frame!.payload.length, 100);
});

await check('a large payload goes out in slices that reassemble to the original', async () => {
  const { ws, contexts } = makeHarness();
  ws.receive({ t: 'open', id: 1, svc: 'echo', m: 'open' });
  await sleep(10);
  const payload = new Uint8Array(SLICE_BYTES * 5 + 123);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  contexts.get(1)!.sendBinary(payload);
  await sleep(50);
  const frames = written(ws).filter((w) => 'frame' in w).map((w) => w.frame!);
  assert.equal(frames.length, 6, `${frames.length} pieces`);
  assert.ok(frames.slice(0, -1).every((f) => f.partial), 'all but the last say more follows');
  assert.equal(frames.at(-1)!.partial, false);
  const assembler = new SliceAssembler();
  let whole: Uint8Array | null = null;
  for (const f of frames) whole = assembler.push(f) ?? whole;
  assert.ok(whole, 'the assembler produced a payload');
  assert.deepEqual(Buffer.from(whole!), Buffer.from(payload));
});

await check('a message sent while a large payload is going out gets between its pieces', async () => {
  // A link that takes 1 ms per kilobyte: the payload is on the wire for ~500 ms.
  const { ws, contexts } = makeHarness(0.001);
  ws.receive({ t: 'open', id: 1, svc: 'echo', m: 'open' });
  ws.receive({ t: 'open', id: 2, svc: 'echo', m: 'open' });
  await sleep(10);
  ws.wire.length = 0;
  contexts.get(1)!.sendBinary(new Uint8Array(SLICE_BYTES * 30));
  await sleep(40);
  // The terminal's byte, and a small frame of another channel.
  contexts.get(2)!.send('tick');
  contexts.get(2)!.sendBinary(new Uint8Array(16));
  await sleep(600);
  const order = written(ws);
  const tickAt = order.findIndex((w) => 'text' in w && w.text!.t === 'data');
  const smallAt = order.findIndex((w) => 'frame' in w && w.frame!.channelId === 2);
  const lastSliceAt = order.findIndex((w) => 'frame' in w && w.frame!.channelId === 1 && !w.frame!.partial);
  assert.ok(lastSliceAt > 0, 'the payload finished');
  assert.ok(tickAt > 0 && tickAt < lastSliceAt, `the message was written at ${tickAt}, the last piece at ${lastSliceAt}`);
  assert.ok(smallAt > 0 && smallAt < lastSliceAt, `the other channel's frame was written at ${smallAt}, the last piece at ${lastSliceAt}`);
});

await check('one piece is in flight at a time, so the socket never holds more than that', async () => {
  const { ws, contexts } = makeHarness(0.002);
  ws.receive({ t: 'open', id: 1, svc: 'echo', m: 'open' });
  await sleep(10);
  contexts.get(1)!.sendBinary(new Uint8Array(SLICE_BYTES * 10));
  contexts.get(1)!.sendBinary(new Uint8Array(SLICE_BYTES * 10));
  let most = 0;
  for (let i = 0; i < 30; i++) {
    most = Math.max(most, ws.inFlight);
    await sleep(10);
  }
  assert.equal(most, 1, `${most} in flight`);
});

await check('a channel keeps its order: a small payload after a large one waits its turn', async () => {
  const { ws, contexts } = makeHarness(0.001);
  ws.receive({ t: 'open', id: 1, svc: 'echo', m: 'open' });
  await sleep(10);
  ws.wire.length = 0;
  contexts.get(1)!.sendBinary(new Uint8Array(SLICE_BYTES * 4).fill(1));
  contexts.get(1)!.sendBinary(new Uint8Array(8).fill(2));
  await sleep(200);
  const frames = written(ws).filter((w) => 'frame' in w).map((w) => w.frame!);
  const assembler = new SliceAssembler();
  const payloads: Uint8Array[] = [];
  for (const f of frames) {
    const whole = assembler.push(f);
    if (whole) payloads.push(whole);
  }
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0][0], 1);
  assert.equal(payloads[1][0], 2);
});

await check('closing a channel drops what was queued for it', async () => {
  const { ws, contexts } = makeHarness(0.001);
  ws.receive({ t: 'open', id: 1, svc: 'echo', m: 'open' });
  ws.receive({ t: 'open', id: 2, svc: 'echo', m: 'open' });
  await sleep(10);
  ws.wire.length = 0;
  contexts.get(1)!.sendBinary(new Uint8Array(SLICE_BYTES * 4));
  contexts.get(1)!.sendBinary(new Uint8Array(SLICE_BYTES * 4));
  contexts.get(2)!.sendBinary(new Uint8Array(SLICE_BYTES * 2));
  await sleep(5);
  ws.receive({ t: 'close', id: 1 });
  await sleep(300);
  const frames = written(ws).filter((w) => 'frame' in w).map((w) => w.frame!);
  const ofOne = frames.filter((f) => f.channelId === 1);
  const ofTwo = frames.filter((f) => f.channelId === 2);
  assert.ok(ofOne.length <= 2, `${ofOne.length} pieces of the closed channel still went out`);
  assert.equal(ofTwo.length, 2, 'the other channel\'s payload went out whole');
  assert.equal(ofTwo.at(-1)!.partial, false);
});

await check('a quiet connection is pinged, and cut off when the ping goes unanswered', async () => {
  const { ws } = makeHarness();
  const session = [...(await import('../server/src/session.js')).liveSessions].at(-1)!;
  await sleep(20);
  session.tick(10);
  assert.equal(ws.pings, 1, 'pinged once');
  assert.equal(ws.terminated, false);
  await sleep(20);
  session.tick(10);
  assert.equal(ws.terminated, true, 'cut off on the second silent tick');
});

await check('a pong is an answer', async () => {
  const { ws } = makeHarness();
  const session = [...(await import('../server/src/session.js')).liveSessions].at(-1)!;
  await sleep(20);
  session.tick(10);
  ws.pong();
  await sleep(20);
  session.tick(10);
  assert.equal(ws.terminated, false);
  assert.equal(ws.pings, 2, 'asked again rather than cut off');
});

await check('a connection that is still taking our bytes is alive, pong or no pong', async () => {
  // The link is slow: a piece takes 50 ms to be accepted, and the heartbeat
  // here is 100 ms. The ping would wait behind the pieces too, and used to be
  // the end of the connection.
  const { ws, contexts } = makeHarness(0.003);
  const session = [...(await import('../server/src/session.js')).liveSessions].at(-1)!;
  ws.receive({ t: 'open', id: 1, svc: 'echo', m: 'open' });
  await sleep(10);
  contexts.get(1)!.sendBinary(new Uint8Array(SLICE_BYTES * 40));
  for (let i = 0; i < 8; i++) {
    await sleep(60);
    session.tick(100);
  }
  assert.equal(ws.terminated, false, 'cut off while its bytes were still being taken');
  assert.equal(ws.pings, 0, `pinged ${ws.pings} times while progress was visible`);
});

await check('a connection that stops taking our bytes is cut off like any other', async () => {
  const { ws, contexts } = makeHarness(0.003);
  const session = [...(await import('../server/src/session.js')).liveSessions].at(-1)!;
  ws.receive({ t: 'open', id: 1, svc: 'echo', m: 'open' });
  await sleep(10);
  // The link dies: the write in flight never completes.
  ws.stalled = true;
  contexts.get(1)!.sendBinary(new Uint8Array(SLICE_BYTES * 4));
  await sleep(30);
  session.tick(10);
  await sleep(30);
  session.tick(10);
  assert.equal(ws.terminated, true);
});

console.log('');
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
