# Roadmap

Ordered by when each starts to hurt, not by size. The first section is the
agreed order for the next releases; the numbered sections after it are the
standing gaps, with the reasoning that put them where they are.

## Next, in this order

The connection is the thing a desktop in a browser is judged on, and 0.3.15
and 0.3.16 made it survive a bad link. The next two releases finish that claim
before anything widens what runs.

1. **0.3.17 — the small ones found shipping 0.3.16.**
   - *A terminal finds the session's SSH agent.* The service is a systemd unit,
     not a login session, so a shell opened in the desktop has no
     `SSH_AUTH_SOCK` and git over SSH falls back to passphrase-protected key
     files. When the runtime directory holds a GNOME keyring (`gcr/ssh`) or
     OpenSSH agent socket, the shell should be given it. Found releasing
     0.3.16 from inside a Finestra terminal.
   - *Checksums published somewhere other than beside the tarball.* A
     `.sha256` next to the file it checks proves only that both were uploaded
     by the same person. Still open from the first install story, and the
     precondition for the updater below.
   - *The desktop knows a newer version exists.* Settings shows the installed
     version, asks finestra.dev for the latest, and offers the update: a
     terminal opened with the `update.sh` command already typed, because the
     service runs unprivileged and the install tree is root's, so somebody has
     to give sudo a password. Today the only way to learn of a release is the
     website.
2. **0.3.18 — lossy encoding for photographic content.** Frames are few now
   (one in flight per window, the newest picture wins) but each is still a
   losslessly compressed bitmap, and a web page is mostly photographs. A
   JPEG or WebP path for the regions that do not deflate well cuts the
   remaining bytes several times over on the link this is actually used on.
   Text and flat UI stay lossless; the choice is per region, not per frame.
3. **Updating from the desktop without a password.** Not before releases are
   signed. The updater grows a `--latest` mode that takes no URL, fetches only
   from finestra.dev and verifies a signature rather than a checksum beside
   the file; then `configure.sh` may install a sudoers rule allowing the
   service user that one command and nothing else. A rule for the updater as
   it is today would make the token worth root: anyone holding it could name
   a URL and have it unpacked and started as root, which is the escalation
   the SSH-boundary design exists to avoid. With signing, the token can only
   ever install a release Finestra signed, the trust apt places in a repository.
