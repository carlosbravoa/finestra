// The access token, in a real browser.
//
// auth.mjs drives the socket and access.test.ts drives the client against a
// fake one. Between them sits the one claim neither can make: that a browser
// gets back in on the HttpOnly cookie alone, with the token nowhere in the
// page and nothing on the socket URL. Only a browser can show that, so this
// drives two desktops in headless Chromium over the DevTools protocol, each
// in its own browser context so they have separate cookie jars: one changes
// the token from Settings, the other is the "another desktop" that is kept,
// then signed out, then — after the server restarts with a fresh token while
// it was away — told so instead of retrying for ever.
//
// It starts its own server, since it changes the token and restarts it, and
// skips itself when there is no Chromium: the `chromium` run.sh puts on the
// server's launch path is a recorder, not a browser, so the real one is
// looked for by absolute path, or named in WD_TEST_BROWSER.
//
//   node tests/access-browser.mjs [port]      WD_TEST_SHOTS=<dir> keeps screenshots

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.argv[2] || 7229);
const DEBUG_PORT = PORT + 1;
const SERVER = 'server/dist/server/src/index.js';
const SHOTS = process.env.WD_TEST_SHOTS || '';

const BROWSERS = [
  process.env.WD_TEST_BROWSER,
  '/snap/bin/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean);
const browserBin = BROWSERS.find((b) => fs.existsSync(b));
if (!browserBin) {
  console.log('SKIP — no Chromium found; set WD_TEST_BROWSER to point at one');
  process.exit(0);
}
if (!fs.existsSync('client/dist/index.html')) {
  console.log('FAIL  the client is not built — run `npm run build` first');
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- the server, with a token of its own making ------------------------ */

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-browser-'));
const TOKEN_FILE = path.join(STATE, 'finestra', 'token');
let server = null;

async function startServer() {
  server = spawn('node', [SERVER], {
    env: { ...process.env, WD_TOKEN: undefined, WD_NO_AUTH: undefined, XDG_STATE_HOME: STATE, WD_PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(100);
  }
  throw new Error('the server did not come up');
}
async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
}
const tokenOnDisk = () => fs.readFileSync(TOKEN_FILE, 'utf8').trim();

/* --- the browser, over the DevTools protocol --------------------------- */

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-browser-profile-'));
const browser = spawn(
  browserBin,
  ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--window-size=1280,800', 'about:blank'],
  { stdio: 'ignore' },
);

async function finish(code) {
  browser.kill('SIGTERM');
  await Promise.race([new Promise((r) => browser.on('exit', r)), sleep(3000).then(() => browser.kill('SIGKILL'))]);
  await stopServer();
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  process.exit(code);
}
process.on('uncaughtException', (e) => {
  console.log(`FAIL  the script itself — ${e.message}`);
  void finish(1);
});
process.on('unhandledRejection', (e) => {
  console.log(`FAIL  the script itself — ${e?.message ?? e}`);
  void finish(1);
});
// Backoff on the client side can reach eight seconds between attempts, so
// the restart case alone can legitimately take twenty. Three minutes is a hang.
setTimeout(() => {
  console.log('FAIL  the whole thing took more than three minutes');
  void finish(1);
}, 180_000).unref();

await startServer();
const first = tokenOnDisk();

let version;
for (let i = 0; i < 100 && !version; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  } catch {
    await sleep(200);
  }
}
if (!version) throw new Error(`${browserBin} did not open its debugging port`);
const cdp = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => cdp.on('open', r));
let nextId = 1;
const pending = new Map();
cdp.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, (m) => resolve(m.result ?? m.error));
    cdp.send(JSON.stringify({ id, method, params, sessionId }));
  });

