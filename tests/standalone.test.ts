// Standalone stays standalone.
//
// This desktop can drive several servers, and that must cost a single-machine
// install exactly nothing: no badge on any window, no switcher in the tray, no
// second connection, no extra state. That is a promise about how the thing
// feels on the box someone actually installed it on, and promises about how
// something feels are the first to rot — so it is asserted here rather than
// remembered.
//
// It also guards the boundary the other way: the fleet console and its service
// live in a different repository, and nothing here should reach for them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostRegistry, LOCAL_HOST_ID } from '../client/src/core/hosts';
import type { SettingsStore } from '../client/src/core/types';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

function memorySettings(seed: Record<string, unknown> = {}): SettingsStore {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T>(key: string, fallback: T) => (store.has(key) ? (store.get(key) as T) : fallback),
    set: (key, value) => void store.set(key, value),
    remove: (key) => void store.delete(key),
    watch: () => () => {},
  };
}

(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
  static OPEN = 1;
  readyState = 0;
  close() {}
};

/* --- a fresh install talks to one machine and knows it -------------- */

check('a fresh install has exactly one host', () => {
  const hosts = new HostRegistry('ws://local/ws', memorySettings());
  assert.equal(hosts.all().length, 1);
  assert.equal(hosts.local().id, LOCAL_HOST_ID);
});

check('it reports itself as single, which is what hides the UI', () => {
  const hosts = new HostRegistry('ws://local/ws', memorySettings());
  assert.equal(hosts.isSingle, true);
});

check('nothing is written to settings by simply starting', () => {
  const settings = memorySettings();
  const written: string[] = [];
  const spy: SettingsStore = { ...settings, set: (k, v) => { written.push(k); settings.set(k, v); } };
  // eslint-disable-next-line no-new
  new HostRegistry('ws://local/ws', spy);
  assert.deepEqual(written, [], `wrote ${written.join(', ')}`);
});

check('one host means one connection', () => {
  const hosts = new HostRegistry('ws://local/ws', memorySettings());
  const clients = new Set(hosts.all().map((h) => h.rpc));
  assert.equal(clients.size, 1);
});

check('the local host is never removable, however it is asked', () => {
  const hosts = new HostRegistry('ws://local/ws', memorySettings());
  hosts.remove(LOCAL_HOST_ID);
  hosts.remove('local');
  assert.equal(hosts.isSingle, true);
  assert.ok(hosts.local());
});

/* --- the shell hides it, and says so in the code -------------------- */

const windowTs = fs.readFileSync(path.join(REPO, 'client/src/ui/window.ts'), 'utf8');
const taskbarTs = fs.readFileSync(path.join(REPO, 'client/src/ui/taskbar.ts'), 'utf8');
const desktopTs = fs.readFileSync(path.join(REPO, 'client/src/core/desktop.ts'), 'utf8');

check('the window host badge starts hidden', () => {
  assert.match(windowTs, /class: 'window-host'[\s\S]{0,80}hidden/);
});

check('the badge is cleared, not just skipped, when there is one host', () => {
  // `setHostLabel(null)` must blank it — a stale label on a window would be
  // worse than none, and this is the line that prevents it.
  assert.match(windowTs, /setHostLabel\(label: string \| null\)/);
  assert.match(windowTs, /this\.hostEl\.textContent = ''/);
});

check('the tray only becomes a switcher when there is a choice', () => {
  assert.match(taskbarTs, /is-switcher.*many|many.*is-switcher/s);
});

check('the tray still shows user@hostname on a single install', () => {
  assert.match(taskbarTs, /many \? \(target\?\.label \?\? ''\) : this\.localLabel/);
});

check('the shell only relabels windows when the host set changes', () => {
  assert.match(desktopTs, /hosts\.events\.on\('changed'/);
});

/* --- the boundary with the fleet product ---------------------------- */

check('the fleet console is not in this repository', () => {
  assert.ok(!fs.existsSync(path.join(REPO, 'client/src/apps/fleet')), 'client/src/apps/fleet exists');
  assert.ok(!fs.existsSync(path.join(REPO, 'server/src/services/fleet.ts')), 'fleet service exists');
});

check('nothing in the shell mentions the other product', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'apps-extra') continue;
        walk(full);
      } else if (/\.(ts|js)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        // Comments may refer to the design; imports and calls may not.
        if (/from ['"].*fleet|require\(['"].*fleet/.test(text)) offenders.push(full);
      }
    }
  };
  walk(path.join(REPO, 'client/src'));
  walk(path.join(REPO, 'server/src'));
  assert.deepEqual(offenders, [], offenders.join(', '));
});

check('the extension points exist for it to be added back', () => {
  assert.ok(fs.existsSync(path.join(REPO, 'client/src/apps-extra/README.md')));
  assert.ok(fs.existsSync(path.join(REPO, 'server/src/extra-services.ts')));
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
