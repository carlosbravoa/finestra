// The services behind the System Manager: sys, proc, systemd, journal, net,
// certs, and the fs scan channel. The interesting cases are the ones the UI
// cannot show: that a refused argument is really refused, that a scan stops
// when its channel closes, and that journalctl does not outlive the panel
// watching it.
import { spawn } from 'node:child_process';
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
const channels = new Map();

const call = (svc, m, a) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ t: 'req', id, svc, m, a }));
  });

/** Opens a channel and collects everything it sends. */
const open = (svc, m, a) => {
  const id = nextId++;
  const state = { id, info: null, data: [], binary: [], closed: false, error: undefined };
  channels.set(id, state);
  ws.send(JSON.stringify({ t: 'open', id, svc, m, a }));
  return state;
};

const hello = await new Promise((resolve, reject) => {
  ws.on('error', reject);
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(raw);
      const channel = channels.get(buf.readUInt32BE(1));
      if (channel) channel.binary.push(buf.subarray(5));
      return;
    }
    const msg = JSON.parse(raw.toString());
    if (msg.t === 'hello') resolve(msg);
    else if (msg.t === 'res') {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.d) : p.reject(new Error(`${msg.e?.code}: ${msg.e?.message}`));
    } else if (msg.t === 'opened') {
      const c = channels.get(msg.id);
      if (c) c.info = msg.d ?? {};
    } else if (msg.t === 'data') {
      const c = channels.get(msg.id);
      if (c) c.data.push(msg.d);
    } else if (msg.t === 'close') {
      const c = channels.get(msg.id);
      if (c) {
        c.closed = true;
        c.error = msg.e;
      }
    }
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const named = (name) => hello.services.find((s) => s.name === name);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------ */
/* Handshake                                                           */
/* ------------------------------------------------------------------ */

for (const svc of ['proc', 'systemd', 'journal', 'net', 'certs']) {
  check(`${svc} is advertised`, Boolean(named(svc)));
}
check('fs advertises the scan channel', named('fs').channels.includes('scan'));
check('sys advertises filesystems', named('sys').methods.includes('filesystems'));

/* ------------------------------------------------------------------ */
/* sys                                                                 */
/* ------------------------------------------------------------------ */

{
  const stats = await call('sys', 'stats');
  check('stats carries a sampling time', typeof stats.time === 'number' && stats.time > 0);
  check('stats reports network totals', Array.isArray(stats.net));
  check('stats reports disk totals',
    typeof stats.disk?.read === 'number' && typeof stats.disk?.written === 'number');
  check('stats reports temperatures as an array', Array.isArray(stats.temps));
  check('the loopback interface is excluded', !stats.net.some((n) => n.name === 'lo'),
    stats.net.map((n) => n.name).join(','));

  // Counters must only ever climb; a decreasing total would produce a
  // negative rate on screen.
  await sleep(300);
  const later = await call('sys', 'stats');
  const before = new Map(stats.net.map((n) => [n.name, n]));
  const monotonic = later.net.every((n) => !before.has(n.name) || n.rx >= before.get(n.name).rx);
  check('network counters do not go backwards', monotonic);
  check('disk counters do not go backwards', later.disk.read >= stats.disk.read);

  const mounts = await call('sys', 'filesystems');
  check('filesystems returns device-backed mounts', mounts.length > 0, `${mounts.length} mounts`);
  check('every mount reports a non-zero total', mounts.every((m) => m.total > 0));
  check('used never exceeds total', mounts.every((m) => m.used <= m.total));
  check('no mount is listed twice', new Set(mounts.map((m) => m.device)).size === mounts.length);
  // Snap images would otherwise bury the real disks under dozens of rows.
  check('read-only image mounts are excluded',
    !mounts.some((m) => m.fstype === 'squashfs'),
    mounts.map((m) => m.fstype).join(','));
}

/* ------------------------------------------------------------------ */
/* proc                                                                */
/* ------------------------------------------------------------------ */

