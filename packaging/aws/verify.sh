#!/usr/bin/env bash
# Installs a release tarball on a machine that has never seen this project, and
# checks that what came up is actually usable.
#
# The instance is pristine on purpose: no toolchain, no Node, no source tree, no
# apt repositories added by us. If the package needs anything that is not in it,
# this is where that shows up.
#
#   packaging/aws/verify.sh [path-to-tarball]

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
source packaging/aws/lib.sh

TARBALL="${1:-$(ls -1t "$REPO"/dist-release/finestra-*-linux-x64.tar.gz 2>/dev/null | awk 'NR==1')}"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "no tarball; run packaging/aws/build.sh first"
VERIFY_TYPE="${VERIFY_TYPE:-t3.micro}"

log "verifying $(basename "$TARBALL") on a pristine ${VERIFY_TYPE}"
wd_ci_init
read -r VERIFY_ID VERIFY_IP <<<"$(wd_ci_launch verify "$VERIFY_TYPE")"

# Same hazard as the builder: unattended-upgrades holds the dpkg lock and
# restarts sshd underneath us, and install.sh runs apt-get for the compositor's
# runtime libraries. This only stops the image's own background upgrades — it
# installs nothing, so the machine is still bare in every way that matters here.
wd_ci_prepare_host "$VERIFY_IP"

# Prove the machine really is bare before we install anything, so a pass cannot
# be explained by something that was already there.
log "confirming the instance is bare"
wd_ci_ssh "$VERIFY_IP" 'bash -s' <<'REMOTE'
set -euo pipefail
echo "  distro:  $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "  glibc:   $(ldd --version | awk 'NR==1 { print $NF }')"
echo "  node:    $(command -v node || echo '(none)')"
echo "  npm:     $(command -v npm || echo '(none)')"
echo "  gcc:     $(command -v gcc || echo '(none)')"
# Must not abort when node is absent — that is the expected, desirable case.
if command -v node >/dev/null 2>&1; then
  echo "  NOTE: a node is already present, so this test is weaker than it looks" >&2
fi
REMOTE

log "installing"
wd_ci_scp_to "$TARBALL" "$VERIFY_IP" "/tmp/$(basename "$TARBALL")"
wd_ci_scp_to "$REPO/packaging/aws/acceptance.mjs" "$VERIFY_IP" /tmp/acceptance.mjs

INSTALL_LOG=$(mktemp)
if ! wd_ci_ssh "$VERIFY_IP" "bash -s '$(basename "$TARBALL")'" 2>&1 <<'REMOTE' | tee "$INSTALL_LOG"
set -euo pipefail
cd /tmp
tar xzf "$1"
dir="${1%-linux-x64.tar.gz}"
cd "$dir"
sudo ./install.sh
REMOTE
then
  log "the installer failed"
  wd_ci_ssh "$VERIFY_IP" 'sudo journalctl -u finestra -n 40 --no-pager' || true
  exit 1
fi

# What the installer prints is documentation, and it is read at the one moment
# someone is about to copy a command. It printed `ssh root@host` once, from a
# fallback that reached for `logname` on a machine installed over a root login —
# a worked example of a habit worth not teaching, for no benefit at all, since
# the tunnel needs no privilege. A placeholder is the better answer when nothing
# real is known, so the failure this catches is a suggestion, not a crash.
if grep -q 'ssh .*root@' "$INSTALL_LOG"; then
  log "FAILED — the installer told the operator to ssh in as root:"
  grep 'ssh .*root@' "$INSTALL_LOG"
  exit 1
fi

# ---------------------------------------------------------------------------
# The checks
# ---------------------------------------------------------------------------

# Every remote block reports through the same helper, so a failed check always
# reaches the exit status rather than only the transcript.
CHECK_HELPER='
fails=0
t() { # t <name> <command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; else echo "FAIL  $name"; fails=$((fails+1)); fi
}
'

# The state directory follows the account install.sh chose, so it is read from
# the unit rather than assumed — the same way update.sh finds it.
STATE_HELPER='
state_dir() { sudo /opt/finestra/current/configure.sh --state-dir; }
'

log "running the acceptance checks"
set +e
wd_ci_ssh "$VERIFY_IP" "bash -s" <<REMOTE
set -uo pipefail
$CHECK_HELPER
$STATE_HELPER
t "the unit is active"           sudo systemctl is-active --quiet finestra
t "the unit is enabled at boot"  sudo systemctl is-enabled --quiet finestra
# Unattended, install.sh runs the desktop as whoever installed it. That is the
# whole point: reaching the port already means holding this account's shell.
t "it runs as the installing user" bash -c '[ "\$(systemctl show -p User --value finestra)" = ubuntu ]'
t "it is not running as root"      bash -c '[ "\$(systemctl show -p User --value finestra)" != root ]'
t "its home is a real home"        bash -c 'systemctl show -p Environment --value finestra | grep -q "HOME=/home/ubuntu"'
t "its state is in that home"      sudo test -s /home/ubuntu/.local/state/finestra/token
# The lesson from the last round: systemctl reports the value that was written,
# not the one in force, and five other options turn this back on behind your
# back. /proc is the only answer that counts.
t "no-new-privileges is really off" bash -c '
  pid=\$(systemctl show -p MainPID --value finestra)
  [ "\$(awk "/NoNewPrivs/ { print \\\$2 }" /proc/\$pid/status)" = 0 ]'
