#!/usr/bin/env bash
# Points the old download site at the new one, without breaking anything that
# already exists.
#
#   packaging/web/retire-web-desktop.sh
#
# Run this AFTER https://finestra.dev serves a release. It refuses to run before
# that, because its whole effect is to send people there.
#
# What it does, and what it deliberately does not:
#
#   get.sh          becomes a shim that says so and execs the new installer, so
#                   a one-liner someone copied months ago still does the right
#                   thing rather than installing a product that no longer exists
#   index.html      becomes a short notice pointing at finestra.dev
#   get-web-desktop.sh   is left exactly as it was — the real pre-rename
#                   installer, kept so that packaging/aws/verify-migrate.sh has
#                   a genuine old install to migrate from, and so the previous
#                   product can still be reproduced
#   latest.txt      untouched
#   releases/*      untouched — an already-installed update.sh still resolves
#                   them, which is the escape hatch if a migration goes wrong
#
# The bucket stays. It costs a few dollars a year and removes an entire class of
# "the URL in my notes 404s".

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

OLD_BUCKET="${WD_OLD_BUCKET:-web-desktop-dl-$(aws sts get-caller-identity --query Account --output text 2>/dev/null | tail -c 7)}"
OLD_REGION="${WD_OLD_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
OLD_BASE="https://${OLD_BUCKET}.s3.${OLD_REGION}.amazonaws.com"
NEW_BASE="${WD_SITE_DOMAIN:+https://${WD_SITE_DOMAIN}}"
NEW_BASE="${NEW_BASE:-https://finestra.dev}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

log "old ${OLD_BASE}"
log "new ${NEW_BASE}"

# See publish.sh: this machine's resolver is not the internet's, and a stale
# answer here would make this refuse to run against a site that is up.
NEW_HOST="${NEW_BASE#https://}"; NEW_HOST="${NEW_HOST%%/*}"
NEW_IP="$(dig +short "$NEW_HOST" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' | head -1)"
RESOLVE=()
[ -n "$NEW_IP" ] && RESOLVE=(--resolve "${NEW_HOST}:443:${NEW_IP}")

# Refuse to send anyone somewhere that does not answer yet.
curl -fsS --max-time 30 ${RESOLVE+"${RESOLVE[@]}"} -o /dev/null "${NEW_BASE}/get.sh" \
  || die "${NEW_BASE}/get.sh does not answer — publish there first"
curl -fsS --max-time 30 ${RESOLVE+"${RESOLVE[@]}"} "${NEW_BASE}/latest.txt" | grep -q 'finestra-.*\.tar\.gz' \
  || die "${NEW_BASE}/latest.txt does not name a release"
log "the new site is serving; proceeding"

# The real installer, kept. Copied only if it is not already there, so re-runs
# cannot overwrite it with the shim written below.
if aws s3 ls "s3://${OLD_BUCKET}/get-web-desktop.sh" >/dev/null 2>&1; then
  log "the pre-rename installer is already preserved"
else
  log "preserving the pre-rename installer as get-web-desktop.sh"
  aws s3 cp "s3://${OLD_BUCKET}/get.sh" "s3://${OLD_BUCKET}/get-web-desktop.sh" \
    --content-type "text/x-shellscript; charset=utf-8" --cache-control "no-cache" --only-show-errors
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A shim, not a redirect: curl follows redirects, but what is being piped into
# root's shell should say out loud that it changed name before it does anything.
cat > "$WORK/get.sh" <<SHIM
#!/usr/bin/env bash
# web desktop is now Finestra. This forwards to the current installer.
set -euo pipefail
echo "web desktop is now Finestra — fetching the current installer from ${NEW_BASE}" >&2
echo "(the previous installer is still at ${OLD_BASE}/get-web-desktop.sh)" >&2
curl -fsSL "${NEW_BASE}/get.sh" | bash -s -- "\$@"
SHIM
bash -n "$WORK/get.sh" || die "the shim does not parse"

cat > "$WORK/index.html" <<PAGE
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>web desktop is now Finestra</title>
<style>
  body { margin:0; padding:0 20px 80px; background:#0b0e13; color:#dfe4ec;
         font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  @media (prefers-color-scheme: light) { body { background:#f6f8fb; color:#1d2530; } }
  main { max-width:640px; margin:0 auto; padding-top:96px; }
  h1 { font-size:32px; letter-spacing:-.02em; margin:0 0 14px; }
  p { color:#99a3b3; }
  a { color:#6c9dff; }
  pre { padding:16px 20px; background:#12161d; border:1px solid #2a3240; border-radius:10px;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13.5px;
        white-space:pre-wrap; overflow-wrap:anywhere; }
  @media (prefers-color-scheme: light) { pre { background:#fff; border-color:#c6cfdb; } }
</style>
</head>
<body><main>
  <h1>web desktop is now Finestra</h1>
  <p>Same product, same install, a name of its own. It lives at
     <a href="${NEW_BASE}">${NEW_BASE}</a>.</p>
  <pre>curl -fsSL ${NEW_BASE}/get.sh | sudo bash</pre>
  <p>Running web desktop already? That command takes the install over rather
     than installing beside it: the access token, the settings and the answer to
     who it runs as all survive, so a bookmarked URL keeps working. If the new
     service does not come up, the old one is put back untouched.</p>
  <p>Releases published under the old name are still here, and an installed
     <code>update.sh</code> still resolves them.</p>
</main></body>
</html>
PAGE

log "uploading the notice and the shim"
aws s3 cp "$WORK/index.html" "s3://${OLD_BUCKET}/index.html" \
  --content-type "text/html; charset=utf-8" --cache-control "no-cache" --only-show-errors
aws s3 cp "$WORK/get.sh" "s3://${OLD_BUCKET}/get.sh" \
  --content-type "text/x-shellscript; charset=utf-8" --cache-control "no-cache" --only-show-errors

log "checking what someone with the old link now gets"
fails=0
body="$(curl -fsSL --max-time 30 "${OLD_BASE}/get.sh" || true)"
printf '%s' "$body" | grep -q "now Finestra" && printf '  PASS  the old get.sh forwards\n' \
  || { printf '  FAIL  the old get.sh forwards\n'; fails=$((fails+1)); }
printf '%s' "$body" | grep -qF "${NEW_BASE}/get.sh" && printf '  PASS  it names the new installer\n' \
  || { printf '  FAIL  it names the new installer\n'; fails=$((fails+1)); }
curl -fsSL --max-time 30 "${OLD_BASE}/index.html" | grep -q "now Finestra" \
  && printf '  PASS  the old page says so\n' \
  || { printf '  FAIL  the old page says so\n'; fails=$((fails+1)); }
curl -fsS --max-time 30 -o /dev/null "${OLD_BASE}/get-web-desktop.sh" \
  && printf '  PASS  the pre-rename installer is still there\n' \
  || { printf '  FAIL  the pre-rename installer is still there\n'; fails=$((fails+1)); }
curl -fsSL --max-time 30 "${OLD_BASE}/latest.txt" | grep -q 'web-desktop-' \
  && printf '  PASS  the old latest.txt is untouched\n' \
  || { printf '  FAIL  the old latest.txt is untouched\n'; fails=$((fails+1)); }

[ "$fails" -eq 0 ] || { log "FAILED ($fails)"; exit 1; }
log "done — the old site points at the new one"
