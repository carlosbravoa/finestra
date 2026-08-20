#!/usr/bin/env bash
# The rule that decides whether a leftover key pair or security group is old
# enough to delete, and the one that decides what a relative path on the
# command line means. Both are pure, both are in packaging/aws/lib.sh, and
# neither needs AWS — which is the point of testing them here rather than
# discovering them on a release.
#
# The sweep got this wrong once in the direction that matters: it deleted a key
# pair belonging to a *live* run, and four of six verifiers died at
# RunInstances about a key that had existed eleven seconds earlier.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WD_CI_CALLER_PWD=/home/someone/downloads
source packaging/aws/lib.sh
# lib.sh turns on -e for the scripts that source it; a test has to survive its
# own failing assertions.
set +e

fails=0
check() {
  local name="$1"; shift
  if "$@"; then
    printf 'PASS  %s\n' "$name"
  else
    printf 'FAIL  %s\n' "$name"
    fails=$((fails + 1))
  fi
}
# `!` cannot be passed as an argument, so the negative case gets its own name.
refute() {
  local name="$1"; shift
  if "$@"; then
    printf 'FAIL  %s\n' "$name"
    fails=$((fails + 1))
  else
    printf 'PASS  %s\n' "$name"
  fi
}
named() { date -u -d "$1" +wd-ci-%Y%m%d-%H%M%S-31415; }

# --- what may be swept ------------------------------------------------
refute "a run that started this second is left alone" wd_ci_sweepable "$(named now)"
refute "so is one from five minutes ago"              wd_ci_sweepable "$(named '-5 minutes')"
check "an hour-old leftover is swept"                   wd_ci_sweepable "$(named '-1 hour')"
check "and so is one from last week"                    wd_ci_sweepable "$(named '-7 days')"
# Costs nothing to leave; costs a run to delete something we cannot date.
refute "a name with no timestamp is left alone"       wd_ci_sweepable wd-ci-handmade
refute "and so is a name with a nonsense one"         wd_ci_sweepable wd-ci-99999999-999999-1

# The boundary itself, stated rather than implied.
check "the grace period is the boundary" \
  test "$(wd_ci_name_age_min "$(named "-${WD_CI_SWEEP_GRACE_MIN} minutes")")" -ge "$WD_CI_SWEEP_GRACE_MIN"

# --- what a path on the command line means ----------------------------
check "a relative path is the caller's, not the repository's" \
  test "$(wd_ci_abs dist-release/x.tar.gz)" = /home/someone/downloads/dist-release/x.tar.gz
check "an absolute path is left as it is" \
  test "$(wd_ci_abs /tmp/x.tar.gz)" = /tmp/x.tar.gz
check "an empty path stays empty, so a default can be spotted" \
  test -z "$(wd_ci_abs '')"

echo ""
if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) FAILED"
  exit 1
fi
echo "the sweep leaves live runs alone, and paths mean what they say."
