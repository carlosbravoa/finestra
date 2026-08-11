import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Service } from './service.js';

/**
 * Services from outside this repository.
 *
 * Some capabilities do not belong here. A console for another product, an
 * integration with a control plane, anything that names a system this project
 * has no opinion about — putting those in `services/` would make this desktop
 * carry a dependency it does not want and a licence boundary it should not
 * cross. So they live in their own repository and are pointed at:
 *
 *   WD_SERVICES_DIR=/opt/finestra-extras/services
 *
 * Every `.js` file directly inside is imported once at startup. A module may
 * export a service as its default, as a named export, or several — anything
 * with a `name` and either `methods` or `channels` is taken.
 *
 * Writing one needs **nothing from this package**. A service is a plain object,
 * and an error only has to be an `Error` carrying a `code` for the browser to
 * receive it properly:
 *
 *   export const thing = {
 *     name: 'thing',
 *     methods: {
 *       hello: async () => ({ ok: true }),
 *       boom:  () => { throw Object.assign(new Error('nope'), { code: 'ENOPE' }); },
 *     },
 *   };
 *
 * **The trust here is total.** Anything loaded runs inside this process, with
 * this process's privileges, and can reach everything the desktop can reach.
 * Pointing this at a directory someone else can write to is the same as letting
 * them replace the server binary. It is refused if the directory is
 * world-writable, which catches the obvious mistake and none of the subtle ones.
 */

function looksLikeService(value: unknown): value is Service {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Service>;
  return (
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    (typeof candidate.methods === 'object' || typeof candidate.channels === 'object')
  );
}

export async function loadExtraServices(
  dir = process.env.WD_SERVICES_DIR,
): Promise<Service[]> {
  if (!dir) return [];

  const root = path.resolve(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    console.warn(`[extra] WD_SERVICES_DIR does not exist: ${root}`);
    return [];
  }
  if (!stat.isDirectory()) {
    console.warn(`[extra] WD_SERVICES_DIR is not a directory: ${root}`);
    return [];
  }
  // 0o002 — writable by anyone. Loading code from there would hand the process
  // to whoever gets there first.
  if ((stat.mode & 0o002) !== 0) {
    console.error(`[extra] refusing ${root}: it is world-writable`);
    return [];
  }

  const found: Service[] = [];
  for (const entry of fs.readdirSync(root).sort()) {
    if (!entry.endsWith('.js')) continue;
    const file = path.join(root, entry);
    try {
      const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      const services = Object.values(module).filter(looksLikeService);
      if (services.length === 0) {
        console.warn(`[extra] ${entry} exported no service`);
        continue;
      }
      for (const service of services) {
        found.push(service);
        console.log(`[extra] loaded service "${service.name}" from ${entry}`);
      }
    } catch (err) {
      // One bad module must not stop the desktop from starting. It is an
      // add-on: the machine is still usable without it, and saying so plainly
      // beats refusing to boot.
      console.error(`[extra] could not load ${entry}:`, (err as Error).message);
    }
  }
  return found;
}
