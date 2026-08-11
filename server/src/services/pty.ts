import fs from 'node:fs';
import os from 'node:os';
import * as pty from 'node-pty';
import { isDirectory, isInside } from '../paths.js';
import { ServiceError, type Service } from '../service.js';

/** Shells we offer, best first. Only those that actually exist are reported. */
const CANDIDATE_SHELLS = [
  process.env.SHELL,
  '/bin/bash',
  '/usr/bin/bash',
  '/bin/zsh',
  '/usr/bin/zsh',
  '/bin/fish',
  '/bin/sh',
].filter((s): s is string => Boolean(s));

/**
 * PTY pids per connection, so `cwd` can only be asked about shells that this
 * client actually started. Entries are removed when their channel closes.
 */
const sessionPids = new Map<string, Set<number>>();

export function availableShells(): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const shell of CANDIDATE_SHELLS) {
    if (seen.has(shell)) continue;
    seen.add(shell);
    try {
      fs.accessSync(shell, fs.constants.X_OK);
      found.push(shell);
    } catch {
      // Not installed on this host.
    }
  }
  return found.length ? found : ['/bin/sh'];
}

interface SpawnArgs {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Extra environment for the child, merged over the server's own. */
  env?: Record<string, string>;
}

/**
 * Real pseudo-terminals. Output is pushed as binary frames so that a fast
 * `find /` does not spend its time being JSON-escaped, and so xterm.js can
 * reassemble UTF-8 sequences split across writes itself.
 */
export const ptyService: Service = {
  name: 'pty',

  methods: {
    shells: () => availableShells(),

    /**
     * The shell's current working directory, so a terminal can be reopened
     * where it was left. Restricted to PTYs this session started: the answer
     * comes from /proc, which would otherwise expose any process on the host.
     */
    cwd(args: { pid: number }, ctx) {
      const pid = ownedPid(args?.pid, ctx.sessionId);
      try {
        return { pid, cwd: fs.readlinkSync(`/proc/${pid}/cwd`) };
      } catch (err) {
        // The shell may have exited between the check and the read.
        throw new ServiceError((err as Error).message, 'ENOENT');
      }
    },

    /**
     * What, if anything, is running in a terminal — so the UI can close an
     * idle one without nagging, and name what it would kill otherwise.
     *
     * `foreground` is derived from the tty's foreground process group, the
     * same signal a normal terminal emulator uses: while the shell is at a
     * prompt it owns the foreground group itself.
     */
    status(args: { pid: number }, ctx) {
      const pid = ownedPid(args?.pid, ctx.sessionId);

      const stat = readStat(pid);
      if (!stat) throw new ServiceError('Terminal is gone', 'ENOENT');

      // tpgid == pid means the shell itself holds the terminal: a prompt.
      const foreground =
        stat.tpgid > 0 && stat.tpgid !== pid
          ? { pid: stat.tpgid, command: commandOf(stat.tpgid) }
          : null;

      // Background jobs survive at a prompt but still die with the shell.
      const jobs = childrenOf(pid)
        .filter((child) => child !== foreground?.pid)
        .map((child) => ({ pid: child, command: commandOf(child) }));

      return { pid, foreground, jobs, busy: foreground !== null || jobs.length > 0 };
    },
  },

  channels: {
    spawn: (args: SpawnArgs, ctx) => {
      const shells = availableShells();
      // Only shells the host actually advertises, so a request cannot name an
      // arbitrary binary to execute.
      const shell = args?.shell && shells.includes(args.shell) ? args.shell : shells[0];

      const home = os.homedir();
      let cwd = args?.cwd || home;
      if (!isDirectory(cwd)) cwd = home;
      if (ctx.config.root && !isInside(cwd, ctx.config.root)) cwd = ctx.config.root;

      const cols = clamp(args?.cols ?? 80, 1, 1000);
      const rows = clamp(args?.rows ?? 24, 1, 1000);

      let child: pty.IPty;
      try {
        child = pty.spawn(shell, ['-l'], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          // Buffers rather than strings: we forward the bytes untouched.
          encoding: null as unknown as undefined,
          env: {
            ...(process.env as Record<string, string>),
            ...(args?.env ?? {}),
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            WEB_DESKTOP: '1',
          },
        });
      } catch (err) {
        throw new ServiceError(
          `Could not start ${shell}: ${(err as Error).message}`,
          'ESPAWN',
        );
      }

      let alive = true;

      let pids = sessionPids.get(ctx.sessionId);
      if (!pids) {
        pids = new Set();
        sessionPids.set(ctx.sessionId, pids);
      }
      pids.add(child.pid);

      const forgetPid = () => {
        const set = sessionPids.get(ctx.sessionId);
        if (!set) return;
        set.delete(child.pid);
        if (set.size === 0) sessionPids.delete(ctx.sessionId);
      };

      child.onData((data) => {
        ctx.sendBinary(data as unknown as Uint8Array);
      });

      child.onExit(({ exitCode, signal }) => {
        alive = false;
        forgetPid();
        ctx.close(
          signal ? `Shell killed by signal ${signal}` : `Shell exited (${exitCode})`,
        );
      });

      return {
        info: { pid: child.pid, shell, cwd, cols, rows },

        onData(data: unknown) {
          if (!alive) return;
          if (data instanceof Uint8Array) child.write(Buffer.from(data).toString('utf8'));
          else if (typeof data === 'string') child.write(data);
        },

        onCtl(method: string, ctlArgs: any) {
          if (!alive) return;
          if (method === 'resize') {
            child.resize(clamp(ctlArgs?.cols ?? cols, 1, 1000), clamp(ctlArgs?.rows ?? rows, 1, 1000));
          } else if (method === 'signal') {
            // node-pty's kill() sends to the whole process group.
            child.kill(typeof ctlArgs?.name === 'string' ? ctlArgs.name : 'SIGTERM');
          }
        },

        onClose() {
          forgetPid();
          if (!alive) return;
          alive = false;
          try {
            child.kill();
          } catch {
            // Already gone.
          }
        },
      };
    },
  },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(Number(n) || lo)));
}

/** Validates that this connection owns the pid before /proc is consulted. */
function ownedPid(value: unknown, sessionId: string): number {
  const pid = Number(value);
  if (!Number.isInteger(pid) || !sessionPids.get(sessionId)?.has(pid)) {
    throw new ServiceError('Unknown terminal', 'ENOPTY');
  }
  return pid;
}

/**
 * `/proc/<pid>/stat`, far enough in to reach tpgid.
 *
 * The second field is the executable name in parentheses and may itself
 * contain spaces and parentheses, so parsing starts after the *last* ')'
 * rather than splitting the whole line.
 */
function readStat(pid: number): { ppid: number; pgrp: number; tpgid: number } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const afterComm = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
  // Fields from here: state, ppid, pgrp, session, tty_nr, tpgid.
  if (afterComm.length < 6) return null;
  return {
    ppid: Number(afterComm[1]),
    pgrp: Number(afterComm[2]),
    tpgid: Number(afterComm[5]),
  };
}

function commandOf(pid: number): string {
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    if (comm) return comm;
  } catch {
    // Fall through to the cmdline, then to a placeholder.
  }
  try {
    const argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0];
    if (argv0) return argv0.split('/').pop() ?? argv0;
  } catch {
    // Process exited while we were looking at it.
  }
  return `pid ${pid}`;
}

/** Direct children of the shell: background jobs, and anything it spawned. */
function childrenOf(pid: number): number[] {
  try {
    return fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    // Not built with CONFIG_PROC_CHILDREN, or the shell is already gone.
    return [];
  }
}
