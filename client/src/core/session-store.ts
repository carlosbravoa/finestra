import type { Rect, SettingsStore, WindowState } from './types';

/** One reopenable window. Everything here must survive `JSON.stringify`. */
export interface WindowRecord {
  appId: string;
  /**
   * Which server it was running on. Absent in sessions saved before there was
   * more than one, which restore reads as the local server — the only thing
   * that existed when they were written.
   */
  host?: string;
  /** Handed back to the app as `params` on the next mount. */
  params: Record<string, unknown>;
  /** Geometry in the *normal* state, even if the window was maximized. */
  bounds: Rect;
  state: WindowState;
  title: string;
  focused: boolean;
}

interface StoredSession {
  version: number;
  savedAt: number;
  windows: WindowRecord[];
}

const STORAGE_KEY = 'session.windows';
const ENABLED_KEY = 'session.restore';
const VERSION = 1;

/** Beyond this, reopening is more likely to surprise than to help. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** A runaway save must not be able to fill the user's storage quota. */
const MAX_WINDOWS = 40;

/**
 * Remembers which windows were open so a reload puts them back.
 *
 * Only the window's identity, geometry and whatever the app volunteered from
 * `saveState()` are stored. Live things — a PTY, a socket, scrollback — are
 * gone by definition, so a restored app starts fresh and merely reopens in the
 * right place.
 */
export class SessionStore {
  constructor(private settings: SettingsStore) {}

  get enabled(): boolean {
    return this.settings.get(ENABLED_KEY, true);
  }

  setEnabled(enabled: boolean): void {
    this.settings.set(ENABLED_KEY, enabled);
    if (!enabled) this.clear();
  }

  save(windows: WindowRecord[]): void {
    if (!this.enabled) return;

    // Round-trip each record on its own, so one app returning something
    // unserialisable from saveState() cannot lose the whole session.
    const safe: WindowRecord[] = [];
    for (const record of windows.slice(0, MAX_WINDOWS)) {
      try {
        safe.push(JSON.parse(JSON.stringify(record)) as WindowRecord);
      } catch {
        console.warn(`Dropping unserialisable session state for "${record.appId}".`);
      }
    }

    const payload: StoredSession = { version: VERSION, savedAt: Date.now(), windows: safe };
    this.settings.set(STORAGE_KEY, payload);
  }

  /** Returns the windows to reopen, bottom of the stack first. */
  load(): WindowRecord[] {
    if (!this.enabled) return [];

    const stored = this.settings.get<StoredSession | null>(STORAGE_KEY, null);
    if (!stored || stored.version !== VERSION || !Array.isArray(stored.windows)) return [];
    if (Date.now() - (stored.savedAt ?? 0) > MAX_AGE_MS) {
      this.clear();
      return [];
    }
    return stored.windows.filter(isValidRecord);
  }

  clear(): void {
    this.settings.remove(STORAGE_KEY);
  }
}

/** Storage is user-editable and survives upgrades, so validate on the way in. */
function isValidRecord(record: unknown): record is WindowRecord {
  if (!record || typeof record !== 'object') return false;
  const r = record as Partial<WindowRecord>;
  return (
    typeof r.appId === 'string' &&
    r.appId.length > 0 &&
    isRect(r.bounds) &&
    (r.state === 'normal' || r.state === 'minimized' || r.state === 'maximized')
  );
}

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<Rect>;
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    (r.width as number) > 0 &&
    (r.height as number) > 0
  );
}
