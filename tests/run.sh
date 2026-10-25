#!/usr/bin/env bash
# Runs every suite against a freshly started server on a spare port.
# Usage: bash tests/run.sh   (or: npm test)
set -euo pipefail
cd "$(dirname "$0")/.."

# A shell opened in a Finestra terminal used to inherit the service's own
# settings, and a suite run from one then tested an installed compositor with
# no token check. The server launched here gets only what this file sets.
unset WD_NO_AUTH WD_TOKEN WD_HOST WD_PORT WD_STATIC WD_WDCOMP WD_ROOT WD_DIAL \
  WD_DIAL_TICKET WD_SESSION_TTL WD_SESSION_IDLE WD_SERVICES_DIR WD_DEV
PORT="${WD_TEST_PORT:-7199}"
SERVER="server/dist/server/src/index.js"
# Every session gets an X display of its own; the X server behind it is
# started by the first X client, so a machine without Xwayland runs the same
# suite with one line more in the log.
export WD_XWAYLAND=1

# Run against a scratch state directory. The suite pins applications, disables
# apps and unpins them again, and without this it does all of that to the state
# of whoever is actually using this machine — which it did, once.
export XDG_STATE_HOME="$(mktemp -d)"

# A scratch applications directory, with three entries the wayland suite makes
# assertions about. They are written here rather than by the test because the
# server scans for desktop entries once and caches the result, so they have to
# exist before it starts.
export XDG_DATA_HOME="$(mktemp -d)"
mkdir -p "$XDG_DATA_HOME/applications"
fixture() {
  printf '[Desktop Entry]\nType=Application\nName=%s\nExec=%s\n%s\n' "$2" "$3" "$4" \
    > "$XDG_DATA_HOME/applications/$1.desktop"
}
# Names a desktop environment that is not this one: must not be offered.
fixture wd-test-hidden "WD Test Hidden" /bin/true "OnlyShowIn=NoSuchDesktop;"
# Excludes one that is not this one either: must still be offered.
fixture wd-test-shown  "WD Test Shown"  /bin/true "NotShowIn=NoSuchDesktop;"
# Exits at once, drawing nothing — the shape of a single-instance handoff.
fixture wd-test-silent "WD Test Silent" /bin/true ""
# Snap-shaped: what matters is the command, since that is what the launcher
# reads to decide which bus this gets. Only offered where `snap` is installed,
# and the suite skips the check when it is not.
fixture wd-test-snap   "WD Test Snap"   "snap run wd-test-snap" ""
# `snap` itself is a fake on the server's PATH, so the entry is offered on
# every machine and nothing real is confined. It behaves as a snap does for
# the one thing the suite is about: it runs the application on the machine's
# session bus — here a private dbus-daemon handed to the server as that bus —
# and the application asks the portal on it for a file dialog from inside
# the session's process tree, which is how a request is traced to its window.
export WD_TEST_PORTAL_DIR="$XDG_STATE_HOME/portal"
mkdir -p "$WD_TEST_PORTAL_DIR"
NODE_BIN="$(command -v node)"
FAKE_BIN="$XDG_DATA_HOME/fakebin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/snap" <<EOF
#!/bin/sh
[ "\$1" = run ] && [ "\$2" = wd-test-snap ] || exit 1
if [ -x "$PWD/compositor/build/subsurface-client" ]; then
  "$NODE_BIN" "$PWD/tests/portal-app.mjs" &
  exec "$PWD/compositor/build/subsurface-client"
fi
exit 0
EOF
chmod +x "$FAKE_BIN/snap"

# Launch quirks are added on the way to spawn and written down nowhere, so the
# only way to see one is to ask the thing that was launched what it was given.
# The launcher decides on the basename, so the name of the script is the point.
BIN_DIR="$XDG_DATA_HOME/bin"
mkdir -p "$BIN_DIR"
export WD_TEST_CHROMIUM_ARGV="$XDG_STATE_HOME/chromium-argv"
export WD_TEST_PLAIN_ARGV="$XDG_STATE_HOME/plain-argv"
recorder() { # name, file
  cat > "$BIN_DIR/$1" <<EOF
#!/bin/sh
printf '%s\n' "\$@" > "$2"
exit 0
EOF
  chmod +x "$BIN_DIR/$1"
}
recorder chromium     "$WD_TEST_CHROMIUM_ARGV"
recorder wd-plain-app "$WD_TEST_PLAIN_ARGV"
fixture wd-test-chromium "WD Test Chromium" "$BIN_DIR/chromium %U" ""
fixture wd-test-plain    "WD Test Plain"    "$BIN_DIR/wd-plain-app" ""

