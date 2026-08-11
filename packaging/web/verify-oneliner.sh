#!/usr/bin/env bash
# Runs the published one-liner on a machine that has never seen this project,
# exactly as a stranger would, and then checks that what came up works.
#
#   packaging/web/verify-oneliner.sh
#
# verify.sh proves a tarball installs. This proves the *download page* does:
# that latest.txt, get.sh, the release and its checksum are all reachable and
# agree with each other, that the checksum is actually enforced, and that
# `curl | sudo bash` on a bare instance ends with a working desktop.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
source packaging/aws/lib.sh

# The address a stranger uses, not the bucket behind it. Checking the bucket
# would skip the two things most likely to be wrong — the certificate and the
# edge — and pass while the published one-liner was unreachable.
REST="${WD_BASE_URL:-https://finestra.dev}"
VERIFY_TYPE="${VERIFY_TYPE:-t3.micro}"

log "verifying the published one-liner from ${REST}"
wd_ci_init
read -r VERIFY_ID VERIFY_IP <<<"$(wd_ci_launch verify-web "$VERIFY_TYPE")"
wd_ci_prepare_host "$VERIFY_IP"

log "confirming the instance is bare"
wd_ci_ssh "$VERIFY_IP" 'bash -s' <<'REMOTE'
set -euo pipefail
echo "  distro:  $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "  glibc:   $(ldd --version | awk 'NR==1 { print $NF }')"
echo "  node:    $(command -v node || echo '(none)')"
echo "  gcc:     $(command -v gcc || echo '(none)')"
REMOTE

CHECK_HELPER='
fails=0
t() { local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; else echo "FAIL  $name"; fails=$((fails+1)); fi
}
'

# ---------------------------------------------------------------------------
# The refusal path first, while the machine is still clean: a tarball that does
# not match its checksum must stop before anything inside it runs. Served from
# the instance itself so nothing has to be corrupted in the real bucket.
# ---------------------------------------------------------------------------

# Before anything is installed: the certificate is valid to a machine that has
# never heard of us, and plaintext does not serve the installer.
log "checking the site itself"
set +e
wd_ci_ssh "$VERIFY_IP" "bash -s '$REST'" <<'REMOTE'
set -uo pipefail
fails=0
# No -k anywhere. A one-liner into a root shell is exactly the case where
# "trust it anyway" is the wrong flag.
if curl -fsS -o /dev/null "$1/get.sh"; then echo "PASS  https serves get.sh with a valid certificate"
else echo "FAIL  https serves get.sh with a valid certificate"; fails=$((fails+1)); fi
code=$(curl -sS -o /dev/null -w '%{http_code}' "$(printf '%s' "$1" | sed 's|^https:|http:|')/get.sh" || echo 000)
case "$code" in
  30*) echo "PASS  plain http is redirected  ($code)" ;;
  *)   echo "FAIL  plain http is redirected  ($code)"; fails=$((fails+1)) ;;
esac
exit $fails
REMOTE
TLS=$?
set -e

