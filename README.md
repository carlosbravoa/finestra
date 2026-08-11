# Finestra

A desktop environment that runs in a browser and drives a headless server. It
gives you windows, menus, icons, a taskbar and context menus, plus a terminal on
a real PTY, a file manager, a text editor, a system manager for processes,
services, disks, ports and the journal — and real Linux GUI applications, drawn
on the server by a Wayland compositor written for this and rendered in a window.

One shell can drive several of your machines at once, each over its own
connection.

![Finestra on a headless EC2 instance: the system manager with live graphs, a
terminal on a real PTY, and GNOME Disks — an ordinary Linux application — each
in its own window, in a browser tab.](docs/finestra-screenshot.png)

The diagram below is the same thing with the lid off:

```
┌──────────────────────────────────────────────────────────┐
│  browser                                                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │ shell:  window manager · taskbar · icons · menus   │  │
│  │         DesktopAPI  ← the contract apps see        │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ apps:   terminal · files · editor · system manager │  │
│  │         native applications · settings             │  │
│  └────────────────────────────────────────────────────┘  │
│                        RpcClient                         │
└────────────────────────────┬─────────────────────────────┘
                             │ one WebSocket per host
                             │ requests + multiplexed channels
┌────────────────────────────┴─────────────────────────────┐
│  server                                                  │
│    Session → services:  pty · fs · sys · proc · systemd  │
│                         journal · net · certs · apps     │
│                         wayland                          │
│                        ↓                                 │
│         node-pty · real filesystem · /proc · systemd     │
│                        ↓                                 │
│              wdcomp, a Wayland compositor (C)            │
└──────────────────────────────────────────────────────────┘
```

## Running it

```bash
npm install
npm run build
npm start            # serves the client, API and socket from :7070
```

The server prints a URL containing an access token — open that. The token is
stored and stripped from the address bar, so later visits need only the bare
URL.

While working on the code, use dev mode instead, which adds hot reload:

```bash
npm run dev          # Vite on :5173, API and socket on :7070
```

In dev the client is served by **Vite on :5173**, and :7070 carries only the
API and the WebSocket. The startup message prints whichever URL is correct for
the mode you are in, and in dev `:7070/` redirects to Vite rather than quietly
serving the last production build.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WD_HOST` | `127.0.0.1` | Bind address. Loopback by default — this is a remote shell. |
| `WD_PORT` | `7070` | Port. |
| `WD_TOKEN` | generated | Access token. Persisted to `~/.local/state/finestra/token`; delete that file to rotate. |
| `WD_NO_AUTH` | unset | `1` disables authentication entirely. Only ever for a private network you control. |
| `WD_ROOT` | unset | Confines the `fs` service to a directory. Does **not** confine the terminal. |
| `WD_STATIC` | auto | Directory the built client is served from. |
| `WD_WDCOMP` | auto | Path to the `wdcomp` binary; without it, native applications are unavailable. |
| `WD_SERVICES_DIR` | unset | Load extra services from outside the tree — see "What this is not" in `CLAUDE.md`. |
| `WD_DIAL` | unset | Dial *out* to a relay instead of listening. Nothing on this machine accepts a connection. |
| `WD_DIAL_TICKET` | unset | Presented to the relay when dialling. |
| `WD_SESSION_TTL` | unlimited | Seconds from start, then the server exits whatever else is happening. |
| `WD_SESSION_IDLE` | unlimited | Seconds without a message from the far side, then exit. |

The last four matter for a desktop opened *by instruction* rather than by hand.
`WD_DIAL` inverts the connection so the machine needs no open port at all, and
the two session limits are enforced inside the process — so a control plane that
is hacked, hung or simply forgotten cannot leave a root-capable desktop running
on someone's machine. Unset means unlimited, which is right when you started it
yourself and wrong when something else did.

### Security

The terminal is a real login shell running as the user who started the server,
so anyone who reaches an authenticated socket has that user's full access. The
defaults are chosen accordingly: loopback only, token required.

To reach it from elsewhere, tunnel it rather than exposing the port:

```bash
ssh -L 7070:127.0.0.1:7070 you@server
```

If you do bind `0.0.0.0`, put TLS in front of it. `WD_ROOT` narrows the file
service but is not a sandbox for the shell.

## Installing on an EC2 instance

The release is a self-contained tarball: it carries its own Node runtime, so
the instance needs no toolchain, no `npm`, and no third-party apt repository —
only systemd, which Ubuntu already has. The whole security model is the SSH you
already use to reach the box, so **you never open port 7070**; the instance's
security group needs nothing but SSH (22).

Use **Ubuntu 24.04 or newer**. The native pieces are built against 24.04's
glibc, and an older release would fail to start with a `GLIBC_… not found` — see
`docs/packaging.md`.

**1. Get a release tarball.** If you do not already have one, build it from a
checkout (this launches a throwaway builder, so it needs AWS credentials):

```bash
packaging/aws/build.sh          # → dist-release/finestra-<version>-linux-x64.tar.gz
```

Or publish it to an S3 bucket and install from there in one line — see
"Publishing a download page" below, which is what `packaging/web/` is for.

**2. Copy it to the instance and install.** From your own machine:

```bash
scp finestra-<version>-linux-x64.tar.gz ubuntu@<instance>:
ssh ubuntu@<instance>
```

then, on the instance:

```bash
tar xzf finestra-<version>-linux-x64.tar.gz
cd finestra-<version>
sudo ./install.sh
```

`install.sh` asks one question — who the desktop runs as — then installs under
`/opt/finestra`, writes a systemd unit and starts it bound to
`127.0.0.1:7070`. It finishes by printing the tunnel command and the tokened URL
for this exact host.

The question matters more than it looks:

```
  1) ubuntu — you.  Your home directory, the journal, and sudo: the same
     reach as the SSH session you are typing this in.  Nothing more.
  2) ubuntu, without privilege.  Your home directory and the journal, but
     nothing that needs root — no sudo in the terminal, no managing units.
  3) finestra — a system account with no home and no login.
     The journal and read-only browsing: observability, and nothing else.