/** A tab in its own browser context: its own cookies, its own storage. */
async function desktop(name) {
  const { browserContextId } = await send('Target.createBrowserContext', {});
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    return r.result?.value;
  };
  const waitFor = async (expr, ms = 8000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const v = await ev(expr);
      if (v) return v;
      await sleep(100);
    }
    return null;
  };
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  };
  // Scrolled into view first: a button below the fold has a rect, and a
  // click at it lands on whatever is drawn there instead.
  const rectOf = (sel, text) =>
    `(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
      const el = els.find((e) => ${text ? `e.textContent.trim().startsWith(${JSON.stringify(text)})` : 'true'});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`;
  const click = async (sel, text) => {
    const r = await waitFor(rectOf(sel, text));
    if (!r) throw new Error(`${name}: nothing to click for ${sel} ${text ?? ''}`);
    await clickAt(r.x, r.y);
  };
  // Through the start menu, hovering categories until the app shows up.
  const launch = async (app) => {
    await click('.taskbar-start');
    await waitFor(`!!document.querySelector('.menu-panel')`);
    await sleep(150);
    if (!(await ev(rectOf('.menu-item-label', app)))) {
      const cats = await ev(`[...document.querySelectorAll('.menu-item-label')].map(e => e.textContent.trim())`);
      for (const c of cats) {
        const r = await ev(rectOf('.menu-item-label', c));
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }, sessionId);
        await sleep(250);
        if (await ev(rectOf('.menu-item-label', app))) break;
      }
    }
    await click('.menu-item-label', app);
  };
  const goto = (url) => send('Page.navigate', { url }, sessionId);
  const booted = () => waitFor(`document.querySelector('.desktop')?.dataset.connection === 'open'`, 10000);
  const connection = () => ev(`document.querySelector('.desktop')?.dataset.connection`);
  const windows = () => ev(`document.querySelectorAll('.window').length`);
  const shot = async (file) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const s = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(s.data, 'base64'));
  };
  return { name, ev, waitFor, click, launch, goto, booted, connection, windows, shot };
}

const A = await desktop('A');
const B = await desktop('B');
const page = (query = '') => `http://127.0.0.1:${PORT}/${query}`;

/* --- getting in, and staying in without the token in the page ---------- */

await A.goto(page(`?t=${first}`));
check('a desktop boots from the link', !!(await A.booted()));
const href = await A.ev('location.href');
check('the token left the address bar', !href.includes('t='), href);
check('and is not in localStorage', (await A.ev(`localStorage.getItem('wd:token')`)) === null);
await sleep(1500);
await A.goto(page());
check('it boots again on the cookie alone — the socket carries no token', !!(await A.booted()));
check('and its terminal came back', (await A.waitFor(`document.querySelectorAll('.window').length`, 10000)) >= 1);

await B.goto(page(`?t=${first}`));
check('a second desktop boots from the same link, in its own browser', !!(await B.booted()));
await sleep(1500);

/* --- Settings → Access ------------------------------------------------- */

await A.launch('Settings');
await A.waitFor(`!!document.querySelector('.settings-session')`);
await sleep(500);
const sessions = await A.ev(`[...document.querySelectorAll('.settings-session')].map(s => s.textContent)`);
check('Settings lists both desktops', sessions.length === 2, JSON.stringify(sessions));
check('and knows which one is this', (await A.ev(`document.querySelectorAll('.settings-session.is-self').length`)) === 1);
const hint = await A.ev(`[...document.querySelectorAll('.settings-row-hint')].map(h => h.textContent).find(t => t.includes('Kept in')) ?? ''`);
check('it names the token file', hint.includes(TOKEN_FILE), hint);
await A.shot('access-before.png');

/* --- changing it, keeping the other ------------------------------------ */

await A.click('.settings-button', 'Change…');
const message = await A.waitFor(`document.querySelector('.dialog-message')?.textContent`);
check('the dialog says the other desktop stays connected', /1 other desktop connected right now stays connected/.test(message ?? ''), message);
await A.click('.dialog-button.is-primary');
const link = await A.waitFor(`document.querySelector('.settings-link-url')?.textContent`);
check('the new link is shown once', !!link && link.startsWith(page('?t=')) && !link.includes(first), link);
const second = link ? new URL(link).searchParams.get('t') : null;
check('the token file holds it', !!second && tokenOnDisk() === second);
await A.shot('access-after.png');

