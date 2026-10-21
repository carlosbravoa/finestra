// What outlives the browser, and for how long.
//
// A desktop does not close your editor because the laptop lid shut, and
// this one used to: a shell or an application whose browser went away was
// kept for an hour and then ended, unless someone had remembered to mark the
// shell "keep running while I am away". The ones lost were the ones nobody
// marked, and on a poor connection that was most of them. The default is now
// no limit at all; a number in WD_TERMINAL_GRACE or WD_WINDOW_GRACE puts one
// back, and 0 is the pre-0.3.7 behaviour of ending things at once.
//
// The config rule and the terminal's side of it are checked here, against a
// real shell; tests/pty-attach.mjs and tests/wayland.mjs run the suite's
// server with a three-second limit and check what happens when it runs out.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../server/src/config.js';
import type { ChannelContext, OpenedChannel } from '../server/src/service.js';
import { ptyService } from '../server/src/services/pty.js';

const results: boolean[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const untilDead = async (pid: number, ms: number) => {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(50);
  return !alive(pid);
};

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}  — ${(err as Error).message}`);
  }
}

/* The rule ------------------------------------------------------------- */

// loadConfig mints a token into the state directory; keep that out of the
// real one.
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-grace-'));

const graces = (terminal?: string, window?: string) => {
  if (terminal === undefined) delete process.env.WD_TERMINAL_GRACE;
  else process.env.WD_TERMINAL_GRACE = terminal;
  if (window === undefined) delete process.env.WD_WINDOW_GRACE;
  else process.env.WD_WINDOW_GRACE = window;
  const c = loadConfig();
  return [c.terminalGrace, c.windowGrace];
};

await check('unset, a shell and an application are kept for ever', () => {
  assert.deepEqual(graces(), [Infinity, Infinity]);
});
await check('an empty value is the same as none', () => {
  assert.deepEqual(graces('', ''), [Infinity, Infinity]);
});
await check('a number is seconds', () => {
  assert.deepEqual(graces('3600', '30'), [3600, 30]);
});
await check('zero ends things the moment the connection goes', () => {
  assert.deepEqual(graces('0', '0'), [0, 0]);
});
await check('each has its own setting', () => {
  assert.deepEqual(graces(undefined, '5'), [Infinity, 5]);
});

/* The terminal --------------------------------------------------------- */

function channel(terminalGrace: number): ChannelContext {
  return {
    config: { terminalGrace } as unknown as Config,
    sessionId: 'browser-1',
    id: 1,
    emit() {},
    announce: () => 0,
    send() {},
    sendBinary() {},
    close() {},
  };
}

const spawn = async (grace: number) => {
  const ctx = channel(grace);
  const opened = (await ptyService.channels!.spawn({}, ctx)) as OpenedChannel;
  const info = opened.info as { id: string; pid: number; grace: number | null };
  return { ctx, opened, info };
};

/** Closes the window on a shell, which is what ends it however long the grace. */
const closeWindow = async (id: string) => {
  const ctx = channel(Infinity);
  const picked = (await ptyService.channels!.attach({ id }, ctx)) as OpenedChannel;
  picked.onClose?.(false);
};

await check('a shell with no limit tells its window so', async () => {
  const { opened, info } = await spawn(Infinity);
  assert.equal(info.grace, null);
  opened.onClose?.(false);
});

await check('a shell with a limit names it', async () => {
  const { opened, info } = await spawn(600);
  assert.equal(info.grace, 600);
  opened.onClose?.(false);
});

await check('losing the connection leaves an unlimited shell running', async () => {
  const { opened, info } = await spawn(Infinity);
  opened.onClose?.(true);
  await sleep(300);
  assert.ok(alive(info.pid), `pid ${info.pid} is gone`);
  const listed = (ptyService.methods!.list({}, channel(Infinity)) as { id: string; attached: boolean }[])
    .find((t) => t.id === info.id);
  assert.ok(listed && !listed.attached, 'not listed as waiting');
  await closeWindow(info.id);
  assert.ok(await untilDead(info.pid, 3000), 'closing its window did not end it');
});

await check('with a limit of zero the same loss hangs the shell up at once', async () => {
  const { opened, info } = await spawn(0);
  opened.onClose?.(true);
  assert.ok(await untilDead(info.pid, 3000), `pid ${info.pid} still running`);
});

await check('with a limit, the shell waits that long and no longer', async () => {
  const { opened, info } = await spawn(1);
  opened.onClose?.(true);
  await sleep(400);
  assert.ok(alive(info.pid), 'gone before its second was up');
  assert.ok(await untilDead(info.pid, 3000), 'still running after the limit');
});

fs.rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
