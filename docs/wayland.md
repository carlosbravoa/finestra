# Design: running real Wayland applications

Status: **stage 5 done**, with one documented gap. A real Linux application
runs on the server and is usable in a window of this desktop — menus, dialogs,
tooltips, mouse, keyboard, cursor shapes, keyboard-layout detection, and
copying text out of it.

The desktop currently owns every pixel it shows, because every app is one we
wrote. This describes how to put a *real* Linux application — `gnome-calculator`,
a Qt tool, an editor — into a window of this shell, running on the server and
rendered in the browser.

## Why this is smaller than it sounds

A Wayland compositor never draws the application. The client renders its own
window into a buffer and hands the compositor those pixels plus a rectangle
saying which part changed. There is no rendering engine to implement, no widget
toolkit to reimplement, no drawing protocol to interpret. What a compositor
does is: own a socket, track surfaces, hand out buffers' contents, and route
input.

That is the same shape as everything already in `server/src/services/` — a
named capability that streams bytes one way and takes events back.

## What a Wayland application actually does

1. Connects to a unix socket at `$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY`. The
   protocol is binary — object ids, opcodes, arguments — and it also passes
   **file descriptors as ancillary data**.
2. Binds `wl_compositor`, creates a `wl_surface`. Binds `xdg_wm_base`, wraps
   the surface in an `xdg_surface`, and gives it the `xdg_toplevel` role.
   **That toplevel is the window.** Title and app id are set on it.
3. The compositor sends `configure(width, height, states)`. The client acks it,
   renders, attaches a buffer, calls `damage_buffer(x, y, w, h)`, and commits.
4. The buffer is one of two things:
   - **`wl_shm`** — a memfd the client passed over the socket. The compositor
     mmaps it and reads pixels directly. libwayland-server implements the whole
     pool/mmap/fd dance for us.
   - **`linux-dmabuf`** — a GPU buffer handle, importable only through
     EGL/GBM.
5. It asks for a `wl_callback` for the next frame. **It will not draw again
   until we send `done`.** That is flow control, for free, and it is exactly
   what a network-attached compositor needs.
6. Input comes back through `wl_seat` — `wl_pointer`, `wl_keyboard`.

Steps 3 through 6 each have an obvious counterpart in this shell. That is the
whole thesis.

## The mapping

| Wayland | Finestra |
| --- | --- |
| `xdg_toplevel` | one shell window (`ui/window.ts`) |
| `set_title` / `set_app_id` | `win.setTitle()`, icon lookup |
| `configure(w, h)` ← | the window's resize handler |
| buffer + `damage_buffer` | binary channel frame → `putImageData` on a canvas |
| `wl_callback.done` → | sent once the browser has acked the frame |
| `xdg_toplevel.move` / `.resize` | the shell starts its own drag |
| `xdg_popup` + `xdg_positioner` | an overlay layer, free to escape the window |
| toplevel with `set_parent` | modal child window |
| `wl_pointer` / `wl_keyboard` | DOM events on the canvas |
| `wl_data_device` selection | `navigator.clipboard` |
| `wl_output` | the window's size and `devicePixelRatio` |

`xdg_toplevel.move` deserves a note. Applications draw their own titlebars, and
when the user drags one the *client* asks the compositor to begin an
interactive move. The window manager already knows how to do that; it just has
to accept the request from somewhere new.

## Architecture

**Node cannot speak this protocol.** `net` has no `SCM_RIGHTS` support — no
ancillary-data API at all — and shm buffers, the xkb keymap, clipboard pipes
and dmabuf handles all arrive as file descriptors. So the compositor is a
separate process, and Node stays the router it already is.

```
browser  ──ws──►  node server  ────fd 3────►  wdcomp
 apps/wayland/    services/wayland.ts          libwayland-server
 canvas, blits    routes frames and ctl        WAYLAND_DISPLAY=wd-…
                                                     ▲
                                                     │ the real protocol
                                                gnome-calculator
```

`wdcomp` speaks Wayland downward and a small framed protocol upward — length
prefix, one type byte, fixed-layout binary in both directions, so the
compositor needs no JSON parser and node decodes it with a `Buffer`:

| Up | |
| --- | --- |
| `W` | a window exists: id, size, title, app id |
| `T` | its title changed |
| `X` | it closed |
| `F` | a frame: id, damage rect, window size, flags, deflated pixels |
| `L` | a log line |

| Down | |
| --- | --- |
| `C` | configure this window to a size |
| `A` | that frame arrived — release the frame callback |
| `K` | ask this window to close |

**Not on stdout.** The application and, under `dbus-run-session`, the bus
daemon both inherit it, and one stray `printf` shreds the frame stream — which
is exactly what happened the first time. The channel is fd 3, which node opens
as a bidirectional socket and hands to the child.

### Why C, and not Rust with Smithay

Smithay would hand us xdg-shell, seat/xkb and popup positioning already
written, and that is a real saving at stage 4. We went with C on
libwayland-server anyway:

- **Every dependency is already required or already present.** `node-pty`
  means a C toolchain is a build requirement today; `libwayland-dev` is the
  only addition. Smithay means a Rust toolchain and a few hundred crates.
- **libwayland-server already implements `wl_shm`,** including the memfd mmap
  and bounds accounting — the part that most needed a library.
- **It stays auditable.** The README's claim is that `server/src/services/` is
  the complete list of what the browser can do to the machine. A ~2000-line
  binary with one library dependency keeps that claim cheap to check; a large
  dependency tree does not.

