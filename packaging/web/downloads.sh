#!/usr/bin/env bash
# What the site actually served: page views, installs started, releases taken.
#
#   packaging/web/downloads.sh [--days N] [--keep-mine] [--by-day] [--sources]
#
# Reads CloudFront access logs from the log bucket. Nothing in the product
# reports anything — these are the requests the CDN already answered, which is
# the only kind of measurement this project is willing to take. See
# "What I would advise against" in the licensing discussion: software that
# phones home would cost more trust than the numbers are worth.
#
# The interesting number is not any single column, it is the drop between them:
#
#   /                 something asked for the page
#   screenshot.png    a browser *rendered* it — see below
#   get.sh            somebody ran, or read, the one-liner
#   latest.txt        get.sh got past its preflight — root, systemd, arch, glibc
#   releases/*.tar.gz they actually took a build
#
# A wide gap between the first two is crawlers; between get.sh and latest.txt,
# the preflight refusing machines; between latest.txt and the tarball, a
# download that failed or was interrupted.
#
# Counting hits on `/` as visitors overstates it by about five times, and the
# error is not noise you can average out — a single scanner sweeping WordPress
# paths hits the apex too. The honest number is `screenshot.png`: the page's
# one subresource, loading="eager", so every browser that lays the page out
# asks for it and nothing that merely fetches HTML ever does. Over the first
# month, 243 addresses asked for `/` and 42 drew it. Do not remove that image,
# make it lazy, or inline it, without knowing that the measurement goes with
# it — the alternative is a tracker, which this project will not ship.
#
# --sources breaks the page traffic down by referrer and by client. It exists
# because a referrer is the one thing an access log has and a redirect-based
# analytics product does not do better; it does not exist to identify anybody.
#
# Your own traffic dominates everything until you exclude it: every CI verifier
# run installs from the real URL and pulls a whole tarball. This drops your
# current public IP by default; --keep-mine puts it back.
set -euo pipefail

