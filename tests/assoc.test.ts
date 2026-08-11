// Exercises file-association scoring, overrides, and the odd filenames a
// server actually contains.
import {
  AssociationOverrides,
  associationKeyFor,
  fileRefFor,
  handlersFor,
  resolveHandler,
  suffixesOf,
} from '../client/src/core/associations';
import type { AppManifest, SettingsStore } from '../client/src/core/types';

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

const app = (id: string, handles: AppManifest['handles']): AppManifest => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  icon: '#',
  handles,
  mount: () => ({}),
});

const editor = app('editor', [{ extensions: ['.txt', '.md', '.conf'], verb: 'Edit' }]);
const archiver = app('archiver', [{ extensions: ['.gz', '.tar.gz', '.zip'] }]);
const gzip = app('gzip', [{ extensions: ['.gz'] }]);
const make = app('make', [{ names: ['Makefile', 'Dockerfile'] }]);
const viewer = app('viewer', [{ fallback: true, verb: 'View' }]);
const logs = app('logs', [{ matches: (f) => f.name.includes('.log.'), verb: 'Tail' }]);
const ALL = [editor, archiver, gzip, make, viewer, logs];

const best = (name: string) => handlersFor(ALL, fileRefFor(`/tmp/${name}`))[0]?.app.id;

// --- suffix parsing --------------------------------------------------
check('splits every dotted suffix', JSON.stringify(suffixesOf('archive.tar.gz')) === '[".tar.gz",".gz"]',
  suffixesOf('archive.tar.gz').join(' '));
check('a dotfile has no extension', suffixesOf('.bashrc').length === 0);
check('a file with no dot has no extension', suffixesOf('Makefile').length === 0);
check('suffixes are lowercased', suffixesOf('NOTES.TXT')[0] === '.txt');

// --- scoring ---------------------------------------------------------
check('matches a plain extension', best('notes.txt') === 'editor');
check('extension match is case-insensitive', best('NOTES.TXT') === 'editor');
check('longer extension wins', best('backup.tar.gz') === 'archiver', best('backup.tar.gz'));
check('shorter extension still matches alone', ['archiver', 'gzip'].includes(best('blob.gz')!), best('blob.gz'));
check('exact filename beats extension', best('Makefile') === 'make');
check('predicate matches when extensions do not', best('syslog.log.1') === 'logs', best('syslog.log.1'));
check('fallback loses to a real claim', best('notes.txt') !== 'viewer');
check('fallback wins when nothing else claims', best('mystery.xyz') === 'viewer');
check('fallback wins for a dotfile', best('.bashrc') === 'viewer', best('.bashrc'));

// --- ordering and shape ----------------------------------------------
{
  const matches = handlersFor(ALL, fileRefFor('/tmp/backup.tar.gz'));
  check('every claimant is listed', matches.length >= 2, matches.map((m) => m.app.id).join(', '));
  check('best match is first', matches[0].app.id === 'archiver');
  check('scores descend', matches.every((m, i) => i === 0 || matches[i - 1].score >= m.score));
  check('verb defaults to Open', handlersFor(ALL, fileRefFor('/x/a.gz'))[0].verb === 'Open');
  check('declared verb is carried', handlersFor(ALL, fileRefFor('/x/a.txt'))[0].verb === 'Edit');
}
{
  // An app declaring several claims should appear once, at its best score.
  const multi = app('multi', [{ extensions: ['.txt'] }, { names: ['special.txt'] }]);
  const matches = handlersFor([multi], fileRefFor('/x/special.txt'));
  check('an app appears once despite several claims', matches.length === 1);
  // The name claim (400) must win over the same app's .txt claim (204).
  check('its strongest claim is used', matches[0].score === 400, `score ${matches[0].score}`);
}
{
  const a = app('alpha', [{ extensions: ['.cfg'] }]);
  const b = app('beta', [{ extensions: ['.cfg'], priority: 10 }]);
  check('priority breaks a tie', handlersFor([a, b], fileRefFor('/x/n.cfg'))[0].app.id === 'beta');
}
{
  const bad = app('bad', [{ matches: () => { throw new Error('boom'); } }]);
  const ids = handlersFor([bad, editor], fileRefFor('/x/n.txt')).map((m) => m.app.id);
  check('a throwing predicate does not break resolution', ids.includes('editor'), ids.join(', '));
  check('the throwing app is simply skipped', !ids.includes('bad'));
}
check('an app with no handles never matches', handlersFor([app('inert', undefined)], fileRefFor('/x/a.txt')).length === 0);

// --- override keys ---------------------------------------------------
check('override key is the longest extension', associationKeyFor(fileRefFor('/x/a.tar.gz')) === '.tar.gz');
check('override key falls back to the name', associationKeyFor(fileRefFor('/x/Makefile')) === 'name:Makefile');
check('override key for a dotfile uses the name', associationKeyFor(fileRefFor('/x/.bashrc')) === 'name:.bashrc');

// --- overrides -------------------------------------------------------
{
  const settings = new FakeSettings();
  const overrides = new AssociationOverrides(settings);
  const file = fileRefFor('/x/notes.txt');

  check('no override by default', resolveHandler(ALL, file, overrides)?.id === 'editor');

  overrides.set(file, 'viewer');
  check('an override beats scoring', resolveHandler(ALL, file, overrides)?.id === 'viewer');
  check('the override applies to the whole type',
    resolveHandler(ALL, fileRefFor('/other/dir/readme.txt'), overrides)?.id === 'viewer');
  check('it does not leak to other types',
    resolveHandler(ALL, fileRefFor('/x/a.md'), overrides)?.id === 'editor');

  overrides.clear(file);
  check('clearing restores scoring', resolveHandler(ALL, file, overrides)?.id === 'editor');

  overrides.set(file, 'uninstalled-app');
  check('a stale override falls back to scoring', resolveHandler(ALL, file, overrides)?.id === 'editor');
}
{
  const overrides = new AssociationOverrides(new FakeSettings());
  check('resolves null when nothing matches at all',
    resolveHandler([editor], fileRefFor('/x/mystery.xyz'), overrides) === null);
}

// --- path handling ---------------------------------------------------
check('takes the basename from a path', fileRefFor('/a/b/c/notes.txt').name === 'notes.txt');
check('tolerates a trailing slash', fileRefFor('/a/b/').name === 'b');

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
