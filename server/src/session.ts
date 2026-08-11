import { randomUUID } from 'node:crypto';
import { noteActivity } from './deadman.js';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  PROTOCOL_VERSION,
  type ClientMessage,
  type HostInfo,
  type ServerMessage,
  type ServiceDescriptor,
} from '../../shared/protocol.js';
import { ServiceError, type OpenedChannel, type Service } from './service.js';

/**
 * Every connection that is currently open.
 *
 * A session normally talks only to itself, and that is still true of every
 * request: this exists so one connection can *announce* something to the
 * others. There is exactly one caller — the `shell` service, carrying an
 * "open this" from a terminal to whichever browsers are showing a desktop —
 * and it is deliberately not a general message bus. Nothing here lets a
 * session read another's state or address one in particular.
 */
export const liveSessions = new Set<Session>();

/**
 * One browser connection. Owns the demultiplexing of requests and channels
 * onto the registered services, and guarantees every channel it opened is
 * closed when the socket goes away.
 */
export class Session {
  readonly id = randomUUID();
  private readonly channels = new Map<number, OpenedChannel>();
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly services: Map<string, Service>,
    private readonly config: Config,
    private readonly host: HostInfo,
  ) {
    ws.on('message', (data, isBinary) => {
      // The session's clock, when it has one, is fed from here — the only
      // place that knows the far side is still there.
      noteActivity();
      this.onMessage(data as Buffer, isBinary);
    });
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
    liveSessions.add(this);
    this.sendHello();
  }

  private sendHello(): void {
    const descriptors: ServiceDescriptor[] = [...this.services.values()].map((s) => ({
      name: s.name,
      methods: Object.keys(s.methods ?? {}),
      channels: Object.keys(s.channels ?? {}),
    }));
    this.send({ t: 'hello', v: PROTOCOL_VERSION, services: descriptors, host: this.host });
  }

  private send(msg: ServerMessage): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private sendBinary(channelId: number, payload: Uint8Array): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(encodeBinaryFrame(channelId, payload), { binary: true });
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const frame = decodeBinaryFrame(data);
      if (!frame) return;
      // Copy out of the shared read buffer: handlers may retain the bytes.
      this.channels.get(frame.channelId)?.onData?.(Uint8Array.from(frame.payload));
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString('utf8')) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.t) {
      case 'req':
        void this.handleRequest(msg.id, msg.svc, msg.m, msg.a);
        break;
      case 'open':
        void this.handleOpen(msg.id, msg.svc, msg.m, msg.a);
        break;
      case 'data':
        this.channels.get(msg.id)?.onData?.(msg.d);
        break;
      case 'ctl':
        this.channels.get(msg.id)?.onCtl?.(msg.m, msg.a);
        break;
      case 'close':
        this.closeChannel(msg.id);
        break;
    }
  }

  private async handleRequest(
    id: number,
    svcName: string,
    method: string,
    args: unknown,
  ): Promise<void> {
    try {
      const handler = this.services.get(svcName)?.methods?.[method];
      if (!handler) {
        throw new ServiceError(`No such method: ${svcName}.${method}`, 'ENOMETHOD');
      }
      const result = await handler(args, this.baseContext());
      this.send({ t: 'res', id, ok: true, d: result });
    } catch (err) {
      this.send({ t: 'res', id, ok: false, e: toWireError(err) });
    }
  }

  private async handleOpen(
    id: number,
    svcName: string,
    method: string,
    args: unknown,
  ): Promise<void> {
    if (this.channels.has(id)) {
      this.send({ t: 'close', id, e: 'Channel id already in use' });
      return;
    }
    try {
      const opener = this.services.get(svcName)?.channels?.[method];
      if (!opener) {
        throw new ServiceError(`No such channel: ${svcName}.${method}`, 'ENOCHANNEL');
      }
      // Reserve the id before awaiting so a racing open cannot claim it.
      const placeholder: OpenedChannel = {};
      this.channels.set(id, placeholder);

      const channel = await opener(args, {
        ...this.baseContext(),
        id,
        send: (d) => this.send({ t: 'data', id, d }),
        sendBinary: (d) => this.sendBinary(id, d),
        close: (e) => this.closeChannel(id, e),
      });

      // The socket may have dropped while the opener was awaiting.
      if (this.closed || this.channels.get(id) !== placeholder) {
        channel.onClose?.();
        return;
      }
      this.channels.set(id, channel);
      this.send({ t: 'opened', id, d: channel.info });
    } catch (err) {
      this.channels.delete(id);
      this.send({ t: 'close', id, e: toWireError(err).message });
    }
  }

  /** Idempotent: safe to call from the client, the service, or teardown. */
  private closeChannel(id: number, error?: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    this.channels.delete(id);
    try {
      channel.onClose?.();
    } catch {
      // A failing teardown must not take the session with it.
    }
    this.send({ t: 'close', id, e: error });
  }

  private baseContext() {
    return {
      config: this.config,
      sessionId: this.id,
      emit: (event: string, data?: unknown) => {
        this.send({ t: 'ev', svc: 'session', e: event, d: data });
      },
      announce: (svc: string, event: string, data?: unknown) =>
        this.announce(svc, event, data),
    };
  }

  /** Announce to every *other* live session. Returns how many were told. */
  announce(svc: string, event: string, data?: unknown): number {
    let told = 0;
    for (const session of liveSessions) {
      if (session === this || session.closed) continue;
      session.send({ t: 'ev', svc, e: event, d: data });
      told++;
    }
    return told;
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    liveSessions.delete(this);
    for (const id of [...this.channels.keys()]) this.closeChannel(id);
  }
}

function toWireError(err: unknown) {
  if (err instanceof ServiceError) return { message: err.message, code: err.code };
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return { message: err.message, code };
  }
  return { message: String(err) };
}
