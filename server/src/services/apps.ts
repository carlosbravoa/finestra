import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { ServiceError, type Service } from '../service.js';

/**
 * Which apps are enabled — Stage 1 of docs/app-installation.md.
 *
 * The server only persists ids; it does not know what apps exist, since the
 * built-ins live in the client bundle. Kept server-side rather than in
 * localStorage because "which apps this machine offers" is a property of the
 * machine, not of one browser profile.
 */

let disabled = new Set<string>();
let file = '';

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ disabled: [...disabled].sort() }, null, 2) + '\n');
  } catch (err) {
    console.warn('Could not persist app state:', (err as Error).message);
  }
}

export const appsService: Service = {
  name: 'apps',

  init(config: Config) {
    file = path.join(config.stateDir, 'disabled-apps.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { disabled?: unknown };
      if (Array.isArray(raw?.disabled)) {
        disabled = new Set(raw.disabled.filter((x): x is string => typeof x === 'string'));
      }
    } catch {
      // First run, or an unreadable file: everything starts enabled.
    }
  },

  methods: {
    list: () => ({ disabled: [...disabled] }),

    setEnabled(args: { id?: unknown; enabled?: unknown }) {
      const id = typeof args?.id === 'string' ? args.id.trim() : '';
      if (!id) throw new ServiceError('An app id is required', 'EINVAL');
      const enabled = Boolean(args?.enabled);

      // Settings is how apps get re-enabled; disabling it would strand the user.
      if (!enabled && id === 'settings') {
        throw new ServiceError('The Settings app cannot be disabled', 'EPERM');
      }

      if (enabled) disabled.delete(id);
      else disabled.add(id);
      persist();
      return { disabled: [...disabled] };
    },
  },
};
