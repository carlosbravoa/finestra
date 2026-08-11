import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { ServiceError, type ChannelContext, type Service } from '../service.js';

/**
 * The systemd journal: read it, filter it, follow it.
 *
 * `systemd.logs` follows one unit and hands the browser journalctl's own text.
 * This is the other half — the whole journal, filtered the way someone actually
 * looks for something: by boot, by priority, by unit, by a pattern. So entries
 * arrive parsed (`--output=json`) rather than pre-formatted, and the client
 * decides how to show them.
 *
 * Every filter becomes an argv element, never a shell word. Values that reach
 * journalctl unvalidated are only ever passed as `--flag=value`, so a value
 * starting with a dash cannot become an option.
 */

const UNIT_NAME = /^[\w.@\\:-]{1,256}$/;
const IDENTIFIER = /^[\w.@:+-]{1,128}$/;
const BOOT_ID = /^[0-9a-f]{32}$/;
/** journalctl's own cursor syntax: `s=…;i=…;b=…;m=…;t=…;x=…`. */
const CURSOR = /^[0-9a-z]=[0-9a-z]+(;[0-9a-z]=[0-9a-z]+)*$/;

/** How long a batch of entries waits for company before being sent. */
const FLUSH_MS = 120;
/** Entries per flush. A boot storm can outrun any browser; see `drop`. */
const MAX_PER_FLUSH = 500;

/**
 * Fields offered for the filter drop-downs. An allowlist because `-F` takes a
 * field name, and there is no reason for the browser to name an arbitrary one.
 */
const LISTABLE = new Set(['_SYSTEMD_UNIT', '_SYSTEMD_USER_UNIT', 'SYSLOG_IDENTIFIER', '_HOSTNAME']);

export type Scope = 'all' | 'system' | 'user';

export interface JournalEntry {
  cursor: string;
  /** Epoch milliseconds. */
  time: number;
  /** syslog priority, 0 (emerg) to 7 (debug). */
  priority: number;
  message: string;
  unit?: string;
  identifier?: string;
  pid?: number;
  host?: string;
  transport?: string;
}

interface Filters {
  scope: Scope;
  boot: string | null;
  priority: number;
  unit: string | null;
  identifier: string | null;
  grep: string | null;
  since: number | null;
  until: number | null;
  lines: number;
  follow: boolean;
}

/* ------------------------------------------------------------------ */
/* Argument validation                                                 */
/* ------------------------------------------------------------------ */

function validScope(value: unknown): Scope {
  if (value === undefined || value === null || value === 'all') return 'all';
  if (value === 'system' || value === 'user') return value;
  throw new ServiceError('scope must be "all", "system" or "user"', 'EINVAL');
}

function optional(value: unknown, pattern: RegExp, what: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ServiceError(`Bad ${what}`, 'EINVAL');
  }
  return value;
}

/**
 * `boot` is either a boot id from `boots()` or the word "this". "All boots" is
 * the absence of the filter, so it is expressed as null rather than a keyword.
 */
function validBoot(value: unknown): string | null {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  if (value === 'this') return 'this';
  return optional(value, BOOT_ID, 'boot id');
}

function validPriority(value: unknown): number {
  if (value === undefined || value === null || value === '') return 7;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 7) {
    throw new ServiceError('priority must be 0..7', 'EINVAL');
  }
  return n;
}

function validTime(value: unknown, what: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  // Epoch milliseconds, handed to journalctl as `@seconds`: no date parsing,
  // no locale, no timezone argument between the browser and the host.
  if (!Number.isFinite(n) || n < 0) throw new ServiceError(`Bad ${what}`, 'EINVAL');
  return n;
}

/**
 * `--grep` is a PCRE run by journalctl over every candidate entry. Length is
 * capped because a pathological pattern costs host CPU, and no useful search
 * needs more.
 */
function validGrep(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 200) {
    throw new ServiceError('Search pattern is too long', 'EINVAL');
  }
  return value;
}

function validFilters(args: Record<string, unknown> | undefined): Filters {
  const a = args ?? {};
  const until = validTime(a.until, 'until');
  return {
    scope: validScope(a.scope),
    boot: validBoot(a.boot),
    priority: validPriority(a.priority),
    unit: optional(a.unit, UNIT_NAME, 'unit name'),
    identifier: optional(a.identifier, IDENTIFIER, 'identifier'),
    grep: validGrep(a.grep),
    since: validTime(a.since, 'since'),
    until,
    lines: Math.min(Math.max(Number(a.lines) || 500, 1), 10_000),
    // Following a window that has already ended would wait forever for entries
    // that cannot arrive, so an end time turns the stream into a snapshot.
    follow: a.follow !== false && until === null,
  };
}

/* ------------------------------------------------------------------ */
/* Building the command                                                */
/* ------------------------------------------------------------------ */

function scopeArgs(scope: Scope): string[] {
  if (scope === 'system') return ['--system'];
  if (scope === 'user') return ['--user'];
  return [];
}

