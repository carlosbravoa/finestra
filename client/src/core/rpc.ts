import {
  CLOSE_REVOKED,
  decodeBinaryFrame,
  encodeBinaryFrame,
  SliceAssembler,
  type ClientMessage,
  type HostInfo,
  type ServerMessage,
  type ServiceDescriptor,
  type WireError,
} from '../../../shared/protocol';
import { Emitter } from './events';
import type { ConnectionState } from './types';

export class RpcError extends Error {
  code?: string;
  constructor(error: WireError) {
    super(error.message);
    this.name = 'RpcError';
    this.code = error.code;
  }
}

export interface ChannelHandlers {
  /** The server accepted the channel; `info` is its handshake payload. */
  onOpen?(info: unknown): void;
  /** A JSON payload arrived. */
  onData?(data: unknown): void;
  /** Raw bytes arrived, e.g. terminal output. */
  onBinary?(data: Uint8Array): void;
  /** The channel ended. `error` is set when it ended badly. */
  onClose?(error?: string): void;
}

export interface RpcEvents {
  state: ConnectionState;
  hello: { services: ServiceDescriptor[]; host: HostInfo };
  /** Unsolicited server push. */
  event: { svc: string; e: string; d: unknown };
  /** The socket closed, for any reason; fires before the state changes. */
  dropped: { code: number; reason: string };
  /**
   * The server will not have this connection back: its credential was
   * revoked. Reconnecting stops, and the reason is the one to show.
   */
  revoked: string;
}

/** A live stream to a server-side channel. */
export class Channel {
  private closed = false;

