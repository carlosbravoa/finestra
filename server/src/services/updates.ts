import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { childEnvironment } from '../child-env.js';
import type { Service } from '../service.js';

/**
 * What this machine could update, asked when somebody asks.
 *
 * Read-only, and never on a timer: every question here is one the package
 * manager answers for an ordinary user, and nothing is installed. Installing
 * wants root and a person watching it, which is a terminal — the report
 * carries the command to type there.
 *
 * The one thing an ordinary user cannot do on apt and zypper is fetch fresh
 * package lists. So that is tried through `sudo -n`, which works where sudo
 * asks no password (most cloud images) and fails at once everywhere else, and
 * the report says which happened and how old the lists it read were. dnf
 * fetches its own as any user. pacman is never refreshed this way: `-Sy`
 * without `-u` is the partial upgrade Arch tells people not to do, and
 * `checkupdates` exists to ask without it.
 *
 * Every parser below was written against output captured from the real tool
 * (Ubuntu 26.04, Debian 12, Rocky 9 with dnf 4, Fedora 41 with dnf 5, Leap
 * 15.5, Arch) and tests/updates.test.ts keeps those captures.
 */

export interface PendingUpdate {
  name: string;
  arch?: string;
  /** Installed version; empty when the tool does not say. */
  current: string;
  available: string;
  /** Repository, suite or channel it comes from. */
  origin?: string;
  security: boolean;
}

export interface UpdateSource {
  id: 'apt' | 'dnf' | 'zypper' | 'pacman' | 'snap' | 'flatpak';
  name: string;
  packages: PendingUpdate[];
  /** The lists were fetched for this check, not read from what was there. */
  fresh: boolean;
  /** When the lists read were last fetched, if not now. Epoch ms. */
  listsAt?: number;
  /** Whether this source can say which updates are security fixes. */
  knowsSecurity: boolean;
  /** Something worth saying that is not a failure. */
  note?: string;
  /** The source could not be asked; `packages` is empty and means nothing. */
  error?: string;
  /** What to type to install them. */
  command: string;
}

export interface UpdateReport {
  checkedAt: number;
  sources: UpdateSource[];
  reboot: { needed: boolean; reasons: string[] };
}

interface Ran {
  /** null when the command does not exist on this machine. */
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], timeoutMs = 180_000): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        // Every one of these prints translated text; the parsers read English.
        env: { ...childEnvironment(), LC_ALL: 'C', LANG: 'C' },
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: string | number; killed?: boolean }) | null;
        if (e?.code === 'ENOENT') return resolve({ code: null, stdout: '', stderr: '' });
        if (e?.killed) return resolve({ code: 124, stdout, stderr: `${cmd} timed out` });
        resolve({ code: typeof e?.code === 'number' ? e.code : e ? 1 : 0, stdout, stderr });
      },
    );
  });
}

const mtime = (path: string): number | undefined => {
  try {
    return fs.statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
};
const newest = (...paths: string[]): number | undefined => {
  const times = paths.map(mtime).filter((t): t is number => t !== undefined);
  return times.length ? Math.max(...times) : undefined;
};
const firstLine = (text: string): string =>
  text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';

/* ------------------------------------------------------------------ */
/* Parsers — pure, so the captured output of each tool can be kept     */
/* ------------------------------------------------------------------ */

/** `apt list --upgradable`: `bash/noble-updates,noble-security 5.2-3 amd64 [upgradable from: 5.2-2]` */
export function parseApt(out: string): PendingUpdate[] {
  const rows: PendingUpdate[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+?)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s*([^\]]+)\]/);
    if (!m) continue;
    const suites = [...new Set(m[2].split(','))];
    rows.push({
      name: m[1],
      arch: m[4],
      current: m[5].trim(),
      available: m[3],
      origin: suites.join(', '),
      security: suites.some((s) => /security/i.test(s)),
    });
  }
  return rows;
}

/**
 * `dnf repoquery --upgrades --qf '%{name}|%{arch}|%{evr}|%{repoid}\n'`.
 * A bar, not a tab: dnf 5 prints `\t` in a format as the two characters.
 * dnf 4 puts a blank line between rows, which is simply skipped.
 */
export function parseDnf(out: string): PendingUpdate[] {
  const rows: PendingUpdate[] = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split('|');
    if (f.length !== 4 || !f[0] || !f[2]) continue;
    rows.push({ name: f[0], arch: f[1], current: '', available: f[2], origin: f[3], security: false });
  }
  return rows;
}

/** `rpm -q --qf '%{NAME}|%{ARCH}|%{EVR}\n'`: what is installed, keyed `name.arch`. */
export function parseRpmInstalled(out: string): Map<string, string> {
  const installed = new Map<string, string>();
  for (const line of out.split('\n')) {
    const f = line.trim().split('|');
    if (f.length === 3) installed.set(`${f[0]}.${f[1]}`, f[2]);
  }
  return installed;
}

