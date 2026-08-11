import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePath } from '../paths.js';
import { ServiceError, type Service } from '../service.js';

export interface DirEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  /** Epoch milliseconds. */
  mtime: number;
  mode: number;
  /** For symlinks, what the link resolves to, when it resolves at all. */
  target?: string;
  /** Set when the entry could not be stat'd, e.g. a permission error. */
  error?: string;
}

/** Cap on a single `read`, so one call cannot try to buffer a huge file. */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * Filesystem access for graphical apps (file manager, editors, pickers).
 *
 * Note that this deliberately runs with the server's own privileges, matching
 * what the terminal already grants. WD_ROOT narrows it when that is too much.
 */
export const fsService: Service = {
  name: 'fs',

  methods: {
    home: () => os.homedir(),

    async list(args: { path: string; showHidden?: boolean }, ctx) {
      const dir = resolvePath(args?.path, ctx.config.root);
      const dirents = await fsp.readdir(dir, { withFileTypes: true });

      const entries = await Promise.all(
        dirents
          .filter((d) => args?.showHidden || !d.name.startsWith('.'))
          .map((d) => describe(path.join(dir, d.name), d.name)),
      );

      // Directories first, then case-insensitive by name.
      entries.sort((a, b) => {
        const aDir = a.kind === 'directory';
        const bDir = b.kind === 'directory';
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), entries };
    },

    async stat(args: { path: string }, ctx) {
      const target = resolvePath(args?.path, ctx.config.root);
      // Unlike a listing row, a direct stat must surface ENOENT/EACCES.
      return describe(target, path.basename(target), false);
    },

    async read(args: { path: string; encoding?: 'utf8' | 'base64' }, ctx) {
      const target = resolvePath(args?.path, ctx.config.root);
      const stats = await fsp.stat(target);
      if (!stats.isFile()) throw new ServiceError('Not a regular file', 'ENOTFILE');
      if (stats.size > MAX_READ_BYTES) {
        throw new ServiceError(
          `File is ${formatBytes(stats.size)}; the limit for a single read is ${formatBytes(MAX_READ_BYTES)}`,
          'ETOOBIG',
        );
      }
      const buf = await fsp.readFile(target);
      const encoding = args?.encoding ?? 'utf8';
      return { path: target, encoding, size: stats.size, content: buf.toString(encoding) };
    },

    async write(
      args: { path: string; content: string; encoding?: 'utf8' | 'base64' },
      ctx,
    ) {
      const target = resolvePath(args?.path, ctx.config.root);
      if (typeof args?.content !== 'string') {
        throw new ServiceError('content must be a string', 'EINVAL');
      }
      await fsp.writeFile(target, Buffer.from(args.content, args?.encoding ?? 'utf8'));
      return { path: target };
    },

    async mkdir(args: { path: string }, ctx) {
      const target = resolvePath(args?.path, ctx.config.root);
      await fsp.mkdir(target, { recursive: true });
      return { path: target };
    },

    async rename(args: { from: string; to: string }, ctx) {
      const from = resolvePath(args?.from, ctx.config.root);
      const to = resolvePath(args?.to, ctx.config.root);
      await fsp.rename(from, to);
      return { path: to };
    },

    async remove(args: { path: string; recursive?: boolean }, ctx) {
      const target = resolvePath(args?.path, ctx.config.root);
      // Guard against a bug or a stray click wiping a whole tree from the root.
      if (target === '/' || target === os.homedir()) {
        throw new ServiceError('Refusing to remove that directory', 'EPERM');
      }
      await fsp.rm(target, { recursive: Boolean(args?.recursive), force: false });
      return { path: target };
    },
  },

  channels: {
    /**
     * Disk-usage scan of one directory: each immediate child is walked fully
     * and reported with its aggregated size, so a drill-down UI re-opens the
     * channel one level deeper. Results stream in as children complete, with
     * progress heartbeats inside big ones, and the walk stops the moment the
     * channel closes — a scan of `/` must die with its window.
     */
    scan(args: { path: string }, ctx) {
      const target = resolvePath(args?.path, ctx.config.root);
      let cancelled = false;

      void scanDirectory(target, ctx, () => cancelled).catch((err) => {
        ctx.close((err as Error).message);
      });

      return {
        info: { path: target },
        onClose: () => {
          cancelled = true;
        },
      };
    },
  },
};

/** How many stat/readdir calls a scan keeps in flight. */
const SCAN_CONCURRENCY = 16;
/** Progress heartbeat interval while inside one large child. */
const SCAN_PROGRESS_MS = 250;

interface WalkTotals {
  bytes: number;
  entries: number;
  errors: number;
}