  constructor(
    readonly id: number,
    private readonly client: RpcClient,
    readonly handlers: ChannelHandlers,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  send(data: unknown): void {
    if (this.closed) return;
    this.client.sendMessage({ t: 'data', id: this.id, d: data });
  }

  /** Bypasses JSON entirely — the fast path for terminal input. */
  sendBinary(data: Uint8Array): void {
    if (this.closed) return;
    this.client.sendRaw(encodeBinaryFrame(this.id, data));
  }

  /** Out-of-band control that is not payload, e.g. a resize. */
  ctl(method: string, args?: unknown): void {
    if (this.closed) return;
    this.client.sendMessage({ t: 'ctl', id: this.id, m: method, a: args });
  }

  close(): void {
    if (this.closed) return;
    this.client.sendMessage({ t: 'close', id: this.id });
    this.markClosed();
  }

  /** @internal Called by the client when the server ends the channel. */
  markClosed(error?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.client.releaseChannel(this.id);
    this.handlers.onClose?.(error);
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

/**
 * The single connection to the server, multiplexing every request and stream.
 *
 * Reconnects on its own with backoff. Channels are *not* re-established across
 * a reconnect — only the app knows what a stream meant — so apps are told via
 * `onClose` and decide for themselves whether to reopen. The terminal reopens
 * onto the shell it had, which the server keeps for a while for exactly this.
 */
export class RpcClient {
  readonly events = new Emitter<RpcEvents>();
  private readonly slices = new SliceAssembler();
  services: ServiceDescriptor[] = [];
  host: HostInfo | null = null;
  state: ConnectionState = 'closed';

  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private channels = new Map<number, Channel>();
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private stopped = false;

  constructor(private url: string) {}

  /** Where the next connection goes — a token in the URL can change under us. */
  setUrl(url: string): void {
    this.url = url;
  }

  /** Resolves once the server's `hello` has arrived. */
  ready(): Promise<void> {
    if (this.state === 'open') return Promise.resolve();
    if (!this.readyPromise) {
      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
      });
    }
    return this.readyPromise;
  }

  connect(): void {
    this.stopped = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = (ev) => this.onDisconnect(ev.code, ev.reason);
    ws.onerror = () => {
      // `onclose` always follows, so recovery is handled in one place.
    };
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }

  /**
   * Give up for good and say why. The server does this with a close code
   * when it hangs up; the shell does it when a reconnect is refused outright,
   * because a refused upgrade reaches the browser as a plain close and would
   * otherwise be retried forever as if the server were merely down.
   */
  revoke(reason: string): void {
    this.disconnect();
    this.setState('closed');
    this.events.emit('revoked', reason);
  }

  /** Request/response. Rejects with an RpcError carrying the server's code. */
  call<T = unknown>(service: string, method: string, args?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.isOpen()) {
        reject(new RpcError({ message: 'Not connected to the server', code: 'EOFFLINE' }));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sendMessage({ t: 'req', id, svc: service, m: method, a: args });
    });
  }

  /**
   * Opens a stream. Returns immediately; `handlers.onOpen` fires when the
   * server confirms, and `handlers.onClose` fires if it refuses.
   */
  openChannel(
    service: string,
    method: string,
    args: unknown,
    handlers: ChannelHandlers,
  ): Channel {
    const id = this.nextId++;
    const channel = new Channel(id, this, handlers);

    if (!this.isOpen()) {
      // Report the failure asynchronously, so callers can wire up first.
      queueMicrotask(() => channel.markClosed('Not connected to the server'));
      return channel;
    }
    this.channels.set(id, channel);
    this.sendMessage({ t: 'open', id, svc: service, m: method, a: args });
    return channel;
  }

  /** True when the server advertised this service in its handshake. */
  hasService(name: string): boolean {
    return this.services.some((s) => s.name === name);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** @internal */
  sendMessage(msg: ClientMessage): void {
    if (!this.isOpen()) return;
    this.ws!.send(JSON.stringify(msg));
  }

  /** @internal */
  sendRaw(bytes: Uint8Array<ArrayBuffer>): void {
    if (!this.isOpen()) return;
    this.ws!.send(bytes);
  }

  /** @internal */
  releaseChannel(id: number): void {
    this.channels.delete(id);
    this.slices.forget(id);
  }

  private onMessage(ev: MessageEvent): void {
    if (ev.data instanceof ArrayBuffer) {
      const frame = decodeBinaryFrame(new Uint8Array(ev.data));
      if (!frame) return;
      // Receive credit: what the server may have in flight is what this
      // page has confirmed, so a slow link queues little in front of the
      // next keystroke. Upstream is the quiet direction, so this is cheap.
      if (frame.sliced) this.sendMessage({ t: 'took', n: ev.data.byteLength });
      // A large payload arrives in pieces, with everything else allowed in
      // between them; the channel sees it whole.
      const payload = this.slices.push(frame);
      if (payload) this.channels.get(frame.channelId)?.handlers.onBinary?.(payload);
      return;
    }

    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data as string) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.t) {
      case 'hello':
        this.services = msg.services;
        this.host = msg.host;
        this.attempt = 0;
        this.setState('open');
        this.events.emit('hello', { services: msg.services, host: msg.host });
        this.readyResolve?.();
        this.readyResolve = null;
        break;

      case 'res': {
        const pending = this.pending.get(msg.id);
        if (!pending) break;
        this.pending.delete(msg.id);
        if (msg.ok) pending.resolve(msg.d);
        else pending.reject(new RpcError(msg.e ?? { message: 'Request failed' }));
        break;
      }

      case 'opened':
        this.channels.get(msg.id)?.handlers.onOpen?.(msg.d);
        break;

      case 'data':
        this.channels.get(msg.id)?.handlers.onData?.(msg.d);
        break;

      case 'close':
        this.channels.get(msg.id)?.markClosed(msg.e);
        break;

      case 'ev':
        this.events.emit('event', { svc: msg.svc, e: msg.e, d: msg.d });
        break;
    }
  }

  private onDisconnect(code = 1006, why = ''): void {
    this.ws = null;
    this.events.emit('dropped', { code, reason: why });
    if (code === CLOSE_REVOKED) this.stopped = true;

    const reason = 'Connection to the server was lost';
    for (const pending of this.pending.values()) {
      pending.reject(new RpcError({ message: reason, code: 'EOFFLINE' }));
    }
    this.pending.clear();

    for (const channel of [...this.channels.values()]) channel.markClosed(reason);
    this.channels.clear();
    this.slices.clear();

    // A fresh `ready()` should wait for the next hello, not resolve instantly.
    this.readyPromise = null;
    this.readyResolve = null;

    if (this.stopped) {
      this.setState('closed');
      if (code === CLOSE_REVOKED) this.events.emit('revoked', why || 'The access token was changed');
      return;
    }

    this.setState('reconnecting');
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.attempt++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.emit('state', state);
  }
}