/**
 * Security advisories, from `dnf updateinfo list --security` (dnf 4) or
 * `dnf advisory list --security` (dnf 5). Both end each row with the package
 * as name-version-release.arch; the name is what is left of the last two
 * dashes.
 */
export function parseDnfSecurity(out: string): Set<string> {
  const names = new Set<string>();
  for (const line of out.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || !/sec/i.test(line)) continue;
    const nevra = fields.find((f) => /^\S+-[^-\s]+-[^-\s]+\.\w+$/.test(f) && !/^[A-Z]+-\d{4}[:-]/.test(f));
    if (nevra) names.add(nevra.replace(/-[^-]+-[^-]+$/, ''));
  }
  return names;
}

const xmlAttr = (tag: string, name: string): string => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return (m?.[1] ?? '').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
};

/** `zypper --xmlout list-updates`: one `<update kind="package" …>` each. */
export function parseZypper(xml: string): PendingUpdate[] {
  const rows: PendingUpdate[] = [];
  for (const m of xml.matchAll(/<update\s[^>]*>/g)) {
    const tag = m[0];
    if (xmlAttr(tag, 'kind') !== 'package') continue;
    const rest = xml.slice(m.index! + tag.length, m.index! + tag.length + 4000);
    const source = rest.slice(0, rest.indexOf('</update>')).match(/<source\s[^>]*>/)?.[0] ?? '';
    rows.push({
      name: xmlAttr(tag, 'name'),
      arch: xmlAttr(tag, 'arch'),
      current: xmlAttr(tag, 'edition-old'),
      available: xmlAttr(tag, 'edition'),
      origin: xmlAttr(source, 'alias') || undefined,
      security: false,
    });
  }
  return rows;
}

/** How many needed patches `zypper --xmlout list-patches --category security` lists. */
export function countZypperPatches(xml: string): number {
  return [...xml.matchAll(/<update\s[^>]*kind="patch"[^>]*>/g)].length;
}

/** What zypper says went wrong, out of its XML. */
export function zypperError(xml: string): string {
  const m = xml.match(/<message type="error">([\s\S]*?)<\/message>/);
  return m ? firstLine(m[1].replace(/&apos;/g, "'").replace(/\n+/g, ' ')) : '';
}

/** `pacman -Qu` and `checkupdates`: `curl 8.23.0-1 -> 8.23.0-2` */
export function parsePacman(out: string): PendingUpdate[] {
  const rows: PendingUpdate[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+->\s+(\S+)/);
    if (m) rows.push({ name: m[1], current: m[2], available: m[3], security: false });
  }
  return rows;
}

/** `snap refresh --list`: a header, then Name Version Rev Size Publisher Notes. */
export function parseSnap(out: string): PendingUpdate[] {
  const rows: PendingUpdate[] = [];
  for (const line of out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    rows.push({ name: f[0], current: '', available: f[1], origin: f[4].replace(/\*+$/, ''), security: false });
  }
  return rows;
}

/** `snap list`: Name Version Rev Tracking Publisher Notes. */
export function parseSnapInstalled(out: string): Map<string, string> {
  const installed = new Map<string, string>();
  for (const line of out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    // A disabled older revision is listed too; the last row is the active one.
    if (f.length >= 2) installed.set(f[0], f[1]);
  }
  return installed;
}

