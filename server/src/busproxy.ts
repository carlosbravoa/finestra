import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DBus, METHOD_CALL, METHOD_RETURN, SIGNAL, ERROR, decode, encode, type Message } from './dbus.js';
import { FileChooserPortal, PORTAL_NAME, type Endpoint, type PortalTarget } from './portal.js';

/*
 * The machine's session bus, with the file chooser answered on the way.
 *
 * A snap has to be on the machine's own bus: `snap run` asks the user's
 * systemd there for a tracking scope and runs nothing without one, and
 * `snap userd`, the document portal and the a11y bus all live there too. But
 * on that bus the portal name belongs to whoever got it first — on a
 * workstation the real xdg-desktop-portal, which draws a confined
 * application's Open File on the physical monitor — and nothing we do on
 * the bus can take a dialog away from it. 0.3.14 tried, and shipped a
 * Firefox whose dialog appeared on a screen nobody was looking at.
 *
 * So the snap is not handed the bus. It is handed a socket of ours, at an
 * abstract address `@/tmp/dbus-…` — the one shape of socket, besides the bus
 * itself, that every snap's profile lets it connect to (a path in its own
 * runtime directory looks permitted and is refused) — and behind it is a
 * connection to the real bus made on its behalf. Every byte
 * passes through unchanged — Hello, names, matches, systemd, all of it —
 * except a method call to the portal's file-chooser interface, which is
 * answered here, and the Response it waits for, which is written into the
 * stream as if the portal's owner had sent it. This is what Flatpak's
 * xdg-dbus-proxy does for its sandboxes, reduced to the one interface.
 *
 * What it costs: file descriptors cannot cross a connection node relays, so
 * NEGOTIATE_UNIX_FD is declined and the application does without — the
 * document portal's AddFull is the only common caller. And the bus sees
 * our unconfined connection, not the snap's, so the daemon's AppArmor
 * mediation of the snap's bus traffic does not apply through here.
 */

const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const CHOOSER = 'org.freedesktop.portal.FileChooser';
const REQUEST = 'org.freedesktop.portal.Request';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const DBUS = 'org.freedesktop.DBus';
const NO_REPLY_EXPECTED = 0x1;

/** Bytes in the message at the head of `buf`, or 0 while it is incomplete. */
function frameLength(buf: Buffer): number {
  if (buf.length < 16) return 0;
  const le = buf[0] === 0x6c;
  const body = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fields = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const total = ((16 + fields + 7) & ~7) + body;
  return buf.length >= total ? total : 0;
}

/** Decoded if we can read it; a message we cannot decode is still forwarded. */
function tryDecode(frame: Buffer): Message | null {
  try {
    return decode(frame)?.message ?? null;
  } catch {
    return null;
  }
}

/** `unix:path=…` only; a snap's bus is one, or it is not reachable from a snap. */
function unixPath(address: string): string {
  for (const part of address.split(';')) {
    const m = /^unix:(.*)$/.exec(part);
    if (!m) continue;
    for (const kv of m[1].split(',')) {
      const [k, v] = kv.split('=');
      if (k === 'path') return decodeURIComponent(v);
    }
  }
  throw new Error(`not a path bus: ${address}`);
}

/**
 * Where the proxy listens. Node binds an abstract name correctly from 22 on
 * (libuv's bind with a length; before that the name is cut at its leading
 * NUL and the socket lands somewhere else, silently), so an older runtime
 * gets a path socket, which an unconfined client — the suite's fake snap —
 * can use and a confined one cannot. The release ships its own Node, so the
 * product always takes the first.
 */
export type ProxyAddress = { abstract: string } | { path: string };

export function abstractSocketsWork(): boolean {
  return Number(process.versions.node.split('.')[0]) >= 22;
}

interface Client {
  down: net.Socket;
  up: net.Socket;
  /** The name the bus gave this connection, learned from the Hello reply. */
  unique: string | null;
  helloSerial: number | null;
  fromClient: Buffer;
  fromBus: Buffer;
  open: boolean;
}

