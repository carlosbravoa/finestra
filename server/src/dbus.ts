import net from 'node:net';
import { EventEmitter } from 'node:events';

/*
 * A D-Bus client small enough to own: the wire format, EXTERNAL auth, method
 * calls, replies, errors and signals. Nothing else.
 *
 * It exists because the portal needs a bus connection and the obvious
 * dependency (dbus-next) drags in node-gyp, request and event-stream, with a
 * critical advisory and no fix — for a protocol that is a few hundred lines
 * when you only need the parts a portal uses. Everything here is from the
 * D-Bus specification; the marshalling is driven by signature strings, so
 * adding a type is one row in a table.
 */

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

/** A value whose type travels with it: the `v` in `a{sv}`. */
export class Variant {
  constructor(
    public readonly signature: string,
    public readonly value: unknown,
  ) {}
}

/*
 * How each signature maps to a JavaScript value:
 *
 *   y n q i u    number           x t    bigint        b    boolean
 *   d            number           s o g  string        v    Variant
 *   ay           Uint8Array       a…     unknown[]     a{…} Map
 *   (…)          unknown[]
 */

const ALIGN: Record<string, number> = {
  y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, h: 4,
  s: 4, o: 4, g: 1, a: 4, '(': 8, '{': 8, v: 1,
};

/** The complete type starting at `at` in `sig`, e.g. `a{sv}` out of `a{sv}s`. */
export function completeType(sig: string, at = 0): string {
  const c = sig[at];
  if (c === 'a') return 'a' + completeType(sig, at + 1);
  if (c === '(' || c === '{') {
    let depth = 0;
    for (let i = at; i < sig.length; i++) {
      if (sig[i] === '(' || sig[i] === '{') depth++;
      else if (sig[i] === ')' || sig[i] === '}') depth--;
      if (depth === 0) return sig.slice(at, i + 1);
    }
    throw new Error(`unterminated container in signature ${sig}`);
  }
  if (c === undefined || !(c in ALIGN)) throw new Error(`bad signature ${sig} at ${at}`);
  return c;
}

/** Splits a signature into its complete types. */
export function splitSignature(sig: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < sig.length; ) {
    const t = completeType(sig, at);
    out.push(t);
    at += t.length;
  }
  return out;
}

class Writer {
  private buf = Buffer.alloc(256);
  pos = 0;

  private need(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }

  align(n: number): void {
    const padded = Math.ceil(this.pos / n) * n;
    this.need(padded - this.pos);
    this.pos = padded;
  }

  bytes(): Buffer {
    return this.buf.subarray(0, this.pos);
  }

  u32(v: number): void {
    this.align(4);
    this.need(4);
    this.buf.writeUInt32LE(v >>> 0, this.pos);
    this.pos += 4;
  }

  write(sig: string, value: unknown): void {
    const c = sig[0];
    switch (c) {
      case 'y':
        this.need(1);
        this.buf[this.pos++] = Number(value) & 0xff;
        return;
      case 'b':
        this.u32(value ? 1 : 0);
        return;
      case 'n':
      case 'q':
        this.align(2);
        this.need(2);
        if (c === 'n') this.buf.writeInt16LE(Number(value), this.pos);
        else this.buf.writeUInt16LE(Number(value), this.pos);
        this.pos += 2;
        return;
      case 'i':
        this.align(4);
        this.need(4);
        this.buf.writeInt32LE(Number(value), this.pos);
        this.pos += 4;
        return;
      case 'u':
      case 'h':
        this.u32(Number(value));
        return;
      case 'x':
      case 't':
        this.align(8);
        this.need(8);
        if (c === 'x') this.buf.writeBigInt64LE(BigInt(value as number), this.pos);
        else this.buf.writeBigUInt64LE(BigInt(value as number), this.pos);
        this.pos += 8;
        return;
      case 'd':
        this.align(8);
        this.need(8);
        this.buf.writeDoubleLE(Number(value), this.pos);
        this.pos += 8;
        return;
      case 's':
      case 'o': {
        const text = Buffer.from(String(value), 'utf8');
        this.u32(text.length);
        this.need(text.length + 1);
        text.copy(this.buf, this.pos);
        this.pos += text.length;
        this.buf[this.pos++] = 0;
        return;
      }
      case 'g': {
        const text = Buffer.from(String(value), 'utf8');
        this.need(text.length + 2);
        this.buf[this.pos++] = text.length;
        text.copy(this.buf, this.pos);
        this.pos += text.length;
        this.buf[this.pos++] = 0;
        return;
      }
      case 'v': {
        const v = value as Variant;
        this.write('g', v.signature);
        this.write(v.signature, v.value);
        return;
      }
      case 'a': {
        const elem = sig.slice(1);
        // The length counts bytes after the element alignment padding, so
        // it is written once the elements are, and the padding is not
        // included — the specification is explicit about this corner.
        this.u32(0);
        const lengthAt = this.pos - 4;
        this.align(ALIGN[elem[0]]);
        const start = this.pos;
        if (elem === 'y') {
          const bytes = value as Uint8Array;
          this.need(bytes.length);
          Buffer.from(bytes).copy(this.buf, this.pos);
          this.pos += bytes.length;
        } else if (elem[0] === '{') {
          const inner = splitSignature(elem.slice(1, -1));
          for (const [k, v] of value as Map<unknown, unknown>) {
            this.align(8);
            this.write(inner[0], k);
            this.write(inner[1], v);
          }
        } else {
          for (const item of value as unknown[]) this.write(elem, item);
        }
        this.buf.writeUInt32LE(this.pos - start, lengthAt);
        return;
      }
      case '(': {
        this.align(8);
        const inner = splitSignature(sig.slice(1, -1));
        const items = value as unknown[];
        inner.forEach((t, i) => this.write(t, items[i]));
        return;
      }
      default:
        throw new Error(`cannot marshal signature ${sig}`);
    }
  }
}

