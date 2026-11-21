/**
 * Disk-usage scans, kept by the server rather than by the panel showing them.
 *
 * A scan used to belong to its channel: leaving the Disk usage tab closed the
 * channel, the walk died with it, and coming back started again from nothing —
 * on a disk that takes minutes, that is a tool that never finishes. A scan now
 * belongs to the path it started from. A panel watches a folder inside one and
 * may stop watching; the walk goes on and the result waits, until someone asks
 * for it to be measured again.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

interface Watcher {
  send(data: unknown): void;
  close(error?: string): void;
}

interface Scan {
  root: string;
  worker: Worker;
  state: 'scanning' | 'done' | 'stopped';
  startedAt: number;
  finishedAt: number | null;
  watchers: Map<number, Watcher>;
  used: number;
  expiry: NodeJS.Timeout | null;
}

/** Each is a thread and a tree in memory; three is "/", home, and one more. */
const MAX_SCANS = 3;
/**
 * How long a result nobody is looking at is kept. Long enough to leave the
 * panel for the afternoon; short enough that a server up for a year is not
 * holding a picture of last spring's disk.
 */
const KEEP_UNWATCHED_MS = 24 * 60 * 60 * 1000;

const scans = new Map<string, Scan>();
let nextWatch = 1;

// Under `tsx` in development this file is .ts and so is its worker.
const self = fileURLToPath(import.meta.url);
const workerFile = path.join(path.dirname(self), `scan-worker${path.extname(self)}`);

const covers = (root: string, target: string): boolean =>
  target === root || target.startsWith(root === '/' ? '/' : `${root}/`);

function drop(scan: Scan, error?: string): void {
  if (scans.get(scan.root) === scan) scans.delete(scan.root);
  if (scan.expiry) clearTimeout(scan.expiry);
  for (const watcher of scan.watchers.values()) watcher.close(error);
  scan.watchers.clear();
  void scan.worker.terminate();
}

function idle(scan: Scan): void {
  if (scan.watchers.size > 0 || scan.expiry) return;
  scan.expiry = setTimeout(() => drop(scan), KEEP_UNWATCHED_MS);
  scan.expiry.unref();
}

function begin(root: string): Scan {
  // A wider scan makes the narrower ones redundant.
  for (const other of [...scans.values()]) if (covers(root, other.root)) drop(other);
  while (scans.size >= MAX_SCANS) {
    const all = [...scans.values()].sort((a, b) => a.used - b.used);
    drop(all.find((s) => s.watchers.size === 0) ?? all[0], 'Another scan took its place.');
  }

  const worker = new Worker(workerFile, { workerData: { root } });
  // A scan must never be what keeps the service from shutting down.
  worker.unref();
  const scan: Scan = {
    root,
    worker,
    state: 'scanning',
    startedAt: Date.now(),
    finishedAt: null,
    watchers: new Map(),
    used: Date.now(),
    expiry: null,
  };
  scans.set(root, scan);

  worker.on('message', (m: any) => {
    if (m.state) {
      scan.state = m.state;
      scan.finishedAt = m.state === 'scanning' ? null : m.at;
      return;
    }
    if (m.all) {
      for (const watcher of scan.watchers.values()) watcher.send(m.msg);
      return;
    }
    const watcher = scan.watchers.get(m.to);
    if (!watcher) return;
    if (m.close) {
      scan.watchers.delete(m.to);
      watcher.close(m.error);
      // The place the scan started from cannot be read: there is no scan.
      if (m.error && m.root) drop(scan);
      else idle(scan);
    } else {
      watcher.send(m.msg);
    }
  });
  worker.on('error', (err) => drop(scan, `The scan failed: ${(err as Error).message}`));
  worker.on('exit', () => {
    if (scans.get(root) === scan) drop(scan, 'The scan stopped unexpectedly.');
  });
  return scan;
}

export interface ScanHandle {
  /** What the panel is told before the first row. */
  info: { path: string; root: string; state: Scan['state']; startedAt: number; finishedAt: number | null };
  /** Stop watching. The scan itself carries on. */
  unwatch(): void;
  /** Stop the scan, for everyone watching it. What it has measured stays. */
  stop(): void;
}

/**
 * Watch one folder of a scan, starting the scan if nothing covers the folder.
 * `fresh` measures the folder again: the whole scan when it is the scan's own
 * root, otherwise just that subtree, with the totals above it corrected.
 */
export function watchScan(target: string, fresh: boolean, watcher: Watcher): ScanHandle {
  const covering: Scan | undefined = [...scans.values()]
    .filter((s) => covers(s.root, target))
    .sort((a, b) => a.root.length - b.root.length)[0];
  let scan: Scan;
  if (!covering) {
    scan = begin(target);
  } else if (fresh && covering.root === target) {
    drop(covering, 'The scan was started again.');
    scan = begin(target);
  } else {
    scan = covering;
  }

  const id = nextWatch++;
  scan.used = Date.now();
  if (scan.expiry) clearTimeout(scan.expiry);
  scan.expiry = null;
  scan.watchers.set(id, watcher);
  const info = {
    path: target,
    root: scan.root,
    state: scan.state,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt,
  };
  scan.worker.postMessage({ op: 'watch', id, path: target, fresh });

  const mine = scan;
  return {
    info,
    unwatch() {
      if (!mine.watchers.delete(id)) return;
      mine.worker.postMessage({ op: 'unwatch', id });
      idle(mine);
    },
    stop() {
      mine.worker.postMessage({ op: 'stop' });
    },
  };
}
