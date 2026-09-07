import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import * as pty from 'node-pty';
import { isDirectory, isInside } from '../paths.js';
import { ServiceError, type ChannelContext, type OpenedChannel, type Service } from '../service.js';

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
 * How much output a terminal remembers, so a window that comes back can be
 * shown what it missed. Enough for a build log; a training run's progress
 * bars overwrite themselves and cost almost nothing.
 */
const SCROLLBACK_BYTES = 1024 * 1024;

/**
 * A shell and the window that draws it, which are no longer the same thing.
 *
 * A terminal outlives its channel: when the socket drops the shell is kept —
 * running, its output banked — until a window claims it by id or the grace
 * period runs out. The id is a capability: only the browser that started the
 * shell (or restored it from its saved session) knows it, and nothing lists
 * them. `owner` is the connection currently allowed to ask `cwd` and `status`
 * about it, which used to be a per-connection set of pids and is now a
 * property of the terminal, because ownership moves with the window.
 */
interface Term {
  id: string;
  child: pty.IPty;
  shell: string;
  cwd: string;
  alive: boolean;
  owner: string | null;
  /** The channel drawing it, or null while detached. */
  ctx: ChannelContext | null;
  ring: Ring;
  grace: ReturnType<typeof setTimeout> | null;
  /** Marked to outlive the grace period: it waits until someone comes back. */
  keep: boolean;
  /** When the last window left, for a list to say how long it has been alone. */
  detachedAt: number | null;
}

const terminals = new Map<string, Term>();

/**
 * The last `limit` bytes of a stream, addressed by stream offset so a window
 * that saw everything up to byte N can ask for exactly what came after.
 *
 * A circular buffer rather than a list of chunks: interactive output arrives
 * one echoed keystroke at a time, and a million one-byte Buffers cost a
 * hundred times their content in object overhead.
 */
class Ring {
  private buf = Buffer.alloc(16 * 1024);
  private head = 0;
  private len = 0;
  /** Stream offset one past the newest byte. */
  end = 0;

  constructor(private readonly limit: number) {}

  /** Stream offset of the oldest byte still held. */
  get start(): number {
    return this.end - this.len;
  }

  push(data: Buffer): void {
    // Only the tail of a write bigger than the whole ring can matter.
    if (data.length > this.limit) data = data.subarray(data.length - this.limit);
    while (this.len + data.length > this.buf.length && this.buf.length < this.limit) this.grow();

    const overflow = this.len + data.length - this.buf.length;
    if (overflow > 0) {
      this.head = (this.head + overflow) % this.buf.length;
      this.len -= overflow;
    }
    const tail = (this.head + this.len) % this.buf.length;
    const first = Math.min(data.length, this.buf.length - tail);
    data.copy(this.buf, tail, 0, first);
    if (first < data.length) data.copy(this.buf, 0, first);
    this.len += data.length;
    this.end += data.length;
  }

  /** Everything after stream offset `from`, or null once that has been dropped. */
  since(from: number): Buffer | null {
    if (from < this.start) return null;
    if (from >= this.end) return Buffer.alloc(0);
    return this.contents().subarray(from - this.start);
  }

  /**
   * Everything held, and the offset it starts at. Once the oldest bytes have
   * gone the cut falls anywhere — inside an escape sequence, as likely as
   * not — so it moves forward to the first line boundary.
   */
  all(): { bytes: Buffer; offset: number } {
    const bytes = this.contents();
    if (this.start === 0) return { bytes, offset: 0 };
    const nl = bytes.indexOf(0x0a);
    const skip = nl >= 0 ? nl + 1 : 0;
    return { bytes: bytes.subarray(skip), offset: this.start + skip };
  }

  private contents(): Buffer {
    const out = Buffer.alloc(this.len);
    const first = Math.min(this.len, this.buf.length - this.head);
    this.buf.copy(out, 0, this.head, this.head + first);
    if (first < this.len) this.buf.copy(out, first, 0, this.len - first);
    return out;
  }

