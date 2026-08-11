// The host registry and the address parsing in front of it.
//
// These run without a browser: `HostRegistry` takes a settings store and makes
// RpcClients, and neither needs a DOM. What is worth testing here is the part
// people will actually hit — pasting whatever address they have to hand — and
// the promises the registry makes about the local host being permanent.

import assert from 'node:assert/strict';
import { HostRegistry, LOCAL_HOST_ID, toWebsocketUrl, hostLabelFor } from '../client/src/core/hosts';
import type { SettingsStore } from '../client/src/core/types';

const results: boolean[] = [];
const check = (name: string, fn: () => void) => {
  try {
    fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}  — ${(err as Error).message}`);
  }
};

/** A settings store in a Map, so nothing touches localStorage or a disk. */
function memorySettings(seed: Record<string, unknown> = {}): SettingsStore {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T>(key: string, fallback: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    set: (key, value) => void store.set(key, value),
    remove: (key) => void store.delete(key),
    watch: () => () => {},
  };
}

// Nothing here should open a socket. Stub it before any registry is built.
(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
  static OPEN = 1;
  readyState = 0;
  close() {}
};

/* --- what people paste ---------------------------------------------- */

check('a full browser URL with a token becomes a ws URL', () => {
  assert.equal(
    toWebsocketUrl('http://box:7070/?t=abc123'),
    'ws://box:7070/ws?t=abc123',
  );
});

check('https becomes wss', () => {
  assert.equal(toWebsocketUrl('https://box/?t=x'), 'wss://box/ws?t=x');
});

check('a bare host:port is accepted', () => {
  assert.equal(toWebsocketUrl('box:7070'), 'ws://box:7070/ws');
});

check('a ws:// URL is accepted as given', () => {
  assert.equal(toWebsocketUrl('ws://box:7070/ws?t=q'), 'ws://box:7070/ws?t=q');
});

check('a token with URL-unsafe characters is encoded', () => {
  const url = toWebsocketUrl('http://box:7070/?t=a%2Fb');
  assert.ok(url?.endsWith('t=a%2Fb'), url ?? 'null');
});

check('nonsense is refused rather than guessed at', () => {
  assert.equal(toWebsocketUrl(''), null);
  assert.equal(toWebsocketUrl('   '), null);
  assert.equal(toWebsocketUrl('http://'), null);
});

check('a label falls back to the hostname', () => {
  assert.equal(hostLabelFor('ws://box:7070/ws'), 'box');
  assert.equal(hostLabelFor('not a url'), 'not a url');
});

/* --- the registry ---------------------------------------------------- */

check('the local host exists from the start and is single', () => {
  const hosts = new HostRegistry('ws://local/ws', memorySettings());
  assert.equal(hosts.all().length, 1);
  assert.equal(hosts.local().id, LOCAL_HOST_ID);
  assert.equal(hosts.isSingle, true);
});

check('adding a host makes it no longer single', () => {
  const hosts = new HostRegistry('ws://local/ws', memorySettings());
  const added = hosts.add('ws://box:7070/ws');
  assert.equal(hosts.isSingle, false);
  assert.equal(hosts.get(added.id)?.label, 'box');
  assert.equal(added.local, false);
});

check('the local host cannot be removed', () => {
  const hosts = new HostRegistry('ws://local/ws', memorySettings());
  hosts.remove(LOCAL_HOST_ID);
  assert.equal(hosts.get(LOCAL_HOST_ID)?.id, LOCAL_HOST_ID, 'local survived');
});

check('a removed host is gone and forgotten', () => {
  const settings = memorySettings();
  const hosts = new HostRegistry('ws://local/ws', settings);
  const added = hosts.add('ws://box:7070/ws');
  hosts.remove(added.id);
  assert.equal(hosts.get(added.id), null);
  assert.deepEqual(settings.get('hosts.remote', []), []);
});

check('remote hosts survive a reload, the local one is not duplicated', () => {
  const settings = memorySettings();
  const first = new HostRegistry('ws://local/ws', settings);
  first.add('ws://box:7070/ws', 'the box');

  const second = new HostRegistry('ws://local/ws', settings);
  assert.equal(second.all().length, 2, 'local + one remote');
  assert.equal(second.all().filter((x) => x.local).length, 1, 'exactly one local');
  assert.equal(second.all().find((x) => !x.local)?.label, 'the box');
});

check('a corrupt stored host is skipped, not fatal', () => {
  const settings = memorySettings({
    'hosts.remote': [{ id: 'ok', label: 'fine', url: 'ws://a/ws' }, { label: 'no id' }, null],
  });
  const hosts = new HostRegistry('ws://local/ws', settings);
  assert.equal(hosts.all().length, 2, 'local + the one good entry');
});

check('renaming persists and is not blank-able', () => {
  const settings = memorySettings();
  const hosts = new HostRegistry('ws://local/ws', settings);
  const added = hosts.add('ws://box:7070/ws');
  hosts.rename(added.id, '  production  ');
  assert.equal(hosts.get(added.id)?.label, 'production');
  hosts.rename(added.id, '   ');
  assert.equal(hosts.get(added.id)?.label, 'production', 'blank rename ignored');
});

check('each host gets its own connection', () => {
  const hosts = new HostRegistry('ws://local/ws', memorySettings());
  const a = hosts.add('ws://a/ws');
  const b = hosts.add('ws://b/ws');
  assert.notEqual(a.rpc, b.rpc);
  assert.notEqual(a.rpc, hosts.local().rpc);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
