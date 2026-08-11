import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { ServiceError, type Service } from '../service.js';

/**
 * Sockets with their owning processes, read from /proc/net — the same data
 * `ss -tunap` shows, without scraping its human-formatted output.
 *
 * Owning processes are found by walking /proc/<pid>/fd for socket inodes,
 * which only works for processes this user may inspect; the rest keep their
 * uid so the UI can at least say whose they are.
 */

const TCP_STATES: Record<string, string> = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
};

export interface SocketRow {
  proto: 'tcp' | 'tcp6' | 'udp' | 'udp6';
  local: string;
  localPort: number;
  remote: string;
  remotePort: number;
  /** LISTEN, ESTABLISHED, ... UDP with no peer is reported as UNCONN. */
  state: string;
  uid: number;
  inode: number;
  pid?: number;
  /** Process name, when the owner could be identified. */
  process?: string;
}

/** /proc/net addresses are hex, little-endian within each 4-byte group. */
function parseAddr(hex: string): string {
  if (hex.length === 8) {
    const bytes = [];
    for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    return bytes.join('.');
  }
  // IPv6: four 32-bit groups, each byte-swapped.
  const parts: string[] = [];
  for (let g = 0; g < 4; g++) {
    const group = hex.slice(g * 8, g * 8 + 8);
    for (let i = 6; i >= 0; i -= 2) {
      parts.push(group.slice(i, i + 2));
    }
  }
  const hextets = [];
  for (let i = 0; i < 16; i += 2) hextets.push(parts[i] + parts[i + 1]);
  const addr = hextets
    .map((x) => parseInt(x, 16).toString(16))
    .join(':')
    .replace(/(^|:)(0:)+0(:|$)/, '::');
  // An IPv4-mapped address reads better in its dotted form.
  const mapped = addr.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (mapped) {
    const n = (parseInt(mapped[1], 16) << 16) | parseInt(mapped[2], 16);
    return `::ffff:${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
  }
  return addr;
}

function parseFile(proto: SocketRow['proto'], raw: string): SocketRow[] {
  const rows: SocketRow[] = [];
  const isUdp = proto.startsWith('udp');
  for (const line of raw.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [localAddr, localPortHex] = f[1].split(':');
    const [remoteAddr, remotePortHex] = f[2].split(':');
    if (!localPortHex || !remotePortHex) continue;
    const state = TCP_STATES[f[3]] ?? f[3];
    rows.push({
      proto,
      local: parseAddr(localAddr),
      localPort: parseInt(localPortHex, 16),
      remote: parseAddr(remoteAddr),
      remotePort: parseInt(remotePortHex, 16),
      // For UDP the kernel reports CLOSE for a plain bound socket.
      state: isUdp && state === 'CLOSE' ? 'UNCONN' : state,
      uid: Number(f[7]),
      inode: Number(f[9]),
    });
  }
  return rows;
}

/** socket-inode → owning process, for every pid this user may inspect. */
async function socketOwners(wanted: Set<number>): Promise<Map<number, { pid: number; process: string }>> {
  const owners = new Map<number, { pid: number; process: string }>();
  let pids: string[];
  try {
    pids = (await fsp.readdir('/proc')).filter((n) => /^\d+$/.test(n));
  } catch {
    return owners;
  }

  await Promise.all(
    pids.map(async (entry) => {
      const pid = Number(entry);
      let fds: string[];
      try {
        fds = await fsp.readdir(`/proc/${pid}/fd`);
      } catch {
        return; // Not ours to look at.
      }
      let name: string | null = null;
      for (const fd of fds) {
        let target: string;
        try {
          target = await fsp.readlink(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        const m = target.match(/^socket:\[(\d+)\]$/);
        if (!m) continue;
        const inode = Number(m[1]);
        if (!wanted.has(inode) || owners.has(inode)) continue;
        if (name === null) {
          try {
            name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
          } catch {
            name = `pid ${pid}`;
          }
        }
        owners.set(inode, { pid, process: name });
      }
    }),
  );
  return owners;
}

export const netService: Service = {
  name: 'net',

  methods: {
    async sockets() {
      if (process.platform !== 'linux') {
        throw new ServiceError('Socket listing requires /proc', 'EUNSUPPORTED');
      }
      const rows: SocketRow[] = [];
      for (const proto of ['tcp', 'tcp6', 'udp', 'udp6'] as const) {
        try {
          rows.push(...parseFile(proto, await fsp.readFile(`/proc/net/${proto}`, 'utf8')));
        } catch {
          // Protocol not compiled in; nothing to list.
        }
      }

      const owners = await socketOwners(new Set(rows.map((r) => r.inode)));
      for (const row of rows) {
        const owner = owners.get(row.inode);
        if (owner) {
          row.pid = owner.pid;
          row.process = owner.process;
        }
      }
      return { time: Date.now(), sockets: rows };
    },
  },
};