token=\$(sudo cat "\$(state_dir)/token")
/opt/finestra/current/runtime/bin/node /tmp/acceptance.mjs "\$token" '' privileged || fails=\$((fails+1))
exit \$fails
REMOTE
CHECKS=$?

# A restart is where a packaging mistake that only worked by accident shows up.
log "restarting the service and re-checking"
wd_ci_ssh "$VERIFY_IP" "bash -s" <<REMOTE
set -uo pipefail
$CHECK_HELPER
sudo systemctl restart finestra; sleep 3
t "survives a restart"            sudo systemctl is-active --quiet finestra
t "answers again after a restart" curl -sf -o /dev/null http://127.0.0.1:7070/healthz
exit \$fails
REMOTE
RESTART=$?

# The other answer to the question install.sh asks. It is a different product —
# observability rather than a desktop — and it has to keep working, because it
# is what anyone who wants this locked down will install.
log "switching to the unprivileged system account, in place"
wd_ci_ssh "$VERIFY_IP" "bash -s" <<REMOTE
set -uo pipefail
$CHECK_HELPER
$STATE_HELPER
# Through the shipped command, not the tarball: changing this later, on a
# machine that no longer has the package it was installed from, is the whole
# reason configure.sh stays behind in the install tree.
t "the install left a way to change this" test -x /opt/finestra/current/configure.sh
t "it can say what it is now"             sudo /opt/finestra/current/configure.sh --show
sudo /opt/finestra/current/configure.sh --system-account >/dev/null
t "it runs as the system account"  bash -c '[ "\$(systemctl show -p User --value finestra)" = finestra ]'
t "no-new-privileges is really on" bash -c '
  pid=\$(systemctl show -p MainPID --value finestra)
  [ "\$(awk "/NoNewPrivs/ { print \\\$2 }" /proc/\$pid/status)" = 1 ]'
t "it still answers"               curl -sf -o /dev/null http://127.0.0.1:7070/healthz
# Locked down is not the same as blind: the log viewer is the entire point of
# this mode, and it is a group membership rather than anything the service can
# ask for at runtime.
t "the system account can read the journal" \
  sudo -u finestra journalctl -n 1 --no-pager -q
token=\$(sudo cat "\$(state_dir)/token")
/opt/finestra/current/runtime/bin/node /tmp/acceptance.mjs "\$token" '' system || fails=\$((fails+1))

# An upgrade must never hand privilege back to a machine that gave it up: the
# person who chose this will not remember a flag they passed once.
cd /tmp/finestra-*/ && sudo ./install.sh >/dev/null
t "a plain reinstall keeps that choice" bash -c '[ "\$(systemctl show -p User --value finestra)" = finestra ]'
t "and keeps it unprivileged"           bash -c '
  pid=\$(systemctl show -p MainPID --value finestra)
  [ "\$(awk "/NoNewPrivs/ { print \\\$2 }" /proc/\$pid/status)" = 1 ]'
exit \$fails
REMOTE
LOCKED=$?

log "uninstalling"
wd_ci_ssh "$VERIFY_IP" "bash -s" <<REMOTE
set -uo pipefail
$CHECK_HELPER
$STATE_HELPER
# Read while the unit still exists: the unit is the only record of where this
# install put its state.
state=\$(state_dir)
cd /tmp/finestra-*/ && sudo ./install.sh --uninstall >/dev/null
t "the service is gone"                bash -c '! systemctl is-active --quiet finestra'
t "the unit file is gone"              bash -c '[ ! -f /etc/systemd/system/finestra.service ]'
# The state directory is 0700 and owned by the service user, so this needs sudo
# to look at all — without it the check fails on permissions and reads as a lost
# state directory, which is the opposite of the truth.
t "uninstall keeps the state directory"  sudo test -e "\$state/token"
t "and keeps the desktop user's state"   sudo test -e /home/ubuntu/.local/state/finestra/token
exit \$fails
REMOTE
UNINSTALL=$?
set -e

if [ $CHECKS -eq 0 ] && [ $RESTART -eq 0 ] && [ $LOCKED -eq 0 ] && [ $UNINSTALL -eq 0 ]; then
  log "VERIFIED — $(basename "$TARBALL") installs and runs on a bare Ubuntu 24.04"
  exit 0
fi
log "FAILED (checks=$CHECKS restart=$RESTART locked-down=$LOCKED uninstall=$UNINSTALL)"
exit 1
