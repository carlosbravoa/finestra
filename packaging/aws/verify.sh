#!/usr/bin/env bash
# Installs a release tarball on a machine that has never seen this project, and
# checks that what came up is actually usable.
#
# The instance is pristine on purpose: no toolchain, no Node, no source tree, no
# package repositories added by us. If the package needs anything that is not in
# it, this is where that shows up.
#
#   packaging/aws/verify.sh [path-to-tarball]
#   WD_CI_DISTRO=debian-12 packaging/aws/verify.sh
#
# The checks themselves are in checks.sh and run on the instance, because the
# same ones have to run unchanged on every distribution verify-distros.sh
# covers. This script is only the part that gets them there.

set -euo pipefail
# Before the cd, so a relative path on the command line still means what it
# meant in the shell that typed it. See wd_ci_abs.
WD_CI_CALLER_PWD="$PWD"
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
source packaging/aws/lib.sh

TARBALL="$(wd_ci_abs "${1:-$(ls -1t "$REPO"/dist-release/finestra-*-linux-x64.tar.gz 2>/dev/null | awk 'NR==1')}")"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "no tarball; run packaging/aws/build.sh first"
VERIFY_TYPE="${VERIFY_TYPE:-t3.micro}"

log "verifying $(basename "$TARBALL") on a pristine ${WD_CI_PRETTY} (${VERIFY_TYPE})"
wd_ci_init
read -r VERIFY_ID VERIFY_IP <<<"$(wd_ci_launch verify "$VERIFY_TYPE")"

# Same hazard as the builder: the image's own upgrade timer holds the package
# lock and restarts sshd underneath us. This only stops that — it installs
# nothing, so the machine is still bare in every way that matters here.
# install.sh no longer runs a package manager at all: the compositor's two
# runtime libraries are optional and reported rather than installed, so a
# verified install is a machine that cannot yet run native applications.
wd_ci_prepare_host "$VERIFY_IP"

log "sending the package and the checks"
wd_ci_scp_to "$TARBALL" "$VERIFY_IP" "/tmp/$(basename "$TARBALL")"
wd_ci_scp_to "$REPO/packaging/aws/acceptance.mjs" "$VERIFY_IP" /tmp/acceptance.mjs
wd_ci_scp_to "$REPO/packaging/aws/checks.sh" "$VERIFY_IP" /tmp/checks.sh

# Detached, because the acceptance run reinstalls and restarts services on a
# machine whose sshd is not entirely under our control. Its exit status is the
# number of checks that failed.
#
# The runner is a two-line file rather than a command string because
# wd_ci_run_detached takes a local script — and because quoting a tarball name
# through ssh, nohup and bash -c three times over is a way to lose an argument
# silently.
# No `trap ... EXIT` to clean this up: lib.sh's trap is what terminates the
# instance, and a second EXIT trap replaces it rather than adding to it — which
# would leak a running machine to save deleting a two-line file in /tmp.
RUNNER="$(mktemp)"
printf '#!/usr/bin/env bash\nbash /tmp/checks.sh %q %q\n' \
  "$(basename "$TARBALL")" "$WD_CI_LOGIN" > "$RUNNER"

log "running the acceptance checks"
set +e
wd_ci_run_detached "$VERIFY_IP" acceptance "$RUNNER" 1800
FAILURES=$?
set -e

if [ "$FAILURES" -eq 0 ]; then
  log "VERIFIED — $(basename "$TARBALL") installs and runs on a bare ${WD_CI_PRETTY}"
  exit 0
fi
log "FAILED on ${WD_CI_PRETTY} — ${FAILURES} check(s) did not pass"
exit 1
