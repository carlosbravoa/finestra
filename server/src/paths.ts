import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ServiceError } from './service.js';

/** True when `child` is `parent` or sits underneath it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Expands a leading `~` and makes the path absolute against the user's home. */
export function expand(p: string): string {
  const home = os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return path.resolve(home, p);
}

/**
 * Resolve a client-supplied path, enforcing WD_ROOT when it is set.
 *
 * Symlinks are resolved first where possible, so a link pointing out of the
 * root cannot be used to escape it. A path that does not exist yet (a file
 * about to be created) is checked via its nearest existing ancestor.
 */
export function resolvePath(input: unknown, root: string | null): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new ServiceError('A path is required', 'EINVAL');
  }
  const abs = expand(input);
  if (!root) return abs;

  const real = realpathOfNearestAncestor(abs);
  if (!isInside(real, root)) {
    throw new ServiceError('Path is outside the permitted root', 'EACCES');
  }
  return abs;
}

function realpathOfNearestAncestor(p: string): string {
  let current = p;
  const trailing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return p;
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}
