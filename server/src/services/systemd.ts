import { execFile, spawn } from 'node:child_process';
import { ServiceError, type Service } from '../service.js';

/**
 * systemd units: list, inspect, control, and follow logs.
 *
 * Everything goes through `systemctl`/`journalctl` with argv arrays and
 * `--output=json` where it exists — no shell, no scraping of human output.
 * Control failures surface systemctl's own stderr (usually polkit's reason),
 * and every control call re-reads the unit state afterwards so the UI reports
 * what actually happened rather than trusting an exit code.
 *
 * Every call takes a `scope`. The system manager needs root or a polkit rule
 * to change anything; the caller's own user manager needs neither, which is
 * what makes `scope: 'user'` worth having.
 */

const UNIT_NAME = /^[\w.@\\:-]{1,256}$/;

export type Scope = 'system' | 'user';

function validScope(value: unknown): Scope {
  if (value === undefined || value === null || value === 'system') return 'system';
  if (value === 'user') return 'user';
  throw new ServiceError('scope must be "system" or "user"', 'EINVAL');
}

/** `--user` where asked for, nothing otherwise. */
function scopeArgs(scope: Scope): string[] {
  return scope === 'user' ? ['--user'] : [];
}

/**
 * `systemctl --user` reaches the caller's session manager over the user bus,
 * which it locates through XDG_RUNTIME_DIR. A server started outside a desktop
 * session — from a system unit, or a bare SSH login — has neither that nor
 * DBUS_SESSION_BUS_ADDRESS, so the standard path is filled in; systemctl
 * derives the bus address from it.
 */
function envFor(scope: Scope): NodeJS.ProcessEnv | undefined {
  if (scope === 'system') return undefined;
  if (process.env.XDG_RUNTIME_DIR || process.env.DBUS_SESSION_BUS_ADDRESS) return undefined;
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  return { ...process.env, XDG_RUNTIME_DIR: `/run/user/${uid}` };
}

/**
 * With no session manager running for this user there is no bus to talk to,
 * which is a different problem from a unit misbehaving and deserves its own
 * explanation rather than a wall of systemctl output.
 */
function assertReachable(scope: Scope, stderr: string): void {
  if (scope === 'user' && /Failed to connect to (?:user scope )?bus/i.test(stderr)) {
    throw new ServiceError(
      'No user session manager is reachable. The desktop server needs to run as a user with a running systemd session (a login, or `loginctl enable-linger`).',
      'ENOUSERBUS',
    );
  }
}

/** Actions we expose. `mask` is deliberately absent — too easy to foot-gun. */
const ACTIONS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable']);

/**
 * Unit names may legitimately begin with a dash — `-.mount` is the root mount —
 * so a name is never rejected for that. What keeps a name from being read as an
 * option is the call site: every invocation either puts the name after `--` or
 * passes it as `--unit=<name>`.
 */
