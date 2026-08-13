#!/usr/bin/env bash
# Installs Finestra from a release tarball. Ships inside the tarball and is
# run from the directory it unpacked into.
#
#   sudo ./install.sh              install or upgrade
#   sudo ./install.sh --uninstall  remove everything except the state directory
#
# This gets the bits onto the machine. Who the desktop then runs as — the one
# decision that changes what the product is — belongs to configure.sh, which
# this hands over to and which stays behind in the install so the answer can be
# changed later without the tarball. Its options are accepted here and passed
# straight through:
#
#   --as-me [--no-privilege]   run as the user invoking sudo (the default)
#   --user NAME                run as some other existing account
#   --system-account           run as an unprivileged system account
#   --bind ADDR                answer on an address, not just loopback
#   --no-token                 no login at all — for a network you trust
#
# There is deliberately no toolchain here and no third-party apt repository: the
# tarball carries its own Node runtime, so the only thing this script needs from
# the host is systemd and two shared libraries that most systems already have.

set -euo pipefail

PREFIX="${PREFIX:-/opt/finestra}"
UNIT="/etc/systemd/system/finestra.service"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Where every install kept its state before the desktop learned to run as a
# person, and still where the system account keeps it. Only used to name
# something useful when an old install is removed.
LEGACY_STATE="/var/lib/finestra"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# Everything except --uninstall is configure.sh's business, and it does its own
# validation. Passing them through unread keeps one list of options in one file.
UNINSTALL=""
PASS_THROUGH=()
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           PASS_THROUGH+=("$arg") ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this with sudo"
command -v systemctl >/dev/null || die "this installer needs systemd"

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
# This lives here rather than in configure.sh for a mechanical reason: it
# removes the install tree, and a script cannot safely delete the file it is
# still being read from. install.sh is the one piece that runs from outside.

if [ -n "$UNINSTALL" ]; then
  step "Removing finestra"
  # Read before the unit goes, since the unit is the only record of where a
  # given install put its state.
  # configure.sh owns the one definition of where state lives; asking it beats
  # a fourth copy of the same sed that has to be found again on every rename.
  GONE_STATE="$("$HERE/configure.sh" --state-dir 2>/dev/null || true)"
  systemctl disable --now finestra.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  rm -rf "$PREFIX"
  # Only if it still points into what was just removed: a symlink someone
  # re-pointed at something of their own is not ours to delete.
  case "$(readlink /usr/local/bin/finestra 2>/dev/null || true)" in
    "${PREFIX}"/*) rm -f /usr/local/bin/finestra ;;
  esac
  say "removed $PREFIX and the service"
  say "kept ${GONE_STATE:-$LEGACY_STATE} — delete it by hand to discard the token and settings"
  exit 0
fi

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

step "Checking the package"
[ -x "$HERE/runtime/bin/node" ] || die "runtime/bin/node is missing from this package"
[ -f "$HERE/app/server/src/index.js" ] || die "app/server is missing from this package"
[ -d "$HERE/app/client" ]       || die "app/client is missing from this package"
# Checked here rather than discovered at the hand-over, which is after the tree
# has already been written to /opt.
[ -f "$HERE/configure.sh" ]     || die "configure.sh is missing from this package"
VERSION="$(sed -n 's/^version=//p' "$HERE/MANIFEST" 2>/dev/null || true)"
[ -n "$VERSION" ] || VERSION="0.0.0-unknown"
say "finestra ${VERSION}"
say "node $("$HERE/runtime/bin/node" -v)"

# The compositor is optional: without it, everything works except native
# applications, and the UI says so honestly rather than failing.
if [ -x "$HERE/libexec/wdcomp" ]; then
  say "compositor included"
else
  say "compositor not included — native applications will be unavailable"
fi

# ---------------------------------------------------------------------------
# Runtime libraries
# ---------------------------------------------------------------------------
# Only the compositor needs these, and only at runtime (not the -dev packages).
# They are reported, not installed: the desktop, the terminal, the files and
# everything else work without them, and the person installing a desktop on a
# headless server has not necessarily asked for a Wayland library on it. Native
# applications are the one feature that needs them, so it is a feature to opt
# into rather than a dependency to acquire silently. The applications window
# runs the same check and says the same thing, so nothing depends on anyone
# having read this.

if [ -x "$HERE/libexec/wdcomp" ]; then
  step "Runtime libraries for the compositor (optional)"
  missing=""
  for lib in libwayland-server.so.0 libxkbcommon.so.0; do
    ldconfig -p 2>/dev/null | grep -q "$lib" || missing="$missing $lib"
  done
  if [ -n "$missing" ]; then
    say "not installed:$missing"
    say "Native Linux applications need them. Everything else works without."
    # A soname is the same everywhere; a package name is not. Only names we are
    # sure of — an unrecognised manager gets the sonames and no guess.
    if command -v apt-get >/dev/null; then
      say "To enable them:  sudo apt install libwayland-server0 libxkbcommon0"
    elif command -v dnf >/dev/null; then
      say "To enable them:  sudo dnf install libwayland-server libxkbcommon"
    elif command -v zypper >/dev/null; then
      say "To enable them:  sudo zypper install libwayland-server0 libxkbcommon0"
    elif command -v pacman >/dev/null; then
      say "To enable them:  sudo pacman -S wayland libxkbcommon"
    else
      say "Install this distribution's packages for them to enable native applications."
    fi
  else
    say "present — native applications are available"
  fi
fi

# ---------------------------------------------------------------------------
# Onto the disk
# ---------------------------------------------------------------------------

step "Installing files"
TARGET="${PREFIX}/${VERSION}"
rm -rf "$TARGET"
install -d -m 0755 "$PREFIX"
cp -a "$HERE" "$TARGET"
# install.sh takes itself out of the tree it just wrote, because it is also what
# deletes that tree and a script cannot safely be read from a file it removed.
# configure.sh and update.sh stay: they are the two things anyone needs later.
rm -f "$TARGET/install.sh"
ln -sfn "$TARGET" "${PREFIX}/current"
chown -R root:root "$PREFIX"
chmod +x "$TARGET/configure.sh"
[ -f "$TARGET/update.sh" ] && chmod +x "$TARGET/update.sh" || true

# `finestra` on PATH. Pointed at `current` rather than at this version, so it
# follows an update instead of pinning the one that happened to install it.
# /usr/local/bin because that is what a local install owns; /usr/bin belongs to
# the distribution's package manager.
if [ -f "$TARGET/bin/finestra" ]; then
  chmod +x "$TARGET/bin/finestra"
  install -d -m 0755 /usr/local/bin
  ln -sfn "${PREFIX}/current/bin/finestra" /usr/local/bin/finestra
  say "finestra command available on PATH"
fi
say "installed to $TARGET"
say "current -> $(readlink -f "${PREFIX}/current")"

# ---------------------------------------------------------------------------
# Hand over
# ---------------------------------------------------------------------------
# configure.sh asks who this runs as, writes the unit, starts it, and prints the
# tunnel command and the tokened URL — so there is deliberately nothing after
# this. --keep means an upgrade quietly keeps an answer already recorded in the
# unit; run by hand later, the same script asks instead.

exec "${TARGET}/configure.sh" --keep ${PASS_THROUGH+"${PASS_THROUGH[@]}"}
