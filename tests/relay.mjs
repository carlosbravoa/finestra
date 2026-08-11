// A throwaway relay, for developing and testing the outbound mode against.
//
// It is deliberately the stupidest thing that can work: two WebSocket paths and
// a pipe between them. The host dials /host?session=<id>, a browser joins at
// /join?session=<id>, and every frame from either side is forwarded verbatim to
// the other. It authorizes nothing, stores nothing, and terminates no TLS.
//
// The real one is Milestone D and is a different animal — stateless, scaled
// out, and forwarding only sessions that carry a capability the center minted.
// Nothing here should be mistaken for it. What this proves is only that the
// protocol survives being relayed, which is the thing the host side needs to
// know before any of that exists.
//
//   node tests/relay.mjs [port]

import { WebSocketServer } from 'ws';

const PORT = Number(process.argv[2] || 7311);
const sessions = new Map(); // id -> { host, join }

const wss = new WebSocketServer({ port: PORT });

// The host announces itself the instant its socket opens — `Session` sends
// `hello` from its constructor — and that is well before a browser has joined.
// Something has to hold those first frames or the session starts with the
// client having missed the only message that describes it.
//
// This buffers, because it is the smallest thing that works. The real answer is
// probably the other one: the relay tells the host when a peer has attached, and
// the host builds its session then. That decision belongs with the relay's own
// design, not here — see fleet-desktop/docs/architecture.md.
const MAX_BUFFERED = 64;

const pair = (id) => {
  const s = sessions.get(id);
  if (!s?.host || !s?.join) return;

  const link = (from, to, label) => {
    from.on('message', (data, isBinary) => {
      if (to.readyState === to.OPEN) to.send(data, { binary: isBinary });
    });
    from.on('close', () => {
      // One side leaving ends the session; a half-open relay is worse than none.
      if (to.readyState === to.OPEN) to.close(1001, `${label} went away`);
      sessions.delete(id);
    });
    from.on('error', () => from.close());
  };

  // Anything the host said before the browser arrived, in order, first.
  for (const [data, isBinary] of s.buffered ?? []) {
    if (s.join.readyState === s.join.OPEN) s.join.send(data, { binary: isBinary });
  }
  if (s.buffered?.length) console.log(`relay: flushed ${s.buffered.length} buffered frame(s)`);
  s.buffered = null;
  s.host.removeAllListeners('message');

  link(s.host, s.join, 'host');
  link(s.join, s.host, 'browser');
  console.log(`relay: session ${id} joined`);
};

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = url.searchParams.get('session') ?? 'default';
  const role = url.pathname === '/host' ? 'host' : url.pathname === '/join' ? 'join' : null;

  if (!role) {
    ws.close(1008, 'use /host or /join');
    return;
  }

  const s = sessions.get(id) ?? {};
  if (s[role]) {
    ws.close(1008, `a ${role} is already connected for ${id}`);
    return;
  }
  s[role] = ws;
  sessions.set(id, s);
  console.log(`relay: ${role} connected for session ${id}` +
    (req.headers['x-wd-ticket'] ? ` (ticket ${String(req.headers['x-wd-ticket']).slice(0, 8)}…)` : ''));

  if (role === 'host') {
    s.buffered = [];
    ws.on('message', (data, isBinary) => {
      if (!s.buffered) return;              // paired already; link() has it
      if (s.buffered.length >= MAX_BUFFERED) return;
      s.buffered.push([Buffer.from(data), isBinary]);
    });
  }

  pair(id);
});

wss.on('listening', () => console.log(`relay: listening on ${PORT}`));
