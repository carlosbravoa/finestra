import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { ServiceError, type Service } from '../service.js';

/**
 * Real Linux applications, in a window.
 *
 * `wdcomp` is a headless Wayland compositor (see `compositor/`, and
 * `docs/wayland.md` for why it cannot live in node: shm buffers arrive as file
 * descriptors and node has no SCM_RIGHTS). It speaks Wayland to the
 * application and a small framed protocol to us, over fd 3 — not stdout,
 * which the application and the bus daemon both share.
 *
 * We are a router: frame messages go straight out as binary, everything else
 * becomes JSON for the app.
 */

/* The wire protocol, mirrored from compositor/src/ipc.h. */
const MSG_WINDOW = 'W'.charCodeAt(0);
const MSG_POPUP = 'U'.charCodeAt(0);
const MSG_TITLE = 'T'.charCodeAt(0);
const MSG_CLOSED = 'X'.charCodeAt(0);
const MSG_FRAME = 'F'.charCodeAt(0);
const MSG_BOUNDS = 'N'.charCodeAt(0);
const MSG_MOVE = 'V'.charCodeAt(0);
const MSG_CURSOR = 'R'.charCodeAt(0);
const MSG_COPY = 'Y'.charCodeAt(0);
const MSG_RESIZE = 'Z'.charCodeAt(0);
const MSG_LOG = 'L'.charCodeAt(0);

const MSG_CONFIGURE = 'C';
const MSG_ACK = 'A';
const MSG_CLOSE = 'K';
const MSG_POINTER = 'P';
const MSG_KEY = 'D';
const MSG_FOCUS = 'G';
const MSG_PASTE = 'Y';

/** A clipboard is text, not a file transfer. */
const MAX_CLIPBOARD_BYTES = 1024 * 1024;

/** Pointer event kinds; mirrored from compositor/src/ipc.h. */
const POINTER_KINDS = 5;
/** Evdev keycodes stop well before here. */
const MAX_KEYCODE = 0x2ff;

/** Frames can be large; anything past this is a bug or an attack. */
const MAX_MESSAGE = 64 * 1024 * 1024;

const MIN_DIMENSION = 64;
const MAX_DIMENSION = 8192;

export interface DesktopApp {
  id: string;
  name: string;
  comment?: string;
  icon?: string;
  categories: string[];
  /** argv, already stripped of .desktop field codes. */
  argv: string[];
}

/* ------------------------------------------------------------------ */
/* Finding wdcomp                                                      */
/* ------------------------------------------------------------------ */

/**
 * The compiled layout nests deeper than the source layout, so walk up looking
 * for the binary rather than counting `..` segments — the same approach
 * `config.ts` takes for the client bundle.
 */
function findCompositor(): string | null {
  if (process.env.WD_WDCOMP) {
    return fs.existsSync(process.env.WD_WDCOMP) ? process.env.WD_WDCOMP : null;
  }

  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'compositor', 'build', 'wdcomp');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const fromCwd = path.resolve(process.cwd(), 'compositor', 'build', 'wdcomp');
  return fs.existsSync(fromCwd) ? fromCwd : null;
}