The generated protocol marshalling comes from `wayland-scanner` against the
XML in `compositor/protocols/`, so the protocol code is not hand-written. If stage 4
turns out to be worse than expected, stages 1–3 are a standalone binary behind
a stable IPC and can be replaced without touching the browser side.

## What will work, and what will not

The dividing line is **shm versus dmabuf**, and it is sharp:

| Buffer type | Applications |
| --- | --- |
| **shm** — works with a small compositor | GTK 3, Qt Widgets, SDL2 software, `foot`, `alacritty` |
| **dmabuf** — needs EGL/GBM import | GTK 4 by default, Qt Quick, Electron with GPU |

The escape hatches are real, and since we control the launch environment we can
apply them per application: `GSK_RENDERER=cairo` puts GTK 4 back on shm,
`QT_QUICK_BACKEND=software` does it for Qt Quick, `LIBGL_ALWAYS_SOFTWARE=1`
covers the rest. That is enough to cover GTK 4 without implementing dmabuf.

### The second dividing line: who draws into the toplevel

There is a sharper split than the buffer type, and it is invisible until you go
looking: **whether the application draws into its `xdg_toplevel` or into a
subsurface.** `wl_subcompositor` exists here so that clients binding it do not
fall over, but it composites nothing, and the IPC path drops every commit that
arrives without an xdg role — `commit on a surface with no xdg role`.

Chrome creates **zero** subsurfaces: chrome, tabs, page, all of it goes to the
toplevel, which is the whole reason it works. Firefox puts its **entire**
interface — tab strip, toolbar, URL bar and web content — into one
`wl_subsurface`, and its toplevel is nothing but an empty rounded rectangle
holding the shadow. So Finestra faithfully renders the one surface Firefox does
not draw in. In a 55-second run the browser received exactly **one** frame, 1.9
kB of blank window, while **27** subsurface commits were dropped. The window is
there, correctly sized and titled, and permanently empty.

Three things about this are worth keeping:

**It is not dmabuf, and not the GPU.** The subsurface carries ordinary shm the
compositor can read perfectly well — the PNG sink proves it by writing a
pixel-exact Firefox window. Nothing needs to be imported, converted or
accelerated; the pixels are already in hand and simply have nowhere to go.

**The debug path flatters the shipping path.** `emit_frame_png()` writes *every*
commit regardless of role, so `smoke.sh` renders Firefox beautifully while the
product shows a blank window. A compositor check that passes and a product that
fails, on the same machine in the same second — trust the IPC path, not the PNG.

**No pref avoids it.** `gfx.webrender.compositor=false`,
`gfx.webrender.software=true` and `layers.acceleration.disabled` were measured
and change nothing: the subsurface is `MozContainerWayland`, part of how Gecko
draws on Wayland, not a compositing option. Firefox cannot be configured into
working here.

The work is smaller than "implement compositing", because this compositor never
composites anything. It ships each surface to the browser as its own canvas and
lets CSS stack them — which is exactly what popups already do, via `IPC_POPUP`
and `placePopup()`. A subsurface is the same mechanism: a message carrying
parent and position, `place_above`/`place_below` for z-order, and the client's
existing `createSurface()`. The genuinely fiddly part is **synchronised**
subsurfaces, whose state applies on the *parent's* commit rather than their own;
ignore that and the result is tearing and stale frames — which is to say, it
looks like the bug it was meant to fix.

### What the buffer type does not explain

Running all 63 desktop entries on one Ubuntu machine put only 21 on screen, and
the buffer type was not why. Two things in the way of the rest, neither of them
protocol:

**The socket has to be called `wayland-<digits>`.** `abstractions/wayland`,
which every snap profile and every confined `.deb` includes, permits exactly one
name pattern under the runtime directory. A socket called anything else — ours
was `wd-<pid>-<n>` — is one a confined application cannot open, and it dies with
`Gtk-WARNING: Failed to open display` having never reached the compositor. The
rename put 15 more applications on screen, Papers and Transmission among them,
and is checked in `tests/wayland.mjs`.

**A snap needs the session bus we were hiding.** `snap-confine` puts the
application into a transient systemd scope and asks the *session* bus to make
it; a private `dbus-run-session` has no systemd on it, so the cgroup is never
created and the snap exits before it draws — every snap, every time, with
`is not a snap cgroup for tag snap.<name>`. Snaps therefore get this user's own
bus when there is one, and the single-instance risk that comes with it. That was
the other 14.

**And a packaged install had no such bus in its environment.** Those 14 were
verified from a shell, where `DBUS_SESSION_BUS_ADDRESS` is simply *there*; a
systemd unit inherits no such thing. `configure.sh` sets
`XDG_RUNTIME_DIR` and stops, so the address was empty, every snap got a private
bus, and every `.deb` application carried on working — which is a confusing
shape to debug, because nothing is broken except the confined half of the menu.
`sessionBusAddress()` now derives it from the runtime directory the same way
`systemd.ts` does for `systemctl --user`, and lingering is what guarantees the
user manager behind it. The question is asked **only for snaps**: everything
else keeps its private bus whatever the answer, so a machine that does have a
desktop session cannot start losing GTK windows to it. Missing
`dbus-user-session` is the remaining way to have no bus at all, and
`configure.sh` says so rather than installing it.

