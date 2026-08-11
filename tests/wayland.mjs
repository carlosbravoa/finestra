// The wayland service: desktop-entry scanning, the compositor session, and
// the things the UI cannot show you — that a refused appId is really refused,
// that frames carry the pixels they claim, that a resize reaches the
// application, and above all that closing the channel reaps the whole process
// group rather than leaving a compositor and an application behind.
//
// Skips itself when the compositor is not built, or when the host has no
// desktop application to run — a server usually has neither.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

const open = (svc, m, a) => {
  const id = nextId++;
  const state = { id, info: null, data: [], frames: [], closed: false, error: undefined };
  channels.set(id, state);
  ws.send(JSON.stringify({ t: 'open', id, svc, m, a }));
  return state;
};

const ctl = (channel, m, a) =>
  ws.send(JSON.stringify({ t: 'ctl', id: channel.id, m, a }));

const hello = await new Promise((resolve, reject) => {
  ws.on('error', reject);
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(raw);
      const channel = channels.get(buf.readUInt32BE(1));
      if (channel) channel.frames.push(buf.subarray(5));
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

/** Waits for a predicate, polling, up to `ms`. */
const until = async (fn, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
};

/** Processes matching a command-line fragment, via pgrep. */
const matching = (pattern) => {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

const decodeFrame = (buf) => {
  const header = {
    id: buf.readUInt32BE(0),
    x: buf.readUInt32BE(4),
    y: buf.readUInt32BE(8),
    width: buf.readUInt32BE(12),
    height: buf.readUInt32BE(16),
    fullWidth: buf.readUInt32BE(20),
    fullHeight: buf.readUInt32BE(24),
    deflated: (buf.readUInt8(28) & 1) !== 0,
  };
  const payload = buf.subarray(29);
  header.wire = payload.length;
  header.pixels = header.deflated ? zlib.inflateSync(payload) : payload;
  return header;
};

/* ------------------------------------------------------------------ */
/* Handshake and availability                                          */
/* ------------------------------------------------------------------ */

check('wayland is advertised', Boolean(named('wayland')));
check('it offers the session channel', named('wayland')?.channels.includes('session'));

const status = await call('wayland', 'available');
check('available answers', typeof status.available === 'boolean',
  status.available ? 'built' : status.reason);

if (!status.available) {
  console.log(`\nSKIP — ${status.reason}`);
  ws.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/* Desktop entries                                                     */
/* ------------------------------------------------------------------ */

const apps = await call('wayland', 'apps');
check('apps returns a list', Array.isArray(apps), `${apps.length} found`);
check('entries carry an id and a name',
  apps.length === 0 || apps.every((a) => a.id && a.name));
// argv is what makes this safe: the browser names an id, never a command.
check('the command line is not exposed to the browser',
  apps.every((a) => a.argv === undefined));

/* ------------------------------------------------------------------ */
/* Entries meant for another desktop                                   */
/* ------------------------------------------------------------------ */

// Offering an entry that cannot work here makes its failure look like ours:
// the Chromium snap ships one whose whole body is OnlyShowIn=UbuntuFrame and
// Exec=/usr/bin/false. run.sh writes the fixtures these ask about.
const fixtureDir = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, 'applications')
  : null;

if (fixtureDir && fs.existsSync(path.join(fixtureDir, 'wd-test-hidden.desktop'))) {
  const ids = new Set(apps.map((a) => a.id));
  check('an entry for a desktop environment we are not is skipped',
    !ids.has('wd-test-hidden'), 'OnlyShowIn=NoSuchDesktop');
  // The mirror image, so the filter cannot pass by hiding everything.
  check('an entry that only excludes some other desktop is kept',
    ids.has('wd-test-shown'), 'NotShowIn=NoSuchDesktop');

  // Snap and flatpak export entries into trees that reach XDG_DATA_DIRS only
  // through a login shell's profile.d. This server is a systemd service and has
  // no such shell, so for a while every snap on the machine was invisible here:
  // installed, exported, and never looked at. The fixture sits in the same kind
  // of export directory, one no XDG variable points at on its own.
  check('an application exported outside the applications directory is offered',
    ids.has('wd-test-exported'), 'flatpak/exports/share/applications');

  /* ---------------------------------------------------------------- */
  /* An application that draws nothing says why                        */
  /* ---------------------------------------------------------------- */

  // Exiting at once without a window is the shape of a single-instance
  // handoff — the application handed the job to a copy of itself in the
  // host's own login session. "It exited normally" is true and useless, and
  // was all the browser used to be told.
  const silent = open('wayland', 'session', { appId: 'wd-test-silent' });
  await until(() => silent.closed, 12000);
  check('a session that never opens a window closes with a reason',
    silent.closed && /without opening a window/.test(silent.error ?? ''),
    silent.error ?? 'never closed');
  // The compositor exits 1 for "no frame streamed" whatever the cause, so
  // quoting that number at the user describes the wrong process.
  check('and does not quote the compositor\'s exit code as the application\'s',
    !/exited \(\d+\)/.test(silent.error ?? ''), silent.error ?? '');
  // This one had a private bus of its own, so the handoff is not the
  // explanation and must not be offered as one.
  check('the handoff is only blamed when the machine\'s own bus was shared',
    !/session bus/.test(silent.error ?? ''), silent.error ?? '');
}

/* ------------------------------------------------------------------ */
/* Icons and pinning                                                   */
/* ------------------------------------------------------------------ */

if (apps.length > 0) {
  const withIcon = [];
  for (const app of apps.slice(0, 12)) {
    const icon = await call('wayland', 'icon', { id: app.id });
    if (icon) withIcon.push({ app, icon });
  }
  check('icons resolve from the host theme', withIcon.length > 0,
    `${withIcon.length}/${Math.min(12, apps.length)} of the first entries`);
  check('an icon carries a browser-renderable type',
    withIcon.every(({ icon }) => ['image/png', 'image/svg+xml'].includes(icon.mime)),
    withIcon.map(({ icon }) => icon.mime).join(','));
  check('icon payloads are base64',
    withIcon.every(({ icon }) => /^[A-Za-z0-9+/=]+$/.test(icon.data)));

  await call('wayland', 'icon', { id: 'no-such-application' }).then(
    () => check('an unknown icon id is refused', false, 'it answered'),
    (err) => check('an unknown icon id is refused', /ENOAPP/.test(err.message)),
  );

  // Pinning: the promotion from "in the list" to "an app of this desktop".
  const target = apps[0];
  const before = await call('wayland', 'pins');
  check('pins starts as a list', Array.isArray(before.pinned));

  const afterPin = await call('wayland', 'setPinned', { id: target.id, pinned: true });
  check('pinning adds the application',
    afterPin.pinned.some((p) => p.id === target.id), target.id);
  const pinnedRecord = afterPin.pinned.find((p) => p.id === target.id);
  check('a pinned record carries what a manifest needs',
    Boolean(pinnedRecord?.name) && 'icon' in pinnedRecord,
    `${pinnedRecord?.name}, icon=${pinnedRecord?.icon ? pinnedRecord.icon.mime : 'none'}`);

  const relisted = await call('wayland', 'apps');
  check('the listing reflects the pin',
    relisted.find((a) => a.id === target.id)?.pinned === true);

  // It must survive a restart, which is the whole point of persisting it.
  const stateFile = `${process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`}/finestra/pinned-applications.json`;
  const persisted = await import('node:fs').then((fs) => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8')).pinned ?? [];
    } catch {
      return [];
    }
  });
  check('the pin is persisted to disk', persisted.includes(target.id),
    `${stateFile}: ${JSON.stringify(persisted)}`);

  await call('wayland', 'setPinned', { id: 'no-such-application', pinned: true }).then(
    () => check('an unknown application cannot be pinned', false, 'it agreed'),
    (err) => check('an unknown application cannot be pinned', /ENOAPP/.test(err.message)),
  );

  const afterUnpin = await call('wayland', 'setPinned', { id: target.id, pinned: false });
  check('unpinning removes it', !afterUnpin.pinned.some((p) => p.id === target.id));
  // Unpinning something unknown must work, or a stale entry could never be cleared.
  await call('wayland', 'setPinned', { id: 'no-such-application', pinned: false }).then(
    () => check('a stale pin can always be cleared', true),
    (err) => check('a stale pin can always be cleared', false, err.message),
  );
}

/* An unknown id must be refused, not passed to a shell. */
let refused = null;
await open('wayland', 'session', { appId: '../../bin/sh' });
await sleep(400);
refused = [...channels.values()].find((c) => c.closed && c.error);
check('an unknown application is refused', Boolean(refused), refused?.error ?? 'not refused');

if (apps.length === 0) {
  console.log('\nSKIP — no desktop applications installed to run');
  ws.close();
  process.exit(results.every(Boolean) ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/* A real session                                                      */
/* ------------------------------------------------------------------ */

// Prefer an application that is *static* when idle: "a frame arrived after
// input" only means something if nothing else is animating.
const preferred = ['org.gnome.Calculator', 'org.gnome.FontViewer',
  'org.gnome.DiskUtility', 'gnome-disks', 'org.gnome.baobab'];
const target =
  preferred.map((id) => apps.find((a) => a.id === id)).find(Boolean) ?? apps[0];

console.log(`\n-- running ${target.name} (${target.id}) --`);

/* ------------------------------------------------------------------ */
/* An application with no size given chooses its own                   */
/* ------------------------------------------------------------------ */

// A window configured at 0x0 is xdg-shell asking the application how big it
// would like to be — which is how the shell avoids squeezing, say, a
// calculator into a generic 900-pixel frame it will not fit in.
{
  const own = open('wayland', 'session', { appId: target.id });
  const opened = await until(() => own.data.some((d) => d.t === 'window') && own.frames.length > 0);
  const windowed = own.data.find((d) => d.t === 'window');
  const frame = own.frames.length ? decodeFrame(own.frames[0]) : null;

  check('an application launched with no size opens a window', opened,
    opened ? '' : (own.error ?? 'no window and frame arrived'));
  check('the window carries the size the application chose',
    Boolean(windowed) && windowed.width > 0 && windowed.height > 0,
    windowed ? `${windowed.width}x${windowed.height}` : 'no window message');
  check('the size announced is the size it drew at',
    Boolean(frame) && frame.fullWidth === windowed?.width &&
      frame.fullHeight === windowed?.height,
    frame ? `announced ${windowed?.width}x${windowed?.height}, drew ${frame.fullWidth}x${frame.fullHeight}` : 'no frame');

  ws.send(JSON.stringify({ t: 'close', id: own.id }));
  await sleep(300);
}

const session = open('wayland', 'session', { appId: target.id, width: 640, height: 480 });

const gotWindow = await until(() => session.data.some((d) => d.t === 'window'));
check('the application opened a window', gotWindow,
  session.error ?? session.data.filter((d) => d.t === 'log').slice(-2).map((d) => d.message).join(' | '));

if (!gotWindow) {
  ws.close();
  process.exit(1);
}

const windowMessage = session.data.find((d) => d.t === 'window');
check('the window carries a title', typeof windowMessage.title === 'string' && windowMessage.title.length > 0,
  windowMessage.title);
check('the window carries an app id', typeof windowMessage.appId === 'string');

const gotFrame = await until(() => session.frames.length > 0);
check('a frame arrived', gotFrame);

const first = decodeFrame(session.frames[0]);
check('the frame is for that window', first.id === windowMessage.id);
check('the frame carries exactly the pixels it claims',
  first.pixels.length === first.width * first.height * 4,
  `${first.pixels.length} vs ${first.width * first.height * 4}`);
check('the first frame covers the whole window',
  first.x === 0 && first.y === 0 &&
    first.width === first.fullWidth && first.height === first.fullHeight,
  `${first.width}x${first.height} of ${first.fullWidth}x${first.fullHeight}`);
check('the window is close to the size we asked for',
  Math.abs(first.fullWidth - 640) <= 64,
  `${first.fullWidth}x${first.fullHeight}`);
check('frames are compressed', first.deflated,
  `${first.wire} bytes on the wire vs ${first.pixels.length} raw`);

/* Acknowledge everything so the application keeps drawing. */
const ackAll = () => {
  for (const frame of session.frames) ctl(session, 'ack', { id: frame.readUInt32BE(0) });
};
ackAll();

/* ------------------------------------------------------------------ */
/* Resize reaches the application                                      */
/* ------------------------------------------------------------------ */

const before = session.frames.length;
ctl(session, 'configure', { id: windowMessage.id, width: 500, height: 380 });

const resized = await until(() => {
  ackAll();
  return session.frames
    .slice(before)
    .some((f) => decodeFrame(f).fullWidth === 500);
}, 10000);
check('a resize reconfigures the application, not the canvas', resized,
  resized ? '' : 'no frame came back at the new width');

if (resized) {
  const after = session.frames.slice(before).map(decodeFrame).find((f) => f.fullWidth === 500);
  check('the resized frame is full, not partial',
    after.x === 0 && after.y === 0 && after.width === 500);
}

/* Damage tracking is the whole bandwidth story: after the first frame, a
 * redraw should cost a fraction of a full one. Only assert it if the
 * application actually redrew something small on its own. */
const partial = session.frames
  .map(decodeFrame)
  .find((f) => f.width < f.fullWidth || f.height < f.fullHeight);
if (partial) {
  check('a partial redraw ships only the damaged rectangle',
    partial.wire < first.wire / 4,
    `${partial.width}x${partial.height} in ${partial.wire} bytes vs a full ${first.wire}`);
}

/* ------------------------------------------------------------------ */
/* Input                                                              */
/* ------------------------------------------------------------------ */

/** Waits until no frame has arrived for `quiet` ms, so a redraw stands out. */
const settle = async (quiet = 1200, limit = 8000) => {
  const deadline = Date.now() + limit;
  let count = session.frames.length;
  let since = Date.now();
  while (Date.now() < deadline) {
    ackAll();
    await sleep(200);
    if (session.frames.length !== count) {
      count = session.frames.length;
      since = Date.now();
    } else if (Date.now() - since >= quiet) {
      return true;
    }
  }
  return false;
};

/** Did the application redraw in response to what we just sent? */
const redrew = async (from, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    ackAll();
    if (session.frames.length > from) return true;
    await sleep(100);
  }
  return false;
};

const idle = await settle();
check('the application goes quiet when left alone', idle,
  idle ? '' : 'it never stopped redrawing, so input cannot be judged');

if (idle) {
  const size = decodeFrame(session.frames[session.frames.length - 1]);

  /* Keyboard: evdev 8 is Digit7 on any layout, since these are physical keys. */
  let before = session.frames.length;
  ctl(session, 'key', { id: windowMessage.id, keycode: 8, pressed: true });
  await sleep(60);
  ctl(session, 'key', { id: windowMessage.id, keycode: 8, pressed: false });
  check('a keystroke reaches the application', await redrew(before));

  /* Pointer: hovering the lower half lands on a keypad and prelights it.
   * This is also the regression test for the window-geometry offset — the
   * surface is bigger than the image we send, and a click that ignores that
   * lands in the wrong place entirely. */
  await settle(800, 4000);
  before = session.frames.length;
  const hx = Math.round(size.fullWidth * 0.2);
  const hy = Math.round(size.fullHeight * 0.85);
  ctl(session, 'pointer', { id: windowMessage.id, kind: 1, x: hx, y: hy });
  check('the pointer reaches the application', await redrew(before),
    `hovered ${hx},${hy} of ${size.fullWidth}x${size.fullHeight}`);

  /* A click has to be accepted too, and must not tear the channel down. */
  before = session.frames.length;
  ctl(session, 'pointer', { id: windowMessage.id, kind: 3, x: hx, y: hy, arg: 0, value: 1 });
  await sleep(80);
  ctl(session, 'pointer', { id: windowMessage.id, kind: 3, x: hx, y: hy, arg: 0, value: 0 });
  const clicked = await redrew(before);
  check('a click reaches the application', clicked);
  check('the session survives input', !session.closed, session.error);

  /* Garbage must be refused rather than forwarded. */
  ctl(session, 'key', { id: windowMessage.id, keycode: 999999, pressed: true });
  ctl(session, 'pointer', { id: windowMessage.id, kind: 42, x: 0, y: 0 });
  ctl(session, 'pointer', { id: 9999, kind: 1, x: 0, y: 0 });
  await sleep(500);
  check('nonsense input does not kill the session', !session.closed, session.error);
}

/* ------------------------------------------------------------------ */
/* Menus, and windows that are not the main one                        */
/* ------------------------------------------------------------------ */

/** Sends a key by evdev code, press and release. */
const tap = async (keycode, id = windowMessage.id) => {
  ctl(session, 'key', { id, keycode, pressed: true });
  await sleep(60);
  ctl(session, 'key', { id, keycode, pressed: false });
};

const messagesOf = (t) => session.data.filter((d) => d.t === t);

if (idle) {
  /*
   * F10 opens the primary menu in a GTK application, which avoids this test
   * needing to know where any button is.
   */
  const popupsBefore = messagesOf('popup').length;
  await tap(68); // KEY_F10
  const opened = await until(() => {
    ackAll();
    return messagesOf('popup').length > popupsBefore;
  }, 8000);
  check('a menu opens as a popup', opened);

  if (opened) {
    const popup = messagesOf('popup').at(-1);
    check('the popup names its parent', popup.parent === windowMessage.id,
      `parent ${popup.parent}`);
    check('the popup has a size', popup.width > 0 && popup.height > 0,
      `${popup.width}x${popup.height}`);

    /* The whole point of the positioner: a menu placed outside the window is
     * a menu nobody can click. Measured against the *window's* last frame —
     * the popup has frames of its own by now. */
    const win = session.frames
      .map(decodeFrame)
      .filter((f) => f.id === windowMessage.id)
      .at(-1);
    const within =
      popup.x >= 0 && popup.y >= 0 &&
      popup.x + popup.width <= win.fullWidth + 1 &&
      popup.y + popup.height <= win.fullHeight + 1;
    check('the popup is placed inside the window', within,
      `${popup.x},${popup.y} ${popup.width}x${popup.height} in ` +
        `${win.fullWidth}x${win.fullHeight}`);

    /* Its own frames arrive under its own id. */
    const drew = await until(() => {
      ackAll();
      return session.frames.some((f) => f.readUInt32BE(0) === popup.id);
    }, 6000);
    check('the popup renders', drew);

    /* Escape reaches the menu, not the window, because the menu holds a
     * grab — that is what closes it. */
    await tap(1); // KEY_ESC
    const gone = await until(
      () => messagesOf('closed').some((d) => d.id === popup.id), 6000);
    check('Escape closes the menu', gone);
  }

  /* Ctrl+N opens a second toplevel: a window that is not the main one. */
  await settle(800, 4000);
  const windowsBefore = messagesOf('window').length;
  ctl(session, 'key', { id: windowMessage.id, keycode: 29, pressed: true }); // Ctrl
  await tap(49); // KEY_N
  ctl(session, 'key', { id: windowMessage.id, keycode: 29, pressed: false });
  const second = await until(() => {
    ackAll();
    return messagesOf('window').length > windowsBefore;
  }, 8000);
  check('a second toplevel is reported as its own window', second,
    second ? '' : 'no extra window appeared');
  if (second) {
    const extra = messagesOf('window').at(-1);
    check('it carries its own id', extra.id !== windowMessage.id);
    ctl(session, 'closeWindow', { id: extra.id });
  }
}

/* ------------------------------------------------------------------ */
/* Cursor and clipboard                                               */
/* ------------------------------------------------------------------ */

if (idle) {
  check('the session reports the keyboard layout it loaded',
    typeof session.info?.layout === 'string' && session.info.layout.length > 0,
    session.info?.layout);

  /*
   * Copying out. Select all and copy: whatever the application puts on its
   * clipboard has to come back to us as text.
   */
  const copiesBefore = messagesOf('copy').length;
  ctl(session, 'key', { id: windowMessage.id, keycode: 29, pressed: true });
  await tap(30); // Ctrl+A
  await tap(46); // Ctrl+C
  ctl(session, 'key', { id: windowMessage.id, keycode: 29, pressed: false });

  const copied = await until(() => {
    ackAll();
    return messagesOf('copy').length > copiesBefore;
  }, 8000);
  check('copying in the application reaches the browser', copied,
    copied ? JSON.stringify(messagesOf('copy').at(-1).text.slice(0, 40)) : 'nothing arrived');

  /* Pasting in. The compositor has to accept it without complaint; whether
   * the application takes it depends on the toolkit — see docs/wayland.md. */
  ctl(session, 'paste', { text: 'from-the-browser' });
  await sleep(400);
  check('the session survives a clipboard push', !session.closed, session.error);

  /* A cursor shape only arrives if the application asks for one, which it
   * does when the pointer is over something it can name. */
  const size = decodeFrame(session.frames.map(decodeFrame).length
    ? session.frames[session.frames.length - 1] : session.frames[0]);
  for (const [x, y] of [[0.5, 0.35], [0.5, 0.5], [0.2, 0.85]]) {
    ctl(session, 'pointer', {
      id: windowMessage.id, kind: 1,
      x: Math.round(size.fullWidth * x), y: Math.round(size.fullHeight * y),
    });
    await sleep(600);
    ackAll();
  }
  const cursors = messagesOf('cursor');
  check('the application drives the cursor shape', cursors.length > 0,
    cursors.map((c) => c.shape).join(','));
}

/* ------------------------------------------------------------------ */
/* Reaping                                                             */
/* ------------------------------------------------------------------ */

/* This session's own socket name, so a compositor belonging to another server
 * on the same machine cannot make this pass or fail. */
const socketName = session.info?.socket;
check('the session names its socket', typeof socketName === 'string' && socketName.length > 0);
// Not cosmetic: abstractions/wayland, which every snap and every confined .deb
// includes, allows `wayland-[0-9]*` under the runtime dir and no other name. A
// socket called anything else is one those applications cannot open.
check('the socket name is one AppArmor lets a confined application open',
  /^wayland-[0-9]+$/.test(socketName ?? ''), socketName);
const compositorsBefore = matching(`wdcomp --ipc -s ${socketName}`);
check('the compositor is running', compositorsBefore.length > 0);

ws.send(JSON.stringify({ t: 'close', id: session.id }));

const reaped = await until(() => matching(`wdcomp --ipc -s ${socketName}`).length === 0, 10000);
check('closing the channel reaps the compositor', reaped,
  reaped ? '' : `still alive: ${matching(`wdcomp --ipc -s ${socketName}`).join(',')}`);

// The compositor is a grandchild through dbus-run-session, so it only dies if
// the whole process group was signalled — killing just the direct child would
// leave both the bus and the application behind.
const busGone = await until(
  () => matching(`dbus-run-session -- .*${socketName}`).length === 0, 8000);
check('and the session bus wrapper with it', busGone,
  busGone ? '' : `still alive: ${matching(`dbus-run-session -- .*${socketName}`).join(',')}`);

ws.close();

console.log('');
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