function hasExecutable(name: string): boolean {
  if (name.includes('/')) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      // Next entry.
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Desktop entries                                                     */
/* ------------------------------------------------------------------ */

/**
 * Split an Exec line the way the desktop-entry spec asks: quoted arguments
 * stay together, and field codes (%f, %U, %i…) are dropped since we have no
 * file to substitute.
 */
function parseExec(exec: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (let i = 0; i < exec.length; i++) {
    const c = exec[i];
    if (quoted) {
      if (c === '\\' && i + 1 < exec.length) {
        current += exec[++i];
      } else if (c === '"') {
        quoted = false;
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ' ' || c === '\t') {
      if (started) argv.push(current);
      current = '';
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) argv.push(current);

  return argv.filter((arg) => !/^%[fFuUdDnNickvm]$/.test(arg));
}

/**
 * The desktop environments an entry may name itself into or out of.
 *
 * We answer with whatever the server was started in, because that is the
 * environment an application launched from here will actually find: its bus,
 * its portals and its settings daemon are the ones already on this machine.
 * A headless server has none, so it matches nothing — which is the right
 * answer for an entry that insists on a desktop that is not running.
 */
function currentDesktops(): string[] {
  return (process.env.XDG_CURRENT_DESKTOP ?? '').split(':').filter(Boolean);
}

/**
 * Where desktop entries live, for a process that is not a login session.
 *
 * Snap and Flatpak keep their entries outside the XDG default directories and
 * get onto `XDG_DATA_DIRS` through `/etc/profile.d`, which only a login shell
 * reads. This server is a systemd service, so it has no such environment — and
 * the result was not an error anywhere: a snap installed successfully, exported
 * a perfectly good `.desktop` file, and simply never appeared, because nothing
 * ever looked in the directory holding it. Named explicitly here so that what
 * the desktop offers depends on what is installed rather than on how the server
 * happened to be started.
 *
 * Order is significance: earlier wins when two entries share an id, so a
 * distribution package keeps precedence over a snap of the same name.
 */
function entryDirs(): string[] {
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dataDirs =
    process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share';
  const dirs = [
    path.join(dataHome, 'applications'),
    ...dataDirs.split(':').filter(Boolean).map((d) => path.join(d, 'applications')),
    '/var/lib/snapd/desktop/applications',
    '/var/lib/flatpak/exports/share/applications',
    // Under XDG_DATA_HOME, which is where flatpak itself puts a per-user
    // export — and which makes this whole rule testable without root.
    path.join(dataHome, 'flatpak', 'exports', 'share', 'applications'),
  ];
  return [...new Set(dirs)];
}

function parseDesktopFile(file: string): DesktopApp | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  // Only the [Desktop Entry] group; actions and other groups follow it.
  let inEntry = false;
  const fields = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry || !line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    // Skip localised keys: Name[fr], Comment[de]…
    if (key.includes('[')) continue;
    if (!fields.has(key)) fields.set(key, line.slice(eq + 1).trim());
  }

  if (fields.get('Type') !== 'Application') return null;
  if (fields.get('NoDisplay') === 'true' || fields.get('Hidden') === 'true') return null;
  // A terminal application needs a terminal emulator; the Terminal app is that.
  if (fields.get('Terminal') === 'true') return null;

  /*
   * OnlyShowIn / NotShowIn. Skipping these put entries in the launcher that
   * cannot work anywhere: the Chromium snap ships one whose whole body is
   * `OnlyShowIn=UbuntuFrame` and `Exec=/usr/bin/false`, and every
   * gnome-control-center panel is a separate entry that needs GNOME Shell
   * running to be worth opening. Both are listed, both fail, and the failure
   * looks like ours.
   */
  const desktops = currentDesktops();
  const listed = (key: string): string[] =>
    (fields.get(key) ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  const only = listed('OnlyShowIn');
  if (only.length > 0 && !only.some((d) => desktops.includes(d))) return null;
  if (listed('NotShowIn').some((d) => desktops.includes(d))) return null;

  const exec = fields.get('Exec');
  const name = fields.get('Name');
  if (!exec || !name) return null;

  const argv = parseExec(exec);
  if (argv.length === 0) return null;

  const tryExec = fields.get('TryExec');
  if (tryExec && !hasExecutable(tryExec)) return null;
  if (!hasExecutable(argv[0])) return null;

  return {
    id: path.basename(file, '.desktop'),
    name,
    comment: fields.get('Comment'),
    icon: fields.get('Icon'),
    categories: (fields.get('Categories') ?? '').split(';').filter(Boolean),
    argv,
  };
}

/**
 * Installed applications, best-named first. Earlier directories win, so a
 * user's own override in ~/.local/share beats the system copy.
 */
function scanApps(): DesktopApp[] {
  const byId = new Map<string, DesktopApp>();
  for (const dir of entryDirs()) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.desktop')) continue;
      const id = name.slice(0, -'.desktop'.length);
      if (byId.has(id)) continue;
      const app = parseDesktopFile(path.join(dir, name));
      if (app) byId.set(id, app);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* Rescanning on every call is wasteful; applications are not installed often. */
let appCache: { at: number; apps: DesktopApp[] } | null = null;

export function cachedApps(): DesktopApp[] {
  if (appCache && Date.now() - appCache.at < 30_000) return appCache.apps;
  const apps = scanApps();
  appCache = { at: Date.now(), apps };
  return apps;
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

/**
 * Resolving `Icon=org.gnome.Calculator` to actual pixels, following enough of
 * the icon-theme spec to be useful without implementing index.theme parsing:
 * look in the usual roots, prefer scalable then large, and fall back to
 * pixmaps.
 */
const ICON_THEMES = ['hicolor', 'Adwaita', 'gnome', 'breeze', 'Papirus', 'Yaru'];
const ICON_SIZES = [
  'scalable',
  '512x512',
  '256x256',
  '128x128',
  '96x96',
  '64x64',
  '48x48',
  '32x32',
];
/**
 * Most application icons sit in `apps`, but a `.desktop` file is free to name
 * a generic themed icon — `Icon=input-keyboard`, `Icon=multimedia-player` —
 * which lives under whichever category the theme filed it in.
 */
const ICON_CATEGORIES = ['apps', 'devices', 'categories', 'mimetypes', 'places', 'status'];

/** An application icon past this is not an icon. */
const MAX_ICON_BYTES = 512 * 1024;

function iconRoots(): string[] {
  const home = os.homedir();
  const dataDirs = process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share';
  return [
    ...new Set([
      path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'icons'),
      path.join(home, '.icons'),
      ...dataDirs.split(':').filter(Boolean).map((d) => path.join(d, 'icons')),
    ]),
  ];
}

function pixmapDirs(): string[] {
  const dataDirs = process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share';
  return dataDirs.split(':').filter(Boolean).map((d) => path.join(d, 'pixmaps'));
}

export interface IconData {
  mime: string;
  /** base64. The client wraps it in an <image>, which cannot run script. */
  data: string;
}

function readIcon(file: string): IconData | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ICON_BYTES) return null;
    const mime = file.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    return { mime, data: fs.readFileSync(file).toString('base64') };
  } catch {
    return null;
  }
}

