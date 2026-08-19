#!/usr/bin/env bash
# The acceptance run, as it happens ON a machine that has never seen this
# project. Given a release tarball, it proves the machine is bare, installs,
# exercises every choice install.sh offers, and uninstalls — printing PASS or
# FAIL per behaviour and exiting with the number of failures.
#
#   bash checks.sh <tarball-basename> <login-account>
#
# It lives in its own file rather than inside verify.sh because the same checks
# have to run unchanged on five distributions. That is the point of them: a
# check that needs a special case per distribution has found a portability bug
# in the product, and the right place to fix it is install.sh or configure.sh,
# not here.
#
# Everything distribution-specific is confined to two things — the login
# account, passed in, and the report block below, which records SELinux, glibc
# and which tools exist so that a failure further down can be read rather than
# guessed at.
#
# Runs detached from the SSH connection that started it (see wd_ci_run_detached),
# because these images restart sshd under their own upgrade timers and a
# dropped link must not be mistaken for a failed install.

set -uo pipefail

TARBALL="${1:?tarball basename}"
LOGIN="${2:?login account}"
PREFIX=/opt/finestra

fails=0
section() { printf '\n== %s\n' "$*"; }
t() { # t <name> <command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; else echo "FAIL  $name"; fails=$((fails+1)); fi
}
note() { printf '  %s\n' "$*"; }

# configure.sh owns the one definition of where state lives, and the unit is the
# only record of where a given install put it. Never assumed.
state_dir() { sudo "${PREFIX}/current/configure.sh" --state-dir; }

# ---------------------------------------------------------------------------
section "what this machine is, before we touch it"
# ---------------------------------------------------------------------------
# A pass has to be unexplainable by something that was already here, so this is
# recorded first and in full. glibc is the number that decides whether a
# tarball built elsewhere can run at all; SELinux is the one that decides
# whether it can run from /opt; and the tools are what the checks below and
# configure.sh itself reach for.

note "distro:   $(. /etc/os-release && echo "$PRETTY_NAME")"
note "kernel:   $(uname -r)"
note "glibc:    $(ldd --version 2>/dev/null | awk 'NR==1 { print $NF }')"
note "selinux:  $(getenforce 2>/dev/null || echo 'not present')"
note "login:    ${LOGIN} (home $(getent passwd "$LOGIN" | cut -d: -f6))"
# `command -v` alone reports useradd missing on Debian, where /usr/sbin is not
# on a non-root PATH — which is a fact about this shell, not about the machine,
# and install.sh runs as root where it is on the PATH. The sbin directories are
# searched explicitly so the report says what is true.
have() {
  local p d
  p="$(command -v "$1" 2>/dev/null)"
  if [ -z "$p" ]; then
    for d in /usr/sbin /sbin /usr/local/sbin; do
      [ -x "$d/$1" ] && { p="$d/$1"; break; }
    done
  fi
  # The `[ -n ]` is what makes a miss a non-zero status. Written as a pipeline
  # into awk first, this always succeeded — awk exits 0 on empty input — so
  # every `|| echo MISSING` was dead and an absent tool printed a blank.
  [ -n "$p" ] && echo "$p"
}
for tool in systemctl ss curl journalctl loginctl useradd getent sudo restorecon; do
  note "$(printf '%-11s %s' "${tool}:" "$(have "$tool" || echo '(MISSING)')")"
done
for tool in node npm gcc; do
  note "$(printf '%-11s %s' "${tool}:" "$(command -v "$tool" || echo '(none — good)')")"
done
# Not a failure, but it makes every claim below weaker, so it must be shouted.
command -v node >/dev/null && note "NOTE: a node was already here; this test is weaker than it looks"

# configure.sh uses each of these, so their absence is a real portability bug
# rather than a quirk of the test — checked as behaviour, not just reported.
t "the machine has systemd"          command -v systemctl
t "the machine has ss (iproute2)"    command -v ss
t "the machine has curl"             command -v curl
t "the machine has no node of its own" bash -c '! command -v node'

# ---------------------------------------------------------------------------
section "installing"
# ---------------------------------------------------------------------------