async function scanDirectory(
  target: string,
  ctx: { send(data: unknown): void; close(error?: string): void },
  isCancelled: () => boolean,
): Promise<void> {
  const dirents = await fsp.readdir(target, { withFileTypes: true });
  ctx.send({ type: 'start', path: target, children: dirents.length });

  const total: WalkTotals = { bytes: 0, entries: 0, errors: 0 };

  // Children one at a time (parallelism lives inside the walk), so results
  // arrive as a steady stream instead of everything completing at the end.
  for (const dirent of dirents) {
    if (isCancelled()) return;
    const childPath = path.join(target, dirent.name);
    const totals: WalkTotals = { bytes: 0, entries: 0, errors: 0 };

    let lastBeat = Date.now();
    const beat = () => {
      if (Date.now() - lastBeat < SCAN_PROGRESS_MS) return;
      lastBeat = Date.now();
      ctx.send({ type: 'progress', name: dirent.name, bytes: totals.bytes, entries: totals.entries });
    };

    let kind: 'file' | 'directory' | 'symlink' | 'other' = 'other';
    if (dirent.isSymbolicLink()) {
      // Symlinks count as themselves; following them would double-count and loop.
      kind = 'symlink';
      try {
        const lst = await fsp.lstat(childPath);
        totals.bytes += lst.blocks * 512;
        totals.entries += 1;
      } catch {
        totals.errors += 1;
      }
    } else if (dirent.isDirectory()) {
      kind = 'directory';
      await walkTree(childPath, totals, isCancelled, beat);
    } else {
      if (dirent.isFile()) kind = 'file';
      try {
        const lst = await fsp.lstat(childPath);
        totals.bytes += lst.blocks * 512;
        totals.entries += 1;
      } catch {
        totals.errors += 1;
      }
    }

    if (isCancelled()) return;
    total.bytes += totals.bytes;
    total.entries += totals.entries;
    total.errors += totals.errors;
    ctx.send({
      type: 'child',
      name: dirent.name,
      path: childPath,
      kind,
      bytes: totals.bytes,
      entries: totals.entries,
      errors: totals.errors,
    });
  }

  ctx.send({ type: 'done', ...total });
  ctx.close();
}

/**
 * Sum a subtree's disk usage (allocated blocks, like `du`) without following
 * symlinks. Keeps a bounded number of filesystem calls in flight and checks
 * for cancellation between them.
 */
async function walkTree(
  root: string,
  totals: WalkTotals,
  isCancelled: () => boolean,
  beat: () => void,
): Promise<void> {
  const queue: string[] = [root];
  let active = 0;

  await new Promise<void>((resolve) => {
    const pump = () => {
      if (isCancelled()) {
        queue.length = 0;
        if (active === 0) resolve();
        return;
      }
      while (active < SCAN_CONCURRENCY && queue.length > 0) {
        const dir = queue.pop()!;
        active++;
        void processDir(dir).finally(() => {
          active--;
          if (active === 0 && queue.length === 0) resolve();
          else pump();
        });
      }
      if (active === 0 && queue.length === 0) resolve();
    };

    const processDir = async (dir: string): Promise<void> => {
      let dirents;
      try {
        const lst = await fsp.lstat(dir);
        totals.bytes += lst.blocks * 512;
        totals.entries += 1;
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        totals.errors += 1;
        return;
      }
      for (const d of dirents) {
        const full = path.join(dir, d.name);
        if (d.isDirectory() && !d.isSymbolicLink()) {
          queue.push(full);
        } else {
          try {
            const lst = await fsp.lstat(full);
            totals.bytes += lst.blocks * 512;
            totals.entries += 1;
          } catch {
            totals.errors += 1;
          }
        }
      }
      beat();
    };

    pump();
  });
}

/**
 * When `tolerant`, an entry that cannot be stat'd is returned carrying an
 * `error` instead of throwing — a listing should still show what it can find.
 */
async function describe(full: string, name: string, tolerant = true): Promise<DirEntry> {
  try {
    const lst = await fsp.lstat(full);
    if (lst.isSymbolicLink()) {
      let target: string | undefined;
      let kind: DirEntry['kind'] = 'symlink';
      try {
        target = await fsp.readlink(full);
        // Report what the link points at, so the UI can show a folder icon.
        const resolved = await fsp.stat(full);
        kind = resolved.isDirectory() ? 'directory' : 'file';
      } catch {
        // Broken link: leave it as a symlink with no usable target.
      }
      return {
        name,
        path: full,
        kind,
        size: lst.size,
        mtime: lst.mtimeMs,
        mode: lst.mode,
        target,
      };
    }
    return {
      name,
      path: full,
      kind: lst.isDirectory() ? 'directory' : lst.isFile() ? 'file' : 'other',
      size: lst.size,
      mtime: lst.mtimeMs,
      mode: lst.mode,
    };
  } catch (err) {
    if (!tolerant) throw err;
    // An unreadable entry should still appear in the listing, greyed out.
    return {
      name,
      path: full,
      kind: 'other',
      size: 0,
      mtime: 0,
      mode: 0,
      error: (err as Error).message,
    };
  }
}

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}
