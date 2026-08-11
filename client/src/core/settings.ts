import { Emitter } from './events';
import type { SettingsStore } from './types';

const PREFIX = 'wd:';

/**
 * Persisted preferences, currently backed by localStorage.
 *
 * Kept behind the `SettingsStore` interface so it can move to a server-side
 * store later — the desktop would then follow the user between browsers —
 * without any app having to change.
 */
export class LocalSettings implements SettingsStore {
  private events = new Emitter<Record<string, unknown>>();

  constructor() {
    // Keep multiple tabs of the same desktop in agreement.
    window.addEventListener('storage', (ev) => {
      if (!ev.key?.startsWith(PREFIX)) return;
      const key = ev.key.slice(PREFIX.length);
      this.events.emit(key, this.get(key, undefined));
    });
  }

  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt or unreadable: behave as if it was never set.
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (err) {
      // Private browsing or a full quota; the desktop still works, unsaved.
      console.warn(`Could not persist setting "${key}":`, err);
    }
    this.events.emit(key, value);
  }

  remove(key: string): void {
    localStorage.removeItem(PREFIX + key);
    this.events.emit(key, undefined);
  }

  watch<T>(key: string, fn: (value: T | undefined) => void): () => void {
    return this.events.on(key, fn as (value: unknown) => void);
  }
}