function selectors(f: Filters): string[] {
  const args = [...scopeArgs(f.scope), '--no-pager', '--output=json'];

  if (f.boot === 'this') args.push('-b');
  else if (f.boot) args.push('-b', f.boot);

  if (f.priority < 7) args.push(`--priority=${f.priority}`);

  // A user unit's entries carry _SYSTEMD_USER_UNIT, which `--unit` does not
  // match; the wrong selector shows an empty journal rather than an error.
  if (f.unit) args.push(f.scope === 'user' ? `--user-unit=${f.unit}` : `--unit=${f.unit}`);
  if (f.identifier) args.push(`--identifier=${f.identifier}`);
  if (f.grep) args.push(`--grep=${f.grep}`);
  if (f.since !== null) args.push(`--since=@${Math.floor(f.since / 1000)}`);
  if (f.until !== null) args.push(`--until=@${Math.floor(f.until / 1000)}`);

  return args;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], timeoutMs = 30_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'journalctl',
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const anyErr = err as (Error & { code?: string | number; killed?: boolean }) | null;
        if (anyErr?.code === 'ENOENT') {
          reject(new ServiceError('This host has no journalctl', 'EUNSUPPORTED'));
          return;
        }
        if (anyErr?.killed) {
          reject(new ServiceError('journalctl timed out', 'ETIMEDOUT'));
          return;
        }
        resolve({ code: typeof anyErr?.code === 'number' ? anyErr.code : anyErr ? 1 : 0, stdout, stderr });
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * A field is usually a string, but the journal stores raw bytes for anything
 * that is not valid UTF-8 and journalctl then emits an array of byte values.
 * A message that arrives as `[80,65,...]` and renders as "80,65" is worse than
 * useless, so those are decoded.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.every((b) => typeof b === 'number')) {
      return Buffer.from(value as number[]).toString('utf8');
    }
    // Repeated fields (a message logged twice under one cursor) come as an
    // array of strings.
    return value.map((v) => text(v)).join('\n');
  }
  return '';
}

function parseEntry(line: string): JournalEntry | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // journalctl writes the odd non-JSON notice into stdout ("-- Reboot --" in
    // some versions). Skipping is right: it is not an entry.
    return null;
  }

  const micros = Number(text(raw.__REALTIME_TIMESTAMP));
  const priority = Number(text(raw.PRIORITY));
  const pid = Number(text(raw._PID));

  return {
    cursor: text(raw.__CURSOR),
    time: Number.isFinite(micros) ? Math.round(micros / 1000) : 0,
    priority: Number.isInteger(priority) && priority >= 0 && priority <= 7 ? priority : 6,
    message: text(raw.MESSAGE),
    unit: text(raw._SYSTEMD_UNIT) || text(raw._SYSTEMD_USER_UNIT) || undefined,
    identifier: text(raw.SYSLOG_IDENTIFIER) || undefined,
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    host: text(raw._HOSTNAME) || undefined,
    transport: text(raw._TRANSPORT) || undefined,
  };
}

/**
 * Reads journalctl's stdout, which arrives in arbitrary chunks, as whole lines.
 * A JSON entry is one line and can be far larger than a pipe buffer, so the
 * tail of every chunk is held back until its newline turns up.
 */
class LineReader {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.onLine(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  flush(): void {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest.length > 0) this.onLine(rest);
  }
}

/* ------------------------------------------------------------------ */
/* The stream                                                          */
/* ------------------------------------------------------------------ */

/**
 * One `stream` channel: the backlog, then — if asked — everything after it.
 *
 * The two phases are separate journalctl runs rather than one `-n N -f`,
 * because `-f` gives no sign of where the backlog ends. Following from the last
 * entry's cursor makes that boundary exact, so the client can say "nothing
 * matched" instead of showing a blank panel that might still be loading.
 */