{
  const list = await call('proc', 'list');
  check('proc.list returns processes', list.rows.length > 10, `${list.rows.length} rows`);
  check('proc.list reports its own pid', list.rows.some((r) => r.pid === list.self));
  check('the clock rate is sane', list.hertz > 0 && list.hertz <= 10000, String(list.hertz));
  check('init is present and named', list.rows.some((r) => r.pid === 1 && r.name.length > 0));

  const self = list.rows.find((r) => r.pid === list.self);
  check('rss is in bytes, not pages', self.rss > 1024 * 1024, `${self.rss} bytes`);
  check('a command line is captured', self.cmdline.includes('node') || self.cmdline.length > 0,
    self.cmdline.slice(0, 60));
  check('usernames are resolved', self.user !== String(self.uid), self.user);

  // A process whose comm contains spaces and parens is exactly what breaks a
  // naive /proc/pid/stat split.
  const awkward = spawn('/bin/bash', ['-c', 'exec -a "we (ird) name" sleep 60'], { stdio: 'ignore' });
  await sleep(400);
  const withAwkward = await call('proc', 'list');
  check('a process with parens in its name is parsed',
    withAwkward.rows.some((r) => r.pid === awkward.pid && r.ppid > 0),
    JSON.stringify(withAwkward.rows.find((r) => r.pid === awkward.pid)));

  const detail = await call('proc', 'detail', { pid: awkward.pid });
  check('detail resolves the working directory', typeof detail.cwd === 'string' && detail.cwd.length > 0);
  check('detail lists open file descriptors', Array.isArray(detail.fds) && detail.fds.length > 0);

  // The guards.
  await call('proc', 'kill', { pid: 1, signal: 'SIGKILL' }).then(
    () => check('refuses to signal init', false, 'it agreed'),
    (err) => check('refuses to signal init', /EPERM/.test(err.message)),
  );
  await call('proc', 'kill', { pid: list.self, signal: 'SIGTERM' }).then(
    () => check('refuses to signal the desktop server', false, 'it agreed'),
    (err) => check('refuses to signal the desktop server', /EPERM/.test(err.message)),
  );
  await call('proc', 'kill', { pid: awkward.pid, signal: 'SIGSEGV' }).then(
    () => check('refuses a signal outside the allowed set', false, 'it agreed'),
    (err) => check('refuses a signal outside the allowed set', /EINVAL/.test(err.message)),
  );
  await call('proc', 'kill', { pid: 0 }).then(
    () => check('refuses pid 0', false, 'it agreed'),
    (err) => check('refuses pid 0', /EINVAL/.test(err.message)),
  );
  await call('proc', 'detail', { pid: 4194303 }).then(
    () => check('reports a missing process as ESRCH', false, 'it answered'),
    (err) => check('reports a missing process as ESRCH', /ESRCH/.test(err.message)),
  );

  // An allowed signal on a process we own really does arrive.
  const killed = await call('proc', 'kill', { pid: awkward.pid, signal: 'SIGKILL' }).then(
    () => true,
    (err) => err.message,
  );
  await sleep(300);
  check('an allowed signal is delivered', killed === true && !alive(awkward.pid), String(killed));
}

/* ------------------------------------------------------------------ */
/* systemd                                                             */
/* ------------------------------------------------------------------ */

