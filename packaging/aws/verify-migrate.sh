#!/usr/bin/env bash
# Proves that a real web-desktop install becomes a real Finestra install, on a
# machine that has both in turn — and that the one thing nobody would forgive
# losing survives: the access token in someone's bookmark.
#
#   packaging/aws/verify-migrate.sh [path-to-finestra-tarball]
#
# The old install is a genuine one, fetched from the preserved pre-rename
# installer, not a hand-fabricated unit. Fabricating it would test the fixture
# rather than the product: the whole risk of a migration lives in the details of
# what the previous version actually wrote, and a fixture is a guess at those.
#
# The unit-level branches — a start that fails, a port that stays held, an
# unmarked unit, a second run — are covered in about a second by
# tests/install-sandbox.sh. This covers the part a sandbox cannot: two real
# systemd services, a real port, and a real token round-tripped through the
# real API.

set -euo pipefail
# Before the cd, so a relative path on the command line still means what it
# meant in the shell that typed it. See wd_ci_abs.
WD_CI_CALLER_PWD="$PWD"
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
source packaging/aws/lib.sh

TARBALL="$(wd_ci_abs "${1:-$(ls -1t "$REPO"/dist-release/finestra-*-linux-x64.tar.gz 2>/dev/null | awk 'NR==1')}")"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "no tarball; run packaging/aws/build.sh first"

# Where the previous product still lives. publish.sh no longer touches this
# bucket; it is kept serving on purpose, both as an escape hatch for anyone
# mid-upgrade and as the only honest source of an old install to migrate from.
OLD_BASE="${WD_OLD_BASE_URL:-https://web-desktop-dl-316139.s3.us-east-1.amazonaws.com}"
OLD_GET="${WD_OLD_GET:-${OLD_BASE}/get-web-desktop.sh}"

log "migration check: ${OLD_GET} → $(basename "$TARBALL")"
wd_ci_init

CHECK_HELPER='
fails=0
t() { local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; else echo "FAIL  $name"; fails=$((fails+1)); fi
}
'

# One pass, on its own instance:
#   $1 label   $2 flags for the OLD installer   $3 account the new one must run as
#   $4 old token path   $5 new token path   $6 acceptance mode
migrate_pass() {
  local label="$1" old_flags="$2" want_user="$3"
  local old_token_path="$4" new_token_path="$5" mode="$6"
  local id ip rc old_token

  log "=== ${label} ==="
  read -r id ip <<<"$(wd_ci_launch migrate "${VERIFY_TYPE:-t3.micro}")"
  wd_ci_prepare_host "$ip"
  wd_ci_scp_to "$TARBALL" "$ip" "/tmp/$(basename "$TARBALL")"
  wd_ci_scp_to "$REPO/packaging/aws/acceptance.mjs" "$ip" /tmp/acceptance.mjs

  log "installing the previous product, for real"
  wd_ci_ssh "$ip" "bash -s '$OLD_GET' '$old_flags'" <<'REMOTE'
set -euo pipefail
if [ -n "$2" ]; then curl -fsSL "$1" | sudo bash -s -- "$2"
else                 curl -fsSL "$1" | sudo bash; fi
REMOTE

  # Read before anything is replaced. This is the value every later assertion
  # is about, so it is captured here rather than derived afterwards.
  old_token="$(wd_ci_ssh "$ip" "sudo cat '$old_token_path'" | tr -d '\r\n')"
  [ -n "$old_token" ] || die "the old install produced no token; there is nothing to prove"
  log "the token to preserve: ${old_token:0:8}…"

  log "taking it over"
  set +e
  wd_ci_ssh "$ip" "bash -s '$(basename "$TARBALL")' '$old_token' '$want_user' '$new_token_path' '$mode'" <<REMOTE
set -uo pipefail
${CHECK_HELPER}
cd /tmp
tar xzf "\$1"
cd "\${1%-linux-x64.tar.gz}"
if ! sudo ./install.sh > /tmp/install.log 2>&1; then
  echo "FAIL  the installer ran"; tail -30 /tmp/install.log; exit 1
fi
echo "PASS  the installer ran"

# Every value is expanded by this shell before t runs it. Nothing is passed
# into a nested \`bash -c\`, which has its own empty positional parameters —
# a check written that way compares two empty strings and always passes.
now_user="\$(systemctl show -p User --value finestra)"
new_token="\$(sudo cat "\$4" 2>/dev/null | tr -d '\\r\\n')"
listeners="\$(ss -ltnH 'sport = :7070' | wc -l)"

t "the new service is active"       sudo systemctl is-active --quiet finestra
t "the new service is enabled"      sudo systemctl is-enabled --quiet finestra
t "it runs as the right account"    test "\$now_user" = "\$3"

# The assertion this whole exercise exists for.
t "the token came across unchanged" test "\$new_token" = "\$2"

t "the old service is stopped"      bash -c '! systemctl is-active --quiet web-desktop'
t "the old service is disabled"     bash -c '! systemctl is-enabled --quiet web-desktop 2>/dev/null'
t "the old unit file is gone"       test ! -f /etc/systemd/system/web-desktop.service
t "its wants-symlink is gone"       test ! -e /etc/systemd/system/multi-user.target.wants/web-desktop.service
t "the old prefix is gone"          test ! -d /opt/web-desktop
# Exactly one. Two would mean an orphan survived and a port race decides which
# desktop you reach — the failure this migration exists to prevent.
t "one thing listens on 7070"       test "\$listeners" = 1
t "it says what it took over"       grep -q "took over" /tmp/install.log
t "it says what it removed"         grep -q "removed" /tmp/install.log

# Through the real API, with the OLD token: proof that the bookmark works,
# rather than proof that a file exists.
/opt/finestra/current/runtime/bin/node /tmp/acceptance.mjs "\$2" '' "\$5" || fails=\$((fails+1))

# And again, because an installer that is not idempotent is one nobody can
# safely re-run after a network drop.
sudo ./install.sh > /tmp/install2.log 2>&1 || { echo "FAIL  a second run succeeds"; exit 1; }
echo "PASS  a second run succeeds"
t "the token is still the same"     test "\$(sudo cat "\$4" | tr -d '\\r\\n')" = "\$2"
t "it is still active"              sudo systemctl is-active --quiet finestra
exit \$fails
REMOTE
  rc=$?
  set -e
  return $rc
}

FAILS=0

set +e
# The common case: an ordinary install running as the person who made it.
migrate_pass "a per-user install" "" ubuntu \
  /home/ubuntu/.local/state/web-desktop/token \
  /home/ubuntu/.local/state/finestra/token privileged
[ $? -eq 0 ] || FAILS=$((FAILS + 1))

# And the locked-down one, where the account itself has to be replaced.
migrate_pass "a system-account install" "--system-account" finestra \
  /var/lib/web-desktop/token \
  /var/lib/finestra/token system
[ $? -eq 0 ] || FAILS=$((FAILS + 1))
set -e

if [ $FAILS -eq 0 ]; then
  log "VERIFIED — a real web-desktop install becomes Finestra, token and all"
  exit 0
fi
log "FAILED — ${FAILS} migration pass(es) did not hold"
exit 1
