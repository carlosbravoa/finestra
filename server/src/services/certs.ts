import { X509Certificate } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolvePath } from '../paths.js';
import { ServiceError, type Service } from '../service.js';

/**
 * TLS certificate inventory: scan directories for certificates and report
 * what expires when. Parsing is done with node's own X509 support — nothing
 * is shelled out, and unparseable files are skipped rather than fatal.
 */

const CERT_EXTENSIONS = new Set(['.pem', '.crt', '.cer']);
/** A certificate file has no business being bigger than this. */
const MAX_CERT_FILE = 256 * 1024;
const MAX_DEPTH = 4;
const MAX_FILES = 2000;

export interface CertInfo {
  path: string;
  subject: string;
  issuer: string;
  /** DNS names and IPs from subjectAltName, comma-separated. */
  altNames: string;
  /** Epoch milliseconds. */
  notBefore: number;
  notAfter: number;
  selfSigned: boolean;
}

function firstCN(dn: string): string {
  const m = dn.match(/(?:^|\n)CN=([^\n]+)/);
  return m ? m[1] : dn.replace(/\n/g, ', ');
}

/** Every certificate in one file — a PEM bundle can hold several. */
function parseCerts(filePath: string, raw: Buffer): CertInfo[] {
  const text = raw.toString('utf8');
  const blocks = text.match(
    /-----BEGIN (?:TRUSTED )?CERTIFICATE-----[\s\S]*?-----END (?:TRUSTED )?CERTIFICATE-----/g,
  );
  // No PEM markers: try the whole file as DER.
  const candidates: Array<string | Buffer> = blocks ?? [raw];

  const out: CertInfo[] = [];
  for (const candidate of candidates) {
    try {
      const cert = new X509Certificate(candidate);
      out.push({
        path: filePath,
        subject: firstCN(cert.subject),
        issuer: firstCN(cert.issuer),
        altNames: (cert.subjectAltName ?? '')
          .replace(/DNS:|IP Address:/g, '')
          .trim(),
        notBefore: Date.parse(cert.validFrom),
        notAfter: Date.parse(cert.validTo),
        selfSigned: cert.subject === cert.issuer,
      });
    } catch {
      // A key, a CSR, or garbage with a .pem name — not ours to report.
    }
  }
  return out;
}

async function scanDir(
  dir: string,
  depth: number,
  budget: { files: number },
  out: CertInfo[],
): Promise<void> {
  if (depth > MAX_DEPTH || budget.files <= 0) return;
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // Unreadable directory — /etc/letsencrypt without root, typically.
  }
  for (const d of dirents) {
    if (budget.files <= 0) return;
    const full = path.join(dir, d.name);
    if (d.isDirectory() && !d.isSymbolicLink()) {
      await scanDir(full, depth + 1, budget, out);
    } else if (CERT_EXTENSIONS.has(path.extname(d.name).toLowerCase())) {
      budget.files--;
      try {
        const stat = await fsp.stat(full);
        if (!stat.isFile() || stat.size > MAX_CERT_FILE) continue;
        out.push(...parseCerts(full, await fsp.readFile(full)));
      } catch {
        // Unreadable file; skip it.
      }
    }
  }
}

export const certsService: Service = {
  name: 'certs',

  methods: {
    /** Scan the given directories (and single files) for certificates. */
    async scan(args: { paths: string[] }, ctx) {
      if (!Array.isArray(args?.paths) || args.paths.length === 0) {
        throw new ServiceError('paths must be a non-empty array', 'EINVAL');
      }
      if (args.paths.length > 32) {
        throw new ServiceError('Too many paths in one scan', 'EINVAL');
      }

      const out: CertInfo[] = [];
      const budget = { files: MAX_FILES };
      const missing: string[] = [];

      for (const p of args.paths) {
        const target = resolvePath(p, ctx.config.root);
        let stat;
        try {
          stat = await fsp.stat(target);
        } catch {
          missing.push(target);
          continue;
        }
        if (stat.isDirectory()) {
          await scanDir(target, 0, budget, out);
        } else if (stat.isFile() && stat.size <= MAX_CERT_FILE) {
          out.push(...parseCerts(target, await fsp.readFile(target)));
        }
      }

      // Bundles repeat CA certificates endlessly; report each subject once
      // per file so the list stays about *which file* needs renewing.
      const seen = new Set<string>();
      const unique = out.filter((c) => {
        const key = `${c.path}\0${c.subject}\0${c.notAfter}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      unique.sort((a, b) => a.notAfter - b.notAfter);
      return { certs: unique, missing, truncated: budget.files <= 0 };
    },
  },
};