/** Icon names come from .desktop files, so they are never a path we build. */
function safeIconName(name: string): boolean {
  return /^[\w.+-]{1,128}$/.test(name);
}

function findIcon(name: string | undefined): IconData | null {
  if (!name) return null;

  // An absolute path is allowed by the spec and used by a few applications.
  if (name.startsWith('/')) {
    return name.endsWith('.svg') || name.endsWith('.png') ? readIcon(name) : null;
  }
  if (!safeIconName(name)) return null;

  for (const root of iconRoots()) {
    let themes: string[];
    try {
      themes = fs.readdirSync(root);
    } catch {
      continue;
    }
    // Known themes first, then whatever else this host happens to have.
    const ordered = [
      ...ICON_THEMES.filter((t) => themes.includes(t)),
      ...themes.filter((t) => !ICON_THEMES.includes(t)),
    ];
    for (const theme of ordered) {
      for (const size of ICON_SIZES) {
        for (const category of ICON_CATEGORIES) {
          for (const ext of ['svg', 'png']) {
            // Themes disagree on whether size or category comes first.
            const found =
              readIcon(path.join(root, theme, size, category, `${name}.${ext}`)) ??
              readIcon(path.join(root, theme, category, size, `${name}.${ext}`));
            if (found) return found;
          }
        }
      }
    }
  }

  for (const dir of pixmapDirs()) {
    const found =
      readIcon(path.join(dir, `${name}.svg`)) ?? readIcon(path.join(dir, `${name}.png`));
    if (found) return found;
  }
  return null;
}

/* Icons do not change under a running server, so this cache never expires. */
const iconCache = new Map<string, IconData | null>();

function cachedIcon(name: string | undefined): IconData | null {
  if (!name) return null;
  if (!iconCache.has(name)) iconCache.set(name, findIcon(name));
  return iconCache.get(name) ?? null;
}

