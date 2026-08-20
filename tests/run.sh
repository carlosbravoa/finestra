#!/usr/bin/env bash
# Runs every suite against a freshly started server on a spare port.
# Usage: bash tests/run.sh   (or: npm test)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${WD_TEST_PORT:-7199}"
SERVER="server/dist/server/src/index.js"

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
ls /proc/self/fd >> "$WD_TEST_BIRTH"
exit 0
EOF
chmod +x "$BIN_DIR/wd-birth"
fixture wd-test-birth "WD Test Birth" "$BIN_DIR/wd-birth" ""

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

export WD_TOKEN="test-$(head -c 12 /dev/urandom | base64 | tr -d '/+=')"
TOKEN="$WD_TOKEN"

if [ ! -f "$SERVER" ]; then
  echo "Server is not built. Run: npm run build" >&2
  exit 1
fi

WD_PORT="$PORT" node "$SERVER" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$XDG_STATE_HOME" "$XDG_DATA_HOME"' EXIT

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
run "transfer + apps service"     node tests/transfer.mjs "$TOKEN" "$PORT"
run "system-manager services"     node tests/sysman.mjs "$TOKEN" "$PORT"
run "wayland service"             node tests/wayland.mjs "$TOKEN" "$PORT"
run "opening from a terminal"     node tests/shell.mjs "$TOKEN" "$PORT"
# The compositor's frame channel. Needs a C compiler and nothing else — not
# libwayland, not a display, not an application — so unlike the rest of
# compositor/ it runs everywhere.
if command -v cc >/dev/null 2>&1; then
  run "compositor frame channel"  make -s -C compositor check-ipc
else
  echo ""; echo "=== compositor frame channel ==="; echo "SKIP — no C compiler"
fi
run "outbound session + relay"    node tests/outbound.mjs
run "host registry"               npx tsx tests/hosts.test.ts
run "standalone stays standalone" npx tsx tests/standalone.test.ts
run "session deadman"             npx tsx tests/deadman.test.ts
run "session store"               npx tsx tests/session-store.test.ts
run "file associations"           npx tsx tests/assoc.test.ts
run "the desktop clipboard"       npx tsx tests/clipboard.test.ts
# Reads files rather than running anything: the product's name where it is
# load-bearing, and the internals that deliberately are not the product's name.
run "packaging names"             bash tests/packaging-names.sh
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
