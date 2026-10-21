/**
 * Wire protocol shared by client and server.
 *
 * One WebSocket carries every conversation with the server. Two shapes ride on it:
 *
 *   1. Request/response  — a call to a named service method that returns once.
 *   2. Channels          — long-lived bidirectional streams (a PTY, a file watch,
 *                          a log tail). Opened by name, then fed with `data`.
 *
 * Control messages are JSON text frames. Channel payloads may *also* travel as
 * binary frames with a 5-byte header, which is how terminal traffic avoids
 * JSON-escaping every byte of output.
 *
 * Adding a capability to the desktop means adding a service on the server and
 * calling it from an app. Nothing here needs to change.
 */

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Client -> Server                                                    */
/* ------------------------------------------------------------------ */

export interface ReqMessage {
  t: 'req';
  /** Correlation id, unique per connection. */
  id: number;
  /** Service name, e.g. "fs". */
  svc: string;
  /** Method name, e.g. "list". */
  m: string;
  /** Arguments. */
  a?: unknown;
}

export interface OpenMessage {
  t: 'open';
  /** Channel id, allocated by the client. Also used as the binary-frame id. */
  id: number;
  svc: string;
  m: string;
  a?: unknown;
}

/** Payload for an open channel. Also expressible as a binary frame. */
export interface DataMessage {
  t: 'data';
  id: number;
  d: unknown;
}

/** Out-of-band control for a channel (resize, signal, ...) that isn't payload. */
export interface CtlMessage {
  t: 'ctl';
  id: number;
  m: string;
  a?: unknown;
}

export interface CloseMessage {
  t: 'close';
  id: number;
  /** Present when the close is due to an error. */
  e?: string;
}

export type ClientMessage =
  | ReqMessage
  | OpenMessage
  | DataMessage
  | CtlMessage
  | CloseMessage;

/* ------------------------------------------------------------------ */
/* Server -> Client                                                    */
/* ------------------------------------------------------------------ */

export interface ResMessage {
  t: 'res';
  id: number;
  ok: boolean;
  /** Result, when ok. */
  d?: unknown;
  /** Error, when not ok. */
  e?: WireError;
}

/** Confirms a channel is live and ready for data. */
export interface OpenedMessage {
  t: 'opened';
  id: number;
  /** Service-specific handshake info (pty pid, file size, ...). */
  d?: unknown;
}

/** Unsolicited server push, not tied to a request or channel. */
export interface EventMessage {
  t: 'ev';
  svc: string;
  e: string;
  d?: unknown;
}

/** Sent once on connect, before anything else. */
export interface HelloMessage {
  t: 'hello';
  v: number;
  /** Services this server exposes, and the methods each supports. */
  services: ServiceDescriptor[];
  /** Facts about the host, for the shell to display. */
  host: HostInfo;
}

export type ServerMessage =
  | ResMessage
  | OpenedMessage
  | DataMessage
  | EventMessage
  | CloseMessage
  | HelloMessage;

/* ------------------------------------------------------------------ */
/* Descriptors                                                         */
/* ------------------------------------------------------------------ */

export interface ServiceDescriptor {
  name: string;
  /** Request/response method names. */
  methods: string[];
  /** Channel-opening method names. */
  channels: string[];
}

/**
 * Which Finestra is running on a host. Carried per host rather than announced
 * once, because one shell drives several machines and they are updated one at
 * a time: the only way to answer "which version am I looking at" is to ask each
 * of them separately.
 */
export interface BuildInfo {
  /**
   * `0.2.0` from a release, `0.2.0+3.g1a2b3c4` when the build is past its tag,
   * `0.2.0+dev` from a source tree. Safe to show a person and to compare for
   * equality; deliberately not safe to sort.
   */
  version: string;
  /** ISO 8601, from the release manifest. Absent in a development build. */
  builtAt?: string;
  /** Running from a source tree rather than an installed release. */
  dev: boolean;
}

export interface HostInfo {
  hostname: string;
  platform: string;
  arch: string;
  user: string;
  home: string;
  /** Shells found on the host, first is the default. */
  shells: string[];
  /** The Finestra serving this connection. */
  build: BuildInfo;
}

export interface WireError {
  message: string;
  code?: string;
}

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

/**
 * The close code a session is given when the token it came in with was
 * changed by another desktop and that desktop chose not to keep it. Private
 * range, so no proxy or library will ever send it for a reason of its own;
 * the shell treats it as "do not reconnect, say why" rather than as an outage.
 */
export const CLOSE_REVOKED = 4401;

/** One open connection, as `auth.status` reports it. */
export interface AccessSession {
  id: string;
  /** The connection that asked. */
  self: boolean;
  /** Where the socket came from; always loopback through an SSH tunnel. */
  address: string | null;
  /** The browser, as it introduced itself. Null for the CLI and the relay. */
  userAgent: string | null;
  /** Epoch milliseconds. */
  since: number;
  /** Reached through a relay (`WD_DIAL`) rather than the listener. */
  viaRelay: boolean;
}