/** `flatpak … --columns=application,version,branch,origin`: tab-separated, version often empty. */
export function parseFlatpak(out: string): Array<{ app: string; version: string; branch: string; origin: string }> {
  const rows = [];
  for (const line of out.split('\n')) {
    const f = line.split('\t').map((s) => s.trim());
    if (f.length < 3 || !f[0] || !f[0].includes('.')) continue;
    rows.push({ app: f[0], version: f[1], branch: f[2], origin: f[3] ?? '' });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

type SourceResult = UpdateSource | null;

const failed = (
  base: Pick<UpdateSource, 'id' | 'name' | 'command' | 'knowsSecurity'>,
  error: string,
): UpdateSource => ({ ...base, packages: [], fresh: false, error });

/** Fetch new lists as root if that takes no password. True when it did. */
async function refreshAsRoot(cmd: string, args: string[]): Promise<boolean> {
  const r = await run('sudo', ['-n', cmd, ...args], 120_000);
  return r.code === 0;
}

async function apt(): Promise<SourceResult> {
  if (!fs.existsSync('/var/lib/dpkg/status')) return null;
  const base = {
    id: 'apt' as const,
    name: 'APT packages',
    command: 'sudo apt update && sudo apt full-upgrade',
    knowsSecurity: true,
  };
  const fresh = await refreshAsRoot('apt-get', ['update', '-qq']);
  const r = await run('apt', ['list', '--upgradable']);
  if (r.code === null) return null;
  if (r.code !== 0) return failed(base, firstLine(r.stderr) || 'apt could not list updates');
  return {
    ...base,
    packages: parseApt(r.stdout),
    fresh,
    listsAt: fresh
      ? undefined
      : newest('/var/lib/apt/periodic/update-success-stamp', '/var/lib/apt/lists', '/var/lib/apt/lists/partial'),
  };
}

async function dnf(): Promise<SourceResult> {
  const base = {
    id: 'dnf' as const,
    name: 'DNF packages',
    command: 'sudo dnf upgrade --refresh',
    knowsSecurity: true,
  };
  // dnf keeps a cache per user and fills it itself, so this is fresh without root.
  const r = await run('dnf', ['-q', 'repoquery', '--refresh', '--upgrades', '--qf', '%{name}|%{arch}|%{evr}|%{repoid}\n']);
  if (r.code === null) return null;
  if (r.code !== 0) return failed(base, firstLine(r.stderr) || 'dnf could not list updates');
  const packages = parseDnf(r.stdout);

  if (packages.length > 0) {
    const names = [...new Set(packages.map((p) => p.name))];
    const [installed, sec4, sec5] = await Promise.all([
      run('rpm', ['-q', '--qf', '%{NAME}|%{ARCH}|%{EVR}\n', ...names]),
      run('dnf', ['-q', 'updateinfo', 'list', '--security']),
      run('dnf', ['-q', 'advisory', 'list', '--security']),
    ]);
    const have = parseRpmInstalled(installed.stdout);
    const security = new Set([...parseDnfSecurity(sec4.stdout), ...parseDnfSecurity(sec5.stdout)]);
    for (const p of packages) {
      // A kernel is installed beside the old one, under an arch of its own;
      // fall back to any installed build of the name.
      p.current = have.get(`${p.name}.${p.arch}`) ?? have.get(`${p.name}.noarch`) ?? '';
      p.security = security.has(p.name);
    }
  }
  return { ...base, packages, fresh: true };
}

async function zypper(): Promise<SourceResult> {
  const base = {
    id: 'zypper' as const,
    name: 'Zypper packages',
    command: 'sudo zypper refresh && sudo zypper update',
    knowsSecurity: false,
  };
  const probe = await run('zypper', ['--version'], 20_000);
  if (probe.code === null) return null;
  const fresh = await refreshAsRoot('zypper', ['--non-interactive', '--quiet', 'refresh']);
  const r = await run('zypper', ['--non-interactive', '--xmlout', 'list-updates']);
  const packages = parseZypper(r.stdout);
  if (r.code !== 0 && packages.length === 0) {
    return failed(
      base,
      `${zypperError(r.stdout) || firstLine(r.stderr) || 'zypper could not list updates'} — run "sudo zypper refresh" once.`,
    );
  }
  const patches = await run('zypper', ['--non-interactive', '--xmlout', 'list-patches', '--category', 'security']);
  const needed = countZypperPatches(patches.stdout);
  const notes: string[] = [];
  if (needed > 0) notes.push(`${needed} security ${needed === 1 ? 'patch is' : 'patches are'} waiting (sudo zypper patch --category security).`);
  return {
    ...base,
    packages,
    fresh,
    listsAt: fresh ? undefined : newest('/var/cache/zypp/raw', '/var/cache/zypp/solv'),
    note: notes.join(' ') || undefined,
  };
}

async function pacman(): Promise<SourceResult> {
  const base = {
    id: 'pacman' as const,
    name: 'Pacman packages',
    command: 'sudo pacman -Syu',
    knowsSecurity: false,
  };
  // checkupdates syncs into a database of its own and exits 2 for "none".
  const checked = await run('checkupdates', []);
  if (checked.code === 0 || checked.code === 2) {
    return { ...base, packages: parsePacman(checked.stdout), fresh: true };
  }
  const r = await run('pacman', ['-Qu']);
  if (r.code === null) return null;
  // pacman -Qu exits 1 for "nothing to do" as well as for trouble.
  const packages = parsePacman(r.stdout);
  if (r.code !== 0 && packages.length === 0 && /error/i.test(r.stderr)) {
    return failed(base, firstLine(r.stderr));
  }
  return {
    ...base,
    packages,
    fresh: false,
    listsAt: newest('/var/lib/pacman/sync', '/var/lib/pacman/sync/core.db'),
    note:
      checked.code === null
        ? 'Read from the last sync. Install pacman-contrib and this check asks the mirrors itself.'
        : `Read from the last sync; checkupdates failed: ${firstLine(checked.stderr) || 'no reason given'}`,
  };
}

async function snap(): Promise<SourceResult> {
  const base = {
    id: 'snap' as const,
    name: 'Snaps',
    command: 'sudo snap refresh',
    knowsSecurity: false,
  };
  const r = await run('snap', ['refresh', '--list']);
  if (r.code === null) return null;
  if (r.code !== 0) return failed(base, firstLine(r.stderr) || 'snap could not be asked');
  const packages = parseSnap(r.stdout);
  if (packages.length > 0) {
    const have = parseSnapInstalled((await run('snap', ['list'])).stdout);
    for (const p of packages) p.current = have.get(p.name) ?? '';
  }
  return { ...base, packages, fresh: true };
}

async function flatpak(): Promise<SourceResult> {
  const base = {
    id: 'flatpak' as const,
    name: 'Flatpaks',
    command: 'flatpak update',
    knowsSecurity: false,
  };
  const columns = '--columns=application,version,branch,origin';
  const r = await run('flatpak', ['remote-ls', '--updates', columns]);
  if (r.code === null) return null;
  if (r.code !== 0) return failed(base, firstLine(r.stderr) || 'flatpak could not be asked');
  const pending = parseFlatpak(r.stdout);
  if (pending.length === 0) return { ...base, packages: [], fresh: true };
  const have = new Map<string, string>();
  for (const row of parseFlatpak((await run('flatpak', ['list', columns])).stdout)) {
    have.set(`${row.app}/${row.branch}`, row.version);
  }
  return {
    ...base,
    fresh: true,
    packages: pending.map((row) => ({
      name: row.app,
      current: have.get(`${row.app}/${row.branch}`) ?? '',
      // Runtimes carry no version of their own; the branch is all there is.
      available: row.version || `${row.branch} (new build)`,
      origin: row.origin || undefined,
      security: false,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Does it want a reboot                                               */
/* ------------------------------------------------------------------ */

async function rebootNeeded(sources: UpdateSource[]): Promise<UpdateReport['reboot']> {
  const reasons: string[] = [];
  const has = (id: UpdateSource['id']) => sources.some((s) => s.id === id);

  // Debian and Ubuntu: a package's postinst leaves this file.
  if (fs.existsSync('/run/reboot-required')) {
    let why = '';
    try {
      const pkgs = [...new Set(fs.readFileSync('/run/reboot-required.pkgs', 'utf8').split('\n').filter(Boolean))];
      why = pkgs.length ? ` (${pkgs.slice(0, 4).join(', ')}${pkgs.length > 4 ? '…' : ''})` : '';
    } catch {
      // The flag without the list still means what it says.
    }
    reasons.push(`Installed updates are waiting for a restart${why}.`);
  }
  if (fs.existsSync('/run/reboot-needed')) reasons.push('Installed updates are waiting for a restart.');

  if (has('dnf')) {
    // A plugin that is not always there; its absence says nothing either way.
    const r = await run('dnf', ['-q', 'needs-restarting', '-r'], 60_000);
    if (/reboot is required/i.test(r.stdout + r.stderr)) {
      reasons.push('Core libraries or the kernel were updated since this machine started.');
    }
  }
  if (has('zypper') && reasons.length === 0) {
    const r = await run('zypper', ['needs-rebooting'], 60_000);
    if (r.code === 102) reasons.push('Core libraries or the kernel were updated since this machine started.');
  }

  // Works everywhere and is the only sign on Arch: the running kernel's
  // modules are gone, because the package that owned them was replaced.
  const running = os.release();
  if (fs.existsSync('/usr/lib/modules') && !fs.existsSync(`/usr/lib/modules/${running}`)) {
    try {
      if (fs.readdirSync('/usr/lib/modules').length > 0) {
        reasons.push(`The running kernel (${running}) has been replaced by a newer one.`);
      }
    } catch {
      // Unreadable: no claim.
    }
  }
  return { needed: reasons.length > 0, reasons };
}

/* ------------------------------------------------------------------ */

let last: UpdateReport | null = null;
let running: Promise<UpdateReport> | null = null;

async function check(): Promise<UpdateReport> {
  const found = await Promise.all([apt(), dnf(), zypper(), pacman(), snap(), flatpak()]);
  const sources = found.filter((s): s is UpdateSource => s !== null);
  for (const s of sources) s.packages.sort((a, b) => a.name.localeCompare(b.name));
  last = { checkedAt: Date.now(), sources, reboot: await rebootNeeded(sources) };
  return last;
}

export const updatesService: Service = {
  name: 'updates',

  methods: {
    /** The last report, without asking anything again. null before the first. */
    last: () => ({ report: last, checking: running !== null }),

    /** Ask every package manager now. Two people asking at once get one answer. */
    check: () => {
      running ??= check().finally(() => {
        running = null;
      });
      return running;
    },
  },
};
