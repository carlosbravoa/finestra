/**
 * A tiny typed event emitter. Every `on` returns its own unsubscribe function,
 * which is what lets windows and apps tear down cleanly without bookkeeping.
 */
export class Emitter<Events> {
  private listeners = new Map<keyof Events, Set<(payload: any) => void>>();

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  once<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    const off = this.on(event, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): void {
    this.listeners.get(event)?.delete(fn);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy first: a listener may unsubscribe itself or others while running.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`Listener for "${String(event)}" threw:`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** Collects teardown functions so a component can dispose of them together. */
export class Disposers {
  private fns: Array<() => void> = [];

  add(fn: () => void): void {
    this.fns.push(fn);
  }

  dispose(): void {
    // Reverse order, so teardown mirrors construction.
    for (const fn of this.fns.reverse()) {
      try {
        fn();
      } catch (err) {
        console.error('Disposer threw:', err);
      }
    }
    this.fns = [];
  }
}
