import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { ServiceError, type Service } from '../service.js';
import { isInside } from '../paths.js';
import type {
  InstalledApp,
  PackageAssociation,
  PackageManifest,
} from '../../../shared/protocol.js';

/**
 * Which apps are enabled, and which app packages are installed —
 * Stages 1 and 2 of docs/app-installation.md.
 *
 * Enabled state is persisted here rather than in localStorage because "which
 * apps this machine offers" is a property of the machine, not of one browser
 * profile. The same reasoning puts packages under the state directory: it is
 * the one place packaging knows how to create, migrate and keep across an
 * update, so a package dropped there survives everything the token does.
 *
 * A package is a directory holding `app.json` and the files it names. The
 * server reads the manifest and hands the files over; it never executes any of
 * it. The browser gets the code over this same socket rather than a static
 * route, because the static route is unauthenticated, does not exist at all
 * when the server dials out (WD_DIAL), and would be one more place to get path
 * handling right. See docs/app-packages.md for the format.
 */

const PACKAGES_LEAF = 'apps';
const MANIFEST_FILE = 'app.json';
/** A bare name: letters, digits and hyphens, nothing a path could be made of. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Same cap as a single `fs.read`; an app bundle is a fraction of this. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

let disabled = new Set<string>();
let file = '';
let packagesDir = '';

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ disabled: [...disabled].sort() }, null, 2) + '\n');
  } catch (err) {
    console.warn('Could not persist app state:', (err as Error).message);
  }
}

/* ------------------------------------------------------------------ */
/* Manifest validation                                                 */
/* ------------------------------------------------------------------ */

/**
 * `app.json` is written by people, so every refusal names the field. An
 * `Error` here becomes the package's `error` in the listing, which is what
 * Settings shows — the only place the author will look.
 */
function fail(field: string, what: string): never {
  throw new Error(`${field}: ${what}`);
}

function bareFilename(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) fail(field, 'is required');
    return undefined;
  }
  if (typeof value !== 'string' || value === '') fail(field, 'must be a filename');
  if (value !== path.basename(value) || value === '.' || value === '..') {
    fail(field, 'must be a bare filename inside the package, not a path');
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(field, 'must be a string');
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(field, 'must be true or false');
  return value;
}

function optionalSize(value: unknown, field: string): PackageManifest['defaultSize'] {
  if (value === undefined) return undefined;
  const size = value as { width?: unknown; height?: unknown } | null;
  if (
    !size ||
    typeof size !== 'object' ||
    typeof size.width !== 'number' ||
    typeof size.height !== 'number' ||
    !(size.width > 0 && size.height > 0)
  ) {
    fail(field, 'must be { "width": n, "height": n } with both positive');
  }
  return { width: size.width, height: size.height };
}

function optionalStrings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    fail(field, 'must be an array of strings');
  }
  return value as string[];
}

function optionalHandles(value: unknown): PackageAssociation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('handles', 'must be an array');
  return value.map((raw, i) => {
    const field = `handles[${i}]`;
    if (!raw || typeof raw !== 'object') fail(field, 'must be an object');
    const entry = raw as Record<string, unknown>;
    const out: PackageAssociation = {};
    const extensions = optionalStrings(entry.extensions, `${field}.extensions`);
    const names = optionalStrings(entry.names, `${field}.names`);
    if (extensions) out.extensions = extensions;
    if (names) out.names = names;
    const fallback = optionalBoolean(entry.fallback, `${field}.fallback`);
    if (fallback !== undefined) out.fallback = fallback;
    const verb = optionalString(entry.verb, `${field}.verb`);
    if (verb !== undefined) out.verb = verb;
    if (entry.priority !== undefined) {
      if (typeof entry.priority !== 'number') fail(`${field}.priority`, 'must be a number');
      out.priority = entry.priority;
    }
    if (!out.extensions?.length && !out.names?.length && !out.fallback) {
      fail(field, 'claims nothing — give it extensions, names, or fallback');
    }
    return out;
  });
}

/** Checks a parsed `app.json` against the directory it was found in. */
export function validateManifest(raw: unknown, dirName: string, dir: string): PackageManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(MANIFEST_FILE, 'must be an object');
  const m = raw as Record<string, unknown>;

  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) {
    fail('id', 'must be lower-case letters, digits and hyphens');
  }
  if (m.id !== dirName) fail('id', `is "${m.id}" but the directory is "${dirName}"`);
  if (typeof m.name !== 'string' || m.name.trim() === '') fail('name', 'is required');
  if (typeof m.version !== 'string' || m.version.trim() === '') fail('version', 'is required');
  if (typeof m.apiVersion !== 'number' || !Number.isInteger(m.apiVersion) || m.apiVersion < 1) {
    fail('apiVersion', 'must be a positive integer');
  }

  const entry = bareFilename(m.entry, 'entry', true)!;
  const style = bareFilename(m.style, 'style', false);
  for (const [field, name] of [['entry', entry], ['style', style]] as const) {
    if (name && !fs.existsSync(path.join(dir, name))) fail(field, `names ${name}, which is not in the package`);
  }

  const manifest: PackageManifest = {
    id: m.id,
    name: m.name,
    version: m.version,
    apiVersion: m.apiVersion,
    entry,
  };
  if (style) manifest.style = style;

  const icon = optionalString(m.icon, 'icon');
  if (icon !== undefined) manifest.icon = icon;
  const description = optionalString(m.description, 'description');
  if (description !== undefined) manifest.description = description;
  const category = optionalString(m.category, 'category');
  if (category !== undefined) manifest.category = category;

  for (const field of [
    'singleton',
    'showOnDesktop',
    'showInLauncher',
    'restorable',
    'resizable',
    'startMaximized',
  ] as const) {
    const value = optionalBoolean(m[field], field);
    if (value !== undefined) manifest[field] = value;
  }
  const defaultSize = optionalSize(m.defaultSize, 'defaultSize');
  if (defaultSize) manifest.defaultSize = defaultSize;
  const minSize = optionalSize(m.minSize, 'minSize');
  if (minSize) manifest.minSize = minSize;
  const handles = optionalHandles(m.handles);
  if (handles) manifest.handles = handles;

  return manifest;
}

