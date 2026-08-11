import type { AppManifest, FileAssociation, FileRef, SettingsStore } from './types';

/**
 * Deciding which app opens a file.
 *
 * Apps declare what they handle in `AppManifest.handles`. A match is scored so
 * that the most specific claim wins: an exact filename beats an extension,
 * a longer extension beats a shorter one (`.tar.gz` over `.gz`), and a
 * `fallback` app only wins when nothing else claims the file at all.
 *
 * A user's explicit choice overrides all of it.
 */

const SCORE_NAME = 400;
const SCORE_EXTENSION = 200;
const SCORE_PREDICATE = 100;
const SCORE_FALLBACK = 1;

const OVERRIDES_KEY = 'associations.defaults';

export interface HandlerMatch {
  app: AppManifest;
  association: FileAssociation;
  score: number;
  /** 'Edit', 'View', … for display in an Open with menu. */
  verb: string;
}

/** The basename, for building a FileRef from a bare path. */
export function fileRefFor(path: string): FileRef {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  return { name, path };
}

/**
 * Every dotted suffix of a filename, shortest last: `archive.tar.gz` yields
 * `['.tar.gz', '.gz']`. A leading dot is skipped, so `.bashrc` has no
 * extension — it is a name, not a type.
 */
export function suffixesOf(name: string): string[] {
  const lower = name.toLowerCase();
  const out: string[] = [];
  let index = lower.indexOf('.', lower.startsWith('.') ? 1 : 0);
  while (index !== -1) {
    out.push(lower.slice(index));
    index = lower.indexOf('.', index + 1);
  }
  return out;
}

/**
 * The key a user's "always open with" choice is stored under: the longest
 * extension, or the exact filename when there is none. Returns null for
 * anything too generic to remember a choice for.
 */
export function associationKeyFor(file: FileRef): string | null {
  const suffixes = suffixesOf(file.name);
  if (suffixes.length > 0) return suffixes[0];
  return file.name.length > 0 ? `name:${file.name}` : null;
}

function scoreAssociation(association: FileAssociation, file: FileRef): number | null {
  const priority = association.priority ?? 0;

  if (association.names?.some((n) => n === file.name)) {
    return SCORE_NAME + priority;
  }

  if (association.extensions?.length) {
    // Longest matching suffix wins, so `.tar.gz` outranks `.gz`.
    const wanted = new Set(association.extensions.map((e) => e.toLowerCase()));
    let best: string | null = null;
    for (const suffix of suffixesOf(file.name)) {
      if (wanted.has(suffix) && (!best || suffix.length > best.length)) best = suffix;
    }
    if (best) return SCORE_EXTENSION + best.length + priority;
  }

  try {
    if (association.matches?.(file)) return SCORE_PREDICATE + priority;
  } catch {
    // A throwing predicate must not break resolution for every other app.
  }

  if (association.fallback) return SCORE_FALLBACK + priority;

  return null;
}

/** Every app that claims this file, best match first. */
export function handlersFor(apps: AppManifest[], file: FileRef): HandlerMatch[] {
  const matches: HandlerMatch[] = [];

  for (const app of apps) {
    if (!app.handles?.length) continue;

    // An app may declare several claims; keep only its strongest.
    let best: HandlerMatch | null = null;
    for (const association of app.handles) {
      const score = scoreAssociation(association, file);
      if (score === null) continue;
      if (!best || score > best.score) {
        best = { app, association, score, verb: association.verb ?? 'Open' };
      }
    }
    if (best) matches.push(best);
  }

  return matches.sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name));
}

/** Persisted "always open this kind of file with…" choices. */
export class AssociationOverrides {
  constructor(private settings: SettingsStore) {}

  private all(): Record<string, string> {
    return this.settings.get<Record<string, string>>(OVERRIDES_KEY, {});
  }

  get(file: FileRef): string | undefined {
    const key = associationKeyFor(file);
    return key ? this.all()[key] : undefined;
  }

  set(file: FileRef, appId: string): void {
    const key = associationKeyFor(file);
    if (!key) return;
    this.settings.set(OVERRIDES_KEY, { ...this.all(), [key]: appId });
  }

  clear(file: FileRef): void {
    const key = associationKeyFor(file);
    if (!key) return;
    const next = { ...this.all() };
    delete next[key];
    this.settings.set(OVERRIDES_KEY, next);
  }
}

/**
 * The app that should open this file: the user's choice if they made one and
 * that app is still installed, otherwise the best-scoring handler.
 */
export function resolveHandler(
  apps: AppManifest[],
  file: FileRef,
  overrides: AssociationOverrides,
): AppManifest | null {
  const chosenId = overrides.get(file);
  if (chosenId) {
    const chosen = apps.find((a) => a.id === chosenId);
    // A stale override for an uninstalled app falls through to scoring.
    if (chosen) return chosen;
  }
  return handlersFor(apps, file)[0]?.app ?? null;
}