```

The default is you. A desktop is the account it runs as: run it as a system
account with no home and no groups and you get something that can draw windows
over a machine it cannot read — nowhere to upload to, nothing to open, and every
privileged action refused. Running it as yourself grants nothing new, because
reaching the port at all means already holding an SSH session as that same
account. Choose 2 or 3 when the machine is shared or the desktop is only there
to look at things; the answer sticks across upgrades, and the flags
`--as-me`, `--no-privilege`, `--system-account` and `--user NAME` answer it in
advance for an unattended install.

State lives in that account's home — `~/.local/state/finestra` — or in
`/var/lib/finestra` for the system account.

### Upgrading from web desktop

Finestra was called *web desktop*. Run the same one-liner (or the same
`install.sh`) on a machine that has one and it is taken over rather than
installed alongside: the access token, the settings and the recorded answer to
the who-runs-as question all survive, so a bookmarked `?t=` URL keeps working.
`web-desktop.service`, `/opt/web-desktop` and the `web-desktop` system account
are removed, and the installer prints what it took over and what it removed. If
the new service does not answer, the old one is enabled and started again with
its files untouched — the migration never leaves a machine with neither.

`/var/lib/web-desktop` is deliberately left behind when a system-account install
is migrated: it holds the only other copy of the token, and deleting it is your
call, not the installer's.

### Changing it later

The answer is not fixed at install time. `configure.sh` stays behind in the
install, so it can be changed later on a machine that no longer has the tarball
it came from — it rewrites the unit, moves the state (carrying the token, so
your URL keeps working) and restarts the service:

```bash
sudo /opt/finestra/current/configure.sh --show   # what it is now
sudo /opt/finestra/current/configure.sh          # ask again
sudo /opt/finestra/current/configure.sh --as-me  # or answer directly
```

**3. Connect.** The desktop is on the instance's loopback, so forward the port
over SSH from your own machine:

```bash
ssh -L 7070:127.0.0.1:7070 ubuntu@<instance>
```

Leave that running and open the URL the installer printed — it carries the
token, which is stored in `~/.local/state/finestra/token`:

```
http://127.0.0.1:7070/?t=…
```

That is it. Afterwards:

### Opening things from a terminal

A shell on the server has no window, and `firefox` typed at a prompt will say it
cannot find a display — correctly. There is no ambient Wayland display to
inherit: every native application runs under its own compositor, which exists
only for the window it draws. So the terminal asks the desktop instead:

```bash
finestra open firefox        # by id or by name; opens in a window in the browser
finestra open notes.md       # a file, through whichever app handles it
finestra apps [filter]       # what is installed
finestra status              # is a desktop connected?
```

With no browser attached there is nothing to draw into, and `finestra open` says
so and exits non-zero rather than reporting success for a window nobody saw.

```bash
sudo systemctl status finestra                    # is it up
journalctl -u finestra -f                          # follow its logs
sudo /opt/finestra/current/configure.sh --show     # who it runs as
sudo /opt/finestra/current/configure.sh            # change that, and restart
sudo /opt/finestra/current/update.sh <tarball>     # upgrade in place
sudo /opt/finestra/current/update.sh --rollback    # undo a bad upgrade
```

To remove it, run the uninstall from an unpacked tarball. `configure.sh` and
`update.sh` stay in the install tree; `install.sh` does not, because it is also
what deletes that tree:

```bash
sudo ./install.sh --uninstall     # removes the service and files; keeps the state directory
```

## Publishing a download page

`packaging/web/` turns a release into the usual one-line install. It puts the
tarball, a small page and a bootstrap script in an S3 bucket:

```bash
packaging/web/publish.sh            # bucket, page, release, checksum
packaging/web/verify-oneliner.sh    # run the published one-liner on a bare instance
```

Installing then looks like every other project's front page:

```bash
curl -fsSL https://<bucket>.s3.<region>.amazonaws.com/get.sh | sudo bash
```

`get.sh` resolves the current release, **checks it against its published
SHA-256 before anything inside it runs**, and hands over to the same
`install.sh` a manual downloader would use. Two endpoints on purpose: the page
is served from the S3 *website* endpoint, which is HTTP-only, while every URL
inside it — `get.sh` included — points at the HTTPS REST endpoint, because
piping plain HTTP into a root shell is not a thing to do.

`verify-oneliner.sh` proves the published path rather than assuming it: on a
pristine instance it confirms a corrupted download is refused and installs
nothing, runs the real one-liner, checks the installed version is the published
one, runs the full acceptance suite, and reinstalls to confirm an upgrade
actually replaces the running process.

## What is in it

| App | What it does |
| --- | --- |
| **Terminal** | A real PTY on the host, xterm.js in front. Reopens in the directory you left it in, and only asks before closing when something is actually running. |
| **Files** | Browse, rename, delete, download, upload. Double-click routes to whichever app handles that file. |
| **Text Editor** | Edit files on the server. Claims `.txt`, `.md`, `.conf` and friends by file association. |
| **System Manager** | Overview, processes, services, journal, disk usage, network and certificates — see below. |
| **Native Desktop Applications** | Browses the host's installed `.desktop` entries and runs a real Linux GUI app in a window. Pin one and it becomes an app of this desktop, with its own icon. Empty on a headless server, and meant to be. |
| **Settings** | Appearance, terminal, uploads, which apps are enabled, file associations, session restore. |

The **System Manager** is the largest of them, and each section is a live view
rather than a snapshot:

- **Overview** — CPU, memory, load, temperatures, network and disk throughput.
- **Processes** — sorted, filterable, with a detail panel; signal one it owns.
- **Services** — systemd units for the system *or* your own user manager, with
  start/stop/restart/enable and a live log tail per unit.
- **Journal** — the whole journal rather than one unit's: filter by boot,
  priority, unit or identifier, search with `--grep`, and follow new entries as
  they arrive. Clicking an entry shows every field the journal recorded.
- **Disk usage** — filesystems, and a scan that walks a directory tree.
- **Network** — listening sockets and connections, attributed to the process
  that owns them.
- **Certificates** — expiry dates for the TLS certificates on the machine.

Everything it shows comes from `/proc`, `/sys`, `systemctl` and `journalctl` —
there is no agent to install and nothing is cached behind your back.

## More than one machine

One shell can drive several servers at once. Each host is a separate connection
straight from your browser to that machine; the servers never learn about each
other.

That is deliberate. A Finestra that proxied to other Finestras would
add a hop, a second trust boundary, and a machine whose compromise is everyone's
compromise. One server per box keeps the blast radius of a compromise to that
box. A window belongs to one host for its whole life — there is no cross-host
drag and no shared state, which is what stops this becoming a distributed system
with all the reconciliation that implies.

On a single-machine install the feature is invisible and costs nothing;
`tests/standalone.test.ts` fails if that stops being true.

## Layout

```
shared/protocol.ts     wire format, imported by both sides
server/src/
  index.ts             HTTP, static files, WebSocket upgrade
  session.ts           demultiplexes requests and channels onto services
  service.ts           the Service interface
  deadman.ts           the session's own TTL and idle clock
  outbound.ts          dialling out to a relay instead of listening
  extra-services.ts    loads services from WD_SERVICES_DIR
  services/            pty fs sys proc systemd journal net certs apps wayland
                         ← add capabilities here