# What a launched application is born with. Node blocks the signals it
# handles around fork and leaks non-CLOEXEC fds (a terminal's PTY master
# reached a launched browser as fd 23); the compositor scrubs both before
# exec, and the only way to see that it did is to ask something it launched.
export WD_TEST_BIRTH="$XDG_STATE_HOME/birth"
cat > "$BIN_DIR/wd-birth" <<EOF
#!/bin/sh
grep SigBlk /proc/self/status > "$WD_TEST_BIRTH"
env | grep -E '^(ELECTRON_OZONE_PLATFORM_HINT|DISPLAY|QT_QPA_PLATFORM)=' >> "$WD_TEST_BIRTH"
ls /proc/self/fd >> "$WD_TEST_BIRTH"
exit 0
EOF
chmod +x "$BIN_DIR/wd-birth"
fixture wd-test-birth "WD Test Birth" "$BIN_DIR/wd-birth" ""

# Exits at once, like a single-instance application handing its window to a
# copy already running. The suite starts that copy itself (`hold`), outside
# the server's process tree, and expects it to be named by pid. A plain shell
# loop rather than exec: comm has to stay the script's own name.
export WD_TEST_BIN="$BIN_DIR"
cat > "$BIN_DIR/wd-test-twin" <<'EOF'
#!/bin/sh
[ "$1" = hold ] && sleep 60
exit 0
EOF
chmod +x "$BIN_DIR/wd-test-twin"
fixture wd-test-twin "WD Test Twin" "$BIN_DIR/wd-test-twin" ""

# Lives until asked to stop, and writes down how it went. SIGTERM reaching it
# at all is the point: children used to be born with it blocked, so every
# shutdown was secretly a SIGKILL and the trap never ran.
export WD_TEST_LIFE="$XDG_STATE_HOME/life"
cat > "$BIN_DIR/wd-longrun" <<EOF
#!/bin/sh
echo "start \$(date +%s.%N)" >> "$WD_TEST_LIFE"
trap 'echo "term \$(date +%s.%N)" >> "$WD_TEST_LIFE"; exit 0' TERM
i=0; while [ \$i -lt 300 ]; do sleep 0.1 & wait \$!; i=\$((i+1)); done
EOF
chmod +x "$BIN_DIR/wd-longrun"
fixture wd-test-longrun "WD Test Longrun" "$BIN_DIR/wd-longrun" ""

# Says why it is going, the way a real application does. The reason has to
# reach the person who clicked, rather than being replaced by a guess.
# The real reason first and crashpad's grumble last, which is the order Chrome
# actually produces: taking the newest error quoted a missing crash-report
# directory at someone whose browser would not start.
cat > "$BIN_DIR/wd-complainer" <<'EOF'
#!/bin/sh
echo "[9901:9901:0812/124845.9:ERROR:chrome/app/main.cc:520] Refusing to start: the profile lock is not mine" >&2
echo "[0812/143714.6:ERROR:third_party/crashpad/crashpad/util/file/directory_reader_posix.cc:43] opendir /home/u/.config/google-chrome/Crash Reports/attachments/ce86: No such file or directory (2)" >&2
exit 1
EOF
chmod +x "$BIN_DIR/wd-complainer"
fixture wd-test-complains "WD Test Complains" "$BIN_DIR/wd-complainer" ""
# Exported the way flatpak and snap export: outside the applications directory,
# in a tree that only reaches XDG_DATA_DIRS through a login shell's profile.d.
# A service has no such shell, which is how every snap came to be invisible.
mkdir -p "$XDG_DATA_HOME/flatpak/exports/share/applications"
printf '[Desktop Entry]\nType=Application\nName=%s\nExec=%s\n' \
  "WD Test Exported" /bin/true \
  > "$XDG_DATA_HOME/flatpak/exports/share/applications/wd-test-exported.desktop"