4. **Xwayland.** The next limit after the link. X11-only programs fail with
   `Failed to open display` today, and a snap shipping an X11-only toolkit is
   out of reach. Xwayland is just another Wayland client to `wdcomp`, but it
   drags a window-management job behind it: X windows do not announce their
   role or geometry the way `xdg_shell` does, so an X window manager has to be
   written inside the compositor. Medium effort, modest demand, and it is the
   last class of application that does not launch at all.

   Two things keep it smaller than in a general compositor. Every launch has
   its own `wdcomp`, so it has its own Xwayland — one application's windows,
   no X server shared between them. And the shell draws the window frame, so
   the window manager draws nothing; decorations are most of the code in
   weston's and wlroots'. The phases, in order:

   0. **Spike.** `Xwayland -rootless -wm <fd>` as a client of `wdcomp`, and
      an XCB window manager that only pairs X windows with their
      `wl_surface` (`WL_SURFACE_ID`) and maps them. Done when `xmessage`
      shows up in a shell window; it also measures the start-up cost and
      what scale 2 does to an X client.
      ✅ On branch `xwayland-spike`, behind `WD_XWAYLAND=1` (`wdcomp
      --xwayland`): `xmessage` and DOSBox-X — SDL2 with no Wayland driver —
      run in shell windows, resize, and close through `WM_DELETE_WINDOW`.
      Xwayland is ready in about 45 ms, so starting it lazily is about
      resources, not latency. What it settled: rootless Xwayland gives a
      window no surface until the window manager redirects it through
      Composite (sent raw, no libxcb-composite); Xt waits five seconds for a
      ConfigureNotify after every request unless the window manager sends a
      synthetic one (ICCCM 4.1.5); at scale 2 an X window is drawn at 1× and
      shown pixel for pixel, so half size — the shell has to know a window's
      scale, which the frame header did not carry. Seen and left for phase
      1: a second toplevel replaced the shell window of a GTK dialog before
      it instead of getting its own, keeping the dialog's title and size.
   1. **Managed windows as toplevels.** Title (`_NET_WM_NAME`), app id
      (`WM_CLASS`), size hints into `IPC_BOUNDS`, configure both ways, ✕ as
      `WM_DELETE_WINDOW` so the polite-close path is the same one, focus by
      `SetInputFocus`/`WM_TAKE_FOCUS`, `WM_TRANSIENT_FOR` as a dialog.
      ✅ Done, and the two things the spike left were not about X. The
      frame header now carries the scale a frame was drawn at, and the
      browser uses that instead of the screen's — which was also wrong for
      any Wayland client that ignores `wl_output.scale`. The "replaced
      window" was zenity: DOSBox-X asks a question through it, zenity exits
      without destroying anything, and libwayland destroys a dead client's
      `wl_surface` before its `xdg_surface`, so the compositor had lost the
      server pointer it needed to report the window closed. Fixed for every
      client that crashes or exits with a window up. With that, a window
      that commits no buffer is reported hidden rather than kept, and when
      the window goes while another parentless toplevel is up, that one
      becomes the window (the chooser-then-main pattern) instead of staying
      a dialog over a stale frame. Still to come from this phase's list:
      nothing; menus are phase 2.
   2. **Override-redirect windows** — menus, tooltips, drop-downs — as
      popups. They place themselves in absolute X coordinates, which here
      are the window's own, since the output is the window.
   3. **Clipboard.** Xwayland does not bridge X selections to Wayland's; the
      window manager has to, `CLIPBOARD` into the existing data-device
      selection, INCR included.
   4. **Launch and lifecycle.** Xwayland started on the first X connection,
      so a Wayland application pays nothing. `DISPLAY` changes what SDL2
      and Qt 5 choose, so the spawn says `SDL_VIDEODRIVER=wayland,x11` and
      `QT_QPA_PLATFORM=wayland;xcb` — argv and env, never configuration.
      Xwayland is plumbing, not the application, for "did not start",
      `liveApps` and `IPC_CLIENT`; `IPC_RESYNC` covers X windows; a missing
      Xwayland names its package.
   5. **Checks and packaging.** An XCB fixture client beside
      `subsurface-client.c`, run at scale 2; Xwayland per distribution in
      `checks.sh` (Amazon Linux 2023 may not package it); the real list
      from `docs/wayland.md` — `dosbox-x`, Tk, VLC's skins2.

   Not in the first round: image cursors (`pointer_set_cursor` only knows
   shapes, and Xwayland only sends images, so X windows get the arrow),
   HiDPI for X clients (drawn at 1× and magnified), drag and drop, PRIMARY,
   XInput2 touch. libxcb is the only new dependency — Composite and the rest
   are a raw request or two, not a library — and whether `wdcomp` links it
   or `dlopen`s it, so a machine without X libraries still runs Wayland
   applications, is decided after the spike.
5. **Audio, routed to nothing.** No sound server is offered to the session, so
   an application that insists on one fails to start, and the rest are
   silent. The first step is **not** sound in the browser: it is a server that
   answers and discards, a PipeWire or PulseAudio null sink in the session,
   so launching never fails for want of audio. Only then is sound into the
   browser worth measuring, and it costs weeks while the null sink costs days.
6. **The rest of the portal.** Notifications and the settings portal are small
   and common: Firefox asks the settings portal for the colour scheme and most
   applications want to post a notification, and the shell already has both.
   Screenshot is different, since the shell already owns every pixel.
7. **More apps** from [`docs/apps-wanted.md`](docs/apps-wanted.md): process
   manager, disk usage, system monitor, network and ports. Each is a small app
   over services that mostly exist.
8. **dmabuf import.** GPU-rendered clients that `force_shm` cannot rescue.
   Hardest and lowest payoff on a headless server; last on purpose.

## 1. Authentication — the token is deliberate, its storage is not

**Settled since this was written: the SSH tunnel is the authentication
boundary, and the token is a second latch on top of it.** Reaching
`127.0.0.1:7070` means you already got onto the machine with a key you own. A
standalone app whose point is being simple to deploy does not need more, and
the deployment story below is the design rather than an apology for one.

