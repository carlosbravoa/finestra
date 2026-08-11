import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from './config.js';

export const TOKEN_COOKIE = 'wd_token';

/** Constant-time compare that also tolerates length mismatches. */
function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure is not obviously faster.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Pull a candidate token from the query string, a cookie, or a bearer header. */
export function extractToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const fromQuery = url.searchParams.get('t') ?? url.searchParams.get('token');
  if (fromQuery) return fromQuery;

  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);

  return parseCookies(req.headers.cookie)[TOKEN_COOKIE] ?? null;
}

export function isAuthorized(req: IncomingMessage, config: Config): boolean {
  if (config.authDisabled) return true;
  const token = extractToken(req);
  return token !== null && tokensMatch(token, config.token);
}

export function cookieHeader(token: string): string {
  // Not `Secure`, because the common case is plain HTTP on a private address
  // or behind an SSH tunnel; a TLS terminator in front can add it.
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
}
