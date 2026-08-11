import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  /** True when running under `npm run dev`, where Vite serves the client. */
  dev: boolean;
  /** Vite's port, so dev-mode hints and redirects point at the right place. */
  clientPort: number;
  /** Empty string means authentication is disabled. */
  token: string;
  authDisabled: boolean;
  /** When set, the fs service refuses to look outside this directory. */
  root: string | null;
  /** Directory the built client is served from, when it exists. */
  staticDir: string;
  /** Where the persisted token lives. */
  stateDir: string;
  /**
   * A relay to dial instead of listening. When set, nothing is accepted
   * inbound — the host opens the connection and a browser is joined to it at
   * the other end. See outbound.ts.
   */
  dial: string | null;
  /** Presented to the relay when dialling. Nothing verifies it yet. */
  dialTicket: string | null;
}

/**
 * Where the token and the persisted app state live.
 *
 * The unit carries only the parent (XDG_STATE_HOME) and this appends the leaf,
 * which makes the leaf a name the server and the installer have to agree on. So
 * a rename needs a fallback, or the ordering decides the outcome: a new binary
 * started under an older unit finds no directory under the new name, mints a
 * fresh token, and every bookmarked ?t= URL 401s with nothing in the log to say
 * why. Prefer the current name; use the previous one only when it is the one
 * that exists. Once the installer has run, `PREVIOUS` never matches again.
 */
const STATE_LEAF = 'finestra';
const PREVIOUS_STATE_LEAF = 'web-desktop';

/**
 * Exported so a read-only caller — the `finestra` command — can find the token
 * without `loadConfig()`, which *creates* one when it is missing. A CLI that
 * mints a token writes a second secret the server has never seen, and every
 * request it makes afterwards is refused for a reason nothing explains.
 */
export function stateDir(): string {
  const base =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const current = path.join(base, STATE_LEAF);
  if (fs.existsSync(current)) return current;
  const previous = path.join(base, PREVIOUS_STATE_LEAF);
  return fs.existsSync(previous) ? previous : current;
}

/**
 * The token is persisted so that restarting the server does not invalidate
 * every open tab and bookmarked URL. Deleting the file rotates it.
 */
function loadOrCreateToken(dir: string): string {
  const file = path.join(dir, 'token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    // Falls through to minting a new one.
  }
  const token = randomBytes(24).toString('base64url');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

/**
 * Find the built client. The compiled layout (server/dist/server/src) nests one
 * level deeper than the source layout, so rather than counting `..` segments we
 * walk up looking for the directory.
 */
function findStaticDir(): string {
  if (process.env.WD_STATIC) return path.resolve(process.env.WD_STATIC);

  const start = path.dirname(new URL(import.meta.url).pathname);
  const candidates: string[] = [];
  let dir = start;
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, 'client', 'dist'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(path.resolve(process.cwd(), 'client', 'dist'));

  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

export function loadConfig(): Config {
  const dir = stateDir();
  const authDisabled = process.env.WD_NO_AUTH === '1';
  const token = authDisabled ? '' : process.env.WD_TOKEN || loadOrCreateToken(dir);

  return {
    host: process.env.WD_HOST || '127.0.0.1',
    port: Number(process.env.WD_PORT || 7070),
    dev: process.env.WD_DEV === '1',
    clientPort: Number(process.env.WD_CLIENT_PORT || 5173),
    token,
    authDisabled,
    root: process.env.WD_ROOT ? path.resolve(process.env.WD_ROOT) : null,
    staticDir: findStaticDir(),
    stateDir: dir,
    dial: process.env.WD_DIAL || null,
    dialTicket: process.env.WD_DIAL_TICKET || null,
  };
}
