// The session clock: the thing that makes "temporary" true even when whoever
// asked for the session has stopped paying attention.
//
// Tested with an injected exit rather than by letting it end the test runner,
// so the assertions are about the rule rather than about timing luck.

import assert from 'node:assert/strict';
import { startDeadman, noteActivity } from '../server/src/deadman.js';

const results: boolean[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Collects what the deadman decided, instead of ending this process. */
function harness(ttlSec: number, idleSec: number) {
  const exits: number[] = [];
  const logs: string[] = [];
  const stop = startDeadman({
    ttlSec,
    idleSec,
    exit: (code) => exits.push(code),
    log: (m) => logs.push(m),
  });
  return { exits, logs, stop };
}

await check('with no limits it does nothing and says nothing', () => {
  const { exits, logs, stop } = harness(0, 0);
  assert.equal(exits.length, 0);
  assert.equal(logs.length, 0, 'no limit, no announcement');
  stop();
});

await check('it announces the limits it was given', () => {
  const { logs, stop } = harness(900, 120);
  assert.match(logs.join(' '), /900s total/);
  assert.match(logs.join(' '), /120s idle/);
  stop();
});

await check('the total limit ends the session', async () => {
  const { exits, logs, stop } = harness(1, 0);
  await sleep(1400);
  stop();
  assert.equal(exits[0], 0, 'exited cleanly');
  assert.match(logs.join(' '), /limit is up/);
});

await check('silence ends the session', async () => {
  const { exits, logs, stop } = harness(0, 1);
  await sleep(1400);
  stop();
  assert.equal(exits[0], 0);
  assert.match(logs.join(' '), /nothing for 1s/);
});

await check('activity holds the idle limit off', async () => {
  const { exits, stop } = harness(0, 2);
  for (let i = 0; i < 6; i++) {
    noteActivity();
    await sleep(400);
  }
  stop();
  assert.equal(exits.length, 0, 'a busy session was not ended');
});

// The one that matters: a session cannot be kept alive past its deadline by
// being used, or a chatty client would own the machine indefinitely.
await check('the total limit is not extended by activity', async () => {
  const { exits, logs, stop } = harness(1, 0);
  for (let i = 0; i < 4; i++) {
    noteActivity();
    await sleep(400);
  }
  stop();
  assert.equal(exits[0], 0, 'busy or not, time is up');
  assert.match(logs.join(' '), /limit is up/);
});

await check('a stopped clock does not fire', async () => {
  const { exits, stop } = harness(1, 0);
  stop();
  await sleep(1400);
  assert.equal(exits.length, 0);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
