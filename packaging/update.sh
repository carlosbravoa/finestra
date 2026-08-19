#!/usr/bin/env bash
# Updates an installed Finestra, and puts it back if the new one does not
# work.
#
#   sudo /opt/finestra/current/update.sh <tarball|url>
#   sudo /opt/finestra/current/update.sh --rollback
#   sudo /opt/finestra/current/update.sh --list
#
# The shape is aria-sysadmin's, deliberately: validate, install beside the
# running version, switch, prove it came up, and go back automatically if it
# did not. A machine that updates itself must never be able to update itself
# into being unreachable — that is the one failure nobody can fix remotely.

set -euo pipefail

PREFIX="${PREFIX:-/opt/finestra}"
CURRENT="${PREFIX}/current"
UNIT="finestra.service"

# Where this install keeps its state. It is wherever install.sh decided, which
# depends on the account it chose to run as, so the installed unit is asked
# rather than assumed — a wrong guess here would strand `last-good` somewhere
# rollback never looks, and rollback is the one path that must not surprise.
# Asked of configure.sh, which owns the one definition. It sits beside this
# script for the life of the install (install.sh removes only itself), so the
# path is always there — but the fallback stays, because an update that cannot
# find `last-good` must still update rather than abort.
STATE_DIR="$("$(dirname "${BASH_SOURCE[0]}")/configure.sh" --state-dir 2>/dev/null \
             || printf '%s\n' "${STATE_PARENT:-/var/lib}/finestra")"
# Where to knock, which is not always loopback: --bind can put the listener on
# one address of a VPN, and then 127.0.0.1 answers nothing at all. That would
# make every update of an opened install look like a failed one and roll itself
# back. configure.sh derives it from the unit it wrote — same reasoning as
# STATE_DIR above, same fallback for the same reason.
HEALTH_URL="${HEALTH_URL:-$("$(dirname "${BASH_SOURCE[0]}")/configure.sh" --health-url 2>/dev/null \
             || printf 'http://127.0.0.1:7070/healthz\n')}"
HEALTH_TRIES="${HEALTH_TRIES:-20}"
KEEP_VERSIONS="${KEEP_VERSIONS:-3}"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo"
[ -L "$CURRENT" ] || die "no installation at ${CURRENT}"

installed_version() { basename "$(readlink -f "$CURRENT")"; }

# The last version that actually passed a health check, and a marker on any that
# did not. Without these, "go back" means "go back to whatever was installed
# most recently" — which, straight after a failed update, is the broken package
# still sitting there for inspection. Rollback would roll forward into the fault
# it was invoked to escape.
LAST_GOOD_FILE="${STATE_DIR}/last-good"

remember_good() { printf '%s\n' "$1" > "$LAST_GOOD_FILE" 2>/dev/null || true; }
mark_failed()   { touch "${PREFIX}/$1/FAILED" 2>/dev/null || true; }
is_failed()     { [ -e "${PREFIX}/$1/FAILED" ]; }

# Versions on disk, newest mtime last. The running one is excluded by callers
# that care.
versions() {
  find "$PREFIX" -maxdepth 1 -mindepth 1 -type d -printf '%T@ %f\n' 2>/dev/null \
    | sort -n | awk '{print $2}'
}

# ---------------------------------------------------------------------------
# Health: the only thing that decides whether an update stands
# ---------------------------------------------------------------------------

