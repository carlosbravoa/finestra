/**
 * The disk-usage walk, in a thread of its own.
 *
 * It is a worker because the fast way to measure a disk is synchronous: an
 * awaited `lstat` per file spends most of its time crossing to the thread pool
 * and back, and measured three times slower than the same calls made in a row
 * (/usr, 308 594 entries, warm: 2.9 s against 1.0 s — `du` takes 0.9). Made in
 * a row on the server's own thread, one stalled network mount would freeze
 * every terminal on the machine.
 *
 * It holds the result as well as producing it. The tree of directories stays
 * here, so opening a folder that has been measured is a lookup, and a panel
 * that goes away and comes back finds the walk where it left it.
 */
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

interface Node {
  name: string;
  parent: Node | null;
  bytes: number;
  entries: number;
  errors: number;
  /** null: not kept — never read, pruned, or a mount that was not entered. */
  children: Node[] | null;
  done: boolean;
  /** Filesystem type of a mount the walk stayed out of. */
  mount?: string;
}

interface Frame {
  node: Node;
  path: string;
  dev: number;
  subdirs: string[];
  next: number;
}

interface Job {
  path: string;
  top: Node;
  frames: Frame[];
  links: Set<string>;
  /** The node this walk replaces when it finishes; null for the scan itself. */
  replaces: Node | null;
  bytes: number;
  entries: number;
}

const port = parentPort!;
const rootPath: string = (workerData as { root: string }).root;

/**
 * A subtree smaller than this is summed and then forgotten. It is what keeps
 * a machine with a few million `node_modules` directories from costing a few
 * hundred megabytes to remember; opening a forgotten one measures it again,
 * which at this size is instant.
 */
const PRUNE_BELOW = 1024 * 1024;
const SLICE_MS = 20;
const PROGRESS_MS = 250;

/**
 * Filesystems the walk does not enter when it meets one below where it
 * started. None of them is space on a disk: kernel views, RAM, read-only
 * images (a machine with snaps has dozens, each permanently full), overlays
 * that show a second time what is already counted underneath, and other
 * machines' disks. Asked for by name — scan /proc — any of them is measured.
 */
const NOT_DISK =
  /^(proc|sysfs|devtmpfs|devpts|tmpfs|ramfs|cgroup2?|pstore|bpf|debugfs|tracefs|securityfs|configfs|fusectl|mqueue|hugetlbfs|autofs|binfmt_misc|efivarfs|nsfs|rpc_pipefs|selinuxfs|squashfs|iso9660|erofs|overlay|nfs4?|cifs|smb3|9p|ceph|fuse\..*)$/;

function readMounts(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [, mount, fstype] = line.split(' ');
      if (!mount || !fstype) continue;
      out.set(
        mount.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))),
        fstype,
      );
    }
  } catch {
    // No mount table: every directory is walked.
  }
  return out;
}

const mounts = readMounts();
const join = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const dirname = (p: string): string => {
  const cut = p.lastIndexOf('/');
  return cut <= 0 ? '/' : p.slice(0, cut);
};
const newNode = (name: string, parent: Node | null): Node => ({
  name,
  parent,
  bytes: 0,
  entries: 0,
  errors: 0,
  children: null,
  done: false,
});

const root = newNode(rootPath, null);
const watches = new Map<number, string>();
const jobs: Job[] = [];
let mainJob: Job | null = null;
let paused = false;
let running = false;
let lastProgress = 0;

/* ------------------------------------------------------------------ */
/* Telling the panels                                                  */
/* ------------------------------------------------------------------ */

function post(to: number, msg: unknown): void {
  port.postMessage({ to, msg });
}

function finish(id: number, error?: string): void {
  watches.delete(id);
  port.postMessage({ to: id, close: true, error });
}

function dirRow(path: string, node: Node | undefined): Record<string, unknown> {
  return {
    type: 'child',
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    kind: 'directory',
    bytes: node?.bytes ?? 0,
    entries: node?.entries ?? 0,
    errors: node?.errors ?? 0,
    pending: !node?.done,
    mount: node?.mount,
  };
}

/** A directory's total is final: its row, and the end of anyone watching it. */
function announce(path: string, node: Node): void {
  const parent = dirname(path);
  for (const [id, watched] of watches) {
    if (watched === parent && path !== parent) post(id, dirRow(path, node));
    if (watched === path) {
      post(id, { type: 'done', bytes: node.bytes, entries: node.entries, errors: node.errors });
      finish(id);
    }
  }
}

