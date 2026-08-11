import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { cookieHeader, isAuthorized } from './auth.js';
import { loadConfig } from './config.js';
import { handleDownload, handleUpload, sendJson } from './transfer.js';
import { loadExtraServices } from './extra-services.js';
import { buildServiceMap } from './services/index.js';
import { hostInfo } from './services/sys.js';
import { readDeadmanEnv, startDeadman } from './deadman.js';
import { dialOut } from './outbound.js';
import { Session } from './session.js';

const config = loadConfig();
const serviceMap = buildServiceMap(await loadExtraServices());
const host = hostInfo();

for (const service of serviceMap.values()) {
  await service.init?.(config);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // A valid token in the query string is exchanged for a cookie, so the shell
  // can reconnect and open new tabs without carrying it in every URL.
  if (url.searchParams.has('t') && isAuthorized(req, config)) {
    res.setHeader('Set-Cookie', cookieHeader(config.token));
  }

  // Lets the client distinguish "wrong token" from "server is down" before it
  // opens a socket, since a failed WebSocket handshake hides the status code.
  if (url.pathname === '/api/session') {
    const ok = isAuthorized(req, config);
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok, host } : { ok, error: 'A valid token is required' }));
    return;
  }

  // Under `npm run dev` Vite serves the client and this port carries only the
  // API and the socket. Redirect navigations instead of quietly serving the
  // last production build, which looks like it works but ignores live edits.
  if (config.dev && url.pathname === '/') {
    const hostname = (req.headers.host ?? '').split(':')[0] || '127.0.0.1';
    // Carry an existing token through; never hand out one the caller lacked.
    const target = `http://${hostname}:${config.clientPort}/${url.search}`;
    res.writeHead(302, { location: target });
    res.end(`The dev client is served by Vite at ${target}\n`);
    return;
  }

  // File transfer rides HTTP so browsers handle progress and save-as natively.
  if (url.pathname === '/api/download' || url.pathname === '/api/upload') {
    if (!isAuthorized(req, config)) {
      sendJson(res, 401, { error: 'A valid token is required' });
      req.resume();
      return;
    }
    if (url.pathname === '/api/download' && req.method === 'GET') {
      handleDownload(url, res, config);
      return;
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      handleUpload(url, req, res, config);
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, host: host.hostname }));
    return;
  }

  serveStatic(url.pathname, res);
});

function serveStatic(pathname: string, res: http.ServerResponse): void {
  if (!fs.existsSync(config.staticDir)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      'The client has not been built yet.\n\n' +
        'Run `npm run dev` for the dev server, or `npm run build` then `npm start`.\n',
    );
    return;
  }

  const requested = path.join(config.staticDir, decodeURIComponent(pathname));
  const resolved = path.resolve(requested);
  // Never serve outside the build directory, whatever the URL says.
  const inRoot =
    resolved === config.staticDir || resolved.startsWith(config.staticDir + path.sep);

  // Unknown paths fall back to index.html so client-side routes work.
  const file =
    inRoot && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
      ? resolved
      : path.join(config.staticDir, 'index.html');

  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000',
  });
  fs.createReadStream(file).pipe(res);
}

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (!isAuthorized(req, config)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // With `noServer: true`, ws never emits 'connection' by itself, but it
    // does add the socket to `wss.clients`. Emitting it here is what keeps
    // the heartbeat below from treating every live connection as dead.
    wss.emit('connection', ws, req);
    new Session(ws, serviceMap, config, host);
  });
});

// Drop connections that stop answering, so dead tabs release their PTYs.
const HEARTBEAT_MS = Number(process.env.WD_HEARTBEAT_MS || 30_000);
const alive = new WeakSet<import('ws').WebSocket>();
wss.on('connection', (ws) => {
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

// Dialling out and listening are alternatives, not companions: the point of
// dialling is that nothing on this machine accepts an inbound connection, and
// keeping a port open alongside would give that away for nothing.
// A session opened by instruction carries its own deadline, and the deadline
// is enforced here rather than by whoever asked for the session.
startDeadman(readDeadmanEnv());

if (config.dial) {
  console.log(`\n  Finestra  ·  ${host.user}@${host.hostname} (${host.platform}/${host.arch})`);
  console.log(`  services     ${[...serviceMap.keys()].join(', ')}`);
  console.log(`  dialling     ${config.dial}  (not listening on any port)`);
  if (!config.dialTicket) {
    console.log('  \x1b[33mNo ticket. Nothing verifies who joins from the other side yet —\x1b[0m');
    console.log('  \x1b[33mthe relay is trusted entirely. Do not point this at the internet.\x1b[0m');
  }
  const outbound = dialOut({
    url: config.dial,
    ticket: config.dialTicket ?? undefined,
    config,
    services: serviceMap,
    host,
    onState: (state, detail) => console.log(`  relay        ${state}${detail ? `  ${detail}` : ''}`),
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log('\nShutting down.');
      outbound.stop();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
} else {
  server.listen(config.port, config.host, () => {
    const display = config.host === '0.0.0.0' ? host.hostname : config.host;
    // In dev the client lives on Vite's port, not this one.
    const clientBase = `http://${display}:${config.dev ? config.clientPort : config.port}`;

    console.log(`\n  Finestra  ·  ${host.user}@${host.hostname} (${host.platform}/${host.arch})`);
    console.log(`  listening    ${config.host}:${config.port}${config.dev ? '  (api + websocket only)' : ''}`);
    console.log(`  services     ${[...serviceMap.keys()].join(', ')}`);
    if (config.root) console.log(`  fs root      ${config.root} (confined)`);

    if (config.authDisabled) {
      console.log('\n  \x1b[41m\x1b[97m AUTH DISABLED \x1b[0m  anyone who can reach this port gets a shell.\n');
      console.log(`  open         ${clientBase}\n`);
    } else {
      console.log(`\n  \x1b[1mopen         ${clientBase}/?t=${config.token}\x1b[0m`);
      if (config.dev) {
        console.log(`               \x1b[2m↑ Vite dev server, with hot reload\x1b[0m`);
      }
      console.log(`  token file   ${path.join(config.stateDir, 'token')}  (delete to rotate)\n`);
    }
    if (config.host === '0.0.0.0') {
      console.log('  \x1b[33mBound to all interfaces. Put TLS in front of this before exposing it.\x1b[0m\n');
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log('\nShutting down.');
      for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
      server.close(() => process.exit(0));
      // Do not wait forever on a client that refuses to hang up.
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