/* ------------------------------------------------------------------ */
/* The packages directory                                              */
/* ------------------------------------------------------------------ */

/**
 * Reads the directory afresh each time. It is a handful of entries, and the
 * promise to authors is "drop a package in and reopen Settings" — a cache
 * would turn that into "and restart the service", which is the thing this
 * stage exists to end.
 */
export function scanPackages(): InstalledApp[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(packagesDir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  // 0o002 — writable by anyone. Code loaded from there runs in every browser
  // that opens this desktop, with the desktop's reach. Same rule, and same
  // reasoning, as WD_SERVICES_DIR.
  if ((stat.mode & 0o002) !== 0) {
    console.error(`[apps] refusing ${packagesDir}: it is world-writable`);
    return [];
  }

  const found: InstalledApp[] = [];
  for (const name of fs.readdirSync(packagesDir).sort()) {
    const dir = path.join(packagesDir, name);
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (!ID_PATTERN.test(name)) {
      found.push({ id: name, dir, error: 'directory name must be lower-case letters, digits and hyphens' });
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')) as unknown;
      found.push({ id: name, dir, manifest: validateManifest(raw, name, dir) });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const message =
        e.code === 'ENOENT'
          ? `${MANIFEST_FILE} is missing`
          : e instanceof SyntaxError
            ? `${MANIFEST_FILE} is not valid JSON: ${e.message}`
            : e.message;
      found.push({ id: name, dir, error: message });
    }
  }
  return found;
}

/**
 * The one way package bytes leave the host. Only files the manifest names can
 * be asked for, by their manifest name, and only once their real location is
 * confirmed to be inside the package — a symlinked `entry` pointing at
 * `~/.ssh/id_ed25519` would otherwise be a perfectly valid "app".
 */
function readPackageFile(id: unknown, file: unknown): { text: string } {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new ServiceError('A package id is required', 'EINVAL');
  }
  if (typeof file !== 'string' || file === '') {
    throw new ServiceError('A file name is required', 'EINVAL');
  }
  const pkg = scanPackages().find((p) => p.id === id);
  if (!pkg) throw new ServiceError(`No package "${id}" is installed`, 'ENOENT');
  if (!pkg.manifest) throw new ServiceError(`Package "${id}" is broken: ${pkg.error}`, 'EINVAL');
  if (file !== pkg.manifest.entry && file !== pkg.manifest.style) {
    throw new ServiceError(`"${file}" is not a file the manifest of "${id}" names`, 'EINVAL');
  }

  const target = path.join(pkg.dir, file);
  let real: string;
  let realDir: string;
  try {
    real = fs.realpathSync(target);
    realDir = fs.realpathSync(pkg.dir);
  } catch {
    throw new ServiceError(`"${file}" is missing from package "${id}"`, 'ENOENT');
  }
  if (!isInside(real, realDir)) {
    throw new ServiceError(`"${file}" in package "${id}" points outside the package`, 'EACCES');
  }
  const size = fs.statSync(real).size;
  if (size > MAX_FILE_BYTES) {
    throw new ServiceError(`"${file}" in package "${id}" is ${size} bytes; the limit is ${MAX_FILE_BYTES}`, 'EFBIG');
  }
  return { text: fs.readFileSync(real, 'utf8') };
}

/* ------------------------------------------------------------------ */
/* The service                                                         */
/* ------------------------------------------------------------------ */

export const appsService: Service = {
  name: 'apps',

  init(config: Config) {
    file = path.join(config.stateDir, 'disabled-apps.json');
    // Never created here: an install with no packages must leave no trace.
    packagesDir = path.join(config.stateDir, PACKAGES_LEAF);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { disabled?: unknown };
      if (Array.isArray(raw?.disabled)) {
        disabled = new Set(raw.disabled.filter((x): x is string => typeof x === 'string'));
      }
    } catch {
      // First run, or an unreadable file: everything starts enabled.
    }
  },

  methods: {
    list: () => ({ disabled: [...disabled], dir: packagesDir, installed: scanPackages() }),

    read: (args: { id?: unknown; file?: unknown }) => readPackageFile(args?.id, args?.file),

    setEnabled(args: { id?: unknown; enabled?: unknown }) {
      const id = typeof args?.id === 'string' ? args.id.trim() : '';
      if (!id) throw new ServiceError('An app id is required', 'EINVAL');
      const enabled = Boolean(args?.enabled);

      // Settings is how apps get re-enabled; disabling it would strand the user.
      if (!enabled && id === 'settings') {
        throw new ServiceError('The Settings app cannot be disabled', 'EPERM');
      }

      if (enabled) disabled.delete(id);
      else disabled.add(id);
      persist();
      return { disabled: [...disabled] };
    },
  },
};
