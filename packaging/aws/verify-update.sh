#!/usr/bin/env bash
# Proves the updater on a real machine, including the case that matters most:
# an update that does not work must put the old one back by itself.
#
# Two extra packages are made from the built one by rewriting its MANIFEST
# version — and, for the third, by breaking its entry point. That tests the
# mechanism (install beside, switch, health-check, revert) without waiting for
# three genuinely different builds, and the broken one is broken in the way a
# bad release actually is: it installs fine and then will not start.
#
#   packaging/aws/verify-update.sh [path-to-tarball]

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
source packaging/aws/lib.sh

TARBALL="${1:-$(ls -1t "$REPO"/dist-release/finestra-*-linux-x64.tar.gz 2>/dev/null | awk 'NR==1')}"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "no tarball; run packaging/aws/build.sh first"

# The tarball is the thing under test, and the updater inside it is a *copy*
# taken at build time. Editing packaging/update.sh and re-running this verifies
# the old code and says nothing about the change — which happened, and cost a
# full round of confused diagnosis before the timestamps were noticed.
if [ packaging/update.sh -nt "$TARBALL" ] || [ packaging/install.sh -nt "$TARBALL" ]; then
  die "$(basename "$TARBALL") is older than packaging/update.sh — rebuild first, or this tests the previous version"
fi

log "verifying the updater with $(basename "$TARBALL")"
wd_ci_init
read -r ID IP <<<"$(wd_ci_launch update "${VERIFY_TYPE:-t3.micro}")"
wd_ci_prepare_host "$IP"

wd_ci_scp_to "$TARBALL" "$IP" "/tmp/$(basename "$TARBALL")"

log "building a newer and a broken package from it, on the instance"
wd_ci_ssh "$IP" "bash -s '$(basename "$TARBALL")'" <<'REMOTE'
set -euo pipefail
cd /tmp
orig="$1"
tar xzf "$orig"
dir=$(find . -maxdepth 1 -type d -name 'finestra-*' -print -quit)
base=$(basename "$dir")
ver=$(sed -n 's/^version=//p' "$dir/MANIFEST")

make_variant() {   # <new-version> [break]
  local nv="$1" brk="${2:-}"
  rm -rf "/tmp/v-$nv"; mkdir -p "/tmp/v-$nv"
  cp -a "$dir" "/tmp/v-$nv/finestra-$nv"
  sed -i "s/^version=.*/version=$nv/" "/tmp/v-$nv/finestra-$nv/MANIFEST"
  if [ -n "$brk" ]; then
    # Fails at startup, exactly as a bad release does: installs cleanly, then
    # will not come up.
    echo 'throw new Error("deliberately broken release");' \
      > "/tmp/v-$nv/finestra-$nv/app/server/src/index.js"
  fi
  (cd "/tmp/v-$nv" && tar czf "/tmp/finestra-$nv.tar.gz" "finestra-$nv")
}

make_variant "9.9.9-newer"
make_variant "9.9.8-broken" break
echo "  original: $ver"
ls -1 /tmp/finestra-9.9.*.tar.gz
REMOTE

log "installing the original"
wd_ci_ssh "$IP" "bash -s '$(basename "$TARBALL")'" <<'REMOTE'
set -euo pipefail
cd /tmp
dir=$(find . -maxdepth 1 -type d -name 'finestra-*' ! -name '*9.9.*' -print -quit)
cd "$dir" && sudo ./install.sh >/dev/null
echo "  installed $(basename "$(readlink -f /opt/finestra/current)")"
REMOTE

# ---------------------------------------------------------------------------

CHECK_HELPER='
fails=0
t() { local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; else echo "FAIL  $name"; fails=$((fails+1)); fi
}
# Exported, because the checks run through `bash -c` and a child shell does not
# inherit functions. Without this every version check failed on "running: command
# not found" and looked like a broken updater.
running() { basename "$(readlink -f /opt/finestra/current)"; }
export -f running
'