  private grow(): void {
    const bigger = Buffer.alloc(Math.min(this.limit, this.buf.length * 2));
    this.contents().copy(bigger);
    this.buf = bigger;
    this.head = 0;
  }
}

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

/** How a terminal is described to a window looking for one to pick up. */
interface TerminalSummary {
  id: string;
  pid: number;
  shell: string;
  cwd: string;
  keep: boolean;
  attached: boolean;
  detachedAt: number | null;
  /** What holds the tty, when the shell is not at a prompt. */
  running: string | null;
}

function summarize(term: Term): TerminalSummary {
  const stat = readStat(term.child.pid);
  const running =
    stat && stat.tpgid > 0 && stat.tpgid !== term.child.pid ? commandOf(stat.tpgid) : null;
  return {
    id: term.id,
    pid: term.child.pid,
    shell: term.shell,
    cwd: currentCwd(term),
    keep: term.keep,
    attached: term.ctx !== null,
    detachedAt: term.detachedAt,
    running,
  };
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

    /**
     * Every shell still running, whoever started it. Not restricted to this
     * connection on purpose: the point is a browser that has never seen
     * them — another machine, a cleared session — finding the job left
     * running yesterday. Any connection here already holds the token, and
     * with it the account these shells run as.
     */
    list(): TerminalSummary[] {
      return [...terminals.values()].filter((t) => t.alive).map(summarize);
    },

    /**
     * Whether a terminal waits indefinitely for a window to come back, or
     * only for the grace period. Only its current window may say.
     */
    keep(args: { id?: string; keep?: boolean }, ctx) {
      const term = typeof args?.id === 'string' ? terminals.get(args.id) : undefined;
      if (!term || !term.alive || term.owner !== ctx.sessionId) {
        throw new ServiceError('Unknown terminal', 'ENOPTY');
      }
      term.keep = Boolean(args?.keep);
      return { id: term.id, keep: term.keep };
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

      const term: Term = {
        id: randomUUID(),
        child,
        shell,
        cwd,
        alive: true,
        owner: null,
        ctx: null,
        ring: new Ring(SCROLLBACK_BYTES),
        grace: null,
        keep: false,
        detachedAt: null,
      };
      terminals.set(term.id, term);

      child.onData((data) => {
        const bytes = data as unknown as Buffer;
        term.ring.push(bytes);
        term.ctx?.sendBinary(bytes);
      });

      child.onExit(({ exitCode, signal }) => {
        term.alive = false;
        terminals.delete(term.id);
        if (term.grace) clearTimeout(term.grace);
        term.ctx?.close(
          signal ? `Shell killed by signal ${signal}` : `Shell exited (${exitCode})`,
        );
      });

      return attach(term, ctx, 0);
    },

    /**
     * Picks up a shell left running by a window that went away. `since` is
     * how many bytes of its output the window has already drawn; what came
     * after is replayed, or everything still held when that is out of reach.
     */
    attach: (args: { id?: string; since?: number }, ctx) => {
      const term = typeof args?.id === 'string' ? terminals.get(args.id) : undefined;
      if (!term || !term.alive) throw new ServiceError('That terminal is gone', 'ENOPTY');
      const since = Number.isInteger(args?.since) && args.since! >= 0 ? args.since! : 0;
      return attach(term, ctx, since);
    },
  },
};

/**
 * Hands a terminal to a channel. The newest window wins, as with
 * `tmux attach -d`: the most recent claim is the best evidence of where the
 * person is, and the window it displaces is told rather than left hanging.
 */
