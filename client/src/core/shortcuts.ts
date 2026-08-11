export interface ShortcutBinding {
  combo: string;
  description?: string;
}

export interface ShortcutRegistry {
  /**
   * Binds a global accelerator such as `Ctrl+Alt+T` or `Alt+Tab`.
   * Returns the function that unbinds it.
   */
  register(combo: string, handler: (ev: KeyboardEvent) => void, description?: string): () => void;
  list(): ShortcutBinding[];
}

interface Entry {
  handler: (ev: KeyboardEvent) => void;
  description?: string;
}

/**
 * Desktop-wide keyboard accelerators.
 *
 * These run in the capture phase so they beat app content — a terminal
 * swallows almost every keystroke otherwise. Only combos that include a
 * modifier are accepted, so plain typing is never intercepted.
 */
export class Shortcuts implements ShortcutRegistry {
  private bindings = new Map<string, Entry>();

  constructor(target: EventTarget = window) {
    target.addEventListener(
      'keydown',
      (ev) => this.dispatch(ev as KeyboardEvent),
      true,
    );
  }

  register(
    combo: string,
    handler: (ev: KeyboardEvent) => void,
    description?: string,
  ): () => void {
    const key = normalize(combo);
    if (!key.includes('+')) {
      throw new Error(`Shortcut "${combo}" needs at least one modifier`);
    }
    if (this.bindings.has(key)) {
      console.warn(`Shortcut "${combo}" is already bound; replacing it.`);
    }
    this.bindings.set(key, { handler, description });
    return () => {
      if (this.bindings.get(key)?.handler === handler) this.bindings.delete(key);
    };
  }

  list(): ShortcutBinding[] {
    return [...this.bindings.entries()].map(([combo, entry]) => ({
      combo: display(combo),
      description: entry.description,
    }));
  }

  private dispatch(ev: KeyboardEvent): void {
    const entry = this.bindings.get(comboFromEvent(ev));
    if (!entry) return;
    ev.preventDefault();
    ev.stopPropagation();
    entry.handler(ev);
  }
}

/** `Ctrl+Alt+T` -> `alt+ctrl+t`, so ordering and case never matter. */
function normalize(combo: string): string {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);

  const modifiers = parts.filter((p) => ['ctrl', 'alt', 'shift', 'meta'].includes(p)).sort();
  const keys = parts.filter((p) => !['ctrl', 'alt', 'shift', 'meta'].includes(p));
  return [...modifiers, ...keys].join('+');
}

function comboFromEvent(ev: KeyboardEvent): string {
  const parts: string[] = [];
  if (ev.altKey) parts.push('alt');
  if (ev.ctrlKey) parts.push('ctrl');
  if (ev.metaKey) parts.push('meta');
  if (ev.shiftKey) parts.push('shift');
  parts.sort();

  // `ev.key` is layout-aware but becomes "Dead"/"±" under some modifiers, so
  // fall back to the physical code when it is not a plain character.
  let key = ev.key.toLowerCase();
  if (key.length !== 1 && !NAMED_KEYS.has(key)) {
    key = ev.code.replace(/^(Key|Digit)/, '').toLowerCase();
  }
  parts.push(key);
  return parts.join('+');
}

const NAMED_KEYS = new Set([
  'tab', 'escape', 'enter', 'backspace', 'delete', 'home', 'end',
  'pageup', 'pagedown', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);

function display(normalized: string): string {
  return normalized
    .split('+')
    .map((p) => (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('+');
}
