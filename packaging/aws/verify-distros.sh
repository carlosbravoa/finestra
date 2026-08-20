#!/usr/bin/env bash
# The same release tarball, installed on a bare machine of every distribution
# this is meant to support, all at once.
#
#   packaging/aws/verify-distros.sh [path-to-tarball]
#   packaging/aws/verify-distros.sh --only debian-12,fedora
#   packaging/aws/verify-distros.sh --list
#
# It runs checks.sh — the identical file verify.sh runs — on each, so a
# difference in the result is a difference in the distribution and nothing
# else. distros.sh is the table of what "each" means.
#
# One tarball, deliberately. The thing being tested is not "can this be built
# on Fedora", which nobody is asked to do; it is whether the artifact we
# actually publish runs where we say it runs. The interesting failure is the
# one glibc causes — native code compiled on the builder against a newer C
# library than the target has — and it can only be found by carrying the real
# artifact to the real machine. Amazon Linux 2023 and Rocky 9 are the near
# edge of that (glibc 2.34, against the builder's 2.39), which is why they are
# on the list.
#
# All distributions run in parallel, each in its own subshell against its own
# instance, because five sequential ten-minute runs is a coffee break and five
# concurrent ones is not. They share one key pair and one security group, and
# the trap in lib.sh terminates every instance carrying this run's tag — so a
# subshell that dies, or a Ctrl-C in the middle, still cleans all five up.

set -euo pipefail
# Before the cd, so a relative path on the command line still means what it
# meant in the shell that typed it. See wd_ci_abs.
WD_CI_CALLER_PWD="$PWD"
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
source packaging/aws/lib.sh

ONLY=""
TARBALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --list) printf '%s\n' "${WD_CI_DISTROS[@]}"; exit 0 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) TARBALL="$1"; shift ;;
  esac
done

if [ -n "$ONLY" ]; then
  IFS=',' read -r -a TARGETS <<<"$ONLY"
else
  TARGETS=("${WD_CI_DISTROS[@]}")
fi

# Fail on an unknown name here, before spending ten minutes and five instances
# finding out. wd_ci_use_distro is the one thing that knows the list, so ask it
# rather than keeping a second copy of the names.
for d in "${TARGETS[@]}"; do
  ( wd_ci_use_distro "$d" ) >/dev/null || die "not a distribution this knows: $d"
done

TARBALL="$(wd_ci_abs "${TARBALL:-$(ls -1t "$REPO"/dist-release/finestra-*-linux-x64.tar.gz 2>/dev/null | awk 'NR==1')}")"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "no tarball; run packaging/aws/build.sh first"
VERIFY_TYPE="${VERIFY_TYPE:-t3.micro}"

LOGDIR="$(mktemp -d -t wd-distros-XXXXXX)"
log "verifying $(basename "$TARBALL") on: ${TARGETS[*]}"
log "per-distribution logs in $LOGDIR"

wd_ci_init

# One distribution, start to finish, on its own instance. Everything it sets —
# the AMI, the login, the family — is a variable local to this subshell, which
# is what lets five of these run at once without a word of locking.
one_distro() {
  local distro="$1" out="$LOGDIR/${1}.log" runner="$LOGDIR/${1}-run.sh" id ip rc
  {
    # `set -e` off inside here, deliberately. This function's whole job is to
    # come back with a number — how many checks failed — and under `set -e` the
    # first non-zero status ends the subshell before the number can be recorded
    # or the transcript finished. The 9x returns below are the errors that stop
    # a run early; anything else is a result, not a fault.
    set +e
    wd_ci_use_distro "$distro" || return 90
    echo "=== ${WD_CI_PRETTY} (${distro})"

    # wd_ci_launch calls die() on the way to giving up, and die() inside $( )
    # ends only the command substitution — so the failure arrives here as an
    # empty line rather than a non-zero status. Checked for what it is.
    read -r id ip <<<"$(wd_ci_launch "verify" "$VERIFY_TYPE")" || true
    if [ -z "${ip:-}" ]; then echo "no instance came up"; return 91; fi
    echo "instance $id at $ip, login ${WD_CI_LOGIN}"

    wd_ci_prepare_host "$ip"
    wd_ci_scp_to "$TARBALL" "$ip" "/tmp/$(basename "$TARBALL")"       || return 92
    wd_ci_scp_to "$REPO/packaging/aws/acceptance.mjs" "$ip" /tmp/acceptance.mjs || return 92
    wd_ci_scp_to "$REPO/packaging/aws/checks.sh" "$ip" /tmp/checks.sh || return 92

    # The runner is written per distribution rather than shared, with the login
    # baked in: wd_ci_run_detached runs the script it is given with no
    # arguments, and the login is the one thing that differs between these five
    # invocations.
    printf '#!/usr/bin/env bash\nbash /tmp/checks.sh %q %q\n' \
      "$(basename "$TARBALL")" "$WD_CI_LOGIN" > "$runner"
    wd_ci_run_detached "$ip" "acceptance" "$runner" 1800
    rc=$?
    echo "=== ${distro}: exit ${rc}"
    return "$rc"
  } >"$out" 2>&1
}

