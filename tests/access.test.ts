// The access token, on the browser's side.
//
// The server's half is in auth.mjs. This is what the page does with what it
// is told: adopt a new token into its cookie, stop reconnecting when it has
// been signed out rather than retry for ever, follow a remote host's token in
// the address it is stored under, and keep the token out of anywhere a script
// in the page could read it back from.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accessLink,
  adoptAccessToken,
  ago,
  browserName,
  describeSession,
  probeAccess,
  withToken,
} from '../client/src/core/access';
import { HostRegistry } from '../client/src/core/hosts';
import { RpcClient } from '../client/src/core/rpc';
import type { SettingsStore } from '../client/src/core/types';
import { CLOSE_REVOKED } from '../shared/protocol';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results: boolean[] = [];
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(
      () => {
        results.push(true);
        console.log(`PASS  ${name}`);
      },
      (err) => {
        results.push(false);
        console.log(`FAIL  ${name}  — ${(err as Error).message}`);
      },
    );

/* --- a browser-shaped world, enough for RpcClient ---------------------- */

(globalThis as unknown as { window: unknown }).window = globalThis;

/** Every socket the client opens, so a test can close one with a reason. */
const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeSocket.CONNECTING;
  binaryType = '';
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    sockets.push(this);
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onmessage?.({ data: JSON.stringify({ t: 'hello', v: 1, services: [], host: { hostname: 'box' } }) });
  }
  serverCloses(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  close(): void {
    this.serverCloses(1005);
  }
  send(): void {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

function memorySettings(): SettingsStore {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    set: (key, value) => void store.set(key, value),
    remove: (key) => void store.delete(key),
    watch: () => () => {},
  };
}

const fakeFetch = (status: number) =>
  (async () => ({ ok: status >= 200 && status < 300, status })) as unknown as typeof fetch;
const failingFetch = (async () => {
  throw new TypeError('Failed to fetch');
}) as unknown as typeof fetch;

/* --- the helpers ------------------------------------------------------ */

await check('the link someone opens carries the token as ?t=', () => {
  assert.equal(accessLink('http://127.0.0.1:7070', 'a b/c'), 'http://127.0.0.1:7070/?t=a%20b%2Fc');
});

await check('a remote host address follows a new token', () => {
  assert.equal(withToken('ws://box:7070/ws?t=old', 'new'), 'ws://box:7070/ws?t=new');
  assert.equal(withToken('ws://box:7070/ws', 'new'), 'ws://box:7070/ws?t=new');
  assert.equal(withToken('not a url', 'new'), 'not a url');
});

await check('adopting a token asks the server to set the cookie, with the token in the query', async () => {
  let asked = '';
  const fetchImpl = (async (input: string, init: RequestInit) => {
    asked = `${input} ${init.credentials}`;
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;
  assert.equal(await adoptAccessToken('t+k', fetchImpl), true);
  assert.equal(asked, '/api/session?t=t%2Bk same-origin');
});

await check('adopting a token the server refuses says so rather than throwing', async () => {
  assert.equal(await adoptAccessToken('x', fakeFetch(401)), false);
  assert.equal(await adoptAccessToken('x', failingFetch), false);
});

await check('a probe tells a refused cookie apart from a server that is down', async () => {
  assert.equal(await probeAccess(fakeFetch(200)), 'ok');
  assert.equal(await probeAccess(fakeFetch(401)), 'refused');
  assert.equal(await probeAccess(fakeFetch(503)), 'unreachable');
  assert.equal(await probeAccess(failingFetch), 'unreachable');
});

await check('a browser is named from how it introduces itself', () => {
  assert.equal(browserName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'), 'Chrome');
  assert.equal(browserName('Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/131.0'), 'Firefox');
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge');
  assert.equal(browserName('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15'), 'Safari');
  assert.equal(browserName(null), 'Something that is not a browser');
});

await check('a connection is described by who, from where, and since when', () => {
  const now = 1_000_000_000_000;
  const mine = describeSession(
    { id: 'a', self: true, address: '::ffff:127.0.0.1', userAgent: 'x Chrome/1 Safari/1', since: now - 30_000, viaRelay: false },
    now,
  );
  assert.deepEqual(mine, { title: 'This desktop', detail: 'from 127.0.0.1, connected just now' });
  const theirs = describeSession(
    { id: 'b', self: false, address: '10.0.0.7', userAgent: 'Firefox/9', since: now - 3 * 3_600_000, viaRelay: false },
    now,
  );
  assert.deepEqual(theirs, { title: 'Firefox', detail: 'from 10.0.0.7, connected 3 h ago' });
  const relayed = describeSession(
    { id: 'c', self: false, address: null, userAgent: null, since: now - 90_000, viaRelay: true },
    now,
  );
  assert.equal(relayed.detail, 'through the relay, connected 2 min ago');
  assert.equal(ago(now - 3 * 86_400_000, now), '3 d ago');
});

/* --- the connection, when it is hung up on ------------------------------ */

await check('a socket closed with the revoked code stops reconnecting and says why', () => {
  const before = sockets.length;
  const rpc = new RpcClient('ws://box/ws');
  const revoked: string[] = [];
  const states: string[] = [];
  rpc.events.on('revoked', (reason) => revoked.push(reason));
  rpc.events.on('state', (s) => states.push(s));
  rpc.connect();
  sockets[sockets.length - 1].open();
  assert.equal(rpc.state, 'open');
  sockets[sockets.length - 1].serverCloses(CLOSE_REVOKED, 'The access token was changed from another desktop');
  assert.deepEqual(revoked, ['The access token was changed from another desktop']);
  assert.equal(rpc.state, 'closed');
  assert.ok(!states.includes('reconnecting'), `went through ${states.join(' → ')}`);
  assert.equal(sockets.length, before + 1, 'opened another socket');
});

await check('an ordinary close still reconnects, and the socket drop is reported first', async () => {
  const rpc = new RpcClient('ws://box/ws');
  const seen: string[] = [];
  rpc.events.on('dropped', ({ code }) => seen.push(`dropped:${code}`));
  rpc.events.on('state', (s) => seen.push(s));
  rpc.connect();
  const first = sockets[sockets.length - 1];
  first.open();
  first.serverCloses(1006);
  assert.deepEqual(seen, ['connecting', 'open', 'dropped:1006', 'reconnecting']);
  await new Promise((r) => setTimeout(r, 600));
  assert.notEqual(sockets[sockets.length - 1], first, 'did not try again');
  rpc.disconnect();
});

await check('the shell can revoke a connection itself, after a refused probe', () => {
  const rpc = new RpcClient('ws://box/ws');
  let reason = '';
  rpc.events.on('revoked', (r) => (reason = r));
  rpc.connect();
  sockets[sockets.length - 1].open();
  rpc.revoke('The access token was changed while this desktop was disconnected');
  assert.equal(rpc.state, 'closed');
  assert.match(reason, /while this desktop was disconnected/);
});

await check('the next connection goes to the URL set since', () => {
  const rpc = new RpcClient('ws://box/ws?t=old');
  rpc.connect();
  sockets[sockets.length - 1].open();
  rpc.setUrl('ws://box/ws?t=new');
  sockets[sockets.length - 1].serverCloses(1006);
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      assert.equal(sockets[sockets.length - 1].url, 'ws://box/ws?t=new');
      rpc.disconnect();
      resolve();
    }, 600),
  );
});

/* --- remote hosts carry the token in their address ---------------------- */

await check('a remote host that changed its token is stored under the new one', () => {
  const settings = memorySettings();
  const registry = new HostRegistry('ws://127.0.0.1/ws', settings);
  const remote = registry.add('ws://box:7070/ws?t=old');
  remote.rpc.events.emit('event', { svc: 'auth', e: 'rotated', d: { token: 'new' } });
  assert.equal(remote.url, 'ws://box:7070/ws?t=new');
  const stored = settings.get<Array<{ url: string }>>('hosts.remote', []);
  assert.equal(stored[0]?.url, 'ws://box:7070/ws?t=new');
});

await check('the local host is left alone — its token is a cookie, not an address', () => {
  const registry = new HostRegistry('ws://127.0.0.1/ws', memorySettings());
  const local = registry.local();
  local.rpc.events.emit('event', { svc: 'auth', e: 'rotated', d: { token: 'new' } });
  assert.equal(local.url, 'ws://127.0.0.1/ws');
});

/* --- what the page never does ------------------------------------------ */

await check('the token is never written to browser storage, and never put on the socket URL', () => {
  const main = fs.readFileSync(path.join(REPO, 'client/src/main.ts'), 'utf8');
  assert.ok(!/localStorage\.setItem/.test(main), 'main.ts stores something in localStorage');
  assert.ok(!/sessionStorage/.test(main), 'main.ts uses sessionStorage');
  const socket = main.match(/function socketUrl[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(socket && !/t=/.test(socket), 'socketUrl puts a token in the URL');
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} access checks passed`);
process.exit(failed === 0 ? 0 : 1);
