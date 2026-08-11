import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { HostInfo } from '../../../shared/protocol.js';
import type { Service } from '../service.js';
import { buildInfo } from '../version.js';
import { availableShells } from './pty.js';

export function hostInfo(): HostInfo {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    user: os.userInfo().username,
    home: os.homedir(),
    shells: availableShells(),
    build: buildInfo(),
  };
}

/** Cumulative busy/total jiffies, for turning two samples into a percentage. */
function cpuTotals(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

let lastSample = cpuTotals();

export interface NetTotals {
  /** Interface name. */
  name: string;
  /** Cumulative bytes received/sent since boot. */
  rx: number;
  tx: number;
}

/**
 * Cumulative traffic per real interface. Totals, not rates — the client keeps
 * the previous sample and divides by its own elapsed time, which stays honest
 * across missed polls.
 */
function netTotals(): NetTotals[] {
  let raw: string;
  try {
    raw = fs.readFileSync('/proc/net/dev', 'utf8');
  } catch {
    return [];
  }
  const out: NetTotals[] = [];
  for (const line of raw.split('\n').slice(2)) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (name === 'lo') continue;
    const fields = m[2].trim().split(/\s+/).map(Number);
    if (fields.length < 16) continue;
    out.push({ name, rx: fields[0], tx: fields[8] });
  }
  return out;
}

/** Whole physical disks; partitions and virtual devices would double-count. */
function isWholeDisk(name: string): boolean {
  if (/^(loop|ram|zram|sr|fd|md|dm-)/.test(name)) return false;
  if (/^nvme\d+n\d+p\d+$/.test(name)) return false;
  if (/^mmcblk\d+p\d+$/.test(name)) return false;
  if (/^(sd|vd|hd|xvd)[a-z]+\d+$/.test(name)) return false;
  return true;
}

/** Cumulative bytes read/written across physical disks, from /proc/diskstats. */
function diskTotals(): { read: number; written: number } {
  let raw: string;
  try {
    raw = fs.readFileSync('/proc/diskstats', 'utf8');
  } catch {
    return { read: 0, written: 0 };
  }
  let read = 0;
  let written = 0;
  for (const line of raw.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14) continue;
    const name = f[2];
    if (!isWholeDisk(name)) continue;
    // Fields 5 and 9 are sectors read/written; a sector is always 512 bytes here.
    read += Number(f[5]) * 512;
    written += Number(f[9]) * 512;
  }
  return { read, written };
}

export interface TempReading {
  /** "coretemp: Package id 0", or just the chip name. */
  label: string;
  /** Degrees Celsius. */
  c: number;
}

/**
 * Temperature sensors from /sys/class/hwmon. The directory layout is stable;
 * missing labels fall back to the chip name.
 */
function temperatures(): TempReading[] {
  const out: TempReading[] = [];
  let chips: string[];
  try {
    chips = fs.readdirSync('/sys/class/hwmon');
  } catch {
    return out;
  }
  for (const chip of chips) {
    const dir = `/sys/class/hwmon/${chip}`;
    let name = chip;
    try {
      name = fs.readFileSync(`${dir}/name`, 'utf8').trim();
    } catch {
      // Keep the directory name.
    }
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const m = file.match(/^temp(\d+)_input$/);
      if (!m) continue;
      try {
        const milli = Number(fs.readFileSync(`${dir}/${file}`, 'utf8').trim());
        if (!Number.isFinite(milli)) continue;
        let label = name;
        try {
          const l = fs.readFileSync(`${dir}/temp${m[1]}_label`, 'utf8').trim();
          if (l) label = `${name}: ${l}`;
        } catch {
          // No label file for this sensor.
        }
        out.push({ label, c: milli / 1000 });
      } catch {
        // Sensor read can fail transiently; skip it.
      }
    }
  }
  return out;
}

export interface MountUsage {
  mount: string;
  device: string;
  fstype: string;
  total: number;
  used: number;
  avail: number;
}

/**
 * Read-only image mounts. A machine with snaps installed has dozens of these,
 * every one of them permanently 100% full, which is noise in a panel whose job
 * is answering "what filled the disk".
 */
const IMAGE_FSTYPES = new Set(['squashfs', 'iso9660', 'erofs']);

/** Disk usage of real (device-backed, writable) mounted filesystems. */
async function filesystems(): Promise<MountUsage[]> {
  let raw: string;
  try {
    raw = await fsp.readFile('/proc/mounts', 'utf8');
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const mounts: Array<{ device: string; mount: string; fstype: string }> = [];
  for (const line of raw.split('\n')) {
    const [device, mount, fstype] = line.split(' ');
    if (!device || !mount || !device.startsWith('/dev/')) continue;
    if (IMAGE_FSTYPES.has(fstype)) continue;
    // A device mounted twice (bind mounts, btrfs subvolumes) counts once.
    if (seen.has(device)) continue;
    seen.add(device);
    // Octal escapes in mount paths ("\040" for space) per proc(5).
    const decoded = mount.replace(/\\(\d{3})/g, (_, oct) =>
      String.fromCharCode(parseInt(oct, 8)),
    );
    mounts.push({ device, mount: decoded, fstype });
  }

  const out: MountUsage[] = [];
  await Promise.all(
    mounts.map(async ({ device, mount, fstype }) => {
      try {
        const s = await fsp.statfs(mount);
        const total = s.blocks * s.bsize;
        if (total <= 0) return;
        out.push({
          mount,
          device,
          fstype,
          total,
          used: (s.blocks - s.bfree) * s.bsize,
          avail: s.bavail * s.bsize,
        });
      } catch {
        // Stale or unreadable mount; leave it out.
      }
    }),
  );
  out.sort((a, b) => a.mount.localeCompare(b.mount));
  return out;
}

/** Host telemetry, for the taskbar and the system-manager app. */
export const sysService: Service = {
  name: 'sys',

  methods: {
    info: () => hostInfo(),

    stats: () => {
      const sample = cpuTotals();
      const busyDelta = sample.busy - lastSample.busy;
      const totalDelta = sample.total - lastSample.total;
      lastSample = sample;

      const totalMem = os.totalmem();
      const freeMem = os.freemem();

      return {
        // First call after start has no previous sample to compare against.
        cpu: totalDelta > 0 ? busyDelta / totalDelta : 0,
        cores: os.cpus().length,
        loadAvg: os.loadavg(),
        memTotal: totalMem,
        memUsed: totalMem - freeMem,
        uptime: os.uptime(),
        /** Server clock at sampling time, for turning totals into rates. */
        time: Date.now(),
        net: netTotals(),
        disk: diskTotals(),
        temps: temperatures(),
      };
    },

    filesystems: () => filesystems(),
  },
};