export class BusProxy implements Endpoint {
  private readonly clients = new Set<Client>();
  private readonly byName = new Map<string, Client>();
  private readonly portal: FileChooserPortal;
  /** Serials for messages of our own in a client's stream; above anything the bus uses in a session. */
  private serial = 0x40000000;
  private closed = false;
  /**
   * The portal name's owner on the real bus, by unique name. A GDBusProxy —
   * Firefox's file picker is one — looks the owner up and addresses its
   * calls to that unique name, never to the well-known one, so a call for
   * the chooser has to be recognised under either. Kept current from
   * NameOwnerChanged; the Response is signed with it too.
   */
  private ownerName: string | null = null;

  private constructor(
    private readonly server: net.Server,
    private readonly control: DBus,
    private readonly hostPath: string,
    private readonly at: ProxyAddress,
    private readonly target: PortalTarget,
  ) {
    this.portal = FileChooserPortal.attach(this, target);
  }

  /**
   * Listens at `socketPath` for one application, in front of the bus at
   * `hostAddress`. The portal name on that bus is taken if nobody has it —
   * a headless server — so that the name always has an owner for the
   * application to predict the Response's sender from.
   */
  static async open(hostAddress: string, at: ProxyAddress, target: PortalTarget): Promise<BusProxy> {
    const hostPath = unixPath(hostAddress);
    const control = await DBus.connect(hostAddress);
    control.on('error', () => {
      // Nothing to do; a dead control connection only costs the owner lookup.
    });
    const owned = (await control.requestName(PORTAL_NAME, 0x4)) === 1;
    const server = net.createServer();
    try {
      if ('path' in at) fs.rmSync(at.path, { force: true });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen('path' in at ? at.path : `\0${at.abstract}`, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      control.close();
      throw err;
    }
    const proxy = new BusProxy(server, control, hostPath, at, target);
    control.onSignal = (msg) => {
      if (msg.member === 'NameOwnerChanged' && msg.body[0] === PORTAL_NAME) {
        proxy.ownerName = typeof msg.body[2] === 'string' && msg.body[2] ? msg.body[2] : null;
      }
    };
    try {
      await control.addMatch(
        `type='signal',sender='${DBUS}',interface='${DBUS}',member='NameOwnerChanged',arg0='${PORTAL_NAME}'`,
      );
      proxy.ownerName = owned ? control.uniqueName : await proxy.lookupOwner();
    } catch {
      // Then the well-known name is all we can sign with; see owner().
    }
    server.on('connection', (socket) => proxy.accept(socket));
    return proxy;
  }

  /** What goes in the application's DBUS_SESSION_BUS_ADDRESS. */
  get address(): string {
    return 'path' in this.at ? `unix:path=${this.at.path}` : `unix:abstract=${this.at.abstract}`;
  }

  /** Whose name the Response has to carry: the portal's owner, as the bus reports it. */
  private owner(): string {
    return this.ownerName ?? PORTAL_NAME;
  }

  private async lookupOwner(): Promise<string | null> {
    try {
      const reply = await this.control.call({
        destination: DBUS,
        path: '/org/freedesktop/DBus',
        interface: DBUS,
        member: 'GetNameOwner',
        signature: 's',
        body: [PORTAL_NAME],
      });
      return typeof reply.body[0] === 'string' ? reply.body[0] : null;
    } catch {
      return null;
    }
  }

  /* ---- the application's side: the SASL handshake, then frames ---- */

  private accept(down: net.Socket): void {
    if (this.closed) {
      down.destroy();
      return;
    }
    let pending = Buffer.alloc(0);
    let begun = false;
    const guid = randomBytes(16).toString('hex');
    const onData = (chunk: Buffer) => {
      if (begun) return;
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf('\r\n');
        if (end < 0) return;
        let line = pending.subarray(0, end).toString('latin1');
        pending = pending.subarray(end + 2);
        if (line.startsWith('\0')) line = line.slice(1);
        if (line === 'BEGIN') {
          begun = true;
          down.off('data', onData);
          this.connect(down, pending);
          return;
        }
        if (line.startsWith('AUTH EXTERNAL')) {
          // With the uid inline it is a complete exchange; without, the
          // client expects to be asked for it.
          down.write(line.length > 'AUTH EXTERNAL'.length ? `OK ${guid}\r\n` : 'DATA\r\n');
        } else if (line.startsWith('DATA')) {
          down.write(`OK ${guid}\r\n`);
        } else if (line.startsWith('AUTH')) {
          down.write('REJECTED EXTERNAL\r\n');
        } else if (line === 'NEGOTIATE_UNIX_FD') {
          // Declined: a descriptor cannot cross this connection.
          down.write('ERROR\r\n');
        } else {
          down.write('ERROR\r\n');
        }
      }
    };
    down.on('data', onData);
    down.on('error', () => down.destroy());
  }