cd /tmp
tar xzf "$TARBALL" || { echo "FAIL  the tarball unpacks"; exit $((fails + 1)); }
dir="${TARBALL%-linux-x64.tar.gz}"
INSTALL_LOG=/tmp/wd-install.log
if (cd "$dir" && sudo ./install.sh) >"$INSTALL_LOG" 2>&1; then
  echo "PASS  install.sh succeeds on a bare machine"
else
  echo "FAIL  install.sh succeeds on a bare machine"
  fails=$((fails+1))
  sed 's/^/    /' "$INSTALL_LOG"
  sudo journalctl -u finestra -n 40 --no-pager 2>/dev/null | sed 's/^/    /'
  # Nothing below can mean anything without an install; stop rather than
  # produce twenty misleading failures.
  echo "== ABORTED after ${fails} failure(s): nothing was installed"
  exit "$fails"
fi
sed 's/^/    /' "$INSTALL_LOG"

# What the installer prints is documentation, and it is read at the one moment
# someone is about to copy a command. It printed `ssh root@host` once, from a
# fallback that reached for `logname` on a machine installed over a root login —
# a worked example of a habit worth not teaching, for no benefit at all, since
# the tunnel needs no privilege. A placeholder is the better answer when nothing
# real is known, so the failure this catches is a suggestion, not a crash.
t "it does not tell the operator to ssh in as root" \
  bash -c '! grep -q "ssh .*root@" /tmp/wd-install.log'

# ---------------------------------------------------------------------------
section "the service it left behind"
# ---------------------------------------------------------------------------

t "the unit is active"           sudo systemctl is-active --quiet finestra
t "the unit is enabled at boot"  sudo systemctl is-enabled --quiet finestra
# Unattended, install.sh runs the desktop as whoever installed it. That is the
# whole point: reaching the port already means holding this account's shell.
t "it runs as the installing user" bash -c '[ "$(systemctl show -p User --value finestra)" = "'"$LOGIN"'" ]'
t "it is not running as root"      bash -c '[ "$(systemctl show -p User --value finestra)" != root ]'
t "its home is a real home"        bash -c 'systemctl show -p Environment --value finestra | grep -q "HOME=/home/'"$LOGIN"'"'
t "its state is in that home"      sudo test -s "/home/${LOGIN}/.local/state/finestra/token"
# systemctl reports the value that was written, not the one in force, and five
# other options turn this back on behind your back. /proc is the only answer
# that counts.
t "no-new-privileges is really off" bash -c '
  pid=$(systemctl show -p MainPID --value finestra)
  [ "$(awk "/NoNewPrivs/ { print \$2 }" /proc/$pid/status)" = 0 ]'

token=$(sudo cat "$(state_dir)/token")
"${PREFIX}/current/runtime/bin/node" /tmp/acceptance.mjs "$token" '' privileged || fails=$((fails+1))

# ---------------------------------------------------------------------------
section "a restart"
# ---------------------------------------------------------------------------
# Where a packaging mistake that only worked by accident shows up.

sudo systemctl restart finestra; sleep 3
t "survives a restart"            sudo systemctl is-active --quiet finestra
t "answers again after a restart" curl -sf -o /dev/null http://127.0.0.1:7070/healthz

# ---------------------------------------------------------------------------
section "what may reach it"
# ---------------------------------------------------------------------------
# The other half of what configure.sh owns. The sandbox test proves what gets
# written into the unit; only a real machine proves the server then does it —
# that WD_HOST reached a listening socket and WD_NO_AUTH reached the request
# path. The security group allows nothing but SSH, so "beyond loopback" is
# checked from the instance against its own address, which is the distinction
# that matters and the one a bind to 127.0.0.1 fails.

