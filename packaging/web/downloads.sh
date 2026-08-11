#!/usr/bin/env bash
# What the site actually served: page views, installs started, releases taken.
#
#   packaging/web/downloads.sh [--days N] [--keep-mine] [--by-day]
#
# Reads CloudFront access logs from the log bucket. Nothing in the product
# reports anything — these are the requests the CDN already answered, which is
# the only kind of measurement this project is willing to take. See
# "What I would advise against" in the licensing discussion: software that
# phones home would cost more trust than the numbers are worth.
#
# The interesting number is not any single column, it is the drop between them:
#
#   get.sh            somebody ran, or read, the one-liner
#   latest.txt        get.sh got past its preflight — root, systemd, arch, glibc
#   releases/*.tar.gz they actually took a build
#
# A wide gap between the first two is the preflight refusing machines; between
# the second and third, a download that failed or was interrupted.
#
# Your own traffic dominates everything until you exclude it: every CI verifier
# run installs from the real URL and pulls a whole tarball. This drops your
# current public IP by default; --keep-mine puts it back.
set -euo pipefail

BUCKET="${WD_LOG_BUCKET:-finestra-logs-316139}"
CACHE="${WD_LOG_CACHE:-$HOME/.cache/finestra-logs}"
DAYS=30
KEEP_MINE=0
BY_DAY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    --keep-mine) KEEP_MINE=1; shift ;;
    --by-day) BY_DAY=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v aws >/dev/null || { echo "this needs the aws cli" >&2; exit 1; }

MINE=""
if [ "$KEEP_MINE" -eq 0 ]; then
  # Best effort: no network, no exclusion, which is honest rather than fatal.
  MINE="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
fi

mkdir -p "$CACHE"
# sync rather than cp: repeat runs move only what is new, and the bill for
# reading a month of logs twice is then zero.
aws s3 sync "s3://${BUCKET}/" "$CACHE/" --exclude '*' --include '*.gz' --only-show-errors

# GNU date; the logs are UTC and so is this.
SINCE="$(date -u -d "${DAYS} days ago" +%Y-%m-%d 2>/dev/null || date -u -v-"${DAYS}"d +%Y-%m-%d)"

files=$(find "$CACHE" -name '*.gz' -type f | wc -l)
[ "$files" -gt 0 ] || { echo "no logs yet in s3://${BUCKET}"; exit 0; }

# Field positions come from each file's own #Fields: header. CloudFront has
# changed the default set before, and a parser with the columns baked in
# reports zeros rather than failing, which is the worst way to be wrong.
find "$CACHE" -name '*.gz' -type f -print0 | xargs -0 zcat 2>/dev/null | awk -v since="$SINCE" -v mine="$MINE" -v byday="$BY_DAY" '
  /^#Fields:/ {
    for (i = 2; i <= NF; i++) col[$i] = i - 1
    next
  }
  /^#/ { next }
  {
    d = $col["date"]; if (d < since) next
    ip = $col["c-ip"]; if (mine != "" && ip == mine) next

    uri = $col["cs-uri-stem"]; status = $col["sc-status"]
    seen_ip[ip] = 1; day_ip[d SUBSEP ip] = 1

    if (uri == "/" || uri == "/index.html")           { page[d]++;  total_page++ }
    else if (uri == "/get.sh")                        { get[d]++;   total_get++ }
    else if (uri == "/latest.txt")                    { res[d]++;   total_res++ }
    else if (uri ~ /^\/releases\/.*\.tar\.gz$/) {
      if (status == 200)      { dl[d]++;  total_dl++;  bytes += $col["sc-bytes"] }
      else if (status == 206) { part[d]++; total_part++ }
    }
    days[d] = 1
  }
  END {
    if (byday) {
      printf "  %-12s %6s %8s %10s %11s %9s\n", "day", "page", "get.sh", "preflight", "downloads", "uniq ip"
      # Insertion sort rather than asorti: that one is gawk only, and Ubuntu
      # ships mawk, so the convenient version fails on exactly the machines
      # this is most likely to be run from. ISO dates sort as strings.
      n = 0
      for (d in days) sorted[++n] = d
      for (i = 2; i <= n; i++) {
        v = sorted[i]; j = i - 1
        while (j > 0 && sorted[j] > v) { sorted[j + 1] = sorted[j]; j-- }
        sorted[j + 1] = v
      }
      for (i = 1; i <= n; i++) {
        d = sorted[i]; u = 0
        for (k in day_ip) { split(k, p, SUBSEP); if (p[1] == d) u++ }
        printf "  %-12s %6d %8d %10d %11d %9d\n", d, page[d], get[d], res[d], dl[d], u
      }
      print ""
    }
    for (k in seen_ip) uniq++
    printf "  page views          %6d\n", total_page
    printf "  get.sh fetched      %6d\n", total_get
    printf "  past preflight      %6d\n", total_res
    printf "  releases taken      %6d   (%.2f GB)\n", total_dl, bytes / 1073741824
    if (total_part) printf "  partial/range       %6d   (resumed or interrupted)\n", total_part
    printf "  unique addresses    %6d\n", uniq
    if (total_get && total_dl <= total_get)
      printf "\n  of everyone who fetched get.sh, %.0f%% ended up taking a build\n", 100 * total_dl / total_get
  }
' | { echo; echo "  Finestra · last ${DAYS} days${MINE:+ · excluding your own ${MINE}}"; echo; cat; echo; }