# A window with a subsurface in it — the shape of Firefox, which draws its
# whole interface in one — as a client of its own, so the suite can check the
# path without a browser installed. Needs libwayland-client to build, so it is
# offered only where it could be built; the suite skips the checks otherwise.
if [ -x compositor/build/wdcomp ] && pkg-config --exists wayland-client 2>/dev/null; then
  make -s -C compositor subsurface-client >/dev/null 2>&1 || true
fi
if [ -x compositor/build/subsurface-client ]; then
  fixture wd-test-subsurface "WD Test Subsurface" "$PWD/compositor/build/subsurface-client" ""
  # The same client ignoring the output's scale, as an X client always does.
  fixture wd-test-unscaled "WD Test Unscaled" "$PWD/compositor/build/subsurface-client --unscaled" ""
  # One that puts its window away and brings it back.
  fixture wd-test-hides "WD Test Hides" "$PWD/compositor/build/subsurface-client --hide" ""
  # An application with a helper process that shows a dialog and exits
  # without destroying anything — zenity's shape, as DOSBox-X uses it.
  cat > "$BIN_DIR/wd-helper-app" <<EOF
#!/bin/sh
"$PWD/compositor/build/subsurface-client" --brief &
exec "$PWD/compositor/build/subsurface-client"
EOF
  chmod +x "$BIN_DIR/wd-helper-app"
  fixture wd-test-helper "WD Test Helper" "$BIN_DIR/wd-helper-app" ""
  # A confined application asking the portal for a file dialog. The script
  # writes down the private bus it was given, then stays connected to the
  # display as the fixture client so the session lives while the test, as
  # the application, talks to the portal on that bus.
  export WD_TEST_BUS="$XDG_STATE_HOME/portal-bus"
  cat > "$BIN_DIR/wd-portal-app" <<EOF
#!/bin/sh
printf '%s' "\$DBUS_SESSION_BUS_ADDRESS" > "$WD_TEST_BUS"
exec "$PWD/compositor/build/subsurface-client"
EOF
  chmod +x "$BIN_DIR/wd-portal-app"
  fixture wd-test-portal "WD Test Portal" "$BIN_DIR/wd-portal-app" ""
fi
# Where that client writes the pointer position the compositor delivered, so
# the suite can click in the browser's pixels and read where it landed.
export WD_TEST_POINTER="$XDG_STATE_HOME/pointer"
export WD_TEST_OUTPUT="$XDG_STATE_HOME/output"

export WD_TOKEN="test-$(head -c 12 /dev/urandom | base64 | tr -d '/+=')"
TOKEN="$WD_TOKEN"
# Short enough that "nobody came back for it" can be checked in a test.
export WD_TERMINAL_GRACE=3
# The same for a native window left without its browser; see tests/wayland.mjs.
export WD_WINDOW_GRACE=3

if [ ! -f "$SERVER" ]; then
  echo "Server is not built. Run: npm run build" >&2
  exit 1
fi

# The machine's session bus, as far as the server is concerned: a private
# dbus-daemon, so the snap path — the proxy socket in front of that bus, the
# chooser answered on the way — runs on every machine and never touches the
# bus of whoever is logged in.
# Handed over as WD_SNAP_BUS rather than DBUS_SESSION_BUS_ADDRESS: the latter
# would also send the server's `systemctl --user` to a bus with no systemd on
# it, and the Services section would fail for a reason that has nothing to
# do with services.
HOST_BUS_PID=""
SNAP_BUS=""
if command -v dbus-daemon >/dev/null 2>&1; then
  SNAP_BUS="unix:path=$XDG_STATE_HOME/host-bus"
  dbus-daemon --session --address="$SNAP_BUS" --nofork --nopidfile >/dev/null 2>&1 &
  HOST_BUS_PID=$!
  for _ in $(seq 1 50); do [ -S "$XDG_STATE_HOME/host-bus" ] && break; sleep 0.1; done
  export WD_TEST_HOST_BUS="$SNAP_BUS"