ip=$(ip -4 -o addr show scope global | awk 'NR==1 { sub(/\/.*/, "", $4); print $4 }')
sudo "${PREFIX}/current/configure.sh" --bind 0.0.0.0 --no-token >/dev/null
t "it listens past loopback"          bash -c 'ss -ltnH "sport = :7070" | grep -q "0\.0\.0\.0:7070"'
t "its own address answers"           curl -sf -o /dev/null "http://${ip}:7070/healthz"
# -f, so a 401 is a failure: with no token configured, the session endpoint has
# to answer rather than refuse. This is the check that would catch WD_NO_AUTH
# being written into a unit the server never reads it from.
t "and nothing asks for a token"      curl -sf -o /dev/null "http://${ip}:7070/api/session"
t "--show admits what it opened"      bash -c 'sudo '"${PREFIX}"'/current/configure.sh --show | grep -q "every interface"'
# The property that matters more than the flag: someone who opened this months
# ago must not have a routine upgrade quietly close it.
(cd /tmp/finestra-*/ && sudo ./install.sh) >/dev/null 2>&1
t "a plain reinstall keeps it open"   bash -c 'systemctl show -p Environment --value finestra | grep -q "WD_HOST=0.0.0.0"'
t "and keeps the token turned off"    curl -sf -o /dev/null "http://${ip}:7070/api/session"
# And back, because everything after this expects the shape the defaults give.
sudo "${PREFIX}/current/configure.sh" --bind local --token >/dev/null
t "closing it puts it back on loopback" bash -c '! ss -ltnH "sport = :7070" | grep -q "0\.0\.0\.0:7070"'
t "and the token is required again"     bash -c '! curl -sf -o /dev/null http://127.0.0.1:7070/api/session'
t "while it still answers here"         curl -sf -o /dev/null http://127.0.0.1:7070/healthz

# ---------------------------------------------------------------------------
section "the unprivileged system account"
# ---------------------------------------------------------------------------
# The other answer to the question install.sh asks. It is a different product —
# observability rather than a desktop — and it has to keep working, because it
# is what anyone who wants this locked down will install.

# Through the shipped command, not the tarball: changing this later, on a
# machine that no longer has the package it was installed from, is the whole
# reason configure.sh stays behind in the install tree.
t "the install left a way to change this" test -x "${PREFIX}/current/configure.sh"
t "it can say what it is now"             sudo "${PREFIX}/current/configure.sh" --show
sudo "${PREFIX}/current/configure.sh" --system-account >/dev/null
t "it runs as the system account"  bash -c '[ "$(systemctl show -p User --value finestra)" = finestra ]'
t "no-new-privileges is really on" bash -c '
  pid=$(systemctl show -p MainPID --value finestra)
  [ "$(awk "/NoNewPrivs/ { print \$2 }" /proc/$pid/status)" = 1 ]'
t "it still answers"               curl -sf -o /dev/null http://127.0.0.1:7070/healthz
# Locked down is not the same as blind: the log viewer is the entire point of
# this mode, and it is a group membership rather than anything the service can
# ask for at runtime. `adm` does not exist on the RPM distributions, so this is
# also the check that proves configure.sh's fallback to systemd-journal works.
t "the system account can read the journal" \
  sudo -u finestra journalctl -n 1 --no-pager -q
token=$(sudo cat "$(state_dir)/token")
"${PREFIX}/current/runtime/bin/node" /tmp/acceptance.mjs "$token" '' system || fails=$((fails+1))

# An upgrade must never hand privilege back to a machine that gave it up: the
# person who chose this will not remember a flag they passed once.
(cd /tmp/finestra-*/ && sudo ./install.sh) >/dev/null 2>&1
t "a plain reinstall keeps that choice" bash -c '[ "$(systemctl show -p User --value finestra)" = finestra ]'
t "and keeps it unprivileged"           bash -c '
  pid=$(systemctl show -p MainPID --value finestra)
  [ "$(awk "/NoNewPrivs/ { print \$2 }" /proc/$pid/status)" = 1 ]'

# ---------------------------------------------------------------------------
section "uninstalling"
# ---------------------------------------------------------------------------

# Read while the unit still exists: the unit is the only record of where this
# install put its state.
state=$(state_dir)
(cd /tmp/finestra-*/ && sudo ./install.sh --uninstall) >/dev/null 2>&1
t "the service is gone"                bash -c '! systemctl is-active --quiet finestra'
t "the unit file is gone"              bash -c '[ ! -f /etc/systemd/system/finestra.service ]'
# The state directory is 0700 and owned by the service user, so this needs sudo
# to look at all — without it the check fails on permissions and reads as a lost
# state directory, which is the opposite of the truth.
t "uninstall keeps the state directory"  sudo test -e "${state}/token"
t "and keeps the desktop user's state"   sudo test -e "/home/${LOGIN}/.local/state/finestra/token"

printf '\n== %s: %d failure(s)\n' "$(. /etc/os-release && echo "$PRETTY_NAME")" "$fails"
exit "$fails"
