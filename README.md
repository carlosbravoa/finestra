# Finestra

A desktop environment that runs in a browser and drives a headless Linux
server. Windows, menus, a taskbar and session restore; a terminal on a real
PTY; a file manager and a text editor; a system manager for processes,
services, disks, ports and the journal; and real Linux applications — Wayland
and X11 — drawn on the server by a compositor written for this and rendered in
a window of the desktop.

One shell can drive several of your machines at once, each over its own
connection.

![Finestra on a headless EC2 instance: the system manager with live graphs, a
terminal on a real PTY, and GNOME Disks — an ordinary Linux application — each
in its own window, in a browser tab.](docs/finestra-screenshot.png)

```
┌──────────────────────────────────────────────────────────┐
│  browser                                                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │ shell:  window manager · taskbar · icons · menus   │  │
│  │ apps:   terminal · files · editor · system manager │  │
│  │         native applications · settings             │  │
│  └────────────────────────────────────────────────────┘  │
└────────────────────────────┬─────────────────────────────┘
                             │ one WebSocket per host
┌────────────────────────────┴─────────────────────────────┐
│  server                                                  │
│    Session → services:  pty · fs · sys · proc · systemd  │
│                         journal · net · certs · apps     │
│                         wayland                          │
│                        ↓                                 │
│    node-pty · the filesystem · /proc · systemd           │
│    wdcomp, a Wayland compositor in C, with Xwayland      │
│    behind it for X11 applications                        │
└──────────────────────────────────────────────────────────┘
```

## Installing

The release is a self-contained tarball with its own Node runtime: the machine
needs no toolchain, no `npm` and no third-party repository, only systemd. Any
systemd distribution with glibc 2.34 or newer, on x86_64 or 64-bit ARM —
Ubuntu 24.04, Debian 12, Rocky 9 and 10, Amazon Linux 2023 and Fedora are
checked on every release, and a Raspberry Pi 4 or 5 on the 64-bit Raspberry Pi
OS is the same arm64 build.

```bash
curl -fsSL https://finestra.dev/get.sh | sudo bash
```

That resolves the current release, checks it against its published SHA-256
before anything inside it runs, and hands over to `install.sh`. The same
installer runs from a downloaded tarball:

```bash
tar xzf finestra-<version>-linux-<arch>.tar.gz
cd finestra-<version>
sudo ./install.sh
```

The installer fetches nothing. Native applications need three shared libraries
that most server images do not carry, and X11 applications an Xwayland as well;
`install.sh` says what is present and prints the line for the package manager it
finds:

```bash
sudo apt install libwayland-server0 libxkbcommon0 libxcb1 xwayland          # Debian, Ubuntu
sudo dnf install libwayland-server libxkbcommon libxcb xorg-x11-server-Xwayland   # Fedora, RHEL
```

Everything else works without them, and the applications window picks them up
as soon as they appear, with no restart.

**Who it runs as.** The installer asks one question:

```
  1) ubuntu — you.  Your home directory, the journal, and sudo: the same
     reach as the SSH session you are typing this in.  Nothing more.
  2) ubuntu, without privilege.  Your home directory and the journal, but
     nothing that needs root — no sudo in the terminal, no managing units.
  3) finestra — a system account with no home and no login.
     The journal and read-only browsing: observability, and nothing else.
```

The default is you. A desktop is the account it runs as: a system account with
no home draws windows over a machine it cannot read. Running it as yourself
grants nothing new, since reaching the port at all means already holding an SSH
session as that account. Choose 2 or 3 when the machine is shared or the desktop
is only there to look at things. The answer sticks across upgrades;
`--as-me`, `--no-privilege`, `--system-account` and `--user NAME` give it in
advance for an unattended install. State lives in `~/.local/state/finestra`, or
`/var/lib/finestra` for the system account.

**Connect.** The service listens on the machine's loopback, so forward the port
over SSH from your own machine and open the URL the installer printed, which
carries the token:

```bash
ssh -L 7070:127.0.0.1:7070 ubuntu@<instance>
# then  http://127.0.0.1:7070/?t=…
```

