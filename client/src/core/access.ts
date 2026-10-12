import type { AccessSession } from '../../../shared/protocol';

/**
 * The access token, on the browser's side of it.
 *
 * The page never holds the token after its first load. `?t=` is claimed from
 * the address bar, exchanged for an HttpOnly cookie, and from then on the
 * cookie is the credential: it rides the WebSocket upgrade, it rides every
 * fetch, and no script in the page — the shell's own or an app package's —
 * can read it back. That is what makes changing the token worth anything: a
 * package that could read the credential could just as well read the new one.
 *
 * So "adopting" a new token is one request with it in the query string, which
 * is how the server hands out cookies, and the socket is none the wiser.
 */

type Fetch = typeof fetch;

/** The link someone opens to get in. */
export function accessLink(origin: string, token: string): string {
  return `${origin}/?t=${encodeURIComponent(token)}`;
}

/** Swap the token in a websocket URL, which is how a remote host is reached. */
export function withToken(wsUrl: string, token: string): string {
  try {
    const url = new URL(wsUrl);
    url.searchParams.set('t', token);
    return url.toString();
  } catch {
    return wsUrl;
  }
}

/**
 * Exchange a token for the cookie that will carry this page from now on.
 * Resolves false when the server refused it or could not be reached, in which
 * case the page still has whatever cookie it had.
 */
export async function adoptAccessToken(token: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`/api/session?t=${encodeURIComponent(token)}`, {
      credentials: 'same-origin',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Whether the cookie this page holds still opens the door. A refused
 * WebSocket upgrade reaches the browser as a bare close event, the same as a
 * server that is down, and the difference decides between "retrying…" and
 * "you have been logged out" — so it is asked over HTTP, where a 401 is a 401.
 */
export async function probeAccess(fetchImpl: Fetch = fetch): Promise<'ok' | 'refused' | 'unreachable'> {
  try {
    const res = await fetchImpl('/api/session', { credentials: 'same-origin' });
    if (res.status === 401) return 'refused';
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** A browser's name out of the string it introduces itself with. */
export function browserName(userAgent: string | null): string {
  if (!userAgent) return 'Something that is not a browser';
  const ua = userAgent;
  // Order matters: every Chromium browser also says "Chrome" and "Safari",
  // and Chrome itself says "Safari".
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chromium\//.test(ua)) return 'Chromium';
  if (/HeadlessChrome\//.test(ua)) return 'Headless Chrome';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
  if (/^node|^undici|^curl|^Wget/i.test(ua)) return 'A script';
  return 'A browser';
}

/** "2 h ago", for a connection's age. */
export function ago(sinceMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** One line per connection, for the list in Settings. */
export function describeSession(
  session: AccessSession,
  nowMs = Date.now(),
): { title: string; detail: string } {
  const title = session.self ? 'This desktop' : browserName(session.userAgent);
  const where = session.viaRelay
    ? 'through the relay'
    : session.address
      ? `from ${session.address.replace(/^::ffff:/, '')}`
      : 'from somewhere';
  return { title, detail: `${where}, connected ${ago(session.since, nowMs)}` };
}