# Launched together, waited on together. `wait` on each pid in turn gives the
# real exit status of that subshell — which is the number of checks that
# failed, or one of the 9x codes above for a failure to even get that far.
#
# The thing that makes this safe is that bash resets a parent's traps to their
# default inside a subshell. lib.sh's cleanup trap terminates every instance
# carrying this run's tag — all five of them — so had `&` inherited that trap,
# the first distribution to finish would have torn down the other four while
# they were still working, and the run would have reported a cascade of
# unreachable hosts. It does not, and the parent's single trap on the way out
# is what cleans up all five. Verified rather than assumed, because the failure
# mode is expensive and looks like a network problem.
declare -A PIDS=()
for d in "${TARGETS[@]}"; do
  one_distro "$d" &
  PIDS["$d"]=$!
  log "  started $d (pid ${PIDS[$d]})"
  # A small stagger. Five simultaneous RunInstances against one brand-new
  # security group is the sort of thing EC2 answers with a rate limit, and the
  # cost of not racing is three seconds.
  sleep 3
done

declare -A RESULT=()
FAILED=0
for d in "${TARGETS[@]}"; do
  set +e
  wait "${PIDS[$d]}"
  RESULT["$d"]=$?
  set -e
  [ "${RESULT[$d]}" -eq 0 ] || FAILED=1
  log "  finished $d -> ${RESULT[$d]}"
done


# ---------------------------------------------------------------------------
# The report
# ---------------------------------------------------------------------------
# Every distribution's full transcript, then a table. Both, because the table is
# what gets read and the transcript is what answers "why" — and on a matrix run
# the failing one is rarely the one you were watching.

for d in "${TARGETS[@]}"; do
  printf '\n\n########## %s ##########\n' "$d"
  cat "$LOGDIR/${d}.log" 2>/dev/null || echo "(no log)"
done

printf '\n\n===================== %s =====================\n' "$(basename "$TARBALL")"
for d in "${TARGETS[@]}"; do
  rc="${RESULT[$d]}"
  case "$rc" in
    0)  verdict="PASS" ;;
    90) verdict="FAIL  (unknown distribution)" ;;
    91) verdict="FAIL  (never launched or ssh never came up)" ;;
    92) verdict="FAIL  (could not copy the package over)" ;;
    124) verdict="FAIL  (the checks did not finish in time)" ;;
    *)  verdict="FAIL  (${rc} check(s) did not pass)" ;;
  esac
  # glibc is pulled back out of the transcript because it is the first thing
  # anyone asks when a distribution fails and the others pass.
  # Unanchored on purpose. checks.sh indents its own report by two spaces and
  # wd_ci_run_detached indents the whole transcript by four more, so a pattern
  # anchored to a fixed indent silently matches nothing and every row of this
  # table reads "glibc ?" — which is what it did until a real run printed it.
  glibc="$(awk '/glibc:/ { print $2; exit }' "$LOGDIR/${d}.log" 2>/dev/null)"
  printf '  %-20s %-12s %s\n' "$d" "glibc ${glibc:-?}" "$verdict"
done
printf '=========================================================\n'
log "logs kept in $LOGDIR"

[ "$FAILED" -eq 0 ] || exit 1
log "VERIFIED on every distribution asked for"