client/src/
  core/
    types.ts           the app SDK: AppManifest, DesktopAPI, MenuItem…
    rpc.ts             connection, requests, channels, reconnect
    desktop.ts         the shell; implements DesktopAPI
    hosts.ts           several servers in one shell
    host-view.ts       a per-host view of the DesktopAPI
    registry.ts        installed apps
    associations.ts    which app opens which file
    session-store.ts   which windows to reopen after a reload
    transfer.ts        upload and download over HTTP
    settings.ts        persisted preferences
    shortcuts.ts       global accelerators
  ui/                  window, window-manager, menu, taskbar, icons, dialogs
  apps/                terminal, files, editor, sysman, wayland, settings
                         ← add apps here
  apps-extra/          apps from other repositories, globbed at build time
compositor/            wdcomp: a headless Wayland compositor (optional)
  protocols/           the Wayland protocol XML, vendored — see its README
packaging/             install.sh, update.sh, and the EC2 build/verify scripts
tests/                 run with `npm test` (build first)
```

## Adding an app

An app is a manifest with a `mount` function. It gets a DOM node and the
`DesktopAPI`; the shell never looks inside its element, so it can be plain DOM,
canvas, or any framework.

```ts
// client/src/apps/notes/index.ts
import type { AppManifest } from '../../core/types';