healthy() {
  local i
  for i in $(seq 1 "$HEALTH_TRIES"); do
    # -fs rather than -fsS: a service that is not up yet is what this loop is
    # for, and printing curl's connection error on each attempt narrates a
    # retry as a fault. Worse here than in configure.sh — this same loop runs
    # during a rollback, where "could not connect" reads as the rollback having
    # failed while it is in fact working.
    if systemctl is-active --quiet "$UNIT" && curl -fs --max-time 3 -o /dev/null "$HEALTH_URL"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Switching is a symlink swap and a restart, so that going back is the same
# operation with a different argument — no special "undo" path to get wrong.
switch_to() {
  local version="$1"
  ln -sfn "${PREFIX}/${version}" "${CURRENT}.new"
  mv -Tf "${CURRENT}.new" "$CURRENT"

  # A broken version crash-loops, which trips systemd's start rate limit, and
  # `systemctl restart` then refuses with "start request repeated too quickly".
  # That happens at exactly the moment we are trying to put the working version
  # back, and because this is a plain function call rather than part of a
  # condition, set -e turned that refusal into an aborted script with nothing
  # running. Clear the limit first, and let `healthy` be the only thing that
  # decides whether a switch worked.
  systemctl reset-failed "$UNIT" 2>/dev/null || true
  systemctl restart "$UNIT" || true
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

if [ "${1:-}" = "--list" ]; then
  running="$(installed_version)"
  step "Installed versions"
  for v in $(versions); do
    say "$([ "$v" = "$running" ] && echo '*' || echo ' ') ${v}"
  done
  say ""
  say "* is running"
  exit 0
fi

if [ "${1:-}" = "--rollback" ]; then
  running="$(installed_version)"
  previous=""

  # A remembered good version wins, because it is the only candidate we have
  # actually seen work.
  if [ -r "$LAST_GOOD_FILE" ]; then
    candidate="$(cat "$LAST_GOOD_FILE")"
    if [ -n "$candidate" ] && [ "$candidate" != "$running" ] && [ -d "${PREFIX}/${candidate}" ]; then
      previous="$candidate"
    fi
  fi

  # Otherwise the newest that is neither running nor already known to be broken.
  if [ -z "$previous" ]; then
    for v in $(versions); do
      if [ "$v" = "$running" ]; then continue; fi
      if is_failed "$v"; then continue; fi
      previous="$v"
    done
  fi
  [ -n "$previous" ] || die "there is no known-good version to go back to"

  step "Going back to ${previous}"
  switch_to "$previous"
  if healthy; then
    remember_good "$previous"
    say "running ${previous}"
    exit 0
  fi
  mark_failed "$previous"
  die "${previous} did not come up either — look at: journalctl -u ${UNIT}"
fi

SOURCE="${1:-}"
[ -n "$SOURCE" ] || die "usage: update.sh <tarball|url> | --rollback | --list"

# ---------------------------------------------------------------------------
# Fetch and check before anything is touched
# ---------------------------------------------------------------------------

step "Fetching"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$SOURCE" in
  http://*|https://*)
    say "$SOURCE"
    curl -fsSL "$SOURCE" -o "$WORK/pkg.tar.gz" || die "could not download it"
    # A checksum beside the tarball is used when it is there. It proves the
    # download arrived intact; it proves nothing about who made it, which is
    # what signing would do and this does not have yet.
    if curl -fsSL "${SOURCE}.sha256" -o "$WORK/pkg.sha256" 2>/dev/null; then
      expected="$(awk '{print $1}' "$WORK/pkg.sha256")"
      actual="$(sha256sum "$WORK/pkg.tar.gz" | awk '{print $1}')"
      [ "$expected" = "$actual" ] || die "checksum mismatch — refusing to install"
      say "checksum ok"
    else
      say "no .sha256 published alongside it — not verified"
    fi
    ;;
  *)
    [ -f "$SOURCE" ] || die "no such file: $SOURCE"
    cp "$SOURCE" "$WORK/pkg.tar.gz"
    say "$(basename "$SOURCE")"
    ;;
esac

step "Checking the package"
tar xzf "$WORK/pkg.tar.gz" -C "$WORK" || die "that is not a readable tarball"
# -print -quit, not `| head -1`: head closing the pipe kills find with SIGPIPE,
# and under pipefail that fails the whole substitution even though the value
# was read — which set -e then turns into an aborted update. A race, so it
# would have gone wrong occasionally and never on a fast machine.
NEW_DIR="$(find "$WORK" -maxdepth 1 -mindepth 1 -type d -name 'finestra-*' -print -quit)"
[ -n "$NEW_DIR" ] || die "the tarball does not contain a finestra-<version> directory"

NEW_VERSION="$(sed -n 's/^version=//p' "$NEW_DIR/MANIFEST" 2>/dev/null || true)"
[ -n "$NEW_VERSION" ] || die "the package has no version in its MANIFEST"
[ -x "$NEW_DIR/runtime/bin/node" ] || die "the package has no runtime"
[ -f "$NEW_DIR/app/server/src/index.js" ] || die "the package has no server"

OLD_VERSION="$(installed_version)"
say "installed: ${OLD_VERSION}"
say "new:       ${NEW_VERSION}"
if [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
  say "already running that version — nothing to do"
  exit 0
fi

# The runtime has to actually run here, not merely exist. A package built for
# another architecture or a newer glibc fails this in a second, rather than
# after the service is already switched to it.
"$NEW_DIR/runtime/bin/node" -e 'process.exit(0)' 2>/dev/null \
  || die "the runtime in that package does not run on this machine"
say "runtime ok: $("$NEW_DIR/runtime/bin/node" -v)"

# ---------------------------------------------------------------------------
# Install beside, switch, prove
# ---------------------------------------------------------------------------

step "Installing ${NEW_VERSION}"
TARGET="${PREFIX}/${NEW_VERSION}"
rm -rf "$TARGET"
cp -a "$NEW_DIR" "$TARGET"
rm -f "$TARGET/install.sh"
chown -R root:root "$TARGET"
# The same SELinux relabel install.sh does, and for the same reason: the new
# version was unpacked under mktemp, so every file carries a tmp type that
# systemd is refused execute on. Without this an update on an enforcing system
# installs cleanly, switches, and then cannot start what it just installed —
# which the health check below reads as a bad release and rolls back, blaming
# the new version for the copy's label. See install.sh for the full symptom.
if command -v restorecon >/dev/null 2>&1; then
  restorecon -R "$TARGET" >/dev/null 2>&1 || true
  say "SELinux file contexts restored"
fi
say "$TARGET"

step "Switching"
switch_to "$NEW_VERSION"

if healthy; then
  say "${NEW_VERSION} is up"
  remember_good "$NEW_VERSION"
else
  step "It did not come up — going back to ${OLD_VERSION}"
  journalctl -u "$UNIT" -n 15 --no-pager || true
  mark_failed "$NEW_VERSION"
  switch_to "$OLD_VERSION"
  if healthy; then
    remember_good "$OLD_VERSION"
    say "back on ${OLD_VERSION}; ${NEW_VERSION} kept, marked FAILED, for inspection"
    exit 1
  fi
  die "neither version is healthy — look at: journalctl -u ${UNIT}"
fi

# ---------------------------------------------------------------------------
# Tidy, but never so far that there is nothing to go back to
# ---------------------------------------------------------------------------

running="$(installed_version)"
mapfile -t all < <(versions)
if [ "${#all[@]}" -gt "$KEEP_VERSIONS" ]; then
  step "Removing old versions"
  remove=$(( ${#all[@]} - KEEP_VERSIONS ))
  for v in "${all[@]}"; do
    if [ "$remove" -le 0 ]; then break; fi
    if [ "$v" = "$running" ]; then continue; fi
    rm -rf "${PREFIX:?}/${v}"
    say "removed ${v}"
    remove=$(( remove - 1 ))
  done
fi

step "Done"
say "running ${NEW_VERSION}"
say "go back with: sudo ${CURRENT}/update.sh --rollback"