{
  const { units } = await call('systemd', 'units');
  check('systemd lists units', units.length > 20, `${units.length} units`);
  check('units carry a description', units.some((u) => u.description?.length > 0));
  check('unit-file state is joined in', units.some((u) => typeof u.file === 'string'));

  const props = await call('systemd', 'unit', { unit: 'systemd-journald.service' });
  check('unit properties are parsed', props.Id === 'systemd-journald.service', props.Id);
  check('a value containing "=" survives parsing',
    Object.values(props).every((v) => typeof v === 'string'));

  // A unit name may legitimately start with a dash: `-.mount` is the root
  // mount, and rejecting it as "looks like a flag" hid it from the UI.
  const rootMount = await call('systemd', 'unit', { unit: '-.mount' }).then(
    (p) => p.Id,
    (err) => `rejected: ${err.message}`,
  );
  check('a unit name starting with a dash is accepted', rootMount === '-.mount', rootMount);

  const dashLogs = open('systemd', 'logs', { unit: '-.mount', lines: 5 });
  await sleep(900);
  check('logs open for a dash-prefixed unit', dashLogs.info?.unit === '-.mount' && !dashLogs.error,
    dashLogs.error ?? 'ok');
  ws.send(JSON.stringify({ t: 'close', id: dashLogs.id }));

  for (const bad of ['../etc/passwd', 'foo;reboot', 'a b']) {
    await call('systemd', 'unit', { unit: bad }).then(
      () => check(`rejects unit name ${JSON.stringify(bad)}`, false, 'it answered'),
      (err) => check(`rejects unit name ${JSON.stringify(bad)}`, /EINVAL/.test(err.message)),
    );
  }
  await call('systemd', 'control', { unit: 'systemd-journald.service', action: 'mask' }).then(
    () => check('refuses an action outside the allowed set', false, 'it agreed'),
    (err) => check('refuses an action outside the allowed set', /EINVAL/.test(err.message)),
  );

  // `power` is never called here with an action that would work, for the
  // obvious reason. What is checked is the gate in front of it: only the two
  // named actions get anywhere near systemctl, and everything else is refused
  // before a process is spawned.
  for (const bad of ['halt', 'kexec', 'restart', 'reboot; halt', '', 'REBOOT']) {
    await call('systemd', 'power', { action: bad }).then(
      () => check(`power refuses ${JSON.stringify(bad)}`, false, 'it agreed'),
      (err) => check(`power refuses ${JSON.stringify(bad)}`, /EINVAL/.test(err.message)),
    );
  }
  await call('systemd', 'power', {}).then(
    () => check('power refuses a missing action', false, 'it agreed'),
    (err) => check('power refuses a missing action', /EINVAL/.test(err.message)),
  );

  // User scope: a separate manager with a separate unit list, reachable
  // without any privileges at all.
  const userList = await call('systemd', 'units', { scope: 'user' }).then(
    (d) => d,
    (err) => ({ error: err.message, units: [] }),
  );
  check('user scope returns its own units', userList.units.length > 0,
    userList.error ?? `${userList.units.length} units`);
  check('user scope is echoed back', userList.scope === 'user', String(userList.scope));

  const systemUnits = new Set(units.map((u) => u.unit));
  const onlyUser = userList.units.filter((u) => !systemUnits.has(u.unit));
  check('the two scopes are genuinely different lists', onlyUser.length > 0,
    `${onlyUser.length} units exist only in user scope`);

  await call('systemd', 'units', { scope: 'sideways' }).then(
    () => check('refuses an unknown scope', false, 'it answered'),
    (err) => check('refuses an unknown scope', /EINVAL/.test(err.message)),
  );

  // A user unit's journal only matches --user-unit; using -u would quietly
  // show an empty log instead of failing.
  const userService = userList.units.find(
    (u) => u.unit.endsWith('.service') && u.active === 'active',
  );
  if (userService) {
    const userLogs = open('systemd', 'logs', { unit: userService.unit, scope: 'user', lines: 20 });
    await sleep(1500);
    check('user-unit logs are followed with the right selector',
      userLogs.binary.length > 0 && !userLogs.error,
      userLogs.error ?? `${userService.unit}: ${userLogs.binary.length} frames`);
    ws.send(JSON.stringify({ t: 'close', id: userLogs.id }));
    await sleep(400);
  }

  // Logs: the child must die with the channel, not linger on the host.
  const before = await countJournalctl();
  const logs = open('systemd', 'logs', { unit: 'systemd-journald.service', lines: 5 });
  await sleep(1200);
  check('the log channel opens', logs.info?.unit === 'systemd-journald.service');
  check('log output arrives as binary', logs.binary.length > 0,
    `${logs.binary.length} frames`);

  ws.send(JSON.stringify({ t: 'close', id: logs.id }));
  await sleep(800);
  const after = await countJournalctl();
  check('journalctl is reaped when the channel closes', after <= before,
    `before=${before} after=${after}`);
}

