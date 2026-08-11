// File transfer over HTTP, and the apps enable/disable service.
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = process.argv[2];
const PORT = Number(process.argv[3] || 7099);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-transfer-'));
const uploadsDir = path.join(scratch, 'inbox');

/* ---------------- download ---------------- */

const dlFile = path.join(scratch, 'download-me.txt');
fs.writeFileSync(dlFile, 'download-me\nline two\n');

{
  const res = await fetch(`${BASE}/api/download?path=${encodeURIComponent(dlFile)}`);
  check('download without a token is refused', res.status === 401, `status ${res.status}`);
}
{
  const res = await fetch(`${BASE}/api/download?path=${encodeURIComponent(dlFile)}&t=${TOKEN}`);
  const body = await res.text();
  check('download streams the file', res.status === 200 && body === 'download-me\nline two\n');
  check('download sets an attachment disposition',
    (res.headers.get('content-disposition') ?? '').includes('attachment'),
    res.headers.get('content-disposition') ?? '(none)');
  check('download reports the size',
    res.headers.get('content-length') === String(fs.statSync(dlFile).size));
}
{
  const res = await fetch(`${BASE}/api/download?path=${encodeURIComponent(scratch)}&t=${TOKEN}`);
  check('downloading a directory is refused', res.status === 400, `status ${res.status}`);
}
{
  const res = await fetch(`${BASE}/api/download?path=/no/such/file&t=${TOKEN}`);
  check('downloading a missing file is a 404', res.status === 404, `status ${res.status}`);
}

/* ---------------- upload ---------------- */

const upload = (name, content, dir = uploadsDir, token = TOKEN) =>
  fetch(
    `${BASE}/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}${token ? `&t=${token}` : ''}`,
    { method: 'POST', body: content },
  );

{
  const res = await upload('hello.txt', 'hi', uploadsDir, '');
  check('upload without a token is refused', res.status === 401, `status ${res.status}`);
}
{
  const res = await upload('hello.txt', 'hi there');
  const data = await res.json();
  check('upload creates the file', res.status === 201 && data.name === 'hello.txt',
    JSON.stringify(data));
  check('the uploads directory is created on demand', fs.existsSync(uploadsDir));
  check('uploaded content matches',
    fs.readFileSync(path.join(uploadsDir, 'hello.txt'), 'utf8') === 'hi there');
}
{
  const res = await upload('hello.txt', 'second copy');
  const data = await res.json();
  check('a name collision gets a suffix', data.name === 'hello (1).txt', data.name);
  check('the original is untouched',
    fs.readFileSync(path.join(uploadsDir, 'hello.txt'), 'utf8') === 'hi there');
}
{
  const res = await upload('backup.tar.gz', 'v1');
  const res2 = await upload('backup.tar.gz', 'v2');
  const d1 = await res.json();
  const d2 = await res2.json();
  check('compound extensions suffix before the whole extension',
    d1.name === 'backup.tar.gz' && d2.name === 'backup (1).tar.gz', d2.name);
}
{
  const res = await upload('../../etc/evil.txt', 'nope');
  const data = await res.json();
  check('a traversal name cannot leave the directory',
    res.status === 201 && !data.name.includes('/') && data.path.startsWith(uploadsDir),
    data.name);
}
{
  const res = await upload('..', 'nope');
  check('a bare ".." name is refused', res.status === 400, `status ${res.status}`);
}
{
  const big = 'x'.repeat(9 * 1024 * 1024);
  const res = await upload('big.bin', big);
  const data = await res.json();
  check('uploads are not subject to the 8 MB rpc cap',
    res.status === 201 && data.size === big.length, `${data.size} bytes`);
}

/* ---------------- apps service ---------------- */

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`);
let nextId = 1;
const pending = new Map();
const call = (svc, m, a) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: 'req', id, svc, m, a }));
  });

await new Promise((resolve, reject) => {
  ws.on('error', reject);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.t === 'hello') resolve(msg);
    else if (msg.t === 'res') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.d) : p.reject(new Error(`${msg.e?.code}: ${msg.e?.message}`));
    }
  });
});

{
  const before = await call('apps', 'list');
  check('apps.list answers', Array.isArray(before.disabled), JSON.stringify(before));

  await call('apps', 'setEnabled', { id: 'files', enabled: false });
  const after = await call('apps', 'list');
  check('disabling an app persists in the list', after.disabled.includes('files'));

  await call('apps', 'setEnabled', { id: 'files', enabled: true });
  const restored = await call('apps', 'list');
  check('re-enabling removes it', !restored.disabled.includes('files'));

  await call('apps', 'setEnabled', { id: 'settings', enabled: false }).then(
    () => check('disabling Settings is refused', false, 'it was allowed'),
    (err) => check('disabling Settings is refused', /EPERM/.test(err.message), err.message),
  );

  await call('apps', 'setEnabled', { id: '', enabled: false }).then(
    () => check('an empty id is refused', false),
    (err) => check('an empty id is refused', /EINVAL/.test(err.message)),
  );
}

ws.close();
fs.rmSync(scratch, { recursive: true, force: true });

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