function isWatched(path: string): boolean {
  const prefix = path === '/' ? '/' : `${path}/`;
  for (const watched of watches.values()) {
    if (watched === path || watched.startsWith(prefix)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Walking                                                             */
/* ------------------------------------------------------------------ */

/** Reads one directory: its own size, its files, and the names still to enter. */
function open(job: Job, node: Node, path: string): Frame | null {
  let dirents: fs.Dirent[];
  let dev: number;
  try {
    const st = fs.lstatSync(path);
    dev = st.dev;
    node.bytes += st.blocks * 512;
    node.entries += 1;
    job.bytes += st.blocks * 512;
    job.entries += 1;
    dirents = fs.readdirSync(path, { withFileTypes: true });
  } catch {
    node.errors += 1;
    return null;
  }

  const subdirs: string[] = [];
  for (const d of dirents) {
    if (d.isDirectory()) {
      subdirs.push(d.name);
      continue;
    }
    try {
      const st = fs.lstatSync(join(path, d.name));
      node.entries += 1;
      job.entries += 1;
      // A file with several names is on the disk once. Without this /usr
      // read 13.1 GB where du says 11.8.
      if (st.nlink > 1) {
        const key = `${st.dev}:${st.ino}`;
        if (job.links.has(key)) continue;
        job.links.add(key);
      }
      node.bytes += st.blocks * 512;
      job.bytes += st.blocks * 512;
    } catch {
      node.errors += 1;
    }
  }
  node.children = [];
  return { node, path, dev, subdirs, next: 0 };
}

function complete(job: Job, node: Node, path: string): void {
  node.done = true;
  const parent = node.parent;
  if (parent) {
    parent.bytes += node.bytes;
    parent.entries += node.entries;
    parent.errors += node.errors;
    if (node.bytes < PRUNE_BELOW && !isWatched(path)) node.children = null;
  }
  // The top of a re-measure is announced once it has taken its place.
  if (node !== job.top || !job.replaces) announce(path, node);
}

/** One step: enter the next subdirectory, or close the one that has run out. */
function step(job: Job): void {
  const frame = job.frames[job.frames.length - 1];
  if (frame.next >= frame.subdirs.length) {
    job.frames.pop();
    complete(job, frame.node, frame.path);
    return;
  }

  const name = frame.subdirs[frame.next++];
  const path = join(frame.path, name);
  const child = newNode(name, frame.node);
  frame.node.children!.push(child);

  const fstype = mounts.get(path);
  if (fstype && NOT_DISK.test(fstype)) {
    let crossed = true;
    try {
      crossed = fs.lstatSync(path).dev !== frame.dev;
    } catch {
      // Unreadable either way; leave it as the mount the table says it is.
    }
    if (crossed) {
      child.mount = fstype;
      complete(job, child, path);
      return;
    }
  }

  const next = open(job, child, path);
  if (next) job.frames.push(next);
  else complete(job, child, path);
}

function start(path: string, top: Node, replaces: Node | null): Job {
  const job: Job = { path, top, frames: [], links: new Set(), replaces, bytes: 0, entries: 0 };
  const frame = open(job, top, path);
  if (frame) job.frames.push(frame);
  else top.done = true;
  jobs.push(job);
  return job;
}

/** A finished re-measure takes the place of what was there, and the ancestors follow. */
function settle(job: Job): void {
  const old = job.replaces;
  if (!old) {
    mainJob = null;
    job.links.clear();
    port.postMessage({ state: 'done', at: Date.now() });
    return;
  }
  const fresh = job.top;
  const delta = {
    bytes: fresh.bytes - old.bytes,
    entries: fresh.entries - old.entries,
    errors: fresh.errors - old.errors,
  };
  old.bytes = fresh.bytes;
  old.entries = fresh.entries;
  old.errors = fresh.errors;
  old.children = fresh.children;
  old.mount = undefined;
  old.done = true;
  for (const child of old.children ?? []) child.parent = old;
  for (let up = old.parent; up; up = up.parent) {
    up.bytes += delta.bytes;
    up.entries += delta.entries;
    up.errors += delta.errors;
  }
  announce(job.path, old);
  // Stopped, and that was the last thing still being measured: whoever is
  // left was waiting on the walk that is not going to move.
  if (paused && jobs.every((j) => j === mainJob)) release();
}

function release(): void {
  for (const id of [...watches.keys()]) {
    post(id, { type: 'stopped' });
    finish(id);
  }
}

const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function run(): Promise<void> {
  if (running) return;
  running = true;
  for (;;) {
    // The newest job first: it is the folder somebody just opened.
    let job: Job | undefined;
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (jobs[i] === mainJob && paused) continue;
      job = jobs[i];
      break;
    }
    if (!job) break;

    const until = Date.now() + SLICE_MS;
    while (job.frames.length > 0 && Date.now() < until) {
      for (let i = 0; i < 64 && job.frames.length > 0; i++) step(job);
    }

    const now = Date.now();
    if (job.frames.length === 0) {
      jobs.splice(jobs.indexOf(job), 1);
      settle(job);
    } else if (now - lastProgress >= PROGRESS_MS) {
      lastProgress = now;
      port.postMessage({
        all: true,
        msg: {
          type: 'progress',
          at: job.frames[job.frames.length - 1].path,
          bytes: job.bytes,
          entries: job.entries,
        },
      });
    }
    // Messages from the server only arrive between slices.
    await breathe();
  }
  running = false;
}

/* ------------------------------------------------------------------ */
/* Watching                                                            */
/* ------------------------------------------------------------------ */

function remeasure(path: string, node: Node): void {
  if (jobs.some((j) => j.path === path)) return;
  node.done = false;
  start(path, newNode(node.name, null), node);
}

/**
 * Finds the node for a path, measuring whatever stands in the way: a subtree
 * that was summed and forgotten, a mount the walk stayed out of, a directory
 * made since. Returns nothing when the walk simply has not got there yet.
 */
function locate(path: string, fresh: boolean): Node | undefined {
  const rel = path === rootPath ? '' : path.slice(rootPath === '/' ? 1 : rootPath.length + 1);
  let node = root;
  let at = rootPath;
  for (const name of rel ? rel.split('/') : []) {
    if (!node.done && node.children === null) return undefined;
    if (node.children === null) {
      remeasure(at, node);
      return undefined;
    }
    let child = node.children.find((c) => c.name === name);
    if (!child) {
      if (!node.done) return undefined;
      child = newNode(name, node);
      child.done = true;
      node.children.push(child);
    }
    node = child;
    at = join(at, name);
  }
  if (node.done && node !== root && (fresh || node.children === null)) remeasure(at, node);
  return node;
}

function watch(id: number, path: string, fresh: boolean): void {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(path, { withFileTypes: true });
  } catch (err) {
    port.postMessage({ to: id, close: true, error: (err as Error).message, root: path === rootPath });
    return;
  }

  // Registered before anything is measured, so nothing on the way to this
  // folder is forgotten while it is being looked at.
  watches.set(id, path);
  if (fresh && paused) {
    paused = false;
    port.postMessage({ state: 'scanning' });
  }
  const node = locate(path, fresh);

  const known = new Map<string, Node>();
  for (const child of node?.children ?? []) known.set(child.name, child);

  post(id, { type: 'start', path, children: dirents.length });
  for (const d of dirents) {
    const full = join(path, d.name);
    if (d.isDirectory()) {
      post(id, dirRow(full, known.get(d.name)));
      continue;
    }
    // Files are read now rather than remembered: there are too many to keep,
    // and one directory's worth costs nothing to ask again.
    const row = {
      type: 'child',
      name: d.name,
      path: full,
      kind: d.isSymbolicLink() ? 'symlink' : d.isFile() ? 'file' : 'other',
      bytes: 0,
      entries: 1,
      errors: 0,
    };
    try {
      row.bytes = fs.lstatSync(full).blocks * 512;
    } catch {
      row.errors = 1;
    }
    post(id, row);
  }

  if (node?.done) {
    post(id, { type: 'done', bytes: node.bytes, entries: node.entries, errors: node.errors });
    finish(id);
  } else if (paused && !jobs.some((j) => j !== mainJob)) {
    post(id, { type: 'stopped' });
    finish(id);
  }
  void run();
}

function stop(): void {
  if (!mainJob) return;
  paused = true;
  port.postMessage({ state: 'stopped', at: Date.now() });
  release();
}

port.on('message', (m: { op: string; id: number; path: string; fresh?: boolean }) => {
  if (m.op === 'watch') watch(m.id, m.path, Boolean(m.fresh));
  else if (m.op === 'unwatch') watches.delete(m.id);
  else if (m.op === 'stop') stop();
});

mainJob = start(rootPath, root, null);
void run();
