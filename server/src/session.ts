import { randomUUID } from 'node:crypto';
import { noteActivity } from './deadman.js';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  encodeSlice,
  PROTOCOL_VERSION,
  SLICE_BYTES,
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
 * others. Two callers: the `shell` service, carrying an "open this" from a
 * terminal to whichever browsers are showing a desktop, and the `auth`
 * service, which has to tell every other desktop the token changed — or hang
 * up on them, which is the one thing a session may do to another. It is
 * deliberately not a general message bus: nothing here lets a session read
 * another's state, and what `auth` lists about the others is who they are,
 * never what they are doing.
 */
export const liveSessions = new Set<Session>();

/** What is known about the far end when the socket was accepted. */
export interface SessionPeer {
  address?: string | null;
  userAgent?: string | null;
  /** The connection came through a relay (`WD_DIAL`), not the listener. */
  viaRelay?: boolean;
}

/**
 * One browser connection. Owns the demultiplexing of requests and channels
 * onto the registered services, and guarantees every channel it opened is
 * closed when the socket goes away.
 */
export class Session {
  readonly id = randomUUID();
  readonly since = Date.now();
  readonly peer: SessionPeer;
  private readonly channels = new Map<number, OpenedChannel>();
  private closed = false;

  /**
   * When the far side last proved it was there: a message, a pong, or bytes
   * of ours it accepted. The last one matters most. A keepalive that only
   * counts pongs declares a slow link dead: the ping waits its turn behind
   * whatever is queued, and a browser on a bad Wi-Fi that was still taking
   * our frames at twenty kilobytes a second was cut off for not answering a
   * question that had not reached it yet.
   */
  private lastSeen = Date.now();
  private pinged = false;

  /**
   * Payloads too large to go out in one piece, waiting their turn. One piece
   * is in flight at a time, and the next goes only once the socket has taken
   * the last — so a JSON message sent meanwhile goes out between two pieces
   * rather than behind the whole payload. Within a channel the order holds:
   * once a channel has something queued, everything of its goes through the
   * queue, however small.
   */
  private readonly bulk: Array<{ id: number; payload: Uint8Array; at: number }> = [];
  private readonly bulkByChannel = new Map<number, number>();
  private pumping = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly services: Map<string, Service>,
    private readonly config: Config,
    private readonly host: HostInfo,
    peer: SessionPeer = {},
  ) {
    this.peer = peer;
    ws.on('message', (data, isBinary) => {
      // The session's clock, when it has one, is fed from here — the only
      // place that knows the far side is still there.
      noteActivity();
      this.seen();
      this.onMessage(data as Buffer, isBinary);
    });
    ws.on('pong', () => this.seen());
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
    if (payload.length <= SLICE_BYTES && !this.bulkByChannel.has(channelId)) {
      this.ws.send(encodeBinaryFrame(channelId, payload), { binary: true });
      return;
    }
    this.bulk.push({ id: channelId, payload, at: 0 });
    this.bulkByChannel.set(channelId, (this.bulkByChannel.get(channelId) ?? 0) + 1);
    this.pump();
  }

  private pump(): void {
    if (this.pumping) return;
    const head = this.bulk[0];
    if (!head) return;
    if (this.closed || this.ws.readyState !== this.ws.OPEN) {
      this.bulk.length = 0;
      this.bulkByChannel.clear();
      return;
    }
    const end = Math.min(head.at + SLICE_BYTES, head.payload.length);
    const last = end >= head.payload.length;
    this.pumping = true;
    // The callback fires once the socket has taken the bytes. On a link that
    // is slow but alive that is the throttle; on one that is gone it never
    // fires, the queue stands still, and tick() draws the conclusion.
    this.ws.send(encodeSlice(head.id, head.payload.subarray(head.at, end), last), { binary: true }, (err) => {
      this.pumping = false;
      if (err) return;
      this.seen();
      if (this.bulk[0] === head) {
        head.at = end;
        // A channel closed under its own payload: the rest is waste, and the
        // client has forgotten the pieces it already holds.
        if (last || !this.channels.has(head.id)) this.dequeue();
      }
      this.pump();
    });
  }

  private dequeue(): void {
    const head = this.bulk.shift();
    if (!head) return;
    const left = (this.bulkByChannel.get(head.id) ?? 1) - 1;
    if (left <= 0) this.bulkByChannel.delete(head.id);
    else this.bulkByChannel.set(head.id, left);
  }

  private seen(): void {
    this.lastSeen = Date.now();
    this.pinged = false;
  }

  /**
   * The liveness check, asked once per heartbeat interval. Nothing is asked
   * of a connection that has shown signs of life since the last tick; one
   * that has not is pinged, and one that has still shown none a tick later
   * is cut off. "Signs of life" include taking our bytes, so a connection
   * that is slow is never mistaken for one that is gone.
   */
  tick(intervalMs: number): void {
    if (this.closed) return;
    if (Date.now() - this.lastSeen < intervalMs) return;
    if (this.pinged) {
      this.ws.terminate();
      return;
    }
    this.pinged = true;
    try {
      this.ws.ping();
    } catch {
      // Closing under us; the close event finishes the job.
    }
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

      // The socket may have dropped while the opener was awaiting. That is a
      // lost connection, and the channel is told so: a terminal being picked
      // up must not be hung up because the reload raced its own handshake.
      if (this.closed || this.channels.get(id) !== placeholder) {
        channel.onClose?.(this.closed);
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
  private closeChannel(id: number, error?: string, lost = false): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    this.channels.delete(id);
    // Queued payloads for a channel that is gone: everything but the piece in
    // flight, which the pump drops when its callback comes back.
    for (let i = this.bulk.length - 1; i >= 1; i--) {
      if (this.bulk[i].id === id) {
        this.bulk.splice(i, 1);
        const left = (this.bulkByChannel.get(id) ?? 1) - 1;
        if (left <= 0) this.bulkByChannel.delete(id);
        else this.bulkByChannel.set(id, left);
      }
    }
    try {
      channel.onClose?.(lost);
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

  /** Push an event to this session alone. */
  tell(svc: string, event: string, data?: unknown): void {
    this.send({ t: 'ev', svc, e: event, d: data });
  }

  /**
   * Hang up, with a reason the browser can show. The socket's own close event
   * does the bookkeeping, so this is nothing more than the frame.
   */
  close(code: number, reason: string): void {
    if (this.closed) return;
    this.ws.close(code, reason);
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
    for (const id of [...this.channels.keys()]) this.closeChannel(id, undefined, true);
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
