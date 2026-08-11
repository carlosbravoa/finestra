#!/usr/bin/env bash
# Publishes a release and its download page to the site.
#
#   packaging/web/publish.sh [path-to-tarball]
#
# Uploads four things into a private bucket that only CloudFront can read:
#
#   /index.html                      the page
#   /get.sh                          the one-liner installer
#   /latest.txt                      the file get.sh resolves
#   /releases/<tarball>[.sha256]     the release itself
#
# One address, https://finestra.dev, for the page and for everything inside it.
# It used to be two — an HTTP-only website endpoint for the page and the HTTPS
# REST endpoint for anything piped into a root shell — which worked but asked
# every reader to notice the difference. The domain is on the HSTS preload
# list, so plaintext is not merely redirected, it is refused by the browser
# before a request is made.
#
# This creates no infrastructure. packaging/web/setup-site.sh owns the bucket,
# the certificate and the distribution, and this refuses to run without them.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
HERE="$REPO/packaging/web"

BUCKET="${WD_WEB_BUCKET:-finestra-dl-$(aws sts get-caller-identity --query Account --output text 2>/dev/null | tail -c 7)}"
REGION="${WD_WEB_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

TARBALL="${1:-$(ls -1t "$REPO"/dist-release/finestra-*-linux-x64.tar.gz 2>/dev/null | awk 'NR==1')}"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "no tarball; run packaging/aws/build.sh first"
[ -f "${TARBALL}.sha256" ] || die "no ${TARBALL}.sha256 beside the tarball"

NAME="$(basename "$TARBALL")"
VERSION="${NAME#finestra-}"; VERSION="${VERSION%-linux-x64.tar.gz}"
SHA="$(awk '{print $1}' "${TARBALL}.sha256")"
BUILT="$(date -u +%Y-%m-%d)"

# Published under a URL-safe name. A build version is `0.1.0+<sha>`, and S3
# reads a literal "+" in a path as a space — so the obvious URL misses the key
# and comes back 403 (403, not 404, because the bucket does not grant
# ListBucket). Percent-encoding would work and would break the moment anyone
# copied the URL by hand, so the "+" simply does not reach a URL.
#
# CloudFront changes nothing about this. It decodes and re-encodes the path on
# the way to the origin, so a literal "+" still reaches S3 as a space — the
# edge just puts one more hop between the mistake and the 403. The "+" does not
# reach a URL, and that is still the whole fix.
SAFE_NAME="${NAME//+/-}"

case "$VERSION" in
  *-dirty) log "WARNING: publishing a -dirty build (uncommitted changes at build time)" ;;
esac

DOMAIN="${WD_SITE_DOMAIN:-finestra.dev}"
BASE="https://${DOMAIN}"

# Resolved by alias, never by an id written down anywhere. Its absence is the
# one thing this script refuses to fix: creating a distribution is setup-site's
# job, and doing it here by accident is how a second one gets created.
DIST_ID="$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Aliases.Items, '${DOMAIN}')].Id | [0]" \
  --output text 2>/dev/null | grep -v '^None$' || true)"
[ -n "$DIST_ID" ] || die "no CloudFront distribution serves ${DOMAIN} — run packaging/web/setup-site.sh first"

log "site     $BASE (distribution $DIST_ID)"
log "bucket   $BUCKET ($REGION)"
log "release  $VERSION"

# ---------------------------------------------------------------------------
# The files
# ---------------------------------------------------------------------------

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The page and the installer are templates; substitute with a delimiter that
# cannot appear in a URL or a hex digest.
sed -e "s|@@BASE_URL@@|${BASE}|g" \
    -e "s|@@VERSION@@|${VERSION}|g" \
    -e "s|@@TARBALL@@|${SAFE_NAME}|g" \
    -e "s|@@SHA256@@|${SHA}|g" \
    -e "s|@@BUILT@@|${BUILT}|g" \
    "$HERE/index.html" > "$WORK/index.html"