fi

PATH="$FAKE_BIN:$PATH" WD_SNAP_BUS="$SNAP_BUS" WD_PORT="$PORT" node "$SERVER" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; [ -n "$HOST_BUS_PID" ] && kill "$HOST_BUS_PID" 2>/dev/null || true; rm -rf "$XDG_STATE_HOME" "$XDG_DATA_HOME"' EXIT

# Wait for it to answer rather than sleeping a fixed amount.
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done

failures=0
run() {
  echo ""
  echo "=== $1 ==="
  shift
  "$@" || failures=$((failures + 1))
}

run "end-to-end (auth, fs, pty)"  node tests/e2e.mjs "$TOKEN" "$PORT"
run "the host names its build"    node tests/version.mjs "$TOKEN" "$PORT"
run "pty.cwd"                     node tests/pty-cwd.mjs "$TOKEN" "$PORT"
run "pty.status"                  node tests/pty-status.mjs "$TOKEN" "$PORT"
run "pty.attach"                  node tests/pty-attach.mjs "$TOKEN" "$PORT"
run "transfer + apps service"     node tests/transfer.mjs "$TOKEN" "$PORT"
run "system-manager services"     node tests/sysman.mjs "$TOKEN" "$PORT"
run "wayland service"             node tests/wayland.mjs "$TOKEN" "$PORT"
run "opening from a terminal"     node tests/shell.mjs "$TOKEN" "$PORT"
# Starts servers of its own: it changes the token, and the shared server's
# token is in every other suite's argv.
run "changing the access token"   node tests/auth.mjs "$((PORT + 20))"
# The same, in a real browser: that a page gets back in on the cookie alone,
# with the token nowhere a script could read it, is a claim only a browser
# can make. Finds Chromium by absolute path — the `chromium` above is a
# recorder — and skips itself when there is none. Its own server, as above.
run "the access token, in a browser" node tests/access-browser.mjs "$((PORT + 30))"
# The compositor's frame channel. Needs a C compiler and nothing else — not
# libwayland, not a display, not an application — so unlike the rest of
# compositor/ it runs everywhere.
if command -v cc >/dev/null 2>&1; then
  run "compositor frame channel"  make -s -C compositor check-ipc
else
  echo ""; echo "=== compositor frame channel ==="; echo "SKIP — no C compiler"
fi
# The compositor's lifetime rule: clients keep a session alive, not the child.
# Needs the built compositor and nothing else; skips itself without it.
run "compositor client lifetime"  node tests/wdcomp-lifetime.mjs
run "outbound session + relay"    node tests/outbound.mjs
run "host registry"               npx tsx tests/hosts.test.ts
run "standalone stays standalone" npx tsx tests/standalone.test.ts
run "session deadman"             npx tsx tests/deadman.test.ts
run "the session's socket"        npx tsx tests/session.test.ts
run "what outlives the browser"   npx tsx tests/grace.test.ts
run "session store"               npx tsx tests/session-store.test.ts
run "file associations"           npx tsx tests/assoc.test.ts
run "the desktop clipboard"       npx tsx tests/clipboard.test.ts
run "the access token in the page" npx tsx tests/access.test.ts
# Reads files rather than running anything: the product's name where it is
# load-bearing, and the internals that deliberately are not the product's name.
run "packaging names"             bash tests/packaging-names.sh
# The CI sweep's age rule and how it reads a path — pure functions out of
# packaging/aws/lib.sh, so this needs no AWS and no credentials.
run "ci sweep and paths"          bash tests/ci-sweep.test.sh
# Runs the real configure.sh as root against a fabricated machine, inside a user
# namespace. Needs unshare, like the compositor suite needs a compiler.
if unshare -rm true 2>/dev/null; then
  run "taking over an old install" bash tests/install-sandbox.sh
else
  echo ""; echo "=== taking over an old install ==="; echo "SKIP — no user namespaces"
fi

echo ""
if [ "$failures" -gt 0 ]; then
  echo "$failures suite(s) FAILED"
  exit 1
fi
echo "All suites passed."