The token is stored by the browser and stripped from the address bar, so later
visits need only the bare URL. Nothing but SSH has to be open on the machine.

**Afterwards:**

```bash
sudo systemctl status finestra                    # is it up
journalctl -u finestra -f                          # follow its logs
sudo /opt/finestra/current/configure.sh --show     # who it runs as, what can reach it
sudo /opt/finestra/current/configure.sh            # ask the account question again
sudo /opt/finestra/current/update.sh <tarball>     # upgrade in place
sudo /opt/finestra/current/update.sh --rollback    # undo a bad upgrade
sudo ./install.sh --uninstall                      # from an unpacked tarball; keeps the state directory
```

A shell on the server has no display of its own — every application runs under
its own compositor, which exists only for the window it draws — so the terminal
asks the desktop instead:

```bash
finestra open firefox        # by id or by name, in a window of every connected desktop
finestra open notes.md       # a file, through whichever app handles it
finestra apps [filter]       # what is installed
finestra status              # is a desktop connected?
finestra version             # which build this is
```

**Upgrading from web desktop.** Finestra was called *web desktop*. The same
installer on a machine that has one takes it over rather than installing
alongside: the token, the settings and the account answer survive, so a
bookmarked URL keeps working, and the old service, tree and account are removed.
If the new service does not answer, the old one is put back.

## Security

The terminal is a real login shell as the account the service runs as, so
anyone who reaches an authenticated socket has that account's full access. The
defaults follow from that: loopback only, token required, and the SSH tunnel is
the boundary. It is plain HTTP; put TLS in front of it before it faces anything
untrusted.

On a network you trust — a VPN, a tailnet, a LAN behind your own router — the
tunnel is a tax rather than a boundary, and `configure.sh` can drop it:

```bash
sudo /opt/finestra/current/configure.sh --bind 0.0.0.0             # answer everywhere
sudo /opt/finestra/current/configure.sh --bind 100.83.0.4          # one address only
sudo /opt/finestra/current/configure.sh --bind 0.0.0.0 --no-token  # and no login at all
sudo /opt/finestra/current/configure.sh --bind local --token       # put it back
```

It warns, records the choice in the unit, and prints what it opened. Both
survive upgrades and a `configure.sh` run about something else leaves them
alone. The same flags work on `install.sh` and on the one-liner. Binding a
single VPN address is tighter and more fragile: the address does not exist until
the tunnel is up. For a tailnet, either bind everything and let the firewall
decide (`ufw allow in on tailscale0 to any port 7070`), or stay on loopback with
`tailscale serve --bg 7070` in front, which also brings a real certificate.

## What is in it

| App | What it does |
| --- | --- |
| **Terminal** | A real PTY on the host, xterm.js in front. Survives a reload or a dropped connection with whatever was running in it, and asks before closing only when something is running. |
| **Files** | Browse, rename, delete, download, upload. Double-click routes to whichever app handles the file. |
| **Text Editor** | Edit files on the server. Claims `.txt`, `.md`, `.conf` and friends. |
| **System Manager** | Overview with live graphs; processes; systemd units for the system or your own user manager, with a log tail per unit; the whole journal, filtered and followed; disk usage; listening sockets attributed to their process; TLS certificate expiry. All of it from `/proc`, `/sys`, `systemctl` and `journalctl`, with no agent. |
| **Native Desktop Applications** | The host's installed desktop entries, each run in a window. Pin one and it becomes an app of this desktop with its own icon. |
| **Settings** | Appearance, terminal, uploads, which apps are enabled, file associations, session restore, the access token. |