sed -e "s|@@BASE_URL@@|${BASE}|g" "$HERE/get.sh" > "$WORK/get.sh"

# latest.txt names the file, not the version, so get.sh needs no rule for
# turning one into the other.
printf '%s\n' "$SAFE_NAME" > "$WORK/latest.txt"

# The checksum file as built names the original file; rewrite it against the
# published name so `sha256sum -c` works for someone downloading by hand.
printf '%s  %s\n' "$SHA" "$SAFE_NAME" > "$WORK/${SAFE_NAME}.sha256"

grep -q '@@' "$WORK/index.html" && die "a placeholder survived in index.html"
grep -q '@@' "$WORK/get.sh"     && die "a placeholder survived in get.sh"
bash -n "$WORK/get.sh" || die "the templated get.sh does not parse"

log "uploading the release ($(du -h "$TARBALL" | cut -f1)) as ${SAFE_NAME}"
aws s3 cp "$TARBALL" "s3://${BUCKET}/releases/${SAFE_NAME}" \
  --content-type application/gzip --only-show-errors
aws s3 cp "$WORK/${SAFE_NAME}.sha256" "s3://${BUCKET}/releases/${SAFE_NAME}.sha256" \
  --content-type text/plain --only-show-errors

SHOT="$REPO/docs/finestra-screenshot.png"
if [ -f "$SHOT" ]; then
  # A year's cache, because the page references it by a fixed name and the
  # invalidation below is what makes a replacement take effect — cheaper than
  # re-downloading half a megabyte on every visit to a page that is itself
  # deliberately uncacheable.
  log "uploading the screenshot ($(du -h "$SHOT" | cut -f1))"
  aws s3 cp "$SHOT" "s3://${BUCKET}/screenshot.png" \
    --content-type image/png --cache-control "public, max-age=31536000" --only-show-errors
else
  log "WARNING: ${SHOT} is missing; the page will show a broken image"
fi

log "uploading the page"
# no-cache on the three small files: the whole point of latest.txt is that it
# changes, and a cached copy would keep pointing at a release that is no longer
# current. The tarballs are immutable and named by version, so they are not.
aws s3 cp "$WORK/index.html" "s3://${BUCKET}/index.html" \
  --content-type "text/html; charset=utf-8" --cache-control "no-cache" --only-show-errors
aws s3 cp "$WORK/get.sh" "s3://${BUCKET}/get.sh" \
  --content-type "text/x-shellscript; charset=utf-8" --cache-control "no-cache" --only-show-errors
aws s3 cp "$WORK/latest.txt" "s3://${BUCKET}/latest.txt" \
  --content-type "text/plain; charset=utf-8" --cache-control "no-cache" --only-show-errors

# ---------------------------------------------------------------------------
# The edge
# ---------------------------------------------------------------------------
# Only the three that change. Releases are immutable and arrive under new keys,
# so invalidating them would spend the 1000-path monthly allowance on nothing.
#
# The wait is not optional. Without it the checks below race the edge, and the
# way that fails is not a red run — it is a green one, against the *previous*
# latest.txt, which is the single object that must never be stale.
log "invalidating the three files that change"
INV_ID="$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
  --paths /index.html /get.sh /latest.txt /screenshot.png \
  --query 'Invalidation.Id' --output text)"
aws cloudfront wait invalidation-completed --distribution-id "$DIST_ID" --id "$INV_ID"

# ---------------------------------------------------------------------------
# Prove it is actually reachable, rather than assuming the upload means served
# ---------------------------------------------------------------------------