export interface AccessStatus {
  /** Whether a token is checked at all. False under WD_NO_AUTH and when dialling out. */
  enabled: boolean;
  /**
   * Where the token comes from, which decides whether it can be changed here.
   * `none` is WD_NO_AUTH; `relay` is a server that dials out, where nothing
   * listens and the relay decides who joins.
   */
  source: 'file' | 'env' | 'none' | 'relay';
  /** The token file, so Settings can say where the new one is also kept. */
  file: string;
  sessions: AccessSession[];
}

/* ------------------------------------------------------------------ */
/* Binary framing                                                      */
/* ------------------------------------------------------------------ */

/** Byte 0 of a binary frame: raw payload for the channel named in bytes 1..5. */
export const BIN_CHANNEL_DATA = 0x01;

/**
 * Byte 0 of a slice: one piece of a larger payload for the channel named in
 * bytes 1..5, and byte 5 is 1 on the last piece. A payload is sliced so that
 * everything else on the socket can get a word in between the pieces — a
 * half-megabyte window frame used to sit in front of every keystroke, every
 * terminal byte and the keepalive for as long as the link took to carry it.
 * Pieces of one channel arrive in order and never interleave with each
 * other; a reader concatenates them until the last.
 */
export const BIN_CHANNEL_SLICE = 0x02;

export const BIN_HEADER_BYTES = 5;
export const SLICE_HEADER_BYTES = 6;

/**
 * How much of a payload goes in one piece. Small enough that a terminal's
 * echo waits at most this long behind a picture on a link doing tens of
 * kilobytes a second; large enough that a frame on a fast link is a few dozen
 * messages rather than thousands.
 */
export const SLICE_BYTES = 16 * 1024;

export function encodeSlice(
  channelId: number,
  piece: Uint8Array,
  last: boolean,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(SLICE_HEADER_BYTES + piece.length));
  out[0] = BIN_CHANNEL_SLICE;
  out[1] = (channelId >>> 24) & 0xff;
  out[2] = (channelId >>> 16) & 0xff;
  out[3] = (channelId >>> 8) & 0xff;
  out[4] = channelId & 0xff;
  out[5] = last ? 1 : 0;
  out.set(piece, SLICE_HEADER_BYTES);
  return out;
}

/** Prefix `payload` with the 5-byte channel header. */
// Typed as a Uint8Array over a plain ArrayBuffer, not ArrayBufferLike: the
// browser's WebSocket.send refuses the wider type under TypeScript 7's lib.
export function encodeBinaryFrame(channelId: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(BIN_HEADER_BYTES + payload.length));
  out[0] = BIN_CHANNEL_DATA;
  // Big-endian channel id.
  out[1] = (channelId >>> 24) & 0xff;
  out[2] = (channelId >>> 16) & 0xff;
  out[3] = (channelId >>> 8) & 0xff;
  out[4] = channelId & 0xff;
  out.set(payload, BIN_HEADER_BYTES);
  return out;
}

export interface BinaryFrame {
  channelId: number;
  payload: Uint8Array;
  /** More of this payload follows; hold it and wait. */
  partial: boolean;
}

/** Returns null when the frame is too short or carries an unknown opcode. */
export function decodeBinaryFrame(buf: Uint8Array): BinaryFrame | null {
  if (buf.length < BIN_HEADER_BYTES) return null;
  const channelId = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
  if (buf[0] === BIN_CHANNEL_DATA) {
    return { channelId, payload: buf.subarray(BIN_HEADER_BYTES), partial: false };
  }
  if (buf[0] === BIN_CHANNEL_SLICE && buf.length >= SLICE_HEADER_BYTES) {
    return { channelId, payload: buf.subarray(SLICE_HEADER_BYTES), partial: buf[5] === 0 };
  }
  return null;
}

/**
 * Puts sliced payloads back together, per channel. Feed it every decoded
 * frame; it returns the whole payload when one is complete and null while
 * pieces are still arriving.
 */
export class SliceAssembler {
  private readonly held = new Map<number, Uint8Array[]>();

  push(frame: BinaryFrame): Uint8Array | null {
    const pieces = this.held.get(frame.channelId);
    if (frame.partial) {
      if (pieces) pieces.push(frame.payload);
      else this.held.set(frame.channelId, [frame.payload]);
      return null;
    }
    if (!pieces) return frame.payload;
    this.held.delete(frame.channelId);
    pieces.push(frame.payload);
    let length = 0;
    for (const p of pieces) length += p.length;
    const whole = new Uint8Array(length);
    let at = 0;
    for (const p of pieces) {
      whole.set(p, at);
      at += p.length;
    }
    return whole;
  }

  /** The channel is gone; whatever was held for it is waste. */
  forget(channelId: number): void {
    this.held.delete(channelId);
  }

  clear(): void {
    this.held.clear();
  }
}
