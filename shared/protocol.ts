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

export interface HostInfo {
  hostname: string;
  platform: string;
  arch: string;
  user: string;
  home: string;
  /** Shells found on the host, first is the default. */
  shells: string[];
}

export interface WireError {
  message: string;
  code?: string;
}

/* ------------------------------------------------------------------ */
/* Binary framing                                                      */
/* ------------------------------------------------------------------ */

/** Byte 0 of a binary frame: raw payload for the channel named in bytes 1..5. */
export const BIN_CHANNEL_DATA = 0x01;

export const BIN_HEADER_BYTES = 5;

/** Prefix `payload` with the 5-byte channel header. */
export function encodeBinaryFrame(channelId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(BIN_HEADER_BYTES + payload.length);
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
}

/** Returns null when the frame is too short or carries an unknown opcode. */
export function decodeBinaryFrame(buf: Uint8Array): BinaryFrame | null {
  if (buf.length < BIN_HEADER_BYTES) return null;
  if (buf[0] !== BIN_CHANNEL_DATA) return null;
  const channelId = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];
  return { channelId: channelId >>> 0, payload: buf.subarray(BIN_HEADER_BYTES) };
}
