import type { Service } from '../service.js';
import { appsService } from './apps.js';
import { certsService } from './certs.js';
import { fsService } from './fs.js';
import { journalService } from './journal.js';
import { netService } from './net.js';
import { procService } from './proc.js';
import { shellService } from './shell.js';
import { ptyService } from './pty.js';
import { sysService } from './sys.js';
import { systemdService } from './systemd.js';
import { waylandService } from './wayland.js';

/**
 * Every capability the desktop exposes. To add one, write a Service and put it
 * in this list — the client discovers it from the `hello` handshake, so no
 * client-side registration is needed.
 */
export const services: Service[] = [
  ptyService,
  fsService,
  sysService,
  appsService,
  procService,
  systemdService,
  journalService,
  netService,
  certsService,
  waylandService,
  shellService,
];

export function buildServiceMap(extra: Service[] = []): Map<string, Service> {
  const map = new Map<string, Service>();
  for (const service of [...services, ...extra]) {
    if (map.has(service.name)) {
      throw new Error(`Duplicate service name: ${service.name}`);
    }
    map.set(service.name, service);
  }
  return map;
}