const toldB = await B.waitFor(`[...document.querySelectorAll('.notification-title')].map(n => n.textContent).find(t => t.includes('token was changed')) ?? null`);
check('the other desktop is told, and keeps working', toldB !== null && (await B.connection()) === 'open', toldB ?? 'no notice');
await B.shot('kept.png');
await B.goto(page());
check('it reloads on its refreshed cookie', !!(await B.booted()));
await sleep(1200);
await A.goto(page());
check('so does the one that changed it', !!(await A.booted()));

const C = await desktop('C');
await C.goto(page(`?t=${first}`));
const refusedTitle = await C.waitFor(`document.querySelector('.boot-error h1')?.textContent`);
check('the old link is refused with a reason', refusedTitle === 'Access token required', refusedTitle ?? 'no screen');
const refusedText = await C.ev(`document.querySelector('.boot-error p')?.textContent ?? ''`);
check('which says the token may have been changed', /token was changed/.test(refusedText));
await C.shot('old-link.png');

/* --- changing it, signing the other out -------------------------------- */

await A.launch('Settings');
await A.waitFor(`!!document.querySelector('.settings-session')`);
await sleep(500);
await A.click('.settings-button', 'Change and sign');
const message2 = await A.waitFor(`document.querySelector('.dialog-message')?.textContent`);
check('the dialog says the other desktop is signed out', /is signed out at once/.test(message2 ?? ''), message2);
await A.click('.dialog-button.is-primary');
const link2 = await A.waitFor(`document.querySelector('.settings-link-url')?.textContent`);
const third = link2 ? new URL(link2).searchParams.get('t') : null;
check('a third token was minted', !!third && third !== second);

const signedOut = await B.waitFor(`document.querySelector('.boot-error.is-over h1')?.textContent`);
check('the other desktop sees it was signed out, over its desktop', signedOut === 'This desktop was signed out', signedOut ?? 'no screen');
check('its windows are still underneath', (await B.windows()) >= 1);
check('and it is not retrying', (await B.connection()) === 'closed');
await B.shot('signed-out.png');
check('the one that changed it is still connected', (await A.connection()) === 'open');

await B.goto(link2);
check('it comes back through the new link', !!(await B.booted()));
check('with its windows as they were', (await B.waitFor(`document.querySelectorAll('.window').length`, 10000)) >= 1);
await B.shot('back.png');

/* --- changed while this desktop was away ------------------------------- */
//
// The token file deleted and the service restarted is the other way to
// change it, and it happens while no socket is open to be told. A refused
// upgrade and a server that is down are the same bare close from the page,
// so the only way the desktop can tell is to ask over HTTP once it is back.

await stopServer();
check('with the server stopped the desktop is reconnecting', (await B.waitFor(`document.querySelector('.desktop')?.dataset.connection === 'reconnecting'`, 5000)) === true);
fs.rmSync(TOKEN_FILE);
await startServer();
const fourth = tokenOnDisk();
check('the restarted server minted a token of its own', fourth !== third && fourth.length >= 16);
const away = await B.waitFor(`document.querySelector('.boot-error.is-over h1')?.textContent`, 30000);
check('the desktop is signed out rather than retrying for ever', away === 'This desktop was signed out', away ?? 'still reconnecting');
const awayText = await B.ev(`document.querySelector('.boot-error.is-over p')?.textContent ?? ''`);
check('and told the token was changed while it was away', /while this desktop was disconnected/.test(awayText), awayText);
check('with its windows still underneath', (await B.windows()) >= 1);
await B.shot('away.png');
await B.goto(page(`?t=${fourth}`));
check('the token on the server gets it back in', !!(await B.booted()));
check('with its windows as they were', (await B.waitFor(`document.querySelectorAll('.window').length`, 10000)) >= 1);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
await finish(failed ? 1 : 0);
