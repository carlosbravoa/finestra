import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { ServiceError, type Service } from '../service.js';

/**
 * Process listing and control, read from /proc.
 *
 * `list` is a snapshot with cumulative CPU ticks; the client keeps its previous
 * snapshot and turns tick deltas into percentages, the same way top does.
 */

/* Both are almost always 4096 and 100; getconf corrects the exceptions. */
let pageSize = 4096;
let clockTicks = 100;
execFile('getconf', ['PAGESIZE'], (err, stdout) => {
  const n = Number(stdout?.trim());
  if (!err && Number.isFinite(n) && n > 0) pageSize = n;
});
execFile('getconf', ['CLK_TCK'], (err, stdout) => {
  const n = Number(stdout?.trim());
  if (!err && Number.isFinite(n) && n > 0) clockTicks = n;
});

/** Signals a browser is allowed to send. Nothing exotic, nothing numeric. */
const ALLOWED_SIGNALS = new Set([
  'SIGTERM',
  'SIGKILL',
  'SIGINT',
  'SIGHUP',
  'SIGSTOP',
  'SIGCONT',
  'SIGUSR1',
  'SIGUSR2',
]);

export interface ProcRow {
  pid: number;
  ppid: number;
  /** Executable name from /proc/pid/comm. */
  name: string;
  /** Single-letter state: R, S, D, Z, T, ... */
  state: string;
  /** Cumulative user+system CPU ticks. */
  ticks: number;
  /** Resident set size in bytes. */
  rss: number;
  threads: number;
  uid: number;
  user: string;
  /** Full command line, NULs turned into spaces. Empty for kernel threads. */
  cmdline: string;
}

/* uid → username, from /etc/passwd, re-read when the file changes. */
let userCache = new Map<number, string>();
let passwdMtime = 0;

function usernames(): Map<number, string> {
  try {
    const mtime = fs.statSync('/etc/passwd').mtimeMs;
    if (mtime !== passwdMtime) {
      passwdMtime = mtime;
      userCache = new Map();
      for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
        const parts = line.split(':');
        if (parts.length >= 3) userCache.set(Number(parts[2]), parts[0]);
      }
    }
  } catch {
    // No passwd file; uids will be shown bare.
  }
  return userCache;
}

/**
 * One process, or null if it vanished mid-read — pids come and go while the
 * directory is being walked, and that is not an error.
 */
function readProc(pid: number, users: Map<number, string>): ProcRow | null {
  let stat: string;
  let uid: number;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    uid = fs.statSync(`/proc/${pid}`).uid;
  } catch {
    return null;
  }

  // comm sits in parentheses and may contain both spaces and ')', so the
  // parse anchors on the *last* ')' in the line.
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  const name = stat.slice(open + 1, close);
  const f = stat.slice(close + 1).trim().split(/\s+/);
  // f[0]=state f[1]=ppid f[11]=utime f[12]=stime f[17]=num_threads f[21]=rss
  if (f.length < 22) return null;

  let cmdline = '';
  try {
    cmdline = fs
      .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .replace(/\0+$/, '')
      .replace(/\0/g, ' ')
      .slice(0, 2048);
  } catch {
    // Gone, or a kernel thread.
  }

  return {
    pid,
    ppid: Number(f[1]),
    name,
    state: f[0],
    ticks: Number(f[11]) + Number(f[12]),
    rss: Number(f[21]) * pageSize,
    threads: Number(f[17]),
    uid,
    user: users.get(uid) ?? String(uid),
    cmdline,
  };
}

function validPid(value: unknown): number {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new ServiceError('A process id is required', 'EINVAL');
  }
  return pid;
}

export const procService: Service = {
  name: 'proc',

  methods: {
    list() {
      if (process.platform !== 'linux') {
        throw new ServiceError('Process listing requires /proc', 'EUNSUPPORTED');
      }
      const users = usernames();
      const rows: ProcRow[] = [];
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const row = readProc(Number(entry), users);
        if (row) rows.push(row);
      }
      return {
        time: Date.now(),
        hertz: clockTicks,
        cores: os.cpus().length,
        memTotal: os.totalmem(),
        /** The desktop server itself, so the UI can badge its own subtree. */
        self: process.pid,
        rows,
      };
    },

    /** Everything worth a details panel. Unreadable parts come back missing. */
    async detail(args: { pid: number }) {
      const pid = validPid(args?.pid);
      const users = usernames();
      const row = readProc(pid, users);
      if (!row) throw new ServiceError('No such process', 'ESRCH');

      const link = async (name: string): Promise<string | null> => {
        try {
          return await fsp.readlink(`/proc/${pid}/${name}`);
        } catch {
          return null; // Typically EACCES on someone else's process.
        }
      };

      let fds: Array<{ fd: number; target: string }> | null = null;
      try {
        const names = await fsp.readdir(`/proc/${pid}/fd`);
        // Cap the readlinks: a process can hold tens of thousands of fds.
        fds = await Promise.all(
          names.slice(0, 512).map(async (n) => ({
            fd: Number(n),
            target: (await link(`fd/${n}`)) ?? '?',
          })),
        );
        fds.sort((a, b) => a.fd - b.fd);
      } catch {
        // Not ours to inspect.
      }

      return {
        ...row,
        cwd: await link('cwd'),
        exe: await link('exe'),
        fds,
        fdCount: fds?.length ?? null,
      };
    },

    /**
     * Send a signal. Deliberately narrow: known signal names only, never
     * pid 1, and never the desktop server itself — killing it from a window
     * it hosts would look like a desktop crash, not a kill.
     */
    kill(args: { pid: number; signal?: string }) {
      const pid = validPid(args?.pid);
      const signal = args?.signal ?? 'SIGTERM';
      if (!ALLOWED_SIGNALS.has(signal)) {
        throw new ServiceError(`Signal not permitted: ${signal}`, 'EINVAL');
      }
      if (pid === 1) {
        throw new ServiceError('Refusing to signal init', 'EPERM');
      }
      if (pid === process.pid) {
        throw new ServiceError(
          'That is the desktop server itself; stop it from the terminal instead',
          'EPERM',
        );
      }
      try {
        process.kill(pid, signal as NodeJS.Signals);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') throw new ServiceError('No such process', 'ESRCH');
        if (code === 'EPERM') {
          throw new ServiceError('Not permitted to signal that process', 'EPERM');
        }
        throw err;
      }
      return { pid, signal };
    },
  },
};
