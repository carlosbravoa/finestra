// Exercises SessionStore against a fake settings backend.
import { SessionStore, type WindowRecord } from '../client/src/core/session-store';
import type { SettingsStore } from '../client/src/core/types';

const results: boolean[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

class FakeSettings implements SettingsStore {
  data = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : fallback;
  }
  set(key: string, value: unknown): void {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
  remove(key: string): void {
    this.data.delete(key);
  }
  watch(): () => void {
    return () => {};
  }
}

const record = (over: Partial<WindowRecord> = {}): WindowRecord => ({
  appId: 'terminal',
  params: { cwd: '/home/carlos' },
  bounds: { x: 10, y: 20, width: 800, height: 500 },
  state: 'normal',
  title: 'Terminal',
  focused: true,
  ...over,
});

// --- round trip ------------------------------------------------------
{
  const settings = new FakeSettings();
  const store = new SessionStore(settings);
  store.save([record(), record({ appId: 'files', focused: false })]);
  const loaded = store.load();
  check('round-trips saved windows', loaded.length === 2, `${loaded.length} records`);
  check('preserves app params', (loaded[0].params as any).cwd === '/home/carlos');
  check('preserves stacking order', loaded[1].appId === 'files');
  check('preserves the focused flag', loaded[0].focused === true && loaded[1].focused === false);
}

// --- enable/disable --------------------------------------------------
{
  const settings = new FakeSettings();
  const store = new SessionStore(settings);
  check('restore is on by default', store.enabled);
  store.save([record()]);
  store.setEnabled(false);
  check('disabling clears the stored session', store.load().length === 0);
  store.save([record()]);
  check('a disabled store saves nothing', store.load().length === 0);
  store.setEnabled(true);
  check('re-enabling does not resurrect old state', store.load().length === 0);
}

// --- hostile / stale input -------------------------------------------
{
  const settings = new FakeSettings();
  const store = new SessionStore(settings);

  settings.set('session.windows', { version: 999, savedAt: Date.now(), windows: [record()] });
  check('ignores a future format version', store.load().length === 0);

  settings.set('session.windows', 'not an object');
  check('ignores corrupt storage', store.load().length === 0);

  settings.set('session.windows', {
    version: 1,
    savedAt: Date.now() - 30 * 24 * 3600 * 1000,
    windows: [record()],
  });
  check('ignores a session older than the cutoff', store.load().length === 0);

  settings.set('session.windows', {
    version: 1,
    savedAt: Date.now(),
    windows: [
      record(),
      { appId: '', bounds: { x: 0, y: 0, width: 1, height: 1 }, state: 'normal' },
      { appId: 'x', bounds: { x: 0, y: 0, width: 0, height: 5 }, state: 'normal' },
      { appId: 'x', bounds: { x: NaN, y: 0, width: 5, height: 5 }, state: 'normal' },
      { appId: 'x', bounds: { x: 0, y: 0, width: 5, height: 5 }, state: 'wat' },
      null,
      'nope',
    ],
  });
  const survivors = store.load();
  check('drops every malformed record', survivors.length === 1, `${survivors.length} survived`);
  check('keeps the valid one', survivors[0]?.appId === 'terminal');
}

// --- unserialisable app state ----------------------------------------
{
  const settings = new FakeSettings();
  const store = new SessionStore(settings);
  const cyclic: any = { name: 'loop' };
  cyclic.self = cyclic;

  store.save([record({ appId: 'bad', params: cyclic }), record({ appId: 'files' })]);
  const loaded = store.load();
  check('one bad app cannot lose the whole session', loaded.length === 1, `${loaded.length} kept`);
  check('the surviving record is the good one', loaded[0]?.appId === 'files');
}

// --- runaway save ----------------------------------------------------
{
  const settings = new FakeSettings();
  const store = new SessionStore(settings);
  store.save(Array.from({ length: 200 }, () => record()));
  check('caps how many windows are stored', store.load().length === 40, `${store.load().length}`);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
