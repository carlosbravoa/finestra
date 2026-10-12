import { mintToken, tokenFile, writeToken } from '../config.js';
import { ServiceError, type Service } from '../service.js';
import { liveSessions, type Session } from '../session.js';
import { CLOSE_REVOKED, type AccessSession, type AccessStatus } from '../../../shared/protocol.js';

/**
 * Changing the access token from inside the desktop.
 *
 * The token is the only thing standing between "a page that runs in your
 * desktop" and "a shell on this machine", and it is a string: it is in a
 * link that may have been pasted somewhere, in a bookmark on a laptop you no
 * longer own, and visible to any app package that runs in the page. Changing
 * it used to mean deleting a file on the host and restarting the service —
 * shell access, to revoke a credential that exists for people who may not
 * have it to hand. This does it from Settings.
 *
 * Who is cut off is the point, so it is worth being precise. Every connection
 * that is open right now got in with the token being retired, and they are
 * all the same to the server: the one that asked has no better claim than the
 * others. So the default hands the new token to every live session, and what
 * that cuts off is exactly every *copy* of the old one that is not connected:
 * old links, old bookmarks, anything that was copied off-box. The alternative,
 * for when the list of live sessions shows one you do not recognise, hangs up
 * on all the others and tells them why — the new link then reaches them the
 * way the first one did.
 *
 * Nothing here grants anything the caller lacked: it already holds the token,
 * and with it the terminal, where `rm` on the file and a restart is one line.
 */

const REVOKED_REASON = 'The access token was changed from another desktop';

function describe(session: Session, selfId: string): AccessSession {
  return {
    id: session.id,
    self: session.id === selfId,
    address: session.peer.address ?? null,
    userAgent: session.peer.userAgent ?? null,
    since: session.since,
    viaRelay: session.peer.viaRelay === true,
  };
}

export const authService: Service = {
  name: 'auth',

  methods: {
    /** Whether a token is in force, where it lives, and who is connected. */
    status(_args: unknown, ctx): AccessStatus {
      const { config } = ctx;
      // Dialling out, nothing listens, so there is nothing a token guards;
      // the relay decides who joins. Saying "enabled" there would offer a
      // rotation that changes nothing anyone can see.
      const enabled = !config.authDisabled && !config.dial;
      return {
        enabled,
        source: config.dial ? 'relay' : config.authDisabled ? 'none' : config.tokenSource,
        file: tokenFile(config.stateDir),
        sessions: [...liveSessions]
          .map((s) => describe(s, ctx.sessionId))
          .sort((a, b) => a.since - b.since),
      };
    },

    /**
     * Mint a new token, make it the one checked from now on, and tell the
     * other live sessions — or hang up on them. The caller gets it back in
     * the response and is never disconnected: it has to be able to refresh
     * its own cookie, and it is the one that proved it meant this.
     */
    rotate(args: { keepOthers?: boolean }, ctx) {
      const { config } = ctx;
      if (config.authDisabled || config.dial) {
        throw new ServiceError('No token is in use on this server', 'EPERM');
      }
      if (config.tokenSource !== 'file') {
        throw new ServiceError(
          'The token is set by WD_TOKEN in the environment; change it there and restart',
          'EPERM',
        );
      }
      const keepOthers = args?.keepOthers !== false;
      const token = mintToken();
      // Disk first: a token the server checks but did not persist would be
      // undone by the next restart, and every link handed out in between
      // would die with it.
      writeToken(config.stateDir, token);
      config.token = token;

      let kept = 0;
      let disconnected = 0;
      for (const session of liveSessions) {
        if (session.id === ctx.sessionId) continue;
        if (keepOthers) {
          session.tell('auth', 'rotated', { token });
          kept++;
        } else {
          session.close(CLOSE_REVOKED, REVOKED_REASON);
          disconnected++;
        }
      }
      return { token, kept, disconnected };
    },
  },
};
