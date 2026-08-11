import fs from 'node:fs';
import { ServiceError, type Service } from '../service.js';
import { liveSessions } from '../session.js';
import { cachedApps } from './wayland.js';

/**
 * Asking the desktop to open something, from somewhere that has no desktop.
 *
 * A terminal inside Finestra runs on the server, and the applications it can
 * start are drawn by a compositor that lives for exactly one window — there is
 * no ambient WAYLAND_DISPLAY to inherit and never will be, because each window
 * *is* its own compositor. So `firefox` typed at a prompt cannot open a window;
 * it can only ask the browsers that have one to open it.
 *
 * That is all this service does. It resolves a name to something openable and
 * announces it to the other connections. It cannot name a session, it gets no
 * reply, and it grants nothing the browser could not already do — the caller
 * has a shell on this machine as the account the desktop runs as, which is
 * strictly more authority than "open a window".
 */

/** Resolve what a person typed to an installed application. */
function resolveApp(query: string): { id: string; name: string } {
  const apps = cachedApps();
  const wanted = query.trim();
  if (!wanted) throw new ServiceError('Name an application', 'EINVAL');

  const byId = apps.find((a) => a.id === wanted);
  if (byId) return { id: byId.id, name: byId.name };

  const lower = wanted.toLowerCase();
  const byName = apps.find((a) => a.name.toLowerCase() === lower);
  if (byName) return { id: byName.id, name: byName.name };

  // A prefix of the id is what people actually type: `firefox` for
  // `firefox_firefox`, `chromium` for `chromium_chromium`.
  const partial = apps.filter(
    (a) => a.id.toLowerCase().startsWith(lower) || a.name.toLowerCase().includes(lower),
  );
  if (partial.length === 1) return { id: partial[0].id, name: partial[0].name };
  if (partial.length > 1) {
    // Ambiguity is answered with the choices, not with a guess: opening the
    // wrong application is worse than opening none.
    throw new ServiceError(
      `"${wanted}" matches ${partial.length} applications: ${partial
        .slice(0, 8)
        .map((a) => a.id)
        .join(', ')}`,
      'EAMBIGUOUS',
    );
  }
  throw new ServiceError(`No application matches "${wanted}"`, 'ENOENT');
}

export const shellService: Service = {
  name: 'shell',

  methods: {
    /** What could be opened, for a caller that has no picker to look at. */
    apps() {
      return {
        apps: cachedApps().map(({ id, name, comment }) => ({ id, name, comment })),
      };
    },

    /** How many desktops would hear an `open` right now. */
    desktops(_args: unknown, ctx) {
      // Minus this one: a terminal's own connection is not a desktop, and
      // counting it would report an audience that cannot draw anything.
      return { desktops: Math.max(0, liveSessions.size - 1), sessionId: ctx.sessionId };
    },

    /**
     * Open an application, or a file, on every connected desktop.
     *
     * The count comes back so the caller can say "no desktop is connected"
     * rather than exiting zero having done nothing — the failure that would
     * otherwise look exactly like success.
     */
    open(args: { app?: string; file?: string }, ctx) {
      if (args?.file !== undefined) {
        const file = String(args.file);
        // Resolved here rather than in the browser: the file is on this
        // machine, and a path that does not exist should fail where it was
        // typed, not silently somewhere else.
        if (!fs.existsSync(file)) {
          throw new ServiceError(`No such file: ${file}`, 'ENOENT');
        }
        const desktops = ctx.announce('shell', 'open', { file });
        return { opened: file, desktops };
      }

      const app = resolveApp(String(args?.app ?? ''));
      const desktops = ctx.announce('shell', 'open', { app: app.id, name: app.name });
      return { opened: app.id, name: app.name, desktops };
    },
  },
};
