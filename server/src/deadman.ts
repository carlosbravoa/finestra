/**
 * The session's own clock.
 *
 * A desktop opened by instruction is temporary, and "temporary" has to be
 * enforced somewhere a compromised or simply forgotten control plane cannot
 * undo. So the deadline lives here, in the process itself: it exits when its
 * time is up, and it exits when nobody has been talking to it for a while.
 *
 * A center that is hacked, hung, or shut down mid-session cannot leave a root-
 * capable desktop running on someone's machine, because nothing it does — or
 * fails to do — can extend this. That is the same rule aria applies to its own
 * agent: the control plane proposes, the host disposes, including about how
 * long anything is allowed to live.
 *
 *   WD_SESSION_TTL    seconds from start, then exit no matter what
 *   WD_SESSION_IDLE   seconds without a message from the far side, then exit
 *
 * Unset means unlimited, which is right for a desktop someone started by hand
 * and wrong for one an instruction opened. The instruction sets both.
 */

let lastActivity = Date.now();
let timer: NodeJS.Timeout | null = null;

/** Called for every message that arrives from a client. Must stay cheap. */
export function noteActivity(): void {
  lastActivity = Date.now();
}

export interface DeadmanOptions {
  ttlSec: number;
  idleSec: number;
  /** Overridable so tests do not have to end the test runner. */
  exit?: (code: number) => void;
  log?: (message: string) => void;
}

export function readDeadmanEnv(): { ttlSec: number; idleSec: number } {
  const num = (value: string | undefined): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    ttlSec: num(process.env.WD_SESSION_TTL),
    idleSec: num(process.env.WD_SESSION_IDLE),
  };
}

/**
 * Starts the clock. Returns a stop function, and does nothing at all when
 * neither limit is set — the ordinary long-lived server must not acquire a
 * lifetime it never asked for.
 */
export function startDeadman(options: DeadmanOptions): () => void {
  const { ttlSec, idleSec } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((message: string) => console.log(message));

  if (ttlSec <= 0 && idleSec <= 0) return () => {};

  const startedAt = Date.now();
  lastActivity = startedAt;

  const parts: string[] = [];
  if (ttlSec > 0) parts.push(`${ttlSec}s total`);
  if (idleSec > 0) parts.push(`${idleSec}s idle`);
  log(`  session      time-limited: ${parts.join(', ')}`);

  const stop = (why: string): void => {
    log(`\n  session      ending: ${why}`);
    if (timer) clearInterval(timer);
    timer = null;
    exit(0);
  };

  // A second is fine: this decides when to end a session, not how it feels.
  timer = setInterval(() => {
    const now = Date.now();
    if (ttlSec > 0 && now - startedAt >= ttlSec * 1000) {
      stop(`the ${ttlSec}s limit is up`);
      return;
    }
    if (idleSec > 0 && now - lastActivity >= idleSec * 1000) {
      stop(`nothing for ${idleSec}s`);
    }
  }, 1000);
  // Deliberately *not* unref'd. This timer is the reason the process is
  // allowed to keep running; letting the loop drain without it would mean a
  // session whose deadline never arrives because nothing else was pending.

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
