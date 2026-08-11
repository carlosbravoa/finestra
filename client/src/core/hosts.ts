import { Emitter } from './events';
import { RpcClient } from './rpc';
import type { ConnectionState, SettingsStore } from './types';
import type { HostInfo } from '../../../shared/protocol';

/**
 * More than one server, in one shell.
 *
 * The federation is deliberately on this side of the wire. A Finestra that
 * proxied to other Finestras would add a hop, a second trust boundary, and
 * a machine whose compromise is everyone's compromise; keeping one server per
 * box means the blast radius of a compromise stays that box. So the browser
 * holds N connections and the servers never learn about each other.
 *
 * A window belongs to one host for its whole life. There is no cross-host drag
 * and no shared state, which is what keeps this from turning into a distributed
 * system with all the reconciliation that implies.
 */

/** Where the page itself came from. Always present, never removable. */
export const LOCAL_HOST_ID = 'local';

export interface HostEntry {
  id: string;
  /** What the person calls it. Defaults to the hostname once connected. */
  label: string;
  /** The websocket URL, token included when one was given. */
  url: string;
  rpc: RpcClient;
  info: HostInfo | null;
  state: ConnectionState;
  /** The local host is the page's own server and cannot be removed. */
  readonly local: boolean;
}

/** What is persisted. Note the token — see the warning on `add`. */
interface StoredHost {
  id: string;
  label: string;
  url: string;
}

export interface HostEvents {
  /** Any change to the set, or to one host's state or identity. */
  changed: void;
}

const SETTINGS_KEY = 'hosts.remote';

export class HostRegistry {
  readonly events = new Emitter<HostEvents>();

  private hosts = new Map<string, HostEntry>();
  private sequence = 0;

  constructor(
    localUrl: string,
    private readonly settings: SettingsStore,
  ) {
    this.insert({
      id: LOCAL_HOST_ID,
      label: 'this server',
      url: localUrl,
      local: true,
    });

    for (const stored of this.settings.get<StoredHost[]>(SETTINGS_KEY, [])) {
      // A stored host that fails to parse must not take the shell down with it.
      if (!stored?.id || !stored?.url) continue;
      this.insert({ id: stored.id, label: stored.label || stored.url, url: stored.url, local: false });
    }
  }

  /** The local server first, then the rest in the order they were added. */
  all(): HostEntry[] {
    return [...this.hosts.values()];
  }

  get(id: string): HostEntry | null {
    return this.hosts.get(id) ?? null;
  }

  /** The one a window falls back to when its own host has gone away. */
  local(): HostEntry {
    return this.hosts.get(LOCAL_HOST_ID)!;
  }

  /** True while there is nothing to disambiguate, so the UI can stay quiet. */
  get isSingle(): boolean {
    return this.hosts.size <= 1;
  }

  /**
   * Adds a server and connects to it.
   *
   * The URL carries the token, because that is the only credential this
   * version has — which means it is persisted in browser storage, and anything
   * that can read that storage can reach every server in this list. That is a
   * real weakness and it is the reason per-user authentication is the next
   * security milestone; see fleet-desktop/docs/architecture.md.
   */
  add(url: string, label?: string): HostEntry {
    const id = `host-${++this.sequence}-${Date.now().toString(36)}`;
    const entry = this.insert({ id, label: label || hostLabelFor(url), url, local: false });
    this.persist();
    entry.rpc.connect();
    return entry;
  }

  remove(id: string): void {
    const entry = this.hosts.get(id);
    if (!entry || entry.local) return;
    entry.rpc.disconnect();
    this.hosts.delete(id);
    this.persist();
    this.events.emit('changed', undefined);
  }

  rename(id: string, label: string): void {
    const entry = this.hosts.get(id);
    if (!entry || !label.trim()) return;
    entry.label = label.trim();
    this.persist();
    this.events.emit('changed', undefined);
  }

  /** Connects everything that is not the local host, which main.ts owns. */
  connectRemotes(): void {
    for (const entry of this.hosts.values()) {
      if (!entry.local) entry.rpc.connect();
    }
  }

  private insert(base: Omit<HostEntry, 'rpc' | 'info' | 'state'>): HostEntry {
    const rpc = new RpcClient(base.url);
    const entry: HostEntry = { ...base, rpc, info: null, state: 'closed' };

    rpc.events.on('state', (state) => {
      entry.state = state;
      this.events.emit('changed', undefined);
    });
    rpc.events.on('hello', ({ host }) => {
      entry.info = host;
      // A host added by URL has a placeholder name until it says its own.
      if (!entry.local && looksLikeUrl(entry.label) && host.hostname) {
        entry.label = host.hostname;
        this.persist();
      }
      this.events.emit('changed', undefined);
    });

    this.hosts.set(entry.id, entry);
    this.events.emit('changed', undefined);
    return entry;
  }

  private persist(): void {
    const stored: StoredHost[] = this.all()
      .filter((h) => !h.local)
      .map((h) => ({ id: h.id, label: h.label, url: h.url }));
    this.settings.set(SETTINGS_KEY, stored);
  }
}

function looksLikeUrl(label: string): boolean {
  return /^wss?:\/\//.test(label);
}

/** A readable name from a URL, before the server has told us its hostname. */
export function hostLabelFor(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/**
 * Turns what someone types into a websocket URL.
 *
 * People paste the address they open in a browser — `http://box:7070/?t=abc`,
 * or just `box:7070`. Making them work out the websocket form of it is a
 * pointless obstacle, so accept all of it.
 */
export function toWebsocketUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  let candidate = raw;
  if (!/^[a-z]+:\/\//i.test(candidate)) candidate = `http://${candidate}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;

  const token = parsed.searchParams.get('t');
  const scheme = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${scheme}//${parsed.hostname}${port}/ws${token ? `?t=${encodeURIComponent(token)}` : ''}`;
}