export const notesApp: AppManifest = {
  id: 'notes',
  name: 'Notes',
  icon: '📝',                 // emoji, or an inline <svg> string
  category: 'Utilities',
  showOnDesktop: true,
  defaultSize: { width: 600, height: 400 },

  async mount({ window: win, root, desktop, params }) {
    const text = document.createElement('textarea');
    root.appendChild(text);

    const { content } = await desktop.rpc.call('fs', 'read', {
      path: params.path ?? '/tmp/notes.txt',
    });
    text.value = content;

    return {
      menu: [{ label: 'File', submenu: () => [{ label: 'Save', onSelect: save }] }],
      onResize: ({ width }) => win.setStatus(`${width}px`),
      onClose: () => desktop.confirm({ message: 'Discard changes?' }),
      destroy: () => { /* release timers, sockets, listeners */ },
    };
  },
};
```

Register it in `client/src/main.ts`:

```ts
desktop.register(notesApp);
```

> There is a Claude Code skill for this: **`finestra-app`** in
> `.claude/skills/`. It carries the full API reference, a compiling starter
> template, the service-authoring guide, and the mistakes worth not repeating.

That is the only place the shell learns an app exists — which is what will let
this list eventually come from remote bundles loaded with `import()`.

What `mount` receives:

- `window` — `setTitle`, `setIcon`, `setMenu`, `setStatus`, `close`, `focus`,
  `minimize`, `maximize`, `setBounds`, and an `on(event, fn)` for
  `focus` / `blur` / `resize` / `move` / `state` / `close`.
- `desktop` — `rpc`, `launch`, `notify`, `confirm`, `prompt`, `contextMenu`,
  `settings`, `shortcuts`, `events`, `host`.
- `params` — whatever `launch()` was called with.

What you may return: `menu`, `destroy`, `onResize`, `onFocus`, `onBlur`,
`onClose` (return `false` to veto the close), and `saveState` (see below).

## Session restore

Open windows come back after a reload: app, geometry, maximized/minimized
state, stacking order and which window had focus.

Live things cannot survive — a PTY dies with its socket — so a restored app
starts fresh and reopens *in the right place*. Apps say what "the right place"
means by returning it from `saveState()`:

```ts
return {
  saveState: () => ({ path: currentDirectory }),
  // …reopens as mount({ params: { path } })
};
```

`saveState` is called synchronously, possibly while the page is unloading, so
return an already-known value rather than starting async work. Anything you
return must be JSON-serialisable; if it is not, that one window is dropped and
the rest of the session still restores. Apps that do not implement it reopen
with the params they were originally launched with.

The terminal uses this to come back in the directory you left it in. Since a
shell never announces `cd`, it polls `pty.cwd` — which reads `/proc/<pid>/cwd`
— while the terminal is focused, and once more when it loses focus. The server
answers only for PTYs that same connection started, and forgets a pid as soon
as its shell exits, so a recycled pid cannot be used to inspect an unrelated
process.

Closing a terminal only asks for confirmation when something is actually
running in it. `pty.status` reports the tty's foreground process group — the
same signal a normal terminal emulator uses — so an idle prompt closes
immediately, and a busy one names what it would kill ("vim" will be
terminated). Background jobs count too, since they die with the shell. Turn the
prompt off entirely under **Shell → Ask before closing**.

Set `restorable: false` on a manifest to opt a window out. Users can turn the
whole feature off under **Apps → Reopen windows on reload**, which also clears
what was stored. Sessions older than 14 days are discarded.

## File associations

An app declares what it can open; the file manager routes double-clicks to it
and offers an **Open with** menu.

```ts
export const editorApp: AppManifest = {
  // …
  handles: [
    { extensions: ['.txt', '.md', '.conf'], verb: 'Edit' },
    { names: ['Makefile', 'Dockerfile'] },
    { matches: (f) => f.name.includes('.log.'), verb: 'Tail' },
    // { fallback: true } claims anything nothing else wants
  ],
};
```

The app is launched with `params.path` set to the file.

Ties resolve by specificity: an exact filename beats an extension, a longer
extension beats a shorter one (`.tar.gz` over `.gz`), a predicate beats a
`fallback`, and `priority` breaks anything still level. A dotfile like
`.bashrc` counts as a *name*, not an extension. A user's explicit "always open
this kind of file with" choice overrides all of it, and is forgotten
automatically if that app is later uninstalled.

From an app:

```ts
await desktop.openFile(path);                            // registered handler
await desktop.openFile(path, { appId, remember: true }); // force, and remember
desktop.fileHandlers(path);                              // for an Open with menu
```

`openFile` returns null when nothing handles the file, having already offered
the user an **Open with…** picker — so callers do not need their own
empty-handler path.

## File transfer

- **Download** — right-click a file in Files → Download. Streams over HTTP
  (`/api/download`), so the browser's own progress/save-as UI applies and
  there is no size cap.
- **Upload** — drag files from your OS onto the desktop and they land in the
  inbox folder (`~/Uploads` by default, changeable in Settings). Drop them onto
  a Files window instead and they land in the directory you are looking at.
  Files → File → "Upload files here…" opens a picker for the same thing.

Name collisions never overwrite: a second `report.pdf` becomes
`report (1).pdf`, atomically, and `backup.tar.gz` suffixes as
`backup (1).tar.gz`. Apps get the same machinery via
`desktop.downloadFile(path)` and `desktop.uploadFiles(files, dir?)`.

## Settings

The **Settings** app (launcher → System, or right-click the desktop)
consolidates what used to live in scattered context menus:

- **Appearance** — dark/light theme, wallpaper.
- **Terminal** — font size, default shell, close confirmation.
- **Files & uploads** — the inbox folder, hidden files.
- **Apps** — enable/disable apps (Stage 1 of `docs/app-installation.md`).
  State persists server-side, so it is a property of the machine, not of one
  browser. Settings itself cannot be disabled — it is how apps get re-enabled.
- **File associations** — review and forget "always open with" choices.
- **Session** — the reopen-windows toggle, and a way to forget saved windows.

Theme and wallpaper apply live: the shell watches the settings keys, so the
Settings app never reaches into shell internals.

## Adding a server capability

A service is a named bundle of methods and channels. Methods are
request/response; channels are long-lived streams.

```ts
// server/src/services/git.ts
import { type Service } from '../service.js';