log "a good update"
set +e
wd_ci_ssh "$IP" "bash -s" <<REMOTE
set -uo pipefail
$CHECK_HELPER
before=\$(running)
sudo /opt/finestra/current/update.sh /tmp/finestra-9.9.9-newer.tar.gz >/tmp/up1.log 2>&1
t "the update reports success"        grep -q "running 9.9.9-newer" /tmp/up1.log
t "current points at the new version" bash -c '[ "\$(running)" = "9.9.9-newer" ]'
t "the service is up on it"           sudo systemctl is-active --quiet finestra
t "it answers"                        curl -fsS -o /dev/null http://127.0.0.1:7070/healthz
t "the old version is still on disk"  bash -c "[ -d /opt/finestra/\$before ]"
# Wherever the install chose to keep it — the token is in someone's bookmark,
# so an update that invalidates it reads as an update that broke the login.
t "the token survived the update"     bash -c '
  sudo test -s "\$(sudo /opt/finestra/current/configure.sh --state-dir)/token"'
exit \$fails
REMOTE
GOOD=$?

log "a broken update must undo itself"
wd_ci_ssh "$IP" "bash -s" <<REMOTE
set -uo pipefail
$CHECK_HELPER
sudo /opt/finestra/current/update.sh /tmp/finestra-9.9.8-broken.tar.gz >/tmp/up2.log 2>&1
rc=\$?
t "the updater reports failure"          bash -c "[ \$rc -ne 0 ]"
t "it says it went back"                 grep -q "back on" /tmp/up2.log
t "current is the working version again" bash -c '[ "\$(running)" = "9.9.9-newer" ]'
t "the service is running"               sudo systemctl is-active --quiet finestra
t "it answers again"                     curl -fsS -o /dev/null http://127.0.0.1:7070/healthz
t "the broken one is kept for a look"    bash -c '[ -d /opt/finestra/9.9.8-broken ]'
exit \$fails
REMOTE
BROKEN=$?

log "an explicit rollback"
wd_ci_ssh "$IP" "bash -s" <<REMOTE
set -uo pipefail
$CHECK_HELPER
sudo /opt/finestra/current/update.sh --rollback >/tmp/up3.log 2>&1; rc=\$?
t "rollback succeeds"              bash -c "[ \$rc -eq 0 ]"
t "it is no longer on 9.9.9-newer" bash -c '[ "\$(running)" != "9.9.9-newer" ]'
t "it did NOT go back to the broken one" bash -c '[ "\$(running)" != "9.9.8-broken" ]'
t "the failed version is marked"   sudo test -e /opt/finestra/9.9.8-broken/FAILED
t "the service is running"         sudo systemctl is-active --quiet finestra
t "it answers"                     curl -fsS -o /dev/null http://127.0.0.1:7070/healthz
exit \$fails
REMOTE
ROLLBACK=$?

log "refusing rubbish"
wd_ci_ssh "$IP" "bash -s" <<REMOTE
set -uo pipefail
$CHECK_HELPER
echo "not a tarball" > /tmp/junk.tar.gz
sudo /opt/finestra/current/update.sh /tmp/junk.tar.gz >/tmp/up4.log 2>&1; rc=\$?
t "a corrupt package is refused"  bash -c "[ \$rc -ne 0 ]"
t "the service is untouched"      sudo systemctl is-active --quiet finestra
sudo /opt/finestra/current/update.sh /tmp/nothing-here.tar.gz >/tmp/up5.log 2>&1; rc=\$?
t "a missing file is refused"     bash -c "[ \$rc -ne 0 ]"
t "the service is still untouched" sudo systemctl is-active --quiet finestra
exit \$fails
REMOTE
JUNK=$?
set -e

if [ $GOOD -eq 0 ] && [ $BROKEN -eq 0 ] && [ $ROLLBACK -eq 0 ] && [ $JUNK -eq 0 ]; then
  log "VERIFIED — updates apply, bad ones undo themselves, rubbish is refused"
  exit 0
fi
log "FAILED (good=$GOOD broken=$BROKEN rollback=$ROLLBACK junk=$JUNK)"
log "the updater's own logs, so this does not have to be guessed at:"
wd_ci_ssh "$IP" 'for f in /tmp/up*.log; do echo "--- $f"; tail -25 "$f"; done' || true
exit 1