**A frame bigger than the socket buffer looked like the application quitting.**
The frame channel is a socketpair node hands us, and node makes *both* ends
non-blocking — so a write larger than the 208 kB the kernel buffers comes back
`EAGAIN` part-written, with the reader alive and about to drain it. `write_all`
retried `EINTR` and nothing else, so that counted as a broken channel: the
compositor shut down cleanly and the browser was told the application had
exited normally. Spotify died at its first album cover, the Snap Store at its
first screenshot, both a few seconds in. Flat GTK windows deflate to a few
kilobytes and never reach the threshold, which is why this presented as "some
applications" rather than as a frame size. `write_all` now polls for room,
which is the blocking behaviour the design always assumed it had, and
`compositor/src/ipc-test.c` pins it — that test needs no Wayland, no display
and no application, so it runs in `npm test` everywhere.

**Chromium picks X11, and dies before it ever reaches Wayland.** Chrome, and
everything derived from Chromium, defaults to the X11 Ozone platform. On a
machine with no display that is not a fallback, it is an immediate abort:
`Missing X server or $DISPLAY`, then `The platform failed to initialize.
Exiting.`, status 1, in well under a second, with the compositor never seeing a
client at all. Nothing about the GPU is involved, which is the misleading part —
with no `zwp_linux_dmabuf` global to bind, Chrome selects shm by itself and
renders a page correctly, software all the way down. The one thing it needs is
`--ozone-platform=wayland`, and it has to be **argv**: `OZONE_PLATFORM` in the
environment is ignored, so the trick that works for GTK (`GDK_BACKEND`) and Qt
(`QT_QPA_PLATFORM`) has no equivalent, and `force_shm` cannot carry it. That
makes it a launch quirk belonging in the argv the service spawns, and nowhere
else. A `.desktop` file under `~/.local/share/applications` would fix it just as
well here and charge a machine that *does* have a desktop session for the
privilege: a duplicate entry in that person's own menu, forcing Wayland, and so
breaking the browser for anyone on an Xorg session. Nothing done to make an
application run here should be visible to a login session this did not start.
Electron applications embed the same Ozone and are expected to fail identically;
not tested.

**Closing a window kills the group, and a single-instance application never
recovers from it.** A window closing takes the whole process group with it, so
nothing the application would have done on the way out gets done. Chrome is the
loudest example: it leaves `SingletonLock` behind in its profile, and every
later launch reads it, fails to make sense of it, and kills *itself* rather than
risk the profile —

```
process_singleton_posix.cc:1150  Failed to extract pid from path: …/SingletonLock
process_singleton_posix.cc:347   Failed to create …/SingletonLock: File exists (17)
chrome_main_delegate.cc:520      Failed to create a ProcessSingleton for your profile
                                 directory. Aborting now to avoid profile corruption.
```

— with `SIGTRAP`, which `wdcomp` reports as `client exited (status -1)` because
it was a signal and not an exit code. The state is a file in the user's profile,
so it outlives the session, the service, a restart and a reinstall: the symptom
is **"it worked once and never again"**, and the shell says only "started and
exited without opening a window", which points at desktop services and is the
wrong place to look. It was isolated by changing exactly one thing —
`--user-data-dir` to a fresh directory — which turned `KILLED BY SIGNAL 5` into
a normal exit and a window.

That was the first diagnosis, and the profile turned out to be innocent: a
"poisoned" profile, copied back byte for byte, ran perfectly outside the
service. What was actually wrong took a day of A/B bisection — same profile,
same minute, replica spawn working while the product failed — and came apart
into three faults stacked on each other, each masking the next:

**Every application was born deaf to SIGTERM.** Node blocks the signals it has
handlers for around `fork`, and the mask survives `exec`: a diagnostic script
launched through the product began life with `SigBlk 4002` — SIGINT and SIGTERM
blocked — all the way down through `dbus-run-session` and the compositor into
the application. So the product's polite `SIGTERM → 4 s → SIGKILL` had never
once delivered a SIGTERM, `wdcomp`'s "client ignored SIGTERM, killing it" was
this and not a stubborn client, and every shutdown in the product's history was
secretly a SIGKILL. The same spawn also leaked every non-CLOEXEC fd the server
held — a terminal's PTY master reached Chrome as fd 23, which is a live handle
into someone's shell session. Both are scrubbed in `spawn_client` now
(`sigprocmask` to empty, `close_range(3, ~0)`), which is the one place every
launch passes through whatever leaks node grows next.

**Closing never asked; it ambushed.** The polite path — client `closeWindow`,
server `MSG_CLOSE`, compositor `xdg_toplevel_send_close` — existed end to end
and had zero callers. Every ✕, tab close and reload tore down the channel and
SIGTERMed the process group, killing the compositor in the same instant — so
the application lost its display mid-shutdown. Chrome aborts inside half a
second when that happens (measured: eight processes to none in 0.5 s), leaving
its `SingletonLock` behind. The ✕ now sends the xdg close and vetoes the window
close; the application exits on its own terms and its `closed` message closes
the window — one that shows a "save your work?" dialog keeps its window, and
one that answers nothing yields to a second click. `stop()` does the same for a
dead tab: ask every live toplevel, two seconds, then SIGTERM, then SIGKILL.

**Session restore handed new windows to corpses.** Reloading the tab kills the
old session's application at the same moment restore relaunches it; the new
instance found the dying one's singleton socket still answering, handed its
window over, and exited 0 — reported as "started and exited without opening a
window", with nothing left running at all. Captured directly: one reload, two
exit records, an exit-0 handoff among them, zero survivors. A relaunch now
waits out the previous instance's exit (`stoppingApps`), which closes the
window in which a corpse can be handed anything.