export const gitService: Service = {
  name: 'git',
  methods: {
    async status({ repo }) { /* … */ },
  },
  channels: {
    log({ repo }, ctx) {
      const child = spawn('git', ['log', '--follow'], { cwd: repo });
      child.stdout.on('data', (b) => ctx.sendBinary(b));
      return {
        info: { pid: child.pid },
        onCtl: (method) => { if (method === 'stop') child.kill(); },
        onClose: () => child.kill(),
      };
    },
  },
};
```

Add it to the list in `server/src/services/index.ts`. The client discovers it
from the `hello` handshake — nothing on the client needs registering.

Calling it:

```ts
await desktop.rpc.call('git', 'status', { repo });

const channel = desktop.rpc.openChannel('git', 'log', { repo }, {
  onBinary: (bytes) => append(bytes),
  onClose: (error) => done(error),
});
channel.ctl('stop');
```

Because every capability the browser has goes through a service,
`server/src/services/` is the complete list of what the desktop can do to the
machine — which is the place to look when auditing reach.

## The wire protocol

One WebSocket carries everything, defined in `shared/protocol.ts`.

- **Requests** — `{t:'req', id, svc, m, a}` → `{t:'res', id, ok, d|e}`.
- **Channels** — `{t:'open', id, svc, m, a}` → `{t:'opened', id, d}`, then
  `data` / `ctl` in both directions until `close`.
- **Binary frames** — `[opcode][4-byte channel id][payload]`. Terminal traffic
  uses these so a fast `find /` is not JSON-escaped byte by byte, and so
  xterm.js reassembles UTF-8 sequences split across writes itself.

The client reconnects with backoff. Channels are deliberately *not* restored
across a reconnect — a PTY that died with the socket is genuinely gone — so
apps are told via `onClose` and decide whether to reopen.

## Keyboard shortcuts

| Combo | Action |
| --- | --- |
| `Ctrl+Alt+T` | New terminal |
| `Alt+Tab` / `Alt+Shift+Tab` | Cycle windows |
| `Ctrl+Alt+M` | Maximize / restore |
| `Ctrl+Alt+D` | Minimize all |
| `Alt+F4` | Close focused window |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste in the terminal |
| `Ctrl+Wheel` | Terminal zoom |

Apps add their own with `desktop.shortcuts.register('Ctrl+Alt+K', fn, 'What it
does')`, which returns the unbinding function.

## What's next

See [`ROADMAP.md`](ROADMAP.md).

On authentication specifically: the SSH tunnel is the boundary and the token is
a second latch on top of it — that is the design, not a placeholder. Logging in
as an OS user was built and then removed, because an unprivileged service cannot
verify another user's password without being handed read access to the password
hashes, which is more attack surface than it buys. `ROADMAP.md` records the
evidence so nobody re-derives it.

- [`ROADMAP.md`](ROADMAP.md) — ordered by when each gap starts to hurt.
- [`docs/app-installation.md`](docs/app-installation.md) — installing and
  enabling apps without rebuilding the shell.
- [`docs/apps-wanted.md`](docs/apps-wanted.md) — the apps a sysadmin actually
  needs, and which ones are not worth building.
- [`docs/wayland.md`](docs/wayland.md) — the compositor that puts *real* Linux
  applications in a window. Working today for anything that renders with shm:
  menus, dialogs, mouse, keyboard, cursor shapes and clipboard. It also records
  what does *not* run and why — X11-only programs, and anything that insists on
  a GPU buffer we cannot read.
- [`docs/packaging.md`](docs/packaging.md) — why the release carries its own
  Node runtime, what ships, how updates and rollback work, and the failures that
  cost the most time.

## Licence

**Free for personal and internal business use, on as many machines as you like.**
That includes a company running it on its own servers, including the ones that
earn the company money, and includes patching it to taste. There is no seat count,
no expiry, no feature held back, and nothing to buy.

**A commercial licence is needed to give Finestra to other people** — hosting it
as a service for third parties, shipping it inside a product or appliance, or
redistributing builds.

The terms are the PolyForm Internal Use License with personal and noncommercial
use added; see [`LICENSE`](LICENSE) for the text,
[`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md) for the plain-language version
and how to ask. [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) covers what
the release bundles — all of it permissive.

Patches are welcome; [`CONTRIBUTING.md`](CONTRIBUTING.md) explains the one
sign-off line and why it is needed.
