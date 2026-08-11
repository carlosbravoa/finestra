// Checks that a host says which Finestra it is running, and says it in a shape
// a person can read. The About dialog is the only place this surfaces, and a
// version that silently degrades to "unknown" there is worse than none at all:
// it looks like a broken desktop rather than a build that forgot to say.
import WebSocket from 'ws';

const PORT = Number(process.argv[3] || 7099);
const TOKEN = process.argv[2];
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`);

const hello = await new Promise((resolve, reject) => {
  ws.on('error', reject);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.t === 'hello') resolve(msg);
  });
});

const build = hello.host?.build;

check('the host says which build it is running', !!build, build ? build.version : 'no build in hello');
check('the version is not the give-up value', build?.version !== 'unknown', build?.version);

// The suite runs from a source tree, so this is the development shape. A
// release has no `+dev` and carries the manifest's build date instead.
check('a source tree admits it is not a release', build?.dev === true, `dev=${build?.dev}`);
check(
  'the version starts with the number package.json declares',
  /^\d+\.\d+\.\d+(\+|$)/.test(build?.version ?? ''),
  build?.version,
);

// Semver build metadata, everything after the first '+'. Kept legal because
// publish.sh has to turn that '+' into something S3 will not read as a space,
// and anything exotic in there makes that substitution a guess.
if (build?.version?.includes('+')) {
  const meta = build.version.slice(build.version.indexOf('+') + 1);
  check(
    'the build metadata is dot-separated alphanumerics',
    /^[0-9A-Za-z.-]+$/.test(meta) && !meta.startsWith('.') && !meta.endsWith('.'),
    meta,
  );
}

ws.close();
console.log(
  results.every(Boolean)
    ? '\nthe host names its own build\n'
    : '\nsomething about the version is wrong\n',
);
process.exit(results.every(Boolean) ? 0 : 1);
