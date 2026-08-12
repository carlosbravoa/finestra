# Changelog

What changed in each release, for someone deciding whether to update. The
reasoning behind a change is in its commit; the failures that cost time are in
`docs/`.

Entries are written for the person running this, not for the person who wrote
it: what now works that did not, and what to expect if it bites.

## 0.3.0 — 2026-08-12

**Browsers run.** Chrome, Chromium and anything built on them now open, draw,
take input and browse. Five separate faults were stacked under one symptom
("it worked once and never again"), and all five are fixed:

- Chromium defaults to the X11 platform and aborted on a machine with no
  display, before ever reaching Wayland. It is now told which platform to use,
  in the command line of that one launch — nothing is written to your machine
  and nothing changes for a desktop you also log into.
- The compositor advertised a zero-pixel screen when a window was free to pick
  its own size. GTK applications ignore that; Chrome reads it and dies without
  a word. Windows that choose their own size now still have a screen to
  choose against.
- Every application was started with SIGTERM blocked and with file descriptors
  it should never have been handed, including a terminal's. Closing an
  application therefore always killed it outright, however politely we asked.
- Closing a window now **asks** the application to close and waits for it to go,
  instead of killing it and its display at the same instant. Applications that
  keep a lock file — most browsers — no longer leave one behind and refuse to
  start next time. A second click on the ✕ still forces a hung one.
- Reloading the browser tab relaunched an application while the previous copy
  was still dying, and the new one handed its window to the old one. A launch
  now waits for the previous copy to be gone.

**When something does not start, it says why.** The reason was already on the
application's own error output and was being thrown away. A window that closes
without opening now quotes the application, and the "it is running in your
desktop session" explanation is only offered on machines that actually have
one — a headless server is no longer told to go and close a window on a screen
it does not have.

## 0.2.3 — 2026-08-12

- Snap applications are marked as such in the applications window, with one
  note explaining what that means, so the caveat arrives before the surprise.
- The download page says snaps are experimental, and `docs/wayland.md` records
  what is known to work and what is not.

## 0.2.2 — 2026-08-11

- Snaps start on a packaged install. The session bus they need is now derived
  from the runtime directory rather than hoped for in the environment, which a
  systemd unit never has.
- The text editor no longer draws a focus ring across the top and left of its
  text area.
- Publishing refuses to overwrite a version that was already released from a
  different build.

## 0.2.1 — 2026-08-11

- The installer no longer fetches two libraries at install time, and says what
  it does instead.
- The licence is back in the install tree.
- The site counts what it served without the product reporting anything.

## 0.2.0 — 2026-08-11

First public release: the desktop, the terminal on a real PTY, the file
manager, system and service management, native Linux applications through a
Wayland compositor written for this, session restore, and a one-command
install.