async function countJournalctl() {
  const list = await call('proc', 'list');
  return list.rows.filter((r) => r.name === 'journalctl').length;
}

/* ------------------------------------------------------------------ */
/* journal                                                             */
/* ------------------------------------------------------------------ */

{
  const entriesOf = (c) => c.data.filter((d) => d.type === 'entries').flatMap((d) => d.entries);

  const { boots } = await call('journal', 'boots');
  check('the journal lists its boots', boots.length > 0, `${boots.length} boots`);
  check('the current boot is index 0', boots.some((b) => b.index === 0));
  check('boot times are epoch milliseconds', boots.every((b) => b.first > 1_000_000_000_000),
    String(boots[0]?.first));

  const units = await call('journal', 'fields', { field: '_SYSTEMD_UNIT', boot: 'this' });
  check('unit names are offered for completion', units.values.length > 0,
    `${units.values.length} units`);
  await call('journal', 'fields', { field: 'MESSAGE' }).then(
    () => check('refuses to list an arbitrary field', false, 'it answered'),
    (err) => check('refuses to list an arbitrary field', /EINVAL/.test(err.message)),
  );

  // A snapshot ends by itself. The backlog marker is what tells the client the
  // difference between "nothing matched" and "still reading".
  const snap = open('journal', 'stream', { boot: 'this', lines: 20, follow: false });
  await sleep(2500);
  const entries = entriesOf(snap);
  check('a snapshot streams entries and then closes', entries.length > 0 && snap.closed,
    `${entries.length} entries, error=${snap.error ?? 'none'}`);
  check('the end of the backlog is announced',
    snap.data.some((d) => d.type === 'backlog' && d.done === true));
  check('entries are parsed, not raw text',
    entries.every((e) => typeof e.message === 'string' && typeof e.cursor === 'string'));
  check('timestamps are epoch milliseconds',
    entries.every((e) => e.time > 1_000_000_000_000), String(entries[0]?.time));
  check('priorities are in range', entries.every((e) => e.priority >= 0 && e.priority <= 7));
  check('a snapshot asked for 20 lines does not return the whole boot',
    entries.length <= 20, `${entries.length} entries`);

  // The compact stream carries a subset; the detail panel asks for the rest.
  const full = await call('journal', 'entry', { cursor: entries.at(-1).cursor });
  check('a cursor resolves to every field of that entry',
    Object.keys(full.fields).length > 8 && full.fields.MESSAGE === entries.at(-1).message,
    `${Object.keys(full.fields).length} fields`);

  const errs = open('journal', 'stream', { boot: 'all', priority: 3, lines: 10, follow: false });
  await sleep(2500);
  check('the priority filter is applied by journalctl',
    entriesOf(errs).every((e) => e.priority <= 3),
    entriesOf(errs).map((e) => e.priority).join(','));

  // Following: an entry written after the backlog ended must arrive. The tag
  // is what makes this test independent of whatever else the host is logging.
  const tag = `wd-test-${process.pid}`;
  const followed = open('journal', 'stream', { boot: 'this', identifier: tag, follow: true });
  await sleep(1500);
  check('a followed stream announces that it is following',
    followed.data.some((d) => d.type === 'backlog' && d.following === true));
  spawn('systemd-cat', ['-t', tag, 'echo', 'written-during-follow'], { stdio: 'ignore' });
  await sleep(2500);
  const live = entriesOf(followed);
  check('an entry written while following arrives',
    live.some((e) => e.message.includes('written-during-follow')),
    `${live.length} entries: ${live.map((e) => e.message).join('|')}`);
  check('the identifier filter excludes everything else',
    live.every((e) => e.identifier === tag), live.map((e) => e.identifier).join(','));

  // A time window, expressed as epoch milliseconds so no date string ever has
  // to survive the trip. That entry was written seconds ago: a window opening
  // before it must contain it, one opening after it must not.
  const recent = open('journal', 'stream', { identifier: tag, since: Date.now() - 300_000, follow: false });
  const later = open('journal', 'stream', { identifier: tag, since: Date.now() + 3_600_000, follow: false });
  await sleep(2500);
  check('since keeps entries inside the window', entriesOf(recent).length > 0,
    `${entriesOf(recent).length} entries`);
  check('since excludes entries before it', entriesOf(later).length === 0,
    `${entriesOf(later).length} entries`);
  // Following a window that has already closed would wait for entries that
  // cannot arrive, so an end time makes the stream a snapshot.
  const bounded = open('journal', 'stream', { identifier: tag, until: Date.now(), follow: true });
  await sleep(2000);
  check('an end time turns a follow into a snapshot', bounded.closed && bounded.info?.follow === false,
    `closed=${bounded.closed} follow=${bounded.info?.follow}`);

  // The filters reach journalctl as argv, and anything that is not a filter is
  // refused before it gets there.
  for (const [args, what] of [
    [{ unit: 'a b' }, 'a unit name with a space'],
    [{ unit: '../etc/passwd' }, 'a unit name that is a path'],
    [{ boot: 'the-last-one' }, 'a boot that is not an id'],
    [{ priority: 9 }, 'a priority out of range'],
    [{ scope: 'sideways' }, 'an unknown scope'],
    [{ identifier: 'a;reboot' }, 'an identifier with a semicolon'],
  ]) {
    const bad = open('journal', 'stream', args);
    await sleep(300);
    check(`refuses ${what}`, bad.closed && /^Bad |must be/.test(bad.error ?? ''), bad.error);
  }
  await call('journal', 'entry', { cursor: '/etc/passwd' }).then(
    () => check('refuses a cursor that is a path', false, 'it answered'),
    (err) => check('refuses a cursor that is a path', /EINVAL/.test(err.message)),
  );

  // Same contract as systemd.logs: the host must not be left with a follower.
  const beforeClose = await countJournalctl();
  ws.send(JSON.stringify({ t: 'close', id: followed.id }));
  await sleep(800);
  const afterClose = await countJournalctl();
  check('closing a journal stream reaps journalctl', afterClose < beforeClose,
    `before=${beforeClose} after=${afterClose}`);
}