/* ------------------------------------------------------------------ */
/* Pinned applications                                                 */
/* ------------------------------------------------------------------ */

/**
 * Pinning is what promotes a native application from "something in the
 * browser list" to an app of this desktop, with its own icon, window identity
 * and session-restore record. Persisted server-side for the same reason app
 * enable/disable is: which applications this machine offers is a property of
 * the machine, not of one browser profile.
 */
let pinned = new Set<string>();
let pinFile = '';

function persistPins(): void {
  try {
    fs.mkdirSync(path.dirname(pinFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pinFile, JSON.stringify({ pinned: [...pinned].sort() }, null, 2) + '\n');
  } catch (err) {
    console.warn('Could not persist pinned applications:', (err as Error).message);
  }
}

/** Pinned entries that still resolve to an installed application. */
function pinnedApps(): Array<{
  id: string;
  name: string;
  comment?: string;
  categories: string[];
  icon: IconData | null;
}> {
  const apps = cachedApps();
  const out = [];
  for (const id of pinned) {
    const app = apps.find((a) => a.id === id);
    // An application that has since been uninstalled is skipped rather than
    // unpinned: it may come back, and losing the pin to a broken package
    // would be its own annoyance.
    if (!app) continue;
    out.push({
      id: app.id,
      name: app.name,
      comment: app.comment,
      categories: app.categories,
      icon: cachedIcon(app.icon),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* The session channel                                                 */
/* ------------------------------------------------------------------ */

/** Pointer coordinates and scroll deltas, kept inside a sane range. */
function coord(value: number): number {
  const n = Math.round(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1 << 20, Math.max(-(1 << 20), n));
}

/**
 * An xkb layout, optionally with a variant: `us`, `de`, `us(dvorak)`. Narrow
 * on purpose — this reaches a command line.
 */
function safeLayout(value: unknown): { layout: string; variant?: string } {
  if (typeof value !== 'string') return { layout: 'us' };
  const match = /^([a-z]{2,8})(?:\(([a-z0-9_-]{1,16})\))?$/.exec(value);
  if (!match) return { layout: 'us' };
  return { layout: match[1], variant: match[2] };
}

/**
 * Zero is not a size, it is a question: a window configured at 0x0 is
 * xdg-shell's way of asking the application what size it would like to be, and
 * wdcomp passes that through. Anything else is clamped to something sane.
 */
function clampDimension(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n === 0) return 0;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, n));
}

interface SessionArgs {
  appId?: string;
  width?: number;
  height?: number;
  /** xkb layout the browser is really typing on; see docs/wayland.md. */
  layout?: string;
  /**
   * The browser's devicePixelRatio, so the application draws for the screen
   * that will show it rather than for a notional 1x one. width and height stay
   * in *pixels* — this only tells the toolkit how dense they are.
   */
  scale?: number;
}

let sessionCounter = 0;

export const waylandService: Service = {
  name: 'wayland',

  init(config) {
    pinFile = path.join(config.stateDir, 'pinned-applications.json');
    try {
      const raw = JSON.parse(fs.readFileSync(pinFile, 'utf8')) as { pinned?: unknown };
      if (Array.isArray(raw?.pinned)) {
        pinned = new Set(raw.pinned.filter((x): x is string => typeof x === 'string'));
      }
    } catch {
      // First run, or an unreadable file: nothing is pinned.
    }
  },

  methods: {
    /** Whether this host can run the feature at all, and why not if it cannot. */
    available() {
      const binary = findCompositor();
      if (!binary) {
        return {
          available: false,
          reason: 'The compositor is not built. Run `make` in compositor/.',
        };
      }
      if (!process.env.XDG_RUNTIME_DIR) {
        return {
          available: false,
          reason: 'XDG_RUNTIME_DIR is not set, so there is nowhere to put the socket.',
        };
      }
      return { available: true, binary, sessionBus: hasExecutable('dbus-run-session') };
    },

    apps() {
      // argv is deliberately not sent: the browser names an id, never a command.
      // Icon *data* is not sent either — a hundred applications is megabytes;
      // the picker asks for the ones it draws through `icon`.
      return cachedApps().map(({ id, name, comment, icon, categories }) => ({
        id,
        name,
        comment,
        icon,
        categories,
        pinned: pinned.has(id),
      }));
    },

    /** One application's icon, as bytes. Null when the theme has none. */
    icon(args: { id?: unknown }) {
      const id = typeof args?.id === 'string' ? args.id : '';
      const app = cachedApps().find((a) => a.id === id);
      if (!app) throw new ServiceError('Unknown application', 'ENOAPP');
      return cachedIcon(app.icon);
    },

    /** Everything the client needs to register pinned apps, in one call. */
    pins() {
      return { pinned: pinnedApps() };
    },

    setPinned(args: { id?: unknown; pinned?: unknown }) {
      const id = typeof args?.id === 'string' ? args.id.trim() : '';
      if (!id) throw new ServiceError('An application id is required', 'EINVAL');

      if (args?.pinned) {
        // Only something we actually advertised can be pinned; unpinning is
        // unrestricted so a stale entry can always be cleared.
        if (!cachedApps().some((a) => a.id === id)) {
          throw new ServiceError('Unknown application', 'ENOAPP');
        }
        pinned.add(id);
      } else {
        pinned.delete(id);
      }
      persistPins();
      return { pinned: pinnedApps() };
    },
  },

  channels: {
    session(args: SessionArgs, ctx) {
      const binary = findCompositor();
      if (!binary) {
        throw new ServiceError(
          'The compositor is not built. Run `make` in compositor/.',
          'ENOCOMPOSITOR',
        );
      }

      // Same rule as pty's shell list: the client names an id we advertised,
      // never a command line of its own.
      const app = cachedApps().find((a) => a.id === args?.appId);
      if (!app) throw new ServiceError('Unknown application', 'ENOAPP');

      // No size asked for means the application picks its own; see the note on
      // clampDimension. The shell then sizes its window to whatever it chose.
      const width = clampDimension(args?.width, 0);
      const height = clampDimension(args?.height, 0);

      const { layout, variant } = safeLayout(args?.layout);
      // What the browser says its display density is. Clamped rather than
      // trusted: the protocol's scale is an integer, and past 3 the buffer
      // costs more bandwidth than the sharpness is worth on a remote link.
      const scale = Math.min(3, Math.max(1, Math.round(Number(args?.scale) || 1)));
      // `wayland-<digits>`, and nothing more descriptive, because AppArmor says
      // so: the profiles the distribution ships — abstractions/wayland, and
      // every snap — allow the name `wayland-[0-9]*` under the runtime dir and
      // no other, so a confined application handed any other socket cannot open
      // it and exits with "Failed to open display". Costs nothing, and is the
      // difference between Papers or Transmission running here and not.
      const socketName = `wayland-${process.pid}${++sessionCounter}`;
      const compositorArgs = [
        '--ipc',
        '-s',
        socketName,
        '-g',
        `${width}x${height}`,
        '--scale',
        String(scale),
        '-l',
        layout,
        ...(variant ? ['--variant', variant] : []),
        '--',
        ...app.argv,
      ];

      /*
       * A private session bus. Without one a GApplication exits silently; with
       * the ambient one, a single-instance application hands its window to
       * whatever is already running in the host's own login session.
       *
       * Snaps are the exception, and it is not a preference: snap-confine puts
       * the application into a transient systemd scope and asks the *session*
       * bus to make it. A private bus has no systemd on it, the cgroup is never
       * created, and the snap exits before it draws — every time, for every
       * snap. So one gets the server's own bus if the server has one, and the
       * single-instance risk that comes with it.
       */
      const isSnap = app.argv[0].startsWith('/snap/') || app.argv[0] === 'snap';
      const hostBus = Boolean(process.env.DBUS_SESSION_BUS_ADDRESS);
      const useBus = hasExecutable('dbus-run-session') && !(isSnap && hostBus);
      const command = useBus ? 'dbus-run-session' : binary;
      const commandArgs = useBus ? ['--', binary, ...compositorArgs] : compositorArgs;

      const env = { ...process.env };
      // A bus of our own replaces this one; with no bus of our own, whatever
      // the server has is better than none at all.
      if (useBus) delete env.DBUS_SESSION_BUS_ADDRESS;
      delete env.WAYLAND_DISPLAY;
      delete env.DISPLAY;

      let child: ChildProcess;
      try {
        child = spawn(command, commandArgs, {
          // fd 3 is the frame channel. Extra pipes are bidirectional.
          stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
          // Its own process group, so closing this reaps the bus and the
          // application too, not just the compositor.
          detached: true,
          env,
        });
      } catch (err) {
        throw new ServiceError(
          `Could not start the compositor: ${(err as Error).message}`,
          'ESPAWN',
        );
      }

      const rawChannel = child.stdio[3];
      if (!rawChannel) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // Already gone.
        }
        throw new ServiceError('The compositor channel did not open', 'EPIPE');
      }

      /*
       * Node opens extra stdio pipes as bidirectional sockets, but types them
       * as one direction only — hence the cast. Verified: the compositor
       * reads configure/ack on the same fd it writes frames to.
       */
      const channel = rawChannel as unknown as Duplex;
      let alive = true;
      let buffered: Buffer = Buffer.alloc(0);

      let killTimer: NodeJS.Timeout | undefined;
      /** Whether we are the reason it is going away, rather than it deciding to. */
      let stopping = false;
      /** Whether anything was ever put on screen. See explainSilentExit. */
      let sawWindow = false;
      const startedAt = Date.now();

      const stop = () => {
        if (!alive) return;
        stopping = true;
        alive = false;
        const group = -child.pid!;
        try {
          // Negative pid: the whole group, so dbus-run-session and the
          // application go too. This is the easiest serious bug to write.
          process.kill(group, 'SIGTERM');
        } catch {
          return; // Already gone.
        }
        // An application that traps SIGTERM to save its work gets a moment to
        // do it, and then stops being asked.
        killTimer = setTimeout(() => {
          try {
            process.kill(group, 'SIGKILL');
          } catch {
            // Exited in the meantime, which is the normal case.
          }
        }, 4000);
        killTimer.unref();
      };

      channel.on('data', (chunk: Buffer) => {
        buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;

        for (;;) {
          if (buffered.length < 4) break;
          const length = buffered.readUInt32BE(0);
          if (length === 0 || length > MAX_MESSAGE) {
            ctx.close('The compositor sent a malformed message');
            stop();
            return;
          }
          if (buffered.length < 4 + length) break;

          const message = buffered.subarray(4, 4 + length);
          buffered = buffered.subarray(4 + length);
          dispatch(message);
        }
      });

      function readString(buf: Buffer, at: number): [string, number] {
        if (at + 2 > buf.length) return ['', buf.length];
        const length = buf.readUInt16BE(at);
        const end = Math.min(at + 2 + length, buf.length);
        return [buf.subarray(at + 2, end).toString('utf8'), end];
      }

      function dispatch(message: Buffer): void {
        const type = message[0];
        const body = message.subarray(1);

        switch (type) {
          case MSG_FRAME:
            // Straight through: header plus pixels, no JSON in the way.
            ctx.sendBinary(body);
            break;

          case MSG_WINDOW: {
            if (body.length < 16) return;
            sawWindow = true;
            const [title, next] = readString(body, 16);
            const [appId] = readString(body, next);
            ctx.send({
              t: 'window',
              id: body.readUInt32BE(0),
              width: body.readUInt32BE(4),
              height: body.readUInt32BE(8),
              // Non-zero means this is a dialog belonging to that window.
              parent: body.readUInt32BE(12),
              title,
              appId,
            });
            break;
          }

          case MSG_POPUP:
            if (body.length < 24) return;
            ctx.send({
              t: 'popup',
              id: body.readUInt32BE(0),
              parent: body.readUInt32BE(4),
              // Relative to the parent window's own geometry origin.
              x: body.readInt32BE(8),
              y: body.readInt32BE(12),
              width: body.readUInt32BE(16),
              height: body.readUInt32BE(20),
            });
            break;

          case MSG_BOUNDS:
            if (body.length < 20) return;
            ctx.send({
              t: 'bounds',
              id: body.readUInt32BE(0),
              minWidth: body.readUInt32BE(4),
              minHeight: body.readUInt32BE(8),
              maxWidth: body.readUInt32BE(12),
              maxHeight: body.readUInt32BE(16),
            });
            break;

          case MSG_MOVE:
            if (body.length < 4) return;
            ctx.send({ t: 'move', id: body.readUInt32BE(0) });
            break;

          case MSG_CURSOR:
            if (body.length < 4) return;
            ctx.send({ t: 'cursor', shape: body.readUInt32BE(0) });
            break;

          case MSG_COPY:
            ctx.send({ t: 'copy', text: body.toString('utf8') });
            break;

          case MSG_RESIZE:
            if (body.length < 8) return;
            ctx.send({
              t: 'resize',
              id: body.readUInt32BE(0),
              edges: body.readUInt32BE(4),
            });
            break;

          case MSG_TITLE: {
            if (body.length < 4) return;
            const [title] = readString(body, 4);
            ctx.send({ t: 'title', id: body.readUInt32BE(0), title });
            break;
          }

          case MSG_CLOSED:
            if (body.length < 4) return;
            ctx.send({ t: 'closed', id: body.readUInt32BE(0) });
            break;

          case MSG_LOG:
            ctx.send({ t: 'log', message: body.toString('utf8') });
            break;

          default:
            break;
        }
      }

      function writeMessage(body: Buffer): void {
        if (!alive || !channel.writable) return;
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(body.length);
        channel.write(Buffer.concat([prefix, body]));
      }

      function sendToCompositor(type: string, ...values: number[]): void {
        const body = Buffer.alloc(1 + values.length * 4);
        body.write(type, 0, 'latin1');
        values.forEach((value, i) => body.writeUInt32BE(value >>> 0, 1 + i * 4));
        writeMessage(body);
      }

      /* Every field here comes from a browser, so every field is clamped. */
      function sendPointer(
        id: number, kind: number, x: number, y: number, arg: number, value: number,
      ): void {
        if (!Number.isInteger(kind) || kind < 0 || kind >= POINTER_KINDS) return;
        const body = Buffer.alloc(22);
        body.write(MSG_POINTER, 0, 'latin1');
        body.writeUInt32BE(id, 1);
        body.writeUInt8(kind, 5);
        body.writeInt32BE(coord(x), 6);
        body.writeInt32BE(coord(y), 10);
        body.writeUInt32BE(Math.min(0xffff, Math.max(0, Math.floor(arg) || 0)), 14);
        body.writeInt32BE(coord(value), 18);
        writeMessage(body);
      }

      function sendKey(id: number, keycode: number, pressed: boolean): void {
        if (!Number.isInteger(keycode) || keycode <= 0 || keycode > MAX_KEYCODE) return;
        const body = Buffer.alloc(10);
        body.write(MSG_KEY, 0, 'latin1');
        body.writeUInt32BE(id, 1);
        body.writeUInt32BE(keycode, 5);
        body.writeUInt8(pressed ? 1 : 0, 9);
        writeMessage(body);
      }

      function sendPaste(text: string): void {
        const bytes = Buffer.from(text, 'utf8').subarray(0, MAX_CLIPBOARD_BYTES);
        const body = Buffer.alloc(1 + bytes.length);
        body.write(MSG_PASTE, 0, 'latin1');
        bytes.copy(body, 1);
        writeMessage(body);
      }

      function sendFocus(id: number, focused: boolean): void {
        const body = Buffer.alloc(6);
        body.write(MSG_FOCUS, 0, 'latin1');
        body.writeUInt32BE(id, 1);
        body.writeUInt8(focused ? 1 : 0, 5);
        writeMessage(body);
      }

      // The compositor's own diagnostics. Worth keeping: "could not exec" and
      // "non-shm buffer" both surface here.
      let stderrTail = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderrTail = (stderrTail + text).slice(-4000);
        for (const line of text.split('\n')) {
          if (line.trim()) ctx.send({ t: 'log', message: line.trim() });
        }
      });

      child.on('error', (err) => {
        alive = false;
        ctx.close(`Could not start the compositor: ${err.message}`);
      });

      /*
       * A graphical application that exits cleanly having never mapped a
       * window has almost always handed the job to something else. Reporting
       * that as "exited normally" is true and useless — it was the whole of
       * what the browser was told when Firefox opened on the host's screen
       * instead of here. This is the one place that knows enough to say what
       * probably happened, so it says it.
       */
      const explainSilentExit = (): string => {
        const opening = `${app.name} started and exited without opening a window.`;

        // Sharing the machine's own bus is what makes the handover possible:
        // the copy already running in its desktop session is reachable, and
        // single-instance applications hand the window straight to it.
        if (!useBus && hostBus && Date.now() - startedAt < 15_000) {
          return (
            `${opening} It is sharing this machine's session bus, which snaps need in order to ` +
            `start at all, so a copy of it already running in the machine's own desktop session ` +
            `will have taken the window. Close it there, or start this one on a separate profile.`
          );
        }
        return `${opening} That usually means it wanted a desktop service this session does not provide.`;
      };

      child.on('exit', (code, signal) => {
        alive = false;
        if (killTimer) clearTimeout(killTimer);
        // We asked, so there is nothing to explain.
        if (stopping) {
          ctx.close();
          return;
        }
        /*
         * Nothing ever reached the screen. Note that `code` is the
         * compositor's, not the application's — wdcomp returns 1 for "no frame
         * streamed" whatever the reason — so repeating it here would be both
         * unhelpful and about the wrong process.
         */
        if (!sawWindow) {
          ctx.close(explainSilentExit());
          return;
        }
        if (code === 0) {
          ctx.close();
          return;
        }
        const how = signal ? `killed by ${signal}` : `exited (${code})`;
        ctx.close(`The application ${how}`);
      });

      channel.on('error', () => {
        // The pipe dies with the process; `exit` reports the real reason.
      });

      return {
        info: {
        app: app.id,
        name: app.name,
        width,
        height,
        layout: variant ? `${layout}(${variant})` : layout,
        sessionBus: useBus,
        /* Names this session's processes exactly, which is what makes
         * "did it get cleaned up?" answerable. */
        socket: socketName,
      },

        onCtl(method: string, ctlArgs: any) {
          if (!alive) return;

          // The clipboard belongs to the session, not to one window.
          if (method === 'paste') {
            if (typeof ctlArgs?.text === 'string') sendPaste(ctlArgs.text);
            return;
          }

          const id = Number(ctlArgs?.id);
          if (!Number.isInteger(id) || id <= 0) return;

          if (method === 'configure') {
            sendToCompositor(
              MSG_CONFIGURE,
              id,
              clampDimension(ctlArgs?.width, width),
              clampDimension(ctlArgs?.height, height),
            );
          } else if (method === 'ack') {
            sendToCompositor(MSG_ACK, id);
          } else if (method === 'closeWindow') {
            sendToCompositor(MSG_CLOSE, id);
          } else if (method === 'pointer') {
            sendPointer(
              id,
              Number(ctlArgs?.kind),
              Number(ctlArgs?.x),
              Number(ctlArgs?.y),
              Number(ctlArgs?.arg ?? 0),
              Number(ctlArgs?.value ?? 0),
            );
          } else if (method === 'key') {
            sendKey(id, Number(ctlArgs?.keycode), Boolean(ctlArgs?.pressed));
          } else if (method === 'focus') {
            sendFocus(id, Boolean(ctlArgs?.focused));
          }
        },

        onClose() {
          stop();
          if (stderrTail && process.env.WD_DEV === '1') {
            console.error(`[wayland] session ended:\n${stderrTail}`);
          }
        },
      };
    },
  },
};
