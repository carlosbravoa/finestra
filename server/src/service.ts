import type { Config } from './config.js';

/**
 * A service is a named bundle of capabilities the desktop can call over the
 * socket. Everything the browser is allowed to do to this machine enters
 * through one, which makes this the place to look when auditing reach.
 *
 * `methods` are request/response. `channels` are long-lived streams.
 * Register new ones in services/index.ts; the client discovers them from the
 * `hello` message and needs no matching change to talk to them.
 */
export interface Service {
  name: string;
  methods?: Record<string, MethodHandler>;
  channels?: Record<string, ChannelOpener>;
  /** Called once when the process starts. */
  init?(config: Config): void | Promise<void>;
}

export type MethodHandler = (args: any, ctx: ServiceContext) => unknown | Promise<unknown>;

export type ChannelOpener = (
  args: any,
  ctx: ChannelContext,
) => OpenedChannel | Promise<OpenedChannel>;

export interface ServiceContext {
  config: Config;
  /** Stable id of the browser connection. */
  sessionId: string;
  /** Push an unsolicited event to this client. */
  emit(event: string, data?: unknown): void;
  /**
   * Push an event to every *other* live connection, and say how many heard it.
   *
   * The one thing that crosses between connections, and it exists for one
   * reason: a command typed in a terminal has no window of its own, so it has
   * to ask the desktops that do. It cannot address a particular session and
   * carries no reply.
   */
  announce(service: string, event: string, data?: unknown): number;
}

export interface ChannelContext extends ServiceContext {
  /** Channel id, chosen by the client. */
  id: number;
  /** Send a JSON payload to the client. */
  send(data: unknown): void;
  /** Send raw bytes to the client, without JSON escaping. */
  sendBinary(data: Uint8Array): void;
  /** Tear the channel down and tell the client why. */
  close(error?: string): void;
}

/** What a channel opener returns: the handshake plus the live handlers. */
export interface OpenedChannel {
  /** Delivered to the client in the `opened` message. */
  info?: unknown;
  /** Client sent a payload. Binary frames arrive as Uint8Array. */
  onData?(data: unknown): void;
  /** Client sent out-of-band control, e.g. a terminal resize. */
  onCtl?(method: string, args: unknown): void;
  /** The channel is going away, for any reason. Always runs exactly once. */
  onClose?(): void;
}

/** Thrown by services to send a specific error code to the client. */
export class ServiceError extends Error {
  code: string;
  constructor(message: string, code = 'ERR') {
    super(message);
    this.code = code;
  }
}