**Native applications.** Each launch gets a compositor of its own, which draws
the window into the browser and takes its mouse, keyboard and clipboard. Wayland
applications run directly; X11 applications — DOSBox-X and the SDL games and
emulators, Tk, Java, Wine, the old X tools — run through an Xwayland the session
starts the moment one asks, with the compositor as its window manager. Menus,
dialogs, size hints and copy and paste both ways work for both. *Open File* and
*Save As* are drawn by the shell through the file-chooser portal, so a confined
application can reach the machine's files. Three limits are worth knowing
before you wonder: anything that insists on rendering through a GPU buffer never
paints (software rendering is set up for the toolkits that can take the hint);
there is no audio; and there is no pointer capture yet, so an emulator or game
that grabs the mouse to read its movement sees it drift. An X11 window is drawn
at 1× and magnified on a 2× screen. Distribution packages are what this is
tested against; snaps run, and when a substantial one misbehaves the reasons
and the debugging order are in [`docs/wayland.md`](docs/wayland.md).

**Terminals and applications outlive their window.** When the socket drops —
tab closed, lid shut, VPN gone — the server keeps the shell or the application
running, and the window that comes back picks it up: a reconnect is shown what
it missed, a reload the last megabyte. Nobody coming back does not end it; what
ends a shell is closing its window, `exit`, or a restart of the service. Come
back from any browser and the desktop opens a window onto every shell and
application nothing is showing; **Shell → Pick up a terminal** lists the rest.
`WD_TERMINAL_GRACE` and `WD_WINDOW_GRACE` put a limit back, in seconds.

**Session restore.** Open windows come back after a reload — app, geometry,
state, stacking and focus. A restored app reopens in the right place: the
terminal in the directory you left, Files in the folder you were in. Turn it off
under **Apps → Reopen windows on reload**.

**File transfer.** Right-click a file in Files to download it; the browser's own
save-as applies and there is no size cap. Drag files from your machine onto the
desktop and they land in the inbox folder (`~/Uploads` by default), or onto a
Files window and they land where you are looking. Collisions never overwrite:
a second `report.pdf` becomes `report (1).pdf`.

**More than one machine.** One shell can drive several servers at once, each a
separate connection straight from the browser to that machine; the servers never
learn about each other, and a window belongs to one host for its life. On a
single-machine install the feature is invisible and costs nothing.

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

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WD_HOST` | `127.0.0.1` | Bind address. On an installed service, set it with `configure.sh --bind`, not by hand. |
| `WD_PORT` | `7070` | Port. |
| `WD_TOKEN` | generated | Access token. Unset, one is minted into `~/.local/state/finestra/token` and can be changed from Settings → Access without a restart; set, the environment owns it and Settings says so. |
| `WD_NO_AUTH` | unset | `1` disables authentication entirely. Only for a private network you control. |
| `WD_ROOT` | unset | Confines the `fs` service to a directory. Does **not** confine the terminal. |
| `WD_STATIC` | auto | Directory the built client is served from. |
| `WD_WDCOMP` | auto | Path to the `wdcomp` binary; without it, native applications are unavailable. |
| `WD_XWAYLAND` | on | `0` turns X11 support off; the X server is otherwise started only when an X client connects. |
| `WD_SERVICES_DIR` | unset | Load extra services from outside the tree (`server/src/extra-services.ts`). |
| `WD_DIAL`, `WD_DIAL_TICKET` | unset | Dial *out* to a relay instead of listening, so the machine needs no open port; the ticket is presented to the relay. |
| `WD_SESSION_TTL`, `WD_SESSION_IDLE` | unlimited | Seconds from start, and seconds without a message, after which the server exits. Enforced inside the process, so a control plane that is hung or forgotten cannot leave a desktop running. |
| `WD_TERMINAL_GRACE`, `WD_WINDOW_GRACE` | unlimited | Seconds a shell, or an application's window, keeps running after its browser disappears. Unset keeps it until the window is closed; `0` hangs up at once. |

## Developing

```bash
npm install --include=dev
npm run build          # client bundle, then server
npm start              # serves client, API and socket from :7070
npm run dev            # Vite on :5173 with hot reload, API and socket on :7070
npm test               # the whole suite, against a server of its own; build first
make -C compositor     # wdcomp; needs libwayland-dev, libxkbcommon-dev, libxcb1-dev, zlib1g-dev
```

```
shared/protocol.ts     wire format, imported by both sides
server/src/
  index.ts             HTTP, static files, WebSocket upgrade
  session.ts           demultiplexes requests and channels onto services
  services/            pty fs sys proc systemd journal net certs apps wayland