/* ------------------------------------------------------------------ */
/* net                                                                 */
/* ------------------------------------------------------------------ */

{
  const { sockets } = await call('net', 'sockets');
  check('net lists sockets', sockets.length > 0, `${sockets.length} sockets`);

  // The desktop server's own listening port must be there, attributed to it.
  const own = sockets.find((s) => s.localPort === PORT && s.state === 'LISTEN');
  check('the server\'s own listening port is found', Boolean(own),
    sockets.filter((s) => s.state === 'LISTEN').map((s) => s.localPort).join(','));
  check('a listening socket names its owning process', own?.process?.length > 0,
    `${own?.process} (${own?.pid})`);
  check('ports are decoded as decimal, not hex', own?.localPort === PORT);
  check('IPv4 addresses are dotted quads',
    sockets.filter((s) => s.proto === 'tcp').every((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s.local)),
    sockets.find((s) => s.proto === 'tcp')?.local);
  check('UDP sockets are not labelled CLOSE',
    !sockets.some((s) => s.proto.startsWith('udp') && s.state === 'CLOSE'));
}

/* ------------------------------------------------------------------ */
/* fs.scan                                                             */
/* ------------------------------------------------------------------ */

{
  const scan = open('fs', 'scan', { path: '/usr/share/doc' });
  await sleep(2500);
  const start = scan.data.find((d) => d.type === 'start');
  const children = scan.data.filter((d) => d.type === 'child');
  check('a scan announces what it is about to walk', Boolean(start), JSON.stringify(start));
  check('children stream in with sizes', children.length > 0, `${children.length} children`);
  check('directory sizes are aggregated, not just the inode',
    children.some((c) => c.kind === 'directory' && c.bytes > 4096));
  check('entry counts are reported', children.every((c) => typeof c.entries === 'number'));

  // Cancellation is the property that matters: closing the channel must stop
  // the walk, not merely stop delivering it. A control run establishes that
  // this scan really is still producing results over the same interval —
  // otherwise "it stopped" would prove nothing.
  const kids = (c) => c.data.filter((d) => d.type === 'child').length;

  const control = open('fs', 'scan', { path: '/usr/share' });
  await sleep(700);
  const controlEarly = kids(control);
  await sleep(1500);
  const controlLate = kids(control);
  check('a scan left open keeps producing results', controlLate > controlEarly,
    `${controlEarly} -> ${controlLate}`);
  ws.send(JSON.stringify({ t: 'close', id: control.id }));

  const big = open('fs', 'scan', { path: '/usr/share' });
  await sleep(700);
  const partial = kids(big);
  ws.send(JSON.stringify({ t: 'close', id: big.id }));
  await sleep(1500);
  check('closing a scan channel stops it', kids(big) === partial,
    `${partial} -> ${kids(big)}`);

  await call('fs', 'stat', { path: '/definitely-not-here' }).then(
    () => check('scanning a missing path fails', false, 'it answered'),
    (err) => check('scanning a missing path fails', /ENOENT/.test(err.message)),
  );

  const missing = open('fs', 'scan', { path: '/definitely-not-here' });
  await sleep(600);
  check('a scan of a missing path closes with an error',
    missing.closed && Boolean(missing.error), missing.error);
}

