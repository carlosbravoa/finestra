import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildInfo } from '../../shared/protocol.js';

/**
 * What version this is, answered from whatever the running layout can prove.
 *
 * A release writes MANIFEST at the root of the install tree and the server sits
 * three directories under it, so the honest answer is there. A source tree has
 * no manifest and the honest answer is package.json plus "this is not a
 * release" — which matters, because a development build's version number is a
 * statement of intent rather than of what is running.
 *
 * Resolved once: neither file changes under a running process, and an update
 * swaps the whole tree and restarts the unit.
 */

function findUp(from: string, name: string): string | null {
  let dir = from;
  // Bounded rather than while(true): a symlinked or unusual layout should give
  // up and fall through to the next source, not walk to / on every start.
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** `key=value` lines, as written by packaging/aws/build.sh. */
function readManifest(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function resolve(): BuildInfo {
  const here = path.dirname(fileURLToPath(import.meta.url));

  const manifest = findUp(here, 'MANIFEST');
  if (manifest) {
    try {
      const fields = readManifest(manifest);
      if (fields.version) {
        return { version: fields.version, builtAt: fields.built_at, dev: false };
      }
    } catch {
      // An unreadable manifest is not worth refusing to start over; the
      // fallback below still produces something truthful.
    }
  }

  const pkg = findUp(here, 'package.json');
  if (pkg) {
    try {
      const { version } = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: string };
      if (version) return { version: `${version}+dev`, dev: true };
    } catch {
      // Same reasoning.
    }
  }

  return { version: 'unknown', dev: true };
}

const BUILD = resolve();

export function buildInfo(): BuildInfo {
  return BUILD;
}