BUCKET="${WD_LOG_BUCKET:-finestra-logs-316139}"
CACHE="${WD_LOG_CACHE:-$HOME/.cache/finestra-logs}"
DOMAIN="${WD_SITE_DOMAIN:-finestra.dev}"
DAYS=30
KEEP_MINE=0
BY_DAY=0
SOURCES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    --keep-mine) KEEP_MINE=1; shift ;;
    --by-day) BY_DAY=1; shift ;;
    --sources) SOURCES=1; shift ;;
    -h|--help) sed -n '2,39p' "$0"; exit 0 ;;
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
find "$CACHE" -name '*.gz' -type f -print0 | xargs -0 zcat 2>/dev/null | awk -v since="$SINCE" -v mine="$MINE" -v byday="$BY_DAY" -v sources="$SOURCES" -v domain="$DOMAIN" '
  # Anything that says out loud that it is not a person. Deliberately only the
  # honest ones: a scanner wearing a four-year-old iPhone user agent sails
  # straight through this, which is exactly why the screenshot count and not
  # this filter is what the report leads with.
  function isbot(ua) {
    return ua ~ /[Bb]ot|[Cc]rawl|[Ss]pider|[Ss]lurp|[Ss]craper|[Cc]hecker|[Mm]onitor|Dataprovider|HeadlessChrome|PhantomJS|facebookexternalhit|WhatsApp|Telegram|python-requests|python-httpx|Go-http-client|axios|okhttp|libwww|Java\//
  }
  # Something that lays out a page, rather than something that fetches bytes.
  # The distinction matters for exactly one line of this report — the render
  # count — and getting it wrong is easy: curl asking for the screenshot is a
  # mirror or a script, not a reader, but it is not a bot either and the list
  # above waves it through. Claiming Mozilla is the cheap test, and every real
  # browser does it; no fetching tool bothers.
  function isbrowser(ua) { return ua ~ /Mozilla/ && !isbot(ua) }
  # What asked. A tool that does not claim Mozilla names itself, and its own
  # name up to the version is the most useful thing to print — "python-httpx"
  # is worth more on screen than a second row of "crawlers and scanners".
  function client(ua) {
    if (ua !~ /Mozilla/)    { sub(/\/.*/, "", ua); return (ua == "" || ua == "-") ? "(no user agent)" : ua }
    if (isbot(ua))          return "crawlers and scanners"
    if (ua ~ /Edg\//)       return "Edge"
    if (ua ~ /OPR\//)       return "Opera"
    if (ua ~ /Firefox\//)   return "Firefox"
    if (ua ~ /Chrome\//)    return "Chrome"
    if (ua ~ /Safari\//)    return "Safari"
    return "other"
  }
  # Host only. A full referring URL is both longer than the terminal and more
  # than anyone needs to know about a reader.
  function refhost(r,   h) {
    if (r == "-" || r == "") return "(direct, or a client that sends none)"
    h = r; sub(/^https?:\/\//, "", h); sub(/[\/?].*/, "", h); sub(/:[0-9]+$/, "", h)
    if (h == domain || h == "www." domain) return "(the site itself)"
    return h
  }
  /^#Fields:/ {
    for (i = 2; i <= NF; i++) col[$i] = i - 1
    next
  }
  /^#/ { next }
  {
    d = $col["date"]; if (d < since) next
    ip = $col["c-ip"]; if (mine != "" && ip == mine) next

    uri = $col["cs-uri-stem"]; status = $col["sc-status"]
    ua = $col["cs(User-Agent)"]
    seen_ip[ip] = 1; day_ip[d SUBSEP ip] = 1

    if (uri == "/" || uri == "/index.html") {
      page[d]++; total_page++
      if (isbot(ua)) total_bot++; else total_human++
      by_client[client(ua)]++
      by_ref[refhost($col["cs(Referer)"])]++
    }
    # The one request only a laid-out page makes.
    else if (uri == "/screenshot.png")                { if (isbrowser(ua)) { drew[d]++; total_drew++ } }
    else if (uri == "/get.sh")                        { get[d]++;   total_get++ }
    else if (uri == "/latest.txt")                    { res[d]++;   total_res++ }
    else if (uri ~ /^\/releases\/.*\.tar\.gz$/) {
      if (status == 200)      { dl[d]++;  total_dl++;  bytes += $col["sc-bytes"] }
      else if (status == 206) { part[d]++; total_part++ }
    }
    days[d] = 1
  }
  # Descending by count, ties broken by name so two runs of the same data print
  # the same thing. Insertion sort for the same reason as the day table below.
  function ranked(c, out,   k, n, i, j, v) {
    n = 0
    for (k in c) out[++n] = k
    for (i = 2; i <= n; i++) {
      v = out[i]; j = i - 1
      while (j > 0 && (c[out[j]] < c[v] || (c[out[j]] == c[v] && out[j] > v))) { out[j + 1] = out[j]; j-- }
      out[j + 1] = v
    }
    return n
  }
  END {
    if (byday) {
      printf "  %-12s %6s %7s %8s %10s %11s %9s\n", "day", "page", "drew", "get.sh", "preflight", "downloads", "uniq ip"
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
        printf "  %-12s %6d %7d %8d %10d %11d %9d\n", d, page[d], drew[d], get[d], res[d], dl[d], u
      }
      print ""
    }
    for (k in seen_ip) uniq++
    printf "  page requests       %6d\n", total_page
    printf "    of those, bots    %6d   (the ones that admit it)\n", total_bot
    printf "  drew the page       %6d   (fetched the screenshot)\n", total_drew
    printf "  get.sh fetched      %6d\n", total_get
    printf "  past preflight      %6d\n", total_res
    printf "  releases taken      %6d   (%.2f GB)\n", total_dl, bytes / 1073741824
    if (total_part) printf "  partial/range       %6d   (resumed or interrupted)\n", total_part
    printf "  unique addresses    %6d\n", uniq
    if (total_get && total_dl <= total_get)
      printf "\n  of everyone who fetched get.sh, %.0f%% ended up taking a build\n", 100 * total_dl / total_get
    if (total_drew && total_dl <= total_drew)
      printf "  of everyone whose browser drew the page, %.0f%% went on to install\n", 100 * total_dl / total_drew

    if (sources) {
      n = ranked(by_ref, r)
      printf "\n  where the page traffic came from\n\n"
      for (i = 1; i <= n && i <= 15; i++) printf "    %-46s %6d\n", substr(r[i], 1, 46), by_ref[r[i]]
      external = 0
      for (i = 1; i <= n; i++) if (r[i] !~ /^\(/) external += by_ref[r[i]]
      if (!external) printf "\n    no other site is linking here yet\n"

      n = ranked(by_client, c)
      printf "\n  what asked for it\n\n"
      for (i = 1; i <= n && i <= 15; i++) printf "    %-46s %6d\n", substr(c[i], 1, 46), by_client[c[i]]
    }
  }
' | { echo; echo "  Finestra · last ${DAYS} days${MINE:+ · excluding your own ${MINE}}"; echo; cat; echo; }