log "checking a corrupted download is refused"
set +e
wd_ci_ssh "$VERIFY_IP" "bash -s '$REST'" <<'REMOTE'
set -uo pipefail
fails=0
cd /tmp && rm -rf tamper && mkdir -p tamper/releases && cd tamper
curl -fsSL "$1/get.sh" -o get.sh
# latest.txt names the file itself; do not reconstruct it from a version.
name=$(curl -fsSL "$1/latest.txt" | tr -d '[:space:]')
# A real checksum file, and a tarball that is not the file it describes.
curl -fsSL "$1/releases/${name}.sha256" -o "releases/${name}.sha256"
printf 'not the release' > "releases/${name}"
printf '%s\n' "$name" > latest.txt
python3 -m http.server 8099 --bind 127.0.0.1 >/dev/null 2>&1 &
srv=$!; sleep 2
out=$(WD_BASE_URL=http://127.0.0.1:8099 sudo -E bash get.sh 2>&1); rc=$?
kill $srv 2>/dev/null
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "checksum mismatch"; then
  echo "PASS  a corrupted release is refused"
else
  echo "FAIL  a corrupted release is refused (rc=$rc)"; echo "$out" | tail -5; fails=$((fails+1))
fi
# And nothing was installed by the attempt.
if [ ! -e /opt/finestra ]; then echo "PASS  and nothing was installed"; else echo "FAIL  and nothing was installed"; fails=$((fails+1)); fi
exit $fails
REMOTE
TAMPER=$?

# ---------------------------------------------------------------------------
# The real thing
# ---------------------------------------------------------------------------

log "running the published one-liner"
wd_ci_ssh "$VERIFY_IP" "curl -fsSL '${REST}/get.sh' | sudo bash" 2>&1 | sed 's/^/  /'
ONELINER=${PIPESTATUS[0]}

log "checking what it installed"
wd_ci_scp_to "$REPO/packaging/aws/acceptance.mjs" "$VERIFY_IP" /tmp/acceptance.mjs
wd_ci_ssh "$VERIFY_IP" "bash -s '$REST'" <<REMOTE
set -uo pipefail
$CHECK_HELPER
t "the unit is active"            sudo systemctl is-active --quiet finestra
t "the unit is enabled at boot"   sudo systemctl is-enabled --quiet finestra
# Not "runs as its own user", which is what this asserted until the account
# stopped being a fixed one — a check written around the default it was meant
# to be testing, and which therefore went on passing while the product was
# unusable. What is invariant is that it is nobody's idea of root; which real
# account it is gets checked below, against the one that ran the installer.
t "it is not running as root"     bash -c '[ "\$(systemctl show -p User --value finestra)" != root ]'
t "it listens on loopback only" \
  bash -c 'ss -ltn | grep -q "127.0.0.1:7070" && ! ss -ltn | grep -qE "0\.0\.0\.0:7070|\*:7070"'
# The published filename replaces "+" with "-" (S3 reads "+" in a path as a
# space), so normalise before comparing rather than expecting them identical.
published="\$(curl -fsSL "\$1/latest.txt" | tr -d '[:space:]' | sed 's/^finestra-//; s/-linux-x64\.tar\.gz\$//')"
installed="\$(sed -n 's/^version=//p' /opt/finestra/current/MANIFEST | tr '+' '-')"
t "the installed version is the published one" test "\$installed" = "\$published"
[ "\$installed" = "\$published" ] || echo "      installed=\$installed published=\$published"
# Piped into a shell with no terminal behind it, install.sh runs the desktop as
# whoever ran the one-liner, and keeps its state in that account's home.
t "it runs as the installing user" bash -c '[ "\$(systemctl show -p User --value finestra)" = ubuntu ]'
token=\$(sudo cat /home/ubuntu/.local/state/finestra/token)
/opt/finestra/current/runtime/bin/node /tmp/acceptance.mjs "\$token" '' privileged || fails=\$((fails+1))
exit \$fails
REMOTE
CHECKS=$?

# Re-running the one-liner is what someone does to upgrade, and it must not
# leave the old process serving.
log "running it a second time — a reinstall must take effect"
wd_ci_ssh "$VERIFY_IP" "bash -s" <<REMOTE
set -uo pipefail
$CHECK_HELPER
before=\$(systemctl show -p MainPID --value finestra)
# Captured, not discarded: when this check failed the first time there was no
# way to tell a failed reinstall from a reinstall that did not restart.
out=\$(curl -fsSL '${REST}/get.sh' | sudo bash 2>&1); rc=\$?
sleep 3
after=\$(systemctl show -p MainPID --value finestra)
t "the reinstall itself succeeded" test \$rc -eq 0
[ \$rc -eq 0 ] || { echo "      --- reinstall output ---"; echo "\$out" | tail -20 | sed 's/^/      /'; }
t "the service is up after reinstalling" sudo systemctl is-active --quiet finestra
# test, not bash -c: the pids are shell variables here and a child shell would
# not see them, which is how this reported a false failure once.
t "and it is a new process, not the old one" test "\$before" != "\$after"
[ "\$before" != "\$after" ] || echo "      pid stayed \$before — the reinstall did not restart it"
t "it still answers"                     curl -sf -o /dev/null http://127.0.0.1:7070/healthz
exit \$fails
REMOTE
REINSTALL=$?
set -e

echo
if [ $TLS -eq 0 ] && [ $TAMPER -eq 0 ] && [ $ONELINER -eq 0 ] && [ $CHECKS -eq 0 ] && [ $REINSTALL -eq 0 ]; then
  log "VERIFIED — the published one-liner installs and runs on a bare machine"
  exit 0
fi
log "FAILED (tls=$TLS tamper=$TAMPER oneliner=$ONELINER checks=$CHECKS reinstall=$REINSTALL)"
exit 1