class JournalStream {
  private child: ChildProcess | null = null;
  private pending: JournalEntry[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastCursor: string | null = null;
  private closed = false;
  /** Seconds since the epoch when the backlog run started; see `follow`. */
  private readonly startedAt = Math.floor(Date.now() / 1000);

  constructor(
    private readonly ctx: ChannelContext,
    private readonly filters: Filters,
  ) {}

  start(): void {
    this.spawn([...selectors(this.filters), '--lines', String(this.filters.lines)], () => {
      if (this.closed) return;
      this.flush();
      this.ctx.send({ type: 'backlog', done: true, following: this.filters.follow });
      if (this.filters.follow) this.follow();
      else this.ctx.close();
    });
  }

  private follow(): void {
    // With a backlog there is an exact place to resume from. Without one, resume
    // from when the backlog run started — not from now — so entries written
    // while it ran are not lost in the gap between the two processes.
    const resume = this.lastCursor
      ? [`--after-cursor=${this.lastCursor}`]
      : [`--since=@${this.startedAt}`, '--lines', '0'];
    this.spawn([...selectors(this.filters), ...resume, '--follow'], () => {
      if (this.closed) return;
      this.flush();
      this.ctx.close();
    });
  }

  private spawn(args: string[], onExit: () => void): void {
    const child = spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    const reader = new LineReader((line) => {
      const entry = parseEntry(line);
      if (entry) this.queue(entry);
    });

    child.stdout?.on('data', (b: Buffer) => reader.push(b));

    // journalctl reports both real failures and a plain hint here — an
    // unprivileged reader is told it is only seeing its own messages, which is
    // exactly what someone staring at a short journal needs to know.
    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-4096);
    });

    child.on('error', (err) => {
      if (!this.closed) this.ctx.close(`journalctl failed: ${err.message}`);
    });

    child.on('exit', (code) => {
      if (this.closed) return;
      this.child = null;
      reader.flush();
      const note = stderr.trim();
      if (code) {
        this.ctx.close(note || `journalctl exited (${code})`);
        return;
      }
      if (note) this.ctx.send({ type: 'note', text: note });
      onExit();
    });
  }

  /**
   * Entries are batched: a boot's worth of backlog is thousands of them, and a
   * message each would spend more time in JSON framing than in the journal.
   * A flood that outruns the batch is counted rather than queued without bound —
   * a browser that is behind gets a truthful gap, not a growing heap.
   */
  private queue(entry: JournalEntry): void {
    this.lastCursor = entry.cursor || this.lastCursor;
    if (this.pending.length >= MAX_PER_FLUSH * 4) {
      this.dropped++;
      return;
    }
    this.pending.push(entry);
    if (this.pending.length >= MAX_PER_FLUSH) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
  }

  private flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0 && this.dropped === 0) return;
    const entries = this.pending;
    const dropped = this.dropped;
    this.pending = [];
    this.dropped = 0;
    this.ctx.send(dropped > 0 ? { type: 'entries', entries, dropped } : { type: 'entries', entries });
  }

  stop(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export const journalService: Service = {
  name: 'journal',

  methods: {
    /**
     * Every boot the journal still holds, oldest first. Used to fill the boot
     * picker, so a host whose journal is not persistent simply offers fewer.
     */
    async boots() {
      const res = await run(['--list-boots', '--output=json', '--no-pager']);
      if (res.code !== 0) {
        throw new ServiceError(res.stderr.trim() || 'Could not list boots', 'EJOURNAL');
      }
      let rows: Array<{ index: number; boot_id: string; first_entry: number; last_entry: number }>;
      try {
        rows = JSON.parse(res.stdout);
      } catch {
        // systemd before v247 has no JSON here. The boot picker then offers
        // only "this boot" and "all boots", which still works.
        return { boots: [] };
      }
      return {
        boots: rows.map((b) => ({
          index: b.index,
          id: b.boot_id,
          first: Math.round(Number(b.first_entry) / 1000),
          last: Math.round(Number(b.last_entry) / 1000),
        })),
      };
    },

    /** Distinct values of one field, for the filter drop-downs. */
    async fields(args: { field?: string; scope?: string; boot?: string }) {
      const field = args?.field;
      if (typeof field !== 'string' || !LISTABLE.has(field)) {
        throw new ServiceError('That field cannot be listed', 'EINVAL');
      }
      const scope = validScope(args?.scope);
      const boot = validBoot(args?.boot);
      const cmd = [...scopeArgs(scope), '--no-pager', '-F', field];
      if (boot === 'this') cmd.push('-b');
      else if (boot) cmd.push('-b', boot);

      const res = await run(cmd);
      if (res.code !== 0) {
        // No entries at all for that field is an error exit, not a failure.
        return { field, values: [] };
      }
      const values = res.stdout
        .split('\n')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
        .sort((a, b) => a.localeCompare(b));
      return { field, values: values.slice(0, 2000) };
    },

    /**
     * Every field of one entry, for the detail panel. The stream carries a
     * compact subset — sending forty fields per line to show one is waste.
     */
    async entry(args: { cursor?: string }) {
      const cursor = optional(args?.cursor, CURSOR, 'cursor');
      if (!cursor) throw new ServiceError('A cursor is required', 'EINVAL');
      const res = await run(['--no-pager', '--output=json', '--lines', '1', `--cursor=${cursor}`]);
      if (res.code !== 0) {
        throw new ServiceError(res.stderr.trim() || 'Could not read that entry', 'EJOURNAL');
      }
      const line = res.stdout.split('\n').find((l) => l.trim().length > 0);
      if (!line) throw new ServiceError('That entry is no longer in the journal', 'ENOENT');
      const raw = JSON.parse(line) as Record<string, unknown>;
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw)) fields[key] = text(value);
      return { fields };
    },
  },

  channels: {
    /** Backlog then follow. The children die with the channel. */
    stream(args: Record<string, unknown>, ctx) {
      const filters = validFilters(args);
      const stream = new JournalStream(ctx, filters);
      // Started after the opener returns, so the handshake reaches the client
      // before the first batch of entries does.
      setImmediate(() => stream.start());
      return {
        info: { ...filters },
        onClose: () => stream.stop(),
      };
    },
  },
};