**Login as an OS user was tried, and does not work.** An unprivileged service
cannot verify another user's password: `unix_chkpwd` refuses a non-root caller
(`check pass; user unknown`) and answers only for root — verified on a real
machine. The only ways through are to let the service read `/etc/shadow` (the
`shadow` group, a capability) or to ship a setuid-root helper, each a larger
attack surface than the thing it protects, on a service that is itself the gate
to the machine. The attempt and its evidence are in the history around the
commit "Back out PAM login: the token over an SSH tunnel is the model". Do not
re-derive it.

So steps 3 and 4 below are **not** planned work. What remains genuinely worth
doing is step 1, which is about where the token is *stored*, not what it is.

What is still wrong with it:

- **One token, one identity.** No notion of *who* connected. Every session is
  the same principal, so there is nothing to audit, revoke individually, or
  scope.
- **Bearer, so possession is authority.** It grants shell access to the server
  from anywhere, indefinitely, to whoever holds it. Copying it off-box is one
  `fetch()`.
- **No expiry, no rotation path.** Rotating means deleting a file on the host
  and restarting the server.
- **Readable by page JavaScript.** `main.ts` keeps a copy in `localStorage` to
  put `?t=` on the WebSocket URL, which puts it within reach of any code
  running in the page — including any app we later let people install.

Steps, smallest first:

1. **Stop storing the token where script can read it.** The server already
   sets an `HttpOnly` cookie. If that cookie rides the WebSocket upgrade on its
   own, the `localStorage` copy is redundant. Verify in both dev (through the
   Vite proxy) and production before removing it.
2. **Rotation and expiry.** A way to invalidate a token without shell access,
   and a default lifetime.
3. ~~**Real identity** against the host's own users.~~ Attempted and abandoned —
   see above. Not achievable without privileging the service.
4. ~~**Sessions, not credentials.**~~ Was built on top of step 3 and removed
   with it. A session store is only worth having once there is an identity to
   put in it.

The deployment story is "bind loopback, reach it over SSH", and that is the
answer rather than a placeholder for one.

## 2. Multi-user

Follows directly from authentication step 3. Today the server runs everything
as the user who started it. Real users mean per-connection privilege, per-user
settings and sessions, and deciding whether one server process drops privileges
or whether each user gets their own.

## 3. Installing and enabling apps

Design and staging in [`docs/app-installation.md`](docs/app-installation.md).
**Stage 1 is done** — enable/disable in Settings, persisted server-side.
Next is Stage 2: loading app packages from disk.

## 4. File transfer — remaining

Download and drag-and-drop upload exist. Still missing: per-file progress for
large uploads (fetch cannot report upload progress; needs XHR or streams),
folder upload, and drag *out* of the browser.

## 5. More apps

See the sysadmin app list in [`docs/apps-wanted.md`](docs/apps-wanted.md).

## 6. Real Linux applications

Not a gap so much as a different ceiling: a Wayland compositor on the server
puts an ordinary application into a window of this shell. Design and staging
in [`docs/wayland.md`](docs/wayland.md). Stages 1–8 are done: **Native
Desktop Applications** runs real GTK, Qt and Chromium-based programs, and the
Firefox and Thunderbird snaps, in a window of this desktop — damage-only frame
streaming, mouse and keyboard, menus, tooltips and dialogs, subsurfaces, cursor
shapes, keyboard-layout detection, copying text out, the file-chooser portal
answered by the shell, and a session that survives its connection being cut or
starved. What is left is in the order at the top of this file: Xwayland, audio
routed to nothing, the rest of the portal, dmabuf.

## Done

- Windows, taskbar, icons, menus, context menus, dialogs, notifications.
- File download (streaming HTTP) and drag-and-drop upload with an inbox
  folder; drops on a Files window target the visible directory.
- Settings app: theme (dark/light), wallpaper, terminal defaults, uploads
  folder, app enable/disable (server-persisted), association overrides,
  session controls. Every colour is a token, so themes are one CSS block.
- Test suites live in `tests/`; `npm test` runs them against a scratch server.
- Terminal on a real PTY; file manager.
- Session restore, including app-contributed state.
- File associations — apps declare what they open; the file manager routes
  double-clicks and offers "Open with".
- Native Linux applications in a window (stages 1–8 of `docs/wayland.md`),
  including snaps, their *Open File* dialog, and surviving a dropped or
  starved connection: nothing left running is closed for you, and a slow link
  is shown the newest frame rather than every one.
- One-command install with a bundled runtime, verified on five distributions;
  updates with rollback.
