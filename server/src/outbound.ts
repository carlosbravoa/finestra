import { WebSocket } from 'ws';
import type { HostInfo } from '../../shared/protocol.js';
import type { Config } from './config.js';
import type { Service } from './service.js';
import { Session } from './session.js';

/**
 * Dialling out instead of listening.
 *
 * A server that listens has to be reachable, which means a port open on a
 * machine whose whole job is to have as little exposed as possible — and it
 * does not work at all behind NAT. The alternative is to reverse the
 * direction: the host opens the connection, a relay joins it to whichever
 * browser has been authorized to reach it, and nothing on the host ever
 * accepts an inbound connection.
 *
 * That this costs almost nothing is a happy accident of how `Session` was
 * already written: it takes anything with `on()` and `send()`, and the `ws`
 * client satisfies that exactly as the server side does. So the same session,
 * the same services and the same protocol run over a socket pointing the other
 * way, and neither the client nor any service knows the difference.
 *
 * See fleet-desktop/docs/architecture.md. What is deliberately *not* here yet:
 * the ticket is passed along but nothing verifies it, because what mints it —
 * the center — does not exist. Until it does, this is reachability only, and
 * the relay must be trusted. `WD_DIAL` is therefore not something to point at
 * the public internet yet.
 */

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const PING_MS = 30_000;

export interface OutboundOptions {
  url: string;
  ticket?: string;
  config: Config;
  services: Map<string, Service>;
  host: HostInfo;
  /** Called on every state change, so the caller owns how it is reported. */
  onState?: (state: 'connecting' | 'connected' | 'closed', detail?: string) => void;
}

export function dialOut(opts: OutboundOptions): { stop: () => void } {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retry = RETRY_MIN_MS;
  let timer: NodeJS.Timeout | undefined;

  const connect = () => {
    if (stopped) return;
    opts.onState?.('connecting', opts.url);

    const ws = new WebSocket(opts.url, {
      headers: opts.ticket ? { 'x-wd-ticket': opts.ticket } : undefined,
      handshakeTimeout: 15_000,
    });
    socket = ws;

    // The relay is the only thing that can tell us the far end went away, so
    // keep the connection provably alive rather than trusting it.
    let alive = true;
    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_MS);
    ping.unref();
    ws.on('pong', () => {
      alive = true;
    });

    ws.on('open', () => {
      retry = RETRY_MIN_MS;
      opts.onState?.('connected', opts.url);
      // From here it is an ordinary session. Nothing below this line knows
      // which way the connection was opened.
      new Session(ws, opts.services, opts.config, opts.host);
    });

    const reconnect = (why: string) => {
      clearInterval(ping);
      if (stopped) return;
      opts.onState?.('closed', why);
      // Deliberately not unref'd. Between losing the relay and reconnecting
      // there may be nothing else holding the event loop open, and an unref'd
      // timer would let the process exit quietly instead of coming back — a
      // host that disappears the first time its relay restarts.
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, RETRY_MAX_MS);
    };

    ws.on('close', (code) => reconnect(`closed (${code})`));
    ws.on('error', (err) => reconnect(err.message));
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close(1001, 'shutting down');
    },
  };
}