  /** The application said BEGIN; now the real bus, authenticated on its behalf. */
  private connect(down: net.Socket, initial: Buffer): void {
    const up = net.createConnection(this.hostPath);
    const client: Client = {
      down,
      up,
      unique: null,
      helloSerial: null,
      fromClient: Buffer.alloc(0),
      fromBus: Buffer.alloc(0),
      open: true,
    };
    this.clients.add(client);
    const drop = () => this.drop(client);
    up.on('error', drop);
    down.on('error', drop);
    up.on('close', drop);
    down.on('close', drop);

    // The application may send its Hello the moment it has said BEGIN,
    // before the bus has let us in; nothing it sends is dropped.
    const early: Buffer[] = [initial];
    let authed = false;
    down.on('data', (c: Buffer) => {
      if (authed) this.fromClient(client, c);
      else early.push(c);
    });

    let line = '';
    const uid = process.getuid?.() ?? 0;
    up.once('connect', () => {
      up.write(`\0AUTH EXTERNAL ${Buffer.from(String(uid)).toString('hex')}\r\n`);
    });
    up.on('data', (chunk: Buffer) => {
      if (authed) {
        this.fromBus(client, chunk);
        return;
      }
      line += chunk.toString('latin1');
      const end = line.indexOf('\r\n');
      if (end < 0) return;
      const answer = line.slice(0, end);
      const rest = line.slice(end + 2);
      if (!answer.startsWith('OK ')) {
        drop();
        return;
      }
      authed = true;
      up.write('BEGIN\r\n');
      for (const c of early) if (c.length) this.fromClient(client, c);
      early.length = 0;
      if (rest) this.fromBus(client, Buffer.from(rest, 'latin1'));
    });
  }

  private drop(client: Client): void {
    if (!client.open) return;
    client.open = false;
    this.clients.delete(client);
    if (client.unique) {
      this.byName.delete(client.unique);
      this.portal.forget(client.unique);
    }
    client.down.destroy();
    client.up.destroy();
  }

  /* ---- frames ---- */

  private fromClient(client: Client, chunk: Buffer): void {
    client.fromClient = client.fromClient.length ? Buffer.concat([client.fromClient, chunk]) : chunk;
    for (;;) {
      const len = frameLength(client.fromClient);
      if (!len) return;
      const frame = client.fromClient.subarray(0, len);
      client.fromClient = client.fromClient.subarray(len);
      const msg = tryDecode(frame);
      if (msg?.type === METHOD_CALL) {
        if (msg.destination === DBUS && msg.member === 'Hello') client.helloSerial = msg.serial;
        if (this.intercepts(msg)) {
          msg.sender = client.unique ?? '';
          void this.portal.handle(msg);
          continue;
        }
      }
      client.up.write(frame);
    }
  }

