import type { DesktopAPI } from './types';
import type { HostEntry } from './hosts';

/**
 * The desktop as one host sees it.
 *
 * Apps ask for things with `desktop.rpc.call('fs', 'list', …)` and never say
 * which machine they mean — and they should not have to. A window belongs to a
 * host, so the `DesktopAPI` handed to that window's app is bound to it: `rpc`
 * is that host's connection and `host` is that host's facts. Every other member
 * is the shell's, shared, and passed straight through.
 *
 * The whole point of doing it this way is that **no existing app changes**. The
 * terminal, the file manager and the native-application window became
 * multi-host by having something else handed to them, which is the difference
 * between a day of work and a rewrite of every app in the tree.
 */
export function hostView(desktop: DesktopAPI, entry: HostEntry): DesktopAPI {
  // A Proxy rather than a spread: `Desktop` exposes accessors and methods that
  // rely on `this`, and copying them would quietly unbind half the API.
  return new Proxy(desktop, {
    get(target, prop, receiver) {
      if (prop === 'rpc') return entry.rpc;
      if (prop === 'host') return entry.info;
      if (prop === 'hostId') return entry.id;

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DesktopAPI;
}