# Checked the way a stranger reaches it, not the way this machine resolves it.
# A workstation that looked the domain up before it moved holds the old answer
# for the length of the previous record's TTL — often a day — so publishing from
# here reported seven failures against a site that was serving perfectly. The
# reverse is worse: a stale answer pointing somewhere that happens to respond
# would let a broken publish pass.
SITE_IP="$(dig +short "$DOMAIN" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' | head -1)"
RESOLVE=()
if [ -n "$SITE_IP" ]; then
  RESOLVE=(--resolve "${DOMAIN}:443:${SITE_IP}" --resolve "${DOMAIN}:80:${SITE_IP}")
  log "checking against ${SITE_IP}, which is what the internet resolves ${DOMAIN} to"
else
  log "could not resolve ${DOMAIN} independently; checking through this machine's resolver"
fi

log "checking what a stranger would get"
fails=0
check() { # check <name> <url> <expected-substring>
  local body
  body="$(curl -fsSL --max-time 30 ${RESOLVE+"${RESOLVE[@]}"} "$2" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -qF "$3"; then
    printf '  PASS  %s\n' "$1"
  else
    printf '  FAIL  %s  (%s)\n' "$1" "$2"; fails=$((fails+1))
  fi
}
check "latest.txt names the published file" "${BASE}/latest.txt" "$SAFE_NAME"
check "get.sh is served"                    "${BASE}/get.sh"     "checksum mismatch"
check "get.sh knows its own base url"       "${BASE}/get.sh"     "$BASE"
# The installer is where the licence reaches the person putting this on a
# company machine, and it went missing once without anyone noticing: the copy in
# the repository was wrong while the copy being published came from a different
# tree that was right, so every check passed until the two swapped places.
# Asserting against what is *served* is the only version of this check that
# could have caught it.
check "get.sh names the licence"            "${BASE}/get.sh"     "licensing@finestra.dev"
check "the page is served"                  "${BASE}/"           "$VERSION"
check "the page links the published file"   "${BASE}/"           "$SAFE_NAME"
check "the checksum names the published file" "${BASE}/releases/${SAFE_NAME}.sha256" "$SAFE_NAME"

# A binary, so the substring check above cannot speak for it: ask for the first
# bytes and look for PNG's own signature rather than trusting a 200.
shot="$(curl -fsS --max-time 30 ${RESOLVE+"${RESOLVE[@]}"} -r 0-7 "${BASE}/screenshot.png" 2>/dev/null | head -c 8 | od -An -tx1 | tr -d ' \n')"
if [ "$shot" = "89504e470d0a1a0a" ]; then
  printf '  PASS  the screenshot is served\n'
else
  printf '  FAIL  the screenshot is served  (got %s)\n' "${shot:-nothing}"; fails=$((fails+1))
fi

# Plain HTTP must not serve this. A one-liner piped into a root shell over a
# connection anyone can rewrite is the whole reason the site moved.
redirect="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 ${RESOLVE+"${RESOLVE[@]}"} "http://${DOMAIN}/get.sh" 2>/dev/null || echo 000)"
case "$redirect" in
  30*) printf '  PASS  http is redirected to https  (%s)\n' "$redirect" ;;
  *)   printf '  FAIL  http is redirected to https  (HTTP %s)\n' "$redirect"; fails=$((fails+1)) ;;
esac

# The URL exactly as the page prints it, since a "+" reaching a path is the
# specific way this broke before. -o /dev/null without -f so a 403 is reported
# as 403 rather than as curl's exit status.
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 60 -r 0-1023 ${RESOLVE+"${RESOLVE[@]}"} \
        "${BASE}/releases/${SAFE_NAME}" 2>/dev/null || echo 000)"
if [ "$code" = "206" ] || [ "$code" = "200" ]; then
  printf '  PASS  the tarball downloads\n'
else
  printf '  FAIL  the tarball downloads  (HTTP %s)\n' "$code"; fails=$((fails+1))
fi

echo
if [ "$fails" -ne 0 ]; then
  log "PUBLISHED, BUT $fails CHECK(S) FAILED"
  exit 1
fi

cat <<REPORT
  Published $VERSION

  Page      $BASE
  Install   curl -fsSL ${BASE}/get.sh | sudo bash

REPORT
log "done"