client/src/
  core/                rpc, desktop (the shell), hosts, registry, associations,
                       session-store, settings, shortcuts, types (the app SDK)
  ui/                  window, window-manager, menu, taskbar, icons, dialogs
  apps/                terminal, files, editor, sysman, wayland, settings
  apps-extra/          apps from other repositories, globbed at build time
compositor/            wdcomp and its X11 window manager; protocols/ is vendored
packaging/             install.sh, update.sh, configure.sh, the EC2 build and verify
tests/                 run with `npm test`
```

**An app** is a manifest with a `mount` function. It gets a DOM node and the
`DesktopAPI`; the shell never looks inside its element, so it can be plain DOM,
canvas or any framework. Register it in `client/src/main.ts`, or drop it in
`apps-extra/` to keep it in its own repository.

```ts
export const notesApp: AppManifest = {
  id: 'notes',
  name: 'Notes',
  icon: '📝',
  category: 'Utilities',
  handles: [{ extensions: ['.txt', '.md'], verb: 'Edit' }],   // file associations
  async mount({ window: win, root, desktop, params }) {
    const { content } = await desktop.rpc.call('fs', 'read', { path: params.path });
    // ... build the UI into root ...
    return {
      menu: [{ label: 'File', submenu: () => [{ label: 'Save', onSelect: save }] }],
      onClose: () => desktop.confirm({ message: 'Discard changes?' }),
      saveState: () => ({ path: params.path }),   // how it reopens after a reload
      destroy: () => { /* release timers, sockets, listeners */ },
    };
  },
};
```

`window` offers `setTitle`, `setMenu`, `setStatus`, `setBounds`, `close` and
events; `desktop` offers `rpc`, `launch`, `openFile`, `notify`, `confirm`,
`prompt`, `contextMenu`, `settings`, `shortcuts` and the clipboard. The full
reference, a compiling starter and the mistakes worth not repeating are in the
`finestra-app` skill under `.claude/skills/`; installing and enabling apps
without rebuilding the shell is `docs/app-installation.md`.

**A server capability** is a service: named methods (request and response) and
channels (long-lived streams), listed in `server/src/services/index.ts` and
discovered by the client from the handshake. Every capability the browser has
goes through one, so that directory is the complete list of what the desktop can
do to the machine — the place to look when auditing reach.

**The wire protocol** is one WebSocket per host, defined in
`shared/protocol.ts`: requests, channels with `data` and `ctl` in both
directions, and binary frames (`[opcode][channel id][payload]`) for terminal
and window traffic. The client reconnects with backoff; channels are not
restored across a reconnect, and the server side of one is told whether the
connection was lost or the client asked, which is how a shell is kept for a
window that will be back and hung up for one that was closed.

## Docs

- [`ROADMAP.md`](ROADMAP.md) — what comes next, in the order it starts to hurt.
- [`CHANGELOG.md`](CHANGELOG.md) — what changed in each release.
- [`docs/wayland.md`](docs/wayland.md) — the compositor: how applications are
  launched, sized and drawn, what runs and what does not, X11 through
  Xwayland, and how to find out why something did not start.
- [`docs/packaging.md`](docs/packaging.md) — why the release carries its own
  Node runtime, what ships, how updates and rollback work.
- [`docs/app-installation.md`](docs/app-installation.md),
  [`docs/apps-wanted.md`](docs/apps-wanted.md) — the app model, and which apps
  are worth building.

## Licence

**Free for personal and internal business use, on as many machines as you
like**, including a company running it on its own servers and patching it to
taste. No seat count, no expiry, nothing held back.

**A commercial licence is needed to give Finestra to other people** — hosting it
as a service for third parties, shipping it inside a product or appliance, or
redistributing builds.

The terms are the PolyForm Internal Use License with personal and noncommercial
use added; see [`LICENSE`](LICENSE), [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md)
for the plain-language version and how to ask, and
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for what the release bundles.
Patches are welcome; [`CONTRIBUTING.md`](CONTRIBUTING.md) explains the one
sign-off line.
