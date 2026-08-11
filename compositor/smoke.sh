#!/bin/sh
# Stage 1 check: build wdcomp, run a real application against it, and confirm
# a frame came out. Not part of `npm test` — it needs a desktop application
# installed, which a server generally does not have.
#
#   ./smoke.sh [command...]     default: whichever GTK app is present
set -eu

cd "$(dirname "$0")"

OUT=$(mktemp -d)
SOCKET="wayland-wd-smoke-$$"
DEADLINE=45

cleanup() {
	# The socket name is unique to this run, so matching on it is exact —
	# and more reliable than the process group, since setsid and
	# dbus-run-session both sit between us and wdcomp.
	pkill -f "$SOCKET" 2>/dev/null || true
	[ -n "${PGID:-}" ] && kill -- "-$PGID" 2>/dev/null || true
	rm -rf "$OUT"
}
trap cleanup EXIT

make >/dev/null

if [ $# -eq 0 ]; then
	for candidate in gnome-disks gnome-calculator baobab gnome-font-viewer \
			file-roller weston-terminal foot alacritty; do
		if command -v "$candidate" >/dev/null 2>&1; then
			set -- "$candidate"
			break
		fi
	done
	if [ $# -eq 0 ]; then
		echo "smoke: no GTK/Qt application found to test with — skipping" >&2
		exit 0
	fi
fi

echo "smoke: rendering $1"

# A private session bus: without one, GApplication exits silently; with the
# ambient one, a single-instance app hands its window to the running desktop.
runner=""
if command -v dbus-run-session >/dev/null 2>&1; then
	runner="dbus-run-session --"
fi

# Run it in its own process group. dbus-run-session does not return until every
# service it activated has exited — portals can take minutes — so the frame
# file, not the exit status, is what we wait on.
# shellcheck disable=SC2086
setsid $runner ./build/wdcomp -s "$SOCKET" -n 1 -o "$OUT" -- "$@" \
	>"$OUT/log" 2>&1 &
PGID=$!

frame="$OUT/frame-000.png"
waited=0
while [ ! -s "$frame" ] && [ "$waited" -lt "$DEADLINE" ]; do
	sleep 1
	waited=$((waited + 1))
done

if [ ! -s "$frame" ]; then
	echo "smoke: FAILED — no frame after ${DEADLINE}s" >&2
	sed 's/^/  /' "$OUT/log" >&2
	exit 1
fi

grep '^wdcomp: frame 0' "$OUT/log" | sed 's/^/  /'
echo "smoke: ok — $(wc -c <"$frame") bytes of PNG in ${waited}s"
