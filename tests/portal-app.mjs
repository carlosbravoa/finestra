// The application side of the portal, as a process inside a session's tree.
//
// Launched by the fake `snap` fixture, so it is a child of the compositor the
// way a real snap is. It asks org.freedesktop.portal.Desktop on the bus it was
// given for a file dialog, with a token it chooses, waits for the Response
// the way GTK does — delivered to it, no match rule — and writes what came
// back to a file named after the token. The suite reads that file.
//
// It retries while the name has no owner: the portal on the machine's bus is
// opened when the first snap session starts, and a real application takes
// longer to get to its first dialog than this script does.
import fs from 'node:fs';
import path from 'node:path';
import { DBus, Variant } from '../server/dist/server/src/dbus.js';

const token = `snap${process.pid}`;
const out = path.join(process.env.WD_TEST_PORTAL_DIR, `${token}.json`);
const write = (result) => fs.writeFileSync(out, JSON.stringify(result));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bus = await DBus.connect(process.env.DBUS_SESSION_BUS_ADDRESS);
// Whether this is the machine's bus, seen through whatever is in front of it:
// the portal name is owned there, by the server, and nowhere else.
const names = (await bus.call({
  destination: 'org.freedesktop.DBus',
  path: '/org/freedesktop/DBus',
  interface: 'org.freedesktop.DBus',
  member: 'ListNames',
})).body[0];
const onMachineBus = Array.isArray(names) && names.includes('org.freedesktop.portal.Desktop');
let handle = null;
for (let attempt = 0; attempt < 50 && !handle; attempt++) {
  try {
    const reply = await bus.call({
      destination: 'org.freedesktop.portal.Desktop',
      path: '/org/freedesktop/portal/desktop',
      interface: 'org.freedesktop.portal.FileChooser',
      member: 'OpenFile',
      signature: 'ssa{sv}',
      body: ['', `From ${token}`, new Map([['handle_token', new Variant('s', token)]])],
    });
    handle = reply.body[0];
  } catch (err) {
    if (!/ServiceUnknown|NameHasNoOwner/.test(String(err.name ?? err))) {
      write({ error: String(err) });
      process.exit(1);
    }
    await sleep(100);
  }
}
if (!handle) {
  write({ error: 'nobody owns the portal name' });
  process.exit(1);
}

const owner = (await bus.call({
  destination: 'org.freedesktop.DBus',
  path: '/org/freedesktop/DBus',
  interface: 'org.freedesktop.DBus',
  member: 'GetNameOwner',
  signature: 's',
  body: ['org.freedesktop.portal.Desktop'],
})).body[0];

bus.onSignal = (m) => {
  if (m.path !== handle || m.member !== 'Response') return;
  write({ token, handle, code: m.body[0], uris: m.body[1]?.get('uris')?.value ?? null, onMachineBus, owner, sender: m.sender });
  process.exit(0);
};
setTimeout(() => {
  write({ token, handle, error: 'no Response within 20s' });
  process.exit(1);
}, 20_000);