The single ingredients were each verified harmless before the stack was found:
a stale lock alone recovers (launch → crash-kill → relaunch works), the leaked
ptmx alone does not crash Chrome, the blocked mask alone does not either. It
took all three faults plus concurrency to produce "worked once, never again" —
which is why it resisted every single-variable explanation, including two
confidently wrong ones recorded in earlier versions of this note.

**And under all of it, a fourth fault, the one that made the crash itself:
`-g 0x0` advertised a zero-pixel screen.** The option means "let each window
choose its own size", and the output advertisement passed the zeros straight
through — `wl_output.mode(…, 0, 0, …)`. GTK shrugs at an empty screen; Chrome
consults the output metrics during startup and CHECK-crashes, silently,
because official builds strip the CHECK message. This is why the failure
pattern read as haunted: a launch through session restore carries the saved
window size and worked; a fresh launch from the picker carries none and died;
and every probe run outside the product happened to pass a real `-g`, so the
replica could never reproduce it. `WAYLAND_DEBUG=client` is what finally
named it — the protocol trace ends at the 0×0 mode, three lines before the
trap. The output now advertises a real screen (the configured size, or
1920×1080 when the windows are choosing their own), which is the difference
between "your window may pick its size" and "you live on zero pixels".

Alongside, **say what the application said**: the reason for a death was on
stderr the whole time, collected into a 4 kB tail and discarded unless
`WD_DEV=1`. `lastComplaint()` now filters the ever-present noise (ours, the
bus, Chromium's GPU/telemetry/crashpad grumbles), skips warnings, prefers
fatal-sounding lines over merely loud ones, strips the
`[pid:tid:date:LEVEL:file(line)]` stamp, and quotes what is left. And
`explainSilentExit()` no longer asserts a desktop-session handoff on machines
that have no desktop session — logind's session `Type` is checked first, since
telling a headless-VM user to "close it there" sends them looking for a screen
that does not exist. In official Chrome builds a failed CHECK traps with the
message stripped, so when Chrome dies silently by SIGTRAP there is genuinely
nothing to quote — the fallback sentence remains for that case.

What is genuinely out of reach, and stays that way:

| Not running | Why |
| --- | --- |
| `texdoctk`, `timidity -ia` | Tk, X11 only — needs an Xwayland we do not have |
| An application already open on the host | Single-instance handoff: LibreOffice hands the document to the `soffice.bin` in your login session and never draws here. A server with no desktop session never sees this. The session now *says so* rather than reporting a clean exit — see "Explaining the handoff" |
| `dosbox-x` | Not unexplained after all: it aborts with `Can't init SDL x11 not available`, and the SDL2 it ships has no Wayland video driver compiled in — `SDL_VIDEODRIVER=wayland` changes nothing. X11 only, so Xwayland again |
| VLC with the skins2 interface | `unable to open display`; skins2 is X11 only. Its Qt interface works |
| Anything on EGL that refuses software | `LIBGL_ALWAYS_SOFTWARE=1` makes it abort (`Not allowed to force software rendering when API explicitly selects a hardware device`); without it, it runs happily and commits dmabuf we cannot read. `GALLIUM_DRIVER=llvmpipe` gets as far as `failed to create dri2 screen`. This one is waiting on dmabuf, not on a workaround |

Slow is not broken: Deja Dup takes about a minute to first paint because it
waits out a D-Bus activation timeout for `org.freedesktop.secrets`, which a
private bus does not have. Turning accessibility off (`NO_AT_BRIDGE`,
`GTK_A11Y=none`) was measured and changed nothing, so it is not done.

### Snaps are experimental, and this is what that means

**Status: a simple snap runs. A complex one is not to be relied on.** The
product says so on the download page, because a user who installs this expecting
their whole snap library to work will file the same handful of issues over and
over, and every one of them is already understood.

Two things get conflated here and are worth separating. Getting a snap to
*start* is solved, and it took two fixes: the socket has to be named
`wayland-<digits>` for `abstractions/wayland` to permit it, and the process
needs a session bus with `systemd --user` on it or `snap-confine` cannot make
its tracking cgroup. Both are above. What is *not* solved is everything a
substantial application expects once it is running, and a snap is more exposed
to that than a `.deb` because it carries its own runtime and cannot see much of
the host.

The known limits, worst first. None is snap-specific in mechanism; snaps just
hit them sooner and harder.

| Limit | What you see | Why |
| --- | --- | --- |
| **No dmabuf import** | A window that never paints, or an application that exits complaining about EGL | Anything on the GPU commits buffers we cannot read. `wdcomp` sets `GSK_RENDERER=cairo`, `QT_QUICK_BACKEND=software` and `LIBGL_ALWAYS_SOFTWARE=1` when it spawns the client (`force_shm`, on by default), which is what rescues GTK 4 and Qt Quick. **Whether those survive into a snap's own runtime is not something we control** — snapd rebuilds much of the environment — so the escape hatch that fixes a `.deb` may simply not apply. Electron-based snaps are the usual casualty |
| **No portals** | *Open File* and *Save As* do nothing, hang, or return empty; screenshots, secrets and notifications fail | `xdg-desktop-portal` is the interface a confined application uses to reach anything outside itself, and a headless server has no portal running. A `.deb` often falls back to its own file chooser; a strictly confined snap frequently has no fallback because the portal *is* its file access |
| **No Xwayland** | `Failed to open display` from anything X11-only | Stage 6, unstarted. A snap shipping an X11-only toolkit is out of reach for the same reason `dosbox-x` is |
| **No audio** | Silence, or a startup failure in an application that insists on a sound server | No PipeWire or PulseAudio is offered to the session |
| **Single-instance handoff** | Starts, draws nothing, exits cleanly | Only on a machine that *has* a desktop session: snaps share this user's real session bus, so a copy already running there takes the window. The session says so rather than reporting a clean exit — see below. A headless server never sees this |
| **snapd counts an open window as the snap running** | Refreshes held back while you work | `snap-confine`'s scope stays alive as long as the application does. Ordinary snapd behaviour, listed because it surprises people |
| **A desktop entry that cannot work here** | The application is not offered at all | Deliberate: the Chromium snap ships one whose whole body is `OnlyShowIn=UbuntuFrame` and `Exec=/usr/bin/false`, and offering it would make its failure look like ours. `OnlyShowIn`/`NotShowIn` filtering is above |

What has actually been seen to work: the fourteen snaps that came on screen once
they were given a session bus, and the Snap Store drawing its window on a server
started the way the unit starts one. What has been seen to fail is consistent
with the table — the failures are in what the application wants next, not in
getting it launched.

**If you are debugging one**, the useful order is: does it appear in the
applications window at all (desktop entry filtering); does it exit immediately
(bus, cgroup, or handoff — the session's closing message distinguishes these);
does it start and never paint (dmabuf, almost always); does it start, paint, and
then fail at one particular action (portals, almost always). `wdcomp -v` and the
`L` log messages carry the compositor's side of it.

**Prefer the distribution package where a project ships both.** Not a
philosophical position — a `.deb` inherits the environment we set, uses the
host's libraries, and has no confinement between it and the socket.

### Explaining the handoff, rather than preventing it

A session that never maps a window now closes with a sentence saying so, and —
when the application was sharing this machine's bus, which is to say when it
was a snap — naming the handoff as the likely reason. The exit code is
deliberately not repeated: it is `wdcomp`'s, and `wdcomp` returns 1 for "no
frame streamed" whatever the cause, so quoting it describes the wrong process.

**Preventing it was tried, and rejected.** Snaps only need the host bus because
`snap-confine` asks `systemd --user` for a tracking scope, and it skips that if
it finds itself already inside a cgroup named `snap.<snap>.<app>*`. Creating
one first —

```
systemd-run --user --scope --unit=snap.firefox.firefox-<unique> -- dbus-run-session -- wdcomp …
```

— does work, and it was measured: Thunderbird, GIMP and the Snap Store all
still launch on a private bus, Firefox draws *here* instead of on the host's
screen, the frame channel survives on fd 3, and closing the channel still reaps
the group. It was still the wrong trade:

- It depends on an **undocumented snap-confine internal**. Nothing promises
  that check will keep its shape, and if it changes, every snap stops
  launching.
- snapd would count the scope as that snap running, and hold back its refresh,
  for as long as a window is open — while the scope also contains our
  compositor and its bus daemon.
- The benefit only exists on a machine that *has* a desktop session to lose the
  window to. On the headless server this product is for, it buys nothing and
  adds a dependency.

The `OnlyShowIn`/`NotShowIn` filtering landed alongside, for the same reason:
an entry that cannot work here should not be offered. The Chromium snap ships
one whose body is `OnlyShowIn=UbuntuFrame` and `Exec=/usr/bin/false`.

## The parts that are genuinely fiddly

**Keyboard.** *Built, with one gap left.* `wl_keyboard` carries *evdev
keycodes*, not characters — the client does its own xkb translation. So we send
physical keys, mapped from `KeyboardEvent.code` through a static table
(`client/src/apps/wayland/keymap.ts`); both describe the same physical
positions, which is why that is a table and not a guess.

The gap is the layout. The compositor compiles a keymap with xkbcommon and
hands it over as a file descriptor, defaulting to `us` and settable per
session — but nothing yet *detects* what the person is really typing on, so an
AZERTY user pressing `a` sends `KeyQ` and the application sees `q`. Chromium's
`navigator.keyboard.getLayoutMap()` could generate the keymap from what the
browser reports; elsewhere it needs to be a setting. Neither exists yet.

**Client-side decorations.** GTK never accepts server-side decorations, so the
titlebar is inside the buffer and *the buffer is larger than the window* — GTK
pads it with invisible margins for its drop shadow.
`xdg_surface.set_window_geometry` gives the real rectangle; ignore it and every
window gains a fat transparent border. Qt does honour `xdg-decoration`, so Qt
applications can be given the shell's own frame instead.

**Popups.** Menus and dropdowns are separate surfaces placed by
`xdg_positioner` anchor/gravity/constraint rules, and they must be allowed to
extend past the parent window's edge. They also take a grab: a click outside
has to produce `popup_done`, or the menu wedges open. This is the difference
between "it renders" and "it is usable".

**Bandwidth.** 1280×720 RGBA is 3.7 MB per frame; streaming full frames is dead
on arrival. Damage rectangles are the saving grace — typing in an editor
damages a few hundred pixels. Ship raw damage rectangles plus zlib first, hold
frame callbacks until the browser acknowledges, and only reach for
ffmpeg → H.264 → WebCodecs `VideoDecoder` when something actually animates.

**Cursor.** `wl_pointer.set_cursor` hands over a surface. Map the common ones
onto CSS cursors; `cursor-shape-v1` makes that exact where the client supports
it.

**The session bus.** Found the hard way in stage 1, and it is not a Wayland
problem at all. A `GApplication` needs a session D-Bus to register on; without
one it exits with status 0 and no window, no error and no clue.
`gnome-text-editor` does exactly that. Worse, if it registers on the *host
user's* bus and that application is already running in their real login
session, the single-instance protocol hands the window to that instance — so
the window opens on the physical screen and the browser gets nothing. Each
A Finestra session therefore needs its **own** bus (`dbus-run-session`), not
the one in the ambient environment. The upside is that the same private bus is
where `xdg-desktop-portal` would live, which is the hook for pointing an
application's *Open File* dialog at the Files app.

## Stages

1. **`wdcomp` alone.** ✅ Headless, shm, writes each committed frame to a PNG.
   No browser involved. This validates the hard half — see "What stage 1
   settled" below.
2. **Pixels in the browser.** ✅ `server/src/services/wayland.ts` and
   `client/src/apps/wayland/` — a canvas, damage blits, frame pacing, and
   window resize driving `configure`. A window you can see but not touch.
3. **Input.** ✅ Pointer and an xkb keyboard. Now it is a usable application.
4. **Windowing fidelity.** ✅ Popups with real positioner geometry, dialogs,
   interactive move/resize, min/max size hints. Still open: `xdg-decoration`
   for Qt, and giving a dialog a shell window of its own.
5. **Integration.** ✅ Browse-and-pin, cursor shapes, keyboard-layout
   detection, and the clipboard — copying out fully, pasting in with the
   limitation described below.
6. **Later, if something demands it.** Subsurface composition — and Firefox is
   the something that demands it, being unusable without it; dmabuf import for
   GPU applications; H.264 for animated content; Xwayland (it is just another
   Wayland client, but it drags a full X11 window-management job behind it);
   audio over PipeWire; an `xdg-desktop-portal` so an application's *Open File*
   dialog opens the Files app.

Stages 1–3 are the small half. Stage 4 is where the time goes, and it is what
decides whether this feels like a desktop or a demo.

## What stage 5 settled

**Cursor shapes are nearly free, because the protocol was designed around
CSS.** `wp_cursor_shape_v1` names its shapes after CSS keywords, so the client
turns a shape into a `cursor:` value by replacing underscores with hyphens —
two entries aside, which have no CSS equivalent. The older path, where the
application hands over a *surface* holding the cursor image, is deliberately
not implemented: it is a second pixel pipeline, and every current toolkit
prefers the shape protocol when it is offered. The one part of it worth
keeping is the NULL surface, which means "hide the pointer".

**Keys are physical, so the layout has to be discovered, not assumed.**
`navigator.keyboard.getLayoutMap()` reports what each physical key produces,
which is enough to recognise the common layouts from a six-key signature
(`KeyQ`, `KeyW`, `KeyY`, `KeyZ`, `KeyA`, `Semicolon`). Chromium answers;
elsewhere the menu decides. The keymap is compiled when the compositor starts,
so a change applies to the next launch — which is why choosing one says so
rather than pretending to take effect.

**Pasting into the browser needs no permission; reading from it does.** The
`paste` DOM event hands over the clipboard for free, but only if the keystroke
is not claimed — so `Ctrl+V` is the one combination deliberately *not*
forwarded on keydown. The paste handler pushes the text to the compositor and
then replays the key, so the application pastes as it normally would. There is
no matching `copy` handler: `Ctrl+C` is forwarded, so the browser never fires
`copy`, and answering it from the last known value would quietly put stale
text on the clipboard.

### The clipboard gap

Copying **out** of an application works completely: the compositor asks the
application's data source for `text/plain;charset=utf-8`, reads the pipe in the
event loop, and hands the text up.

Pasting **in** works when the application has not itself set the clipboard
during that session. Once it has, GTK re-claims the selection as soon as it
loses it — the compositor offers the browser's text, and the toolkit
immediately answers with `set_selection` of its own source again, so a
subsequent paste yields the application's own text. This was chased a long way
and the compositor side is now protocol-correct: the selection is echoed back
to the client that set it, offers carry the source's real mime types, and a
request for the application's own clipboard splices the file descriptor
straight through without copying. The remaining behaviour is the toolkit's,
and beating it would mean fighting it.

Worth knowing before picking this up again: it is *not* a case of the offer
being malformed or ignored. With no prior copy in the session, the same code
path works — the application asks for `text/plain;charset=utf-8` and pastes
what the browser sent.

## Browse and pin, not a wall of icons

The original plan for stage 5 said `.desktop` files would "become desktop
icons". Promoting all of them turned out to be the wrong instinct, for two
reasons that only showed up once it ran.

**A desktop icon is a promise.** The shm/dmabuf line above means some
applications will not work, and a user cannot tell an unsupported application
from a broken desktop. **And there are too many of them.** This development
machine has 116 `.desktop` files; dropping `NoDisplay`, `Hidden`,
`Terminal=true` and non-`Application` entries leaves 62 — which is not a
desktop, it is a menu.

So identity is opt-in. *Native Desktop Applications* browses everything the
host has, with real icons resolved from its theme; starring one pins it — as
does **Application → Pin to the desktop** in the window of anything already
running, because deciding you want to keep something is a thing you realise
while using it, not while reading a list. A pinned application is registered
as an app of this desktop in its own right —
`wayland:<id>`, its own desktop icon, launcher entry, taskbar name and
session-restore record. Unpinned applications still run, under the browser's
own window identity.

The runtime is shared: every pinned app mounts the same function with a
different `appId`. Only the *identity* is new, which is possible because
`register()` is a runtime call and `AppManifest` is structural — the same two
properties that `docs/app-installation.md` relies on. Pins are persisted
server-side, next to app enable/disable, because which applications a machine
offers is a property of the machine and not of one browser profile.

Curation is therefore user-driven and evidence-based: you pin what you have
watched work, and we never have to maintain a compatibility list.

**On a headless cloud server this list is empty, and that is the correct
result.** A server has no reason to carry GUI applications, and this feature
does not ask it to. It exists for the uncommon case where a particular program
has to run on *that* machine and be seen from a browser — a vendor tool, a GUI
that has no CLI, something with a licence tied to the host. Installing a
desktop package on a server should stay a deliberate act, so the empty state
says as much rather than presenting itself as something that failed to load.

## What stage 4 settled

**A menu is just a window anchored to another one.** Once window identity moved
off the toplevel and onto the `xdg_surface`, popups streamed, positioned and
took input through the same path as everything else — no special case. They are
placed by the real `xdg_positioner` rules: anchor, gravity, flip, slide. Our
"output" is the parent window, so constraining a menu to it is not a
compromise; it is the same rule a real compositor applies at a screen edge.

**`xdg_popup.reposition` is not optional.** GTK 4 opens a menu by creating the
popup and *immediately* repositioning it, and it will not attach a buffer until
that request is answered with `repositioned`, `configure` and
`xdg_surface.configure`. Our stub logged and returned, so every menu was
created and then silently never appeared. Nothing in the logs said "you are
missing a reply" — the popup simply never drew.

**Switching pointer focus needs an explicit leave.** Moving from the window to
a menu and back is a `leave` then an `enter`. Sending only the `enter` leaves
the old surface believing the pointer is still inside it, which is the kind of
bug that shows up later as a button stuck in its hover state.

**GTK's resize edges are in the part we crop away.** The invisible shadow
margin is where a client-side-decorated window puts its resize handles, and we
remove it before sending the image. So `xdg_toplevel.resize` almost never
fires for a GTK application — the shell's own frame does the resizing instead.
`xdg_toplevel.move` is the opposite: dragging the application's own titlebar
is a request the shell honours by moving its window, which works and feels
right.

**Honouring min/max size stops the two sides fighting.** The application is
configured to the window's content box, but a window that cannot shrink below
616 pixels will keep drawing 616 and keep overflowing. Clamping the configure
to the size hints the application gave us ends the argument.

**A configure of 0x0 asks the application what size it wants.** Which is the
other half of the same problem: a shell that always names a size opens every
application maximized into a generic frame, and one whose minimum does not fit
— a calculator wants 360x616, and never less — overflows that frame for as long
as it is open. So a session started without a size gets `-g 0x0`, wdcomp sends
the initial configure at 0x0, and the first buffer the application commits is
its answer: 360x616 for gnome-calculator, 600x480 for file-roller, 900x600 for
gnome-disks. The compositor adopts that as the window's size and announces it,
and the shell resizes its own window — chrome included — to fit. Only a window
the person has already sized keeps its geometry and has the application fitted
into it instead.

## What stage 3 settled

**The window-geometry crop applies to input, backwards.** This is the one that
cost an afternoon. We crop the buffer to `set_window_geometry` before sending
it, so the browser measures clicks against the cropped image — but
`wl_pointer` coordinates are *surface*-local, and the surface still includes
the invisible shadow margin. Without adding that offset back, every click
landed about 25 pixels up and to the left. It looks exactly like input being
broken, and it is not: it is two coordinate spaces that differ by the width of
a drop shadow.

**Only a popup that took a grab is modal.** Popups are not streamed yet, so a
menu would be invisible but still hold input — the fix was to dismiss it on the
next click. Keying that off "a popup object exists" swallowed *every* click,
because toolkits create popup objects long before they show one.
`xdg_popup.grab` is the signal that means a menu is actually open.

**The browser's key repeat has to be suppressed.** The client repeats for
itself from the `repeat_info` we send, so forwarding events with
`KeyboardEvent.repeat` set doubles every held key.

**Modifiers are derived, not reported.** The compositor keeps an `xkb_state`
and updates it from the physical keys, rather than trusting the browser's
`ctrlKey`/`shiftKey`. That is both more correct and one less thing to
validate — but it means focus loss has to release everything still held, or a
tab switch mid-chord leaves the application with a stuck Ctrl and no way to
clear it.

**Some keys stay with the shell.** `Alt+Tab` (window switching has to work
from inside a focused application), `F11`/`F12` (fullscreen and devtools are
how someone gets out of trouble), and the shell's own `Ctrl+Alt+…`
accelerators. Everything else is forwarded with its default prevented, so the
application gets `Ctrl+W` and `Ctrl+S` rather than the browser acting on them.

## What stage 2 settled

The whole path works: a `.desktop` entry in the launcher's picker starts a
compositor, an application draws into it, and its pixels land on a canvas in a
window of this shell. Verified end to end — `tests/wayland.mjs` drives the real
socket, and a headless Chromium run confirmed the browser half rather than
assuming it.

**Damage tracking is the entire bandwidth story.** A full 640×480 frame is
1,228,800 raw bytes and 42 kB deflated — about 29×. But a redraw of one
spinner is a 36×34 rectangle that costs **262 bytes**. That is four orders of
magnitude below the naive full-frame stream, and it is why this is usable over
a tunnel at all. Deflate runs at level 1; interface pixels compress so well
that anything more is wasted time.

**Frame callbacks really are the flow control.** The compositor holds each
`wl_callback` until the browser acknowledges the frame, so a fast application
throttles itself to the socket rather than queueing stale frames. The one thing
this needs is a timeout: a browser tab that stops acknowledging would otherwise
freeze the application permanently, so an unacknowledged frame is released
after two seconds.

**Resize has to reconfigure, not scale.** Dragging the shell window sends
`configure`, the application relayouts at the new size, and the next frame
arrives at the new dimensions — text stays crisp and widgets reflow, which is
the entire advantage over a video stream. The canvas is never CSS-scaled.

**Reaping needs the process group.** The compositor is a grandchild through
`dbus-run-session`, so signalling the direct child leaves both the bus and the
application running. `detached: true` plus `kill(-pid)` is what actually
cleans up; the test asserts it, because this is the easiest serious bug to
write here.

## What stage 1 settled

Three real applications, rendered by `wdcomp` with no display server of any
kind underneath:

| Application | Toolkit | Buffer | Window geometry |
| --- | --- | --- | --- |
| `gnome-calculator` | GTK 4 + libadwaita, `GSK_RENDERER=cairo` | 850×666 | 800×616 |
| `gnome-disks` | GTK 3, shm natively | 952×652 | 900×600 |
| `gnome-text-editor` | GTK 4, `GSK_RENDERER=cairo` | 950×700 | 900×650 |

Every buffer arrived exactly 50 pixels wider and taller than the window — the
invisible shadow margin, 25 pixels a side. Cropping to
`xdg_surface.set_window_geometry` removes it precisely, which settles that
question: it is not an estimate, and it is not optional.

Also confirmed: `GSK_RENDERER=cairo` does put GTK 4 back on shm, one
application can open several toplevels in the same connection (the editor
restored a previous session's windows alongside the new one), and titles change
freely after mapping, so the shell must treat `set_title` as a live signal
rather than something read once.

**Not yet settled: dmabuf.** The run with `--no-force-shm` did not exercise the
GPU path — EGL failed to initialise in the test environment and GTK fell back
to shm on its own. That failure mode is itself what a headless server usually
looks like, and it is a point in favour of the shm-first plan, but the
dmabuf half of the table above is still an untested claim.

## Security

This opens no new hole: `wdcomp` runs as the same user the PTY already does,
and anyone holding an authenticated socket already has a shell. Two things
still deserve care.

`wdcomp` mmaps memory a client controls, so buffer offsets, strides and sizes
must be bounds-checked rather than trusted — libwayland validates the pool
accounting, but the stride and format a client declares are still its own
claims. And the compositor socket is a capability: anything that can reach
`$XDG_RUNTIME_DIR/wayland-wd` can open windows on someone's desktop, read their
clipboard, and — until popup grabs are correct — see keystrokes meant for other
surfaces. It should live in the session's own runtime directory with the
permissions Wayland sockets normally carry, not somewhere world-writable.

## Building the compositor

```bash
cd compositor && make
```

Requires `libwayland-dev`, `libxkbcommon-dev` and `zlib1g-dev`. The build is
optional: without `wdcomp` the applications window says so and everything else
in the desktop is unaffected.

`wayland-protocols` is deliberately **not** on that list. The three XML files
are vendored in `compositor/protocols/`, because which of them a distribution
ships is a property of its release date: Ubuntu 22.04 has one of the three, and
24.04 as released is missing `stable/tablet-v2` and only acquired it through an
`-updates` SRU — so the release build was quietly depending on that SRU. It
also means the compositor can be built on an older base to lower the glibc floor
of the release, which was previously impossible for a reason that had nothing to
do with glibc. See `compositor/protocols/README.md`.

## What the machine that runs it needs

`libwayland-server.so.0` and `libxkbcommon.so.0` — the runtime halves of two of
the build dependencies, and the only thing this product ever wants from a
package manager. They are **not** installed for you, by `install.sh` or by
anything else: nothing but the compositor links them, so native applications
are a feature to opt into rather than a dependency a desktop acquires on your
server without being asked.

`available()` therefore runs `ldd` on `wdcomp` on *every* ask and reports the
sonames that came back `not found`, along with the command that would install
them. Every ask, not once at startup, so the applications window can offer
**Try again** and have it work the moment the packages land — no restart, no
reload.

The command is per package manager, and named in sonames everywhere else:

| | |
|---|---|
| `apt` | `libwayland-server0 libxkbcommon0` |
| `dnf` | `libwayland-server libxkbcommon` |
| `zypper` | `libwayland-server0 libxkbcommon0` |
| `pacman` | `wayland libxkbcommon` |

A soname is the same on every distribution and a package name is not, so a
manager that is not in that table — or a library with no name recorded for the
manager this machine has — produces no command at all, and the window says
"install whatever this distribution calls the packages providing …" instead.
Telling someone on Fedora to run `apt` is worse than telling them nothing.

`ldd` rather than simply running the binary: the loader stops at the first
library it cannot find, so running it would have someone install one package,
retry, and only then be told about the other.

See [`compositor/README.md`](../compositor/README.md) for how to run stage 1.