  private fromBus(client: Client, chunk: Buffer): void {
    client.fromBus = client.fromBus.length ? Buffer.concat([client.fromBus, chunk]) : chunk;
    for (;;) {
      const len = frameLength(client.fromBus);
      if (!len) return;
      const frame = client.fromBus.subarray(0, len);
      client.fromBus = client.fromBus.subarray(len);
      if (client.unique === null && client.helloSerial !== null) {
        const msg = tryDecode(frame);
        if (msg?.type === METHOD_RETURN && msg.replySerial === client.helloSerial && typeof msg.body[0] === 'string') {
          client.unique = msg.body[0];
          this.byName.set(client.unique, client);
        }
      }
      client.down.write(frame);
    }
  }

  /**
   * The file chooser, its version, and the Close of a request we opened.
   * Everything else addressed to the portal name goes to whoever owns it.
   */
  private intercepts(msg: Message): boolean {
    if (msg.destination !== PORTAL_NAME && (!this.ownerName || msg.destination !== this.ownerName)) return false;
    if (msg.path === PORTAL_PATH && msg.interface === CHOOSER) return true;
    if (msg.path === PORTAL_PATH && msg.interface === PROPERTIES && msg.body[0] === CHOOSER) return true;
    if (msg.interface === REQUEST && msg.member === 'Close' && msg.path && this.portal.has(msg.path)) return true;
    return false;
  }

  /* ---- Endpoint: our answers, written into the application's stream ---- */

  private inject(client: Client, msg: Omit<Message, 'serial'>): void {
    if (!client.open) return;
    client.down.write(encode({ ...msg, serial: this.serial++ }));
  }

  reply(to: Message, signature = '', body: unknown[] = []): void {
    if ((to.flags ?? 0) & NO_REPLY_EXPECTED) return;
    const client = to.sender ? this.byName.get(to.sender) : undefined;
    if (!client) return;
    this.inject(client, {
      type: METHOD_RETURN,
      replySerial: to.serial,
      destination: to.sender,
      sender: this.owner(),
      signature,
      body,
    });
  }

  replyError(to: Message, name: string, text: string): void {
    if ((to.flags ?? 0) & NO_REPLY_EXPECTED) return;
    const client = to.sender ? this.byName.get(to.sender) : undefined;
    if (!client) return;
    this.inject(client, {
      type: ERROR,
      replySerial: to.serial,
      destination: to.sender,
      sender: this.owner(),
      errorName: name,
      signature: 's',
      body: [text],
    });
  }

  /**
   * GTK subscribes to the Response with NO_MATCH_RULE and a sender of
   * `org.freedesktop.portal.Desktop`, which GDBus checks against that name's
   * current owner — so the signal carries the owner's unique name, whoever
   * that is on the real bus, and goes to the one connection that asked.
   */
  emitSignal(path: string, iface: string, member: string, signature: string, body: unknown[], destination?: string): void {
    const client = destination ? this.byName.get(destination) : undefined;
    if (!client) return;
    this.inject(client, { type: SIGNAL, path, interface: iface, member, signature, body, destination, sender: this.owner() });
  }

  pidOf(): Promise<number | null> {
    return Promise.resolve(null);
  }

  /** The browser answered a dialog. */
  respond(id: string, uris: string[] | null): void {
    this.portal.respond(id, uris);
  }

  /** A window came back: show it the dialogs still waiting. */
  redeliver(): void {
    this.portal.redeliver(this.target);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.close();
    for (const client of [...this.clients]) this.drop(client);
    this.portal.close();
    this.control.close();
    if ('path' in this.at) {
      try {
        fs.rmSync(this.at.path, { force: true });
        // The directory is snapd's once the snap has run; before that it is
        // only ours, and then it should not be left behind.
        fs.rmdirSync(path.dirname(this.at.path));
      } catch {
        // Gone already, or in use.
      }
    }
  }
}