class Reader {
  pos = 0;

  constructor(
    private readonly buf: Buffer,
    private readonly le: boolean,
  ) {}

  align(n: number): void {
    this.pos = Math.ceil(this.pos / n) * n;
  }

  u32(): number {
    this.align(4);
    const v = this.le ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  read(sig: string): unknown {
    const c = sig[0];
    switch (c) {
      case 'y':
        return this.buf[this.pos++];
      case 'b':
        return this.u32() !== 0;
      case 'n':
      case 'q': {
        this.align(2);
        const v =
          c === 'n'
            ? this.le ? this.buf.readInt16LE(this.pos) : this.buf.readInt16BE(this.pos)
            : this.le ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos);
        this.pos += 2;
        return v;
      }
      case 'i': {
        this.align(4);
        const v = this.le ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos);
        this.pos += 4;
        return v;
      }
      case 'u':
      case 'h':
        return this.u32();
      case 'x':
      case 't': {
        this.align(8);
        const v =
          c === 'x'
            ? this.le ? this.buf.readBigInt64LE(this.pos) : this.buf.readBigInt64BE(this.pos)
            : this.le ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos);
        this.pos += 8;
        return v;
      }
      case 'd': {
        this.align(8);
        const v = this.le ? this.buf.readDoubleLE(this.pos) : this.buf.readDoubleBE(this.pos);
        this.pos += 8;
        return v;
      }
      case 's':
      case 'o': {
        const len = this.u32();
        const v = this.buf.toString('utf8', this.pos, this.pos + len);
        this.pos += len + 1;
        return v;
      }
      case 'g': {
        const len = this.buf[this.pos++];
        const v = this.buf.toString('utf8', this.pos, this.pos + len);
        this.pos += len + 1;
        return v;
      }
      case 'v': {
        const vsig = this.read('g') as string;
        return new Variant(vsig, this.read(vsig));
      }
      case 'a': {
        const elem = sig.slice(1);
        const len = this.u32();
        this.align(ALIGN[elem[0]]);
        const end = this.pos + len;
        if (elem === 'y') {
          const v = Uint8Array.from(this.buf.subarray(this.pos, end));
          this.pos = end;
          return v;
        }
        if (elem[0] === '{') {
          const inner = splitSignature(elem.slice(1, -1));
          const map = new Map<unknown, unknown>();
          while (this.pos < end) {
            this.align(8);
            const k = this.read(inner[0]);
            map.set(k, this.read(inner[1]));
          }
          return map;
        }
        const items: unknown[] = [];
        while (this.pos < end) items.push(this.read(elem));
        return items;
      }
      case '(': {
        this.align(8);
        return splitSignature(sig.slice(1, -1)).map((t) => this.read(t));
      }
      default:
        throw new Error(`cannot unmarshal signature ${sig}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

export const METHOD_CALL = 1;
export const METHOD_RETURN = 2;
export const ERROR = 3;
export const SIGNAL = 4;

const NO_REPLY_EXPECTED = 0x1;

export interface Message {
  type: number;
  serial: number;
  flags?: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature?: string;
  body: unknown[];
}

/* Header field codes, from the specification. */
const F_PATH = 1;
const F_INTERFACE = 2;
const F_MEMBER = 3;
const F_ERROR_NAME = 4;
const F_REPLY_SERIAL = 5;
const F_DESTINATION = 6;
const F_SENDER = 7;
const F_SIGNATURE = 8;

export function encode(msg: Message): Buffer {
  const bodyWriter = new Writer();
  const signature = msg.signature ?? '';
  const types = splitSignature(signature);
  types.forEach((t, i) => bodyWriter.write(t, msg.body[i]));
  const body = bodyWriter.bytes();

  const fields: Array<[number, Variant]> = [];
  if (msg.path) fields.push([F_PATH, new Variant('o', msg.path)]);
  if (msg.interface) fields.push([F_INTERFACE, new Variant('s', msg.interface)]);
  if (msg.member) fields.push([F_MEMBER, new Variant('s', msg.member)]);
  if (msg.errorName) fields.push([F_ERROR_NAME, new Variant('s', msg.errorName)]);
  if (msg.replySerial !== undefined) fields.push([F_REPLY_SERIAL, new Variant('u', msg.replySerial)]);
  if (msg.destination) fields.push([F_DESTINATION, new Variant('s', msg.destination)]);
  if (msg.sender) fields.push([F_SENDER, new Variant('s', msg.sender)]);
  if (signature) fields.push([F_SIGNATURE, new Variant('g', signature)]);

  const w = new Writer();
  w.write('y', 'l'.charCodeAt(0));
  w.write('y', msg.type);
  w.write('y', msg.flags ?? 0);
  w.write('y', 1);
  w.write('u', body.length);
  w.write('u', msg.serial);
  w.write('a(yv)', fields);
  w.align(8);
  return Buffer.concat([w.bytes(), body]);
}

/** One message off the front of `buf`, or null until there is a whole one. */
export function decode(buf: Buffer): { message: Message; length: number } | null {
  if (buf.length < 16) return null;
  const le = buf[0] === 'l'.charCodeAt(0);
  const bodyLength = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fieldsLength = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const headerLength = Math.ceil((16 + fieldsLength) / 8) * 8;
  const length = headerLength + bodyLength;
  if (buf.length < length) return null;

  const r = new Reader(buf, le);
  r.pos = 1;
  const type = r.read('y') as number;
  const flags = r.read('y') as number;
  r.pos = 8;
  const serial = r.u32();
  r.pos = 12;
  const fields = r.read('a(yv)') as Array<[number, Variant]>;

  const msg: Message = { type, flags, serial, body: [] };
  for (const [code, v] of fields) {
    switch (code) {
      case F_PATH: msg.path = v.value as string; break;
      case F_INTERFACE: msg.interface = v.value as string; break;
      case F_MEMBER: msg.member = v.value as string; break;
      case F_ERROR_NAME: msg.errorName = v.value as string; break;
      case F_REPLY_SERIAL: msg.replySerial = v.value as number; break;
      case F_DESTINATION: msg.destination = v.value as string; break;
      case F_SENDER: msg.sender = v.value as string; break;
      case F_SIGNATURE: msg.signature = v.value as string; break;
      default: break;
    }
  }
  if (msg.signature) {
    const br = new Reader(buf.subarray(headerLength, length), le);
    msg.body = splitSignature(msg.signature).map((t) => br.read(t));
  }
  return { message: msg, length };
}

/* ------------------------------------------------------------------ */
/* The connection                                                      */
/* ------------------------------------------------------------------ */

export class DBusError extends Error {
  constructor(
    public readonly name: string,
    message: string,
  ) {
    super(message);
  }
}

/** `unix:path=…` or `unix:abstract=…`; the only transports a session bus uses. */
function socketPath(address: string): string {
  for (const part of address.split(';')) {
    const m = /^unix:(.*)$/.exec(part);
    if (!m) continue;
    for (const kv of m[1].split(',')) {
      const [k, v] = kv.split('=');
      if (k === 'path') return decodeURIComponent(v);
      if (k === 'abstract') return `\0${decodeURIComponent(v)}`;
    }
  }
  throw new Error(`unsupported bus address: ${address}`);
}

export type MethodHandler = (msg: Message) => void;

/**
 * One connection. Method calls arriving for us go to `onMethodCall`; signals
 * to `onSignal`; replies resolve the promise of the call they answer.
 */
export class DBus extends EventEmitter {
  private serial = 1;
  private buffered: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve(m: Message): void; reject(e: Error): void }>();
  uniqueName = '';
  onMethodCall: MethodHandler | null = null;
  onSignal: ((msg: Message) => void) | null = null;

  private constructor(private readonly socket: net.Socket) {
    super();
  }

  static connect(address: string): Promise<DBus> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath(address));
      const bus = new DBus(socket);
      let authed = false;
      let line = '';
      const fail = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        const uid = process.getuid?.() ?? 0;
        socket.write(`\0AUTH EXTERNAL ${Buffer.from(String(uid)).toString('hex')}\r\n`);
      });
      socket.on('data', (chunk: Buffer) => {
        if (authed) {
          bus.feed(chunk);
          return;
        }
        line += chunk.toString('latin1');
        const end = line.indexOf('\r\n');
        if (end < 0) return;
        const answer = line.slice(0, end);
        const rest = line.slice(end + 2);
        if (!answer.startsWith('OK ')) {
          fail(new Error(`bus refused authentication: ${answer}`));
          return;
        }
        authed = true;
        socket.write('BEGIN\r\n');
        if (rest) bus.feed(Buffer.from(rest, 'latin1'));
        bus
          .call({
            destination: 'org.freedesktop.DBus',
            path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus',
            member: 'Hello',
          })
          .then((reply) => {
            bus.uniqueName = reply.body[0] as string;
            socket.off('error', fail);
            socket.on('error', (err) => bus.emit('error', err));
            socket.on('close', () => {
              for (const p of bus.pending.values()) p.reject(new Error('bus connection closed'));
              bus.pending.clear();
              bus.emit('close');
            });
            resolve(bus);
          }, fail);
      });
    });
  }

  private feed(chunk: Buffer): void {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    for (;;) {
      let got: { message: Message; length: number } | null;
      try {
        got = decode(this.buffered);
      } catch (err) {
        this.emit('error', err);
        this.socket.destroy();
        return;
      }
      if (!got) return;
      this.buffered = this.buffered.subarray(got.length);
      this.dispatch(got.message);
    }
  }

  private dispatch(msg: Message): void {
    if (msg.type === METHOD_RETURN || msg.type === ERROR) {
      const p = msg.replySerial !== undefined ? this.pending.get(msg.replySerial) : undefined;
      if (!p) return;
      this.pending.delete(msg.replySerial!);
      if (msg.type === ERROR) {
        p.reject(new DBusError(msg.errorName ?? 'org.freedesktop.DBus.Error.Failed', String(msg.body[0] ?? '')));
      } else p.resolve(msg);
      return;
    }
    if (msg.type === SIGNAL) {
      this.onSignal?.(msg);
      return;
    }
    if (msg.type === METHOD_CALL) {
      if (this.onMethodCall) this.onMethodCall(msg);
      else this.replyError(msg, 'org.freedesktop.DBus.Error.UnknownMethod', 'No such method');
    }
  }

  send(msg: Omit<Message, 'serial'> & { serial?: number }): number {
    const serial = msg.serial ?? this.serial++;
    this.socket.write(encode({ ...msg, serial }));
    return serial;
  }

  call(msg: {
    destination: string;
    path: string;
    interface: string;
    member: string;
    signature?: string;
    body?: unknown[];
  }): Promise<Message> {
    return new Promise((resolve, reject) => {
      const serial = this.serial++;
      this.pending.set(serial, { resolve, reject });
      this.socket.write(encode({ type: METHOD_CALL, serial, body: [], ...msg }));
    });
  }

  reply(to: Message, signature = '', body: unknown[] = []): void {
    if ((to.flags ?? 0) & NO_REPLY_EXPECTED) return;
    this.send({
      type: METHOD_RETURN,
      replySerial: to.serial,
      destination: to.sender,
      signature,
      body,
    });
  }

  replyError(to: Message, name: string, text: string): void {
    if ((to.flags ?? 0) & NO_REPLY_EXPECTED) return;
    this.send({
      type: ERROR,
      replySerial: to.serial,
      destination: to.sender,
      errorName: name,
      signature: 's',
      body: [text],
    });
  }

  /**
   * With a destination the signal is unicast: delivered to that connection
   * whether or not it holds a match rule. Without one it is a broadcast and
   * reaches only connections that asked for it with AddMatch.
   */
  emitSignal(
    path: string,
    iface: string,
    member: string,
    signature = '',
    body: unknown[] = [],
    destination?: string,
  ): void {
    this.send({ type: SIGNAL, path, interface: iface, member, signature, body, destination });
  }

  /** 1 = primary owner, 2 = queued, 3 = exists, 4 = already owner. */
  async requestName(name: string, flags = 0): Promise<number> {
    const reply = await this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'RequestName',
      signature: 'su',
      body: [name, flags],
    });
    return reply.body[0] as number;
  }

  async addMatch(rule: string): Promise<void> {
    await this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'AddMatch',
      signature: 's',
      body: [rule],
    });
  }

  /** The pid behind a unique name, or null if the bus will not say. */
  async pidOf(name: string): Promise<number | null> {
    try {
      const reply = await this.call({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'GetConnectionUnixProcessID',
        signature: 's',
        body: [name],
      });
      return reply.body[0] as number;
    } catch {
      return null;
    }
  }

  close(): void {
    this.socket.destroy();
  }
}
