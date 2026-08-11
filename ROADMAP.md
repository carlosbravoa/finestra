# Roadmap

Ordered roughly by when each starts to hurt, not by size.

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

Not a gap so much as a different ceiling: run a Wayland compositor on the
server and put an ordinary application — an editor, a Qt tool — into a window
of this shell. Design and staging in [`docs/wayland.md`](docs/wayland.md).
Stages 1–5 are done: **Native Desktop Applications** runs a real GTK program
in a window of this desktop — damage-only frame streaming, mouse and keyboard,
menus, tooltips and dialogs, cursor shapes, keyboard-layout detection, and
copying text out of it. Browsing and pinning give an application its own
desktop identity. What is left is stage 6, and none of it is needed yet:
dmabuf for GPU applications, H.264 for animated content, Xwayland, audio, and
a portal so an application's *Open File* dialog opens the Files app.

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