function validUnit(value: unknown): string {
  if (typeof value !== 'string' || !UNIT_NAME.test(value)) {
    throw new ServiceError('Bad unit name', 'EINVAL');
  }
  return value;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: string[],
  scope: Scope = 'system',
  timeoutMs = 60_000,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: envFor(scope) },
      (err, stdout, stderr) => {
        const anyErr = err as (Error & { code?: string | number; killed?: boolean }) | null;
        if (anyErr?.code === 'ENOENT') {
          reject(new ServiceError(`${cmd} is not available on this host`, 'EUNSUPPORTED'));
          return;
        }
        if (anyErr?.killed) {
          reject(new ServiceError(`${cmd} timed out`, 'ETIMEDOUT'));
          return;
        }
        const code = typeof anyErr?.code === 'number' ? anyErr.code : anyErr ? 1 : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

export interface UnitRow {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  /** enabled | disabled | static | masked | generated | ... when known. */
  file?: string;
}

async function listUnits(scope: Scope): Promise<UnitRow[]> {
  const flags = scopeArgs(scope);
  const [units, files] = await Promise.all([
    run('systemctl', [...flags, 'list-units', '--all', '--output=json', '--no-pager'], scope),
    run('systemctl', [...flags, 'list-unit-files', '--output=json', '--no-pager'], scope),
  ]);
  if (units.code !== 0) {
    assertReachable(scope, units.stderr);
    throw new ServiceError(units.stderr.trim() || 'systemctl failed', 'ESYSTEMD');
  }

  const fileState = new Map<string, string>();
  if (files.code === 0) {
    try {
      for (const f of JSON.parse(files.stdout) as Array<{ unit_file: string; state: string }>) {
        fileState.set(f.unit_file, f.state);
      }
    } catch {
      // Older systemd without JSON here; the column just stays empty.
    }
  }

  const rows = JSON.parse(units.stdout) as UnitRow[];
  for (const row of rows) row.file = fileState.get(row.unit);

  // Unit files that are not loaded (disabled, never started) still deserve a
  // row — they are exactly what someone looking to *start* something needs.
  const listed = new Set(rows.map((r) => r.unit));
  for (const [unit, state] of fileState) {
    if (listed.has(unit) || unit.endsWith('@.service')) continue;
    rows.push({ unit, load: '', active: '', sub: '', description: '', file: state });
  }
  return rows;
}

/** `systemctl show` as a key→value map. */
async function showUnit(unit: string, scope: Scope): Promise<Record<string, string>> {
  const res = await run('systemctl', [...scopeArgs(scope), 'show', '--no-pager', '--', unit], scope);
  if (res.code !== 0) {
    assertReachable(scope, res.stderr);
    throw new ServiceError(res.stderr.trim() || `Could not inspect ${unit}`, 'ESYSTEMD');
  }
  const props: Record<string, string> = {};
  for (const line of res.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return props;
}

export const systemdService: Service = {
  name: 'systemd',

  methods: {
    async units(args: { scope?: string }) {
      const scope = validScope(args?.scope);
      return { scope, units: await listUnits(scope) };
    },

    async unit(args: { unit: string; scope?: string }) {
      return showUnit(validUnit(args?.unit), validScope(args?.scope));
    },

    /**
     * Run one control action and report the state the unit actually landed in.
     * A zero exit is not treated as proof of success, and a refusal (polkit,
     * missing unit) surfaces systemctl's own words.
     */
    async control(args: { unit: string; action: string; scope?: string }) {
      const unit = validUnit(args?.unit);
      const scope = validScope(args?.scope);
      const action = args?.action;
      if (typeof action !== 'string' || !ACTIONS.has(action)) {
        throw new ServiceError(`Action not permitted: ${String(action)}`, 'EINVAL');
      }

      const res = await run(
        'systemctl',
        [...scopeArgs(scope), action, '--no-ask-password', '--', unit],
        scope,
      );
      const state = await showUnit(unit, scope).catch(() => ({}) as Record<string, string>);
      const summary = {
        unit,
        scope,
        action,
        active: state.ActiveState ?? '',
        sub: state.SubState ?? '',
        file: state.UnitFileState ?? '',
        result: state.Result ?? '',
      };

      if (res.code !== 0) {
        assertReachable(scope, res.stderr);
        const detail = res.stderr.trim() || `systemctl ${action} exited with ${res.code}`;
        throw new ServiceError(detail, 'ESYSTEMD');
      }
      return summary;
    },

    /**
     * Restart or shut down the machine itself.
     *
     * Two things make this different from every other call here. It ends the
     * connection that asked for it, so the reply has to get out first —
     * `systemctl reboot` returns as soon as logind accepts the job, well before
     * anything stops, which is what makes that possible.
     *
     * And it is the one action whose permission depends on how this service was
     * installed. logind asks polkit, and polkit grants reboot to an *active
     * local session*; a system service has no session at all, so the direct call
     * is refused however privileged the account looks. `sudo -n` is the way
     * through, and it exists only in the privileged install — which is the same
     * boundary as the terminal, where the same person could type the same
     * command. When neither works, the refusal says which install this is
     * rather than repeating polkit's "interactive authentication required" at
     * someone who has no terminal to authenticate on.
     */
    async power(args: { action: string }) {
      const action = args?.action;
      if (action !== 'reboot' && action !== 'poweroff') {
        throw new ServiceError('action must be "reboot" or "poweroff"', 'EINVAL');
      }

      const direct = await run('systemctl', [action, '--no-ask-password'], 'system');
      if (direct.code === 0) return { action, via: 'systemctl' };

      // Only after the direct attempt: on a host where polkit does allow it,
      // nothing here ever needs sudo.
      const canSudo = await run('sudo', ['-n', 'true'], 'system');
      if (canSudo.code === 0) {
        const viaSudo = await run('sudo', ['-n', 'systemctl', action, '--no-ask-password'], 'system');
        if (viaSudo.code === 0) return { action, via: 'sudo' };
        throw new ServiceError(
          viaSudo.stderr.trim() || `sudo systemctl ${action} exited with ${viaSudo.code}`,
          'ESYSTEMD',
        );
      }

      const verb = action === 'reboot' ? 'restart' : 'shut down';
      throw new ServiceError(
        `This desktop is not allowed to ${verb} the machine. It runs unprivileged, ` +
          `so neither logind nor sudo will take the request. ` +
          `Run \`sudo /opt/finestra/current/configure.sh\` on the server to change that, ` +
          `or \`sudo systemctl ${action}\` over SSH.`,
        'EPERM',
      );
    },
  },

  channels: {
    /** Follow a unit's journal. Closes with the window; the child dies with it. */
    logs(args: { unit: string; lines?: number; scope?: string }, ctx) {
      const unit = validUnit(args?.unit);
      const scope = validScope(args?.scope);
      const lines = Math.min(Math.max(Number(args?.lines) || 200, 0), 5000);

      // A user unit's entries do not match `--unit`; journalctl has a separate
      // selector for them, and using the wrong one shows an empty log rather
      // than an error.
      const selector = scope === 'user' ? `--user-unit=${unit}` : `--unit=${unit}`;

      const child = spawn(
        'journalctl',
        [selector, '-n', String(lines), '-f', '--output=short-iso', '--no-pager'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: envFor(scope) },
      );

      child.stdout.on('data', (b: Buffer) => ctx.sendBinary(b));
      child.stderr.on('data', (b: Buffer) => ctx.sendBinary(b));
      child.on('error', (err) => ctx.close(`journalctl failed: ${err.message}`));
      child.on('exit', (code) => ctx.close(code ? `journalctl exited (${code})` : undefined));

      return {
        info: { unit, scope, lines },
        onClose: () => {
          child.kill('SIGTERM');
        },
      };
    },
  },
};