function attach(term: Term, ctx: ChannelContext, since: number): OpenedChannel {
  const previous = term.ctx;
  if (previous) {
    // Cleared first, so the displaced channel's onClose sees it no longer
    // holds the terminal and leaves the shell alone.
    term.ctx = null;
    term.owner = null;
    previous.close('Attached from another window');
  }
  if (term.grace) {
    clearTimeout(term.grace);
    term.grace = null;
  }
  term.ctx = ctx;
  term.owner = ctx.sessionId;
  term.detachedAt = null;

  let replay = term.ring.since(since);
  let offset = since;
  let mode: 'partial' | 'full' = 'partial';
  if (!replay) {
    ({ bytes: replay, offset } = term.ring.all());
    mode = 'full';
  }
  // A full replay is a fresh window drawing from a buffer that started
  // mid-history, and a full-screen program's state may not all be in it. The
  // program can redraw itself, but only tells it to on SIGWINCH — which a
  // window the same size as before never causes. So the first resize after
  // a full replay goes through a wrong size on its way to the right one, the
  // trick tmux uses for the same reason.
  let repaint = mode === 'full';
  // After the `opened` message, which the session sends once this returns —
  // the window resets itself on a full replay, and would wipe bytes that
  // arrived first.
  const bytes = replay;
  setImmediate(() => {
    if (term.ctx === ctx && bytes.length) ctx.sendBinary(bytes);
  });

  return {
    info: {
      id: term.id,
      pid: term.child.pid,
      shell: term.shell,
      cwd: currentCwd(term),
      keep: term.keep,
      replay: mode,
      offset,
    },

    onData(data: unknown) {
      if (!term.alive) return;
      if (data instanceof Uint8Array) term.child.write(Buffer.from(data).toString('utf8'));
      else if (typeof data === 'string') term.child.write(data);
    },

    onCtl(method: string, ctlArgs: any) {
      if (!term.alive) return;
      if (method === 'resize') {
        const cols = clamp(ctlArgs?.cols ?? 80, 1, 1000);
        const rows = clamp(ctlArgs?.rows ?? 24, 1, 1000);
        if (repaint) {
          repaint = false;
          term.child.resize(cols, rows === 1 ? 2 : rows - 1);
          // Not back-to-back: the program would see only the final size,
          // find it unchanged, and draw nothing.
          setTimeout(() => {
            if (term.alive && term.ctx === ctx) term.child.resize(cols, rows);
          }, 50);
          return;
        }
        term.child.resize(cols, rows);
      } else if (method === 'signal') {
        // node-pty's kill() sends to the whole process group.
        term.child.kill(typeof ctlArgs?.name === 'string' ? ctlArgs.name : 'SIGTERM');
      }
    },

    onClose(lost?: boolean) {
      // Displaced by a newer window: the shell is theirs now.
      if (term.ctx !== ctx) return;
      term.ctx = null;
      term.owner = null;
      if (!term.alive) return;

      const grace = ctx.config.terminalGrace;
      if (lost && (term.keep || grace > 0)) {
        term.detachedAt = Date.now();
        if (!term.keep) {
          term.grace = setTimeout(() => hangUp(term), grace * 1000);
          term.grace.unref();
        }
        return;
      }
      hangUp(term);
    },
  };
}

/** SIGHUP, which is what a terminal emulator does when its window closes. */
function hangUp(term: Term): void {
  if (!term.alive) return;
  term.alive = false;
  try {
    term.child.kill();
  } catch {
    // Already gone.
  }
}

function currentCwd(term: Term): string {
  try {
    return fs.readlinkSync(`/proc/${term.child.pid}/cwd`);
  } catch {
    return term.cwd;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(Number(n) || lo)));
}

/**
 * Validates that this connection holds the terminal before /proc is
 * consulted. A detached terminal has no holder, so nobody can ask about it
 * until a window claims it.
 */
function ownedPid(value: unknown, sessionId: string): number {
  const pid = Number(value);
  let owned = false;
  for (const term of terminals.values()) {
    if (term.child.pid === pid && term.owner === sessionId) owned = true;
  }
  if (!Number.isInteger(pid) || !owned) {
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