/* ------------------------------------------------------------------ */
/* certs                                                               */
/* ------------------------------------------------------------------ */

{
  const result = await call('certs', 'scan', { paths: ['/etc/ssl/certs'] });
  check('certificates are parsed', result.certs.length > 0, `${result.certs.length} certs`);
  check('expiry dates are epoch milliseconds',
    result.certs.every((c) => c.notAfter > 946_684_800_000));
  check('certificates come back sorted by expiry',
    result.certs.every((c, i, all) => i === 0 || all[i - 1].notAfter <= c.notAfter));
  check('subjects are extracted', result.certs.every((c) => c.subject.length > 0));

  const missing = await call('certs', 'scan', { paths: ['/nope/not/here'] });
  check('a missing path is reported, not fatal',
    missing.missing.length === 1 && missing.certs.length === 0);

  await call('certs', 'scan', { paths: [] }).then(
    () => check('refuses an empty path list', false, 'it answered'),
    (err) => check('refuses an empty path list', /EINVAL/.test(err.message)),
  );
}

/* ------------------------------------------------------------------ */
/* Socket teardown reaps channel children                              */
/* ------------------------------------------------------------------ */

{
  const before = await countJournalctl();
  open('systemd', 'logs', { unit: 'systemd-journald.service', lines: 5 });
  await sleep(900);
  const during = await countJournalctl();
  check('an open log channel has a journalctl running', during > before,
    `before=${before} during=${during}`);

  // Not a clean close: drop the whole socket, as a browser tab closing does.
  ws.close();
  await sleep(1200);

  const probe = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`);
  const after = await new Promise((resolve, reject) => {
    let id = 1;
    probe.on('error', reject);
    probe.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'hello') probe.send(JSON.stringify({ t: 'req', id, svc: 'proc', m: 'list' }));
      else if (msg.t === 'res') resolve(msg.d.rows.filter((r) => r.name === 'journalctl').length);
    });
  });
  probe.close();
  check('dropping the socket reaps its journalctl', after <= before,
    `before=${before} after=${after}`);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
