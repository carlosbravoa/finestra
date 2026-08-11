/**
 * `finestra` — ask the desktop to open something, from a terminal on the server.
 *
 *   finestra open firefox        an application, by id or by name
 *   finestra open notes.md       a file, through whichever app handles it
 *   finestra apps                what is installed
 *   finestra status              whether a desktop is listening
 *
 * Why this exists rather than a WAYLAND_DISPLAY to export: every native
 * application here runs under its own compositor, spawned as its parent and
 * ending with its window. There is no long-lived display for a shell to point
 * at, so a shell cannot open a window — it can only ask a browser that already
 * has one. `firefox` at a prompt will still say it cannot find a display, and
 * that is correct; this is the thing to type instead.
 *
 * It talks to the same loopback server the browser does, with the same token,
 * and gains nothing by it: anyone who can run this already has a shell on the
 * machine as the account the desktop runs as.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './config.js';
import { buildInfo } from './version.js';

const HELP = `finestra — ask this machine's desktop to open something

  finestra open <application>   open it in a window on every connected desktop
  finestra open <file>          open a file with whatever handles it
  finestra apps [filter]        list the applications that can be opened
  finestra status               is a desktop connected?
  finestra version              which build is installed here

An application that needs a display cannot be started from a shell: each one
runs under its own compositor, which exists only for the window it draws. Open
it with this instead, and it appears in the browser.`;

function die(message: string): never {
  process.stderr.write(`finestra: ${message}\n`);
  process.exit(1);
}

/**
 * The token, read the way the server writes it.
 *
 * A terminal opened *inside* the desktop inherits the service's environment, so
 * XDG_STATE_HOME is already right and this needs no help. From a plain SSH
 * session it is not set, and the unit is the only record of where the state
 * went — the same question `configure.sh --state-dir` answers, asked directly
 * here to keep this a single file with no shell-out.
 */
function readToken(stateDir: string): string {
  const direct = path.join(stateDir, 'token');
  if (fs.existsSync(direct)) return fs.readFileSync(direct, 'utf8').trim();

  try {
    const unit = fs.readFileSync('/etc/systemd/system/finestra.service', 'utf8');
    const parent = unit.match(/^Environment=XDG_STATE_HOME=(.*)$/m)?.[1];
    if (parent) {
      const file = path.join(parent.trim(), 'finestra', 'token');
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    }
  } catch {
    // Not installed as a service, or the unit is unreadable. Fall through to
    // the message below, which is more useful than either error.
  }
  die(
    `could not read the access token (looked in ${direct}).\n` +
      `        Run this as the account the desktop runs as.`,
  );
}

interface Reply {
  t: string;
  id?: number;
  ok?: boolean;
  d?: any;
  e?: { message?: string };
}

async function call(method: string, args: unknown): Promise<any> {
  // Deliberately not loadConfig(): it mints a token when there is none, and a
  // command that reads must not write the machine's credentials.
  const token = process.env.WD_TOKEN || readToken(stateDir());
  const port = Number(process.env.WD_PORT || 7070);

  // `ws` ships in the install's own node_modules, beside this file.
  const { default: WebSocket } = await import('ws');
  const url = `ws://127.0.0.1:${port}/ws?t=${encodeURIComponent(token)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no answer from the desktop server on port ${port}`));
    }, 10_000);

    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(
        /ECONNREFUSED/.test(err.message)
          ? new Error(`nothing is listening on 127.0.0.1:${port} — is finestra running?`)
          : err,
      );
    });
    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString()) as Reply;
      // The hello arrives first and is the signal that the token was accepted.
      if (msg.t === 'hello') {
        ws.send(JSON.stringify({ t: 'req', id: 1, svc: 'shell', m: method, a: args }));
        return;
      }
      if (msg.t !== 'res' || msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      msg.ok ? resolve(msg.d) : reject(new Error(msg.e?.message ?? 'the request failed'));
    });
  });
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'open': {
      const target = rest.join(' ').trim();
      if (!target) die('name an application or a file');

      // A path wins over an application name, and only when it really exists:
      // `finestra open notes.md` should open the file in front of you rather
      // than an application that happens to be called something similar.
      const asPath = path.resolve(target);
      const args = fs.existsSync(asPath) && fs.statSync(asPath).isFile()
        ? { file: asPath }
        : { app: target };

      const res = await call('open', args);
      if (res.desktops === 0) {
        // Exiting zero here would be the whole failure: the command "worked",
        // and nothing opened, because nobody was watching.
        die(
          `no desktop is connected, so nothing opened.\n` +
            `        Open Finestra in a browser and run this again.`,
        );
      }
      const what = res.name ?? res.opened;
      process.stdout.write(
        `opened ${what} on ${res.desktops} desktop${res.desktops === 1 ? '' : 's'}\n`,
      );
      return;
    }

    case 'apps': {
      const filter = rest.join(' ').toLowerCase();
      const { apps } = await call('apps', {});
      const rows = (apps as Array<{ id: string; name: string }>).filter(
        (a) => !filter || a.id.toLowerCase().includes(filter) || a.name.toLowerCase().includes(filter),
      );
      if (rows.length === 0) {
        process.stdout.write(filter ? `nothing matches "${filter}"\n` : 'no applications found\n');
        return;
      }
      const width = Math.max(...rows.map((a) => a.id.length));
      for (const app of rows) {
        process.stdout.write(`${app.id.padEnd(width)}  ${app.name}\n`);
      }
      return;
    }

    case 'status': {
      const res = await call('desktops', {});
      process.stdout.write(
        res.desktops > 0
          ? `${res.desktops} desktop${res.desktops === 1 ? '' : 's'} connected\n`
          : 'no desktop is connected\n',
      );
      if (res.desktops === 0) process.exit(1);
      return;
    }

    // Answers without a running desktop, unlike every command above it: the
    // question "which version is on this box" is usually asked precisely
    // because something is not working.
    case 'version':
    case '--version':
    case '-V': {
      const build = buildInfo();
      process.stdout.write(
        `finestra ${build.version}${build.builtAt ? `  (built ${build.builtAt})` : ''}\n`,
      );
      return;
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(`${HELP}\n`);
      return;

    default:
      die(`unknown command: ${command}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err: Error) => die(err.message));
