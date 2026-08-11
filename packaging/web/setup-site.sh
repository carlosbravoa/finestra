#!/usr/bin/env bash
# Builds the download site's infrastructure, once, and is safe to re-run.
#
#   packaging/web/setup-site.sh          create or reconcile everything
#   packaging/web/setup-site.sh --show   what exists now
#
# Splitting this out of publish.sh is the point: publishing a release happens
# every build, and creating a CloudFront distribution happens about never. A
# script that did both would spend most of its life checking whether it had
# already done the rare half, which is where idempotence bugs live.
#
# What it makes, on AWS:
#
#   s3://finestra-dl-<account>   private. Only CloudFront may read it.
#   an Origin Access Control     which is how "only CloudFront" is enforced
#   an ACM certificate           in us-east-1, because CloudFront reads them
#                                from nowhere else, whatever region anything
#                                else is in
#   a CloudFront distribution    HTTPS only, aliased to the domain
#   a Route 53 hosted zone       so the apex can ALIAS to the distribution
#
# The apex is why the zone has to live here. `https://finestra.dev` with no
# `www.` needs an ALIAS record, which is a Route 53 thing; a plain CNAME is not
# legal at a zone apex, and a registrar's "forwarding" is an HTTP redirect,
# which cannot serve `curl | sudo bash` honestly. The nameserver change at the
# registrar is the one step nobody can automate — this script prints exactly
# what to paste and then waits to be run again.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

DOMAIN="${WD_SITE_DOMAIN:-finestra.dev}"
BUCKET="${WD_WEB_BUCKET:-finestra-dl-$(aws sts get-caller-identity --query Account --output text 2>/dev/null | tail -c 7)}"
REGION="${WD_WEB_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

# CloudFront's own hosted-zone id. A constant, the same in every account, and
# the thing an ALIAS record at the apex has to point at.
CLOUDFRONT_ZONE_ID="Z2FDTNDATAQYW2"
# Managed-CachingOptimized. Chosen because it *honours the origin's
# Cache-Control*, which is what keeps `no-cache` working on latest.txt — and
# latest.txt is the entire mechanism by which get.sh finds a release. A policy
# that ignored origin headers would break installs a week after a publish, in a
# way that looks like the bucket is fine because the bucket is fine.
CACHE_POLICY_ID="658327ea-f89d-4fab-a63d-7e88639e58f6"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

command -v aws >/dev/null || die "this needs the aws CLI"

# ---------------------------------------------------------------------------
# Finding what is already there. Every lookup is by a stable property — the
# alias, the domain, the bucket name — never by an id written down somewhere.
# ---------------------------------------------------------------------------

find_distribution() {
  aws cloudfront list-distributions \
    --query "DistributionList.Items[?contains(Aliases.Items, '${DOMAIN}')].Id | [0]" \
    --output text 2>/dev/null | grep -v '^None$' || true
}
find_certificate() {
  aws acm list-certificates --region us-east-1 \
    --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn | [0]" \
    --output text 2>/dev/null | grep -v '^None$' || true
}
find_zone() {
  aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN" \
    --query "HostedZones[?Name=='${DOMAIN}.'].Id | [0]" \
    --output text 2>/dev/null | grep -v '^None$' | sed 's|/hostedzone/||' || true
}
find_oac() {
  aws cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='${BUCKET}'].Id | [0]" \
    --output text 2>/dev/null | grep -v '^None$' || true
}
zone_nameservers() {
  aws route53 get-hosted-zone --id "$1" --query 'DelegationSet.NameServers' --output text
}
# Asked of a public resolver before the local one. A workstation that looked the
# domain up before the change holds the old answer for as long as the previous
# NS record's TTL — often a day — so the local cache says "not delegated" long
# after the internet, ACM and CloudFront all agree that it is. The question is
# what the world sees, not what this machine remembers.
live_nameservers() {
  local out
  for resolver in @8.8.8.8 @1.1.1.1 ''; do
    out="$(dig +short NS "$DOMAIN" $resolver 2>/dev/null | sort | tr '\n' ' ')"
    [ -n "$out" ] && { printf '%s' "$out"; return; }
  done
}

if [ "${1:-}" = "--show" ]; then
  printf '  domain        %s\n' "$DOMAIN"
  printf '  bucket        %s\n' "$BUCKET"
  printf '  zone          %s\n' "$(find_zone || echo '(none)')"
  printf '  certificate   %s\n' "$(find_certificate || echo '(none)')"
  printf '  distribution  %s\n' "$(find_distribution || echo '(none)')"
  printf '  nameservers   %s\n' "$(live_nameservers)"
  exit 0
fi

log "domain $DOMAIN, bucket $BUCKET, account $ACCOUNT"

# ---------------------------------------------------------------------------
# The bucket: private, and it stays private
# ---------------------------------------------------------------------------

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  log "bucket exists"
else
  log "creating the bucket"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  fi
fi

# The opposite of what the site used to need. Nothing reads this bucket directly
# any more, so every public-access door is shut and the only way in is the
# distribution — which is also what makes the edge's 403-on-a-miss behaviour
# something we have to handle rather than something we can ignore.
log "closing it to the public — CloudFront reads it, nobody else"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null
aws s3api delete-bucket-website --bucket "$BUCKET" 2>/dev/null || true

# ---------------------------------------------------------------------------
# The certificate. us-east-1 whatever the bucket's region is.
# ---------------------------------------------------------------------------

CERT_ARN="$(find_certificate)"
if [ -z "$CERT_ARN" ]; then
  log "requesting a certificate for ${DOMAIN} and www.${DOMAIN}"
  CERT_ARN="$(aws acm request-certificate --region us-east-1 \
    --domain-name "$DOMAIN" --subject-alternative-names "www.${DOMAIN}" \
    --validation-method DNS --query CertificateArn --output text)"
  # ACM populates the validation records a moment after the request.
  sleep 5
fi
log "certificate $CERT_ARN"
CERT_STATUS="$(aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT_ARN" \
  --query 'Certificate.Status' --output text)"
log "certificate is ${CERT_STATUS}"

# ---------------------------------------------------------------------------
# The hosted zone, and the one thing a human has to do
# ---------------------------------------------------------------------------

ZONE_ID="$(find_zone)"
if [ -z "$ZONE_ID" ]; then
  log "creating the hosted zone for ${DOMAIN}"
  ZONE_ID="$(aws route53 create-hosted-zone --name "$DOMAIN" \
    --caller-reference "finestra-$(date -u +%Y%m%d%H%M%S)" \
    --query 'HostedZone.Id' --output text | sed 's|/hostedzone/||')"
fi
log "hosted zone $ZONE_ID"

WANT_NS="$(zone_nameservers "$ZONE_ID")"
HAVE_NS="$(live_nameservers)"
DELEGATED=1
for ns in $WANT_NS; do
  case " $HAVE_NS " in *" ${ns}. "*|*" ${ns} "*) ;; *) DELEGATED=0 ;; esac
done

if [ "$DELEGATED" = 0 ]; then
  cat >&2 <<NEEDS_DNS

  ${DOMAIN} is not delegated to this hosted zone yet, so nothing below can be
  validated and the certificate cannot be issued.

  At your registrar, replace the nameservers for ${DOMAIN} with these four:

$(for ns in $WANT_NS; do printf '      %s\n' "$ns"; done)

  Delegation usually takes a few minutes and can take a couple of hours. Then
  run this again — it will pick up exactly where it left off.

  Currently answering: ${HAVE_NS:-(nothing)}

NEEDS_DNS
  exit 2
fi
log "delegation is live"

# ---------------------------------------------------------------------------
# The validation record, then the distribution
# ---------------------------------------------------------------------------

upsert_record() {  # upsert_record <json-of-one-ResourceRecordSet>
  aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
    --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":$1}]}" >/dev/null
}

if [ "$CERT_STATUS" != "ISSUED" ]; then
  # EVERY option, not the first. A certificate with a subject alternative name
  # has one validation record per name, and ACM issues nothing until all of them
  # resolve — so writing only [0] produces a certificate that sits in
  # PENDING_VALIDATION forever while the record it is waiting on is one nobody
  # wrote. The two names here often share a zone but never share a record.
  log "writing the DNS validation records"
  wrote=0
  while read -r vname vvalue; do
    [ -n "$vname" ] && [ "$vname" != "None" ] || continue
    upsert_record "{\"Name\":\"${vname}\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"${vvalue}\"}]}"
    say_ns="${vname%%.*}"; log "  ${say_ns}… for $(printf '%s' "$vname" | cut -d. -f2-)"
    wrote=$((wrote + 1))
  done < <(aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT_ARN" \
             --query 'Certificate.DomainValidationOptions[].ResourceRecord.[Name,Value]' --output text)
  [ "$wrote" -gt 0 ] || die "ACM has not published its validation records yet; re-run in a minute"

  # ACM polls DNS on its own schedule; the CLI waiter gives up after about four
  # minutes, which is well inside the range this normally takes. Waited on in a
  # loop instead, and it is safe to interrupt — re-running picks it up.
  log "waiting for the certificate (ACM usually takes a few minutes)"
  for _ in $(seq 1 60); do
    CERT_STATUS="$(aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT_ARN" \
      --query 'Certificate.Status' --output text)"
    [ "$CERT_STATUS" = "ISSUED" ] && break
    case "$CERT_STATUS" in
      FAILED|VALIDATION_TIMED_OUT) die "the certificate ended up ${CERT_STATUS}" ;;
    esac
    sleep 15
  done
  [ "$CERT_STATUS" = "ISSUED" ] || die "the certificate is still ${CERT_STATUS} after 15 minutes; the records are written, so re-running will pick it up"
  log "certificate issued"
fi

OAC_ID="$(find_oac)"
if [ -z "$OAC_ID" ]; then
  log "creating the origin access control"
  OAC_ID="$(aws cloudfront create-origin-access-control \
    --origin-access-control-config "Name=${BUCKET},Description=Finestra downloads,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
    --query 'OriginAccessControl.Id' --output text)"
fi
log "origin access control $OAC_ID"

DIST_ID="$(find_distribution)"
if [ -z "$DIST_ID" ]; then
  log "creating the distribution"
  # ErrorCachingMinTTL=0 on 403 and 404 is not a detail. S3 answers a miss with
  # 403 rather than 404 because the bucket grants no ListBucket, and the edge
  # caches errors for ten seconds by default — so a request that arrives while
  # a publish is mid-upload gets a *cached* 403, and the fix looks like a
  # permissions problem for as long as the TTL lasts.
  DIST_ID="$(aws cloudfront create-distribution --distribution-config "$(cat <<CONFIG
{
  "CallerReference": "finestra-$(date -u +%Y%m%d%H%M%S)",
  "Aliases": {"Quantity": 2, "Items": ["${DOMAIN}", "www.${DOMAIN}"]},
  "DefaultRootObject": "index.html",
  "Origins": {"Quantity": 1, "Items": [{
    "Id": "s3-${BUCKET}",
    "DomainName": "${BUCKET}.s3.${REGION}.amazonaws.com",
    "OriginAccessControlId": "${OAC_ID}",
    "S3OriginConfig": {"OriginAccessIdentity": ""}
  }]},
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-${BUCKET}",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
    "CachePolicyId": "${CACHE_POLICY_ID}",
    "Compress": true
  },
  "CustomErrorResponses": {"Quantity": 2, "Items": [
    {"ErrorCode": 403, "ErrorCachingMinTTL": 0},
    {"ErrorCode": 404, "ErrorCachingMinTTL": 0}
  ]},
  "ViewerCertificate": {
    "ACMCertificateArn": "${CERT_ARN}",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021"
  },
  "Comment": "Finestra downloads",
  "Enabled": true
}
CONFIG
)" --query 'Distribution.Id' --output text)"
fi
DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" \
  --query 'Distribution.DomainName' --output text)"
log "distribution $DIST_ID ($DIST_DOMAIN)"

# The bucket policy names the distribution, so it can only be written once the
# distribution exists. Rewritten every run rather than created once: it is the
# only thing standing between "private bucket" and "public bucket".
log "granting read to that distribution, and to nothing else"
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontRead",
    "Effect": "Allow",
    "Principal": {"Service": "cloudfront.amazonaws.com"},
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${BUCKET}/*",
    "Condition": {"StringEquals": {
      "AWS:SourceArn": "arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST_ID}"
    }}
  }]
}
POLICY
)" >/dev/null

log "pointing ${DOMAIN} at it"
for rec in A AAAA; do
  upsert_record "{\"Name\":\"${DOMAIN}\",\"Type\":\"${rec}\",\"AliasTarget\":{\"HostedZoneId\":\"${CLOUDFRONT_ZONE_ID}\",\"DNSName\":\"${DIST_DOMAIN}\",\"EvaluateTargetHealth\":false}}"
done
upsert_record "{\"Name\":\"www.${DOMAIN}\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"${DOMAIN}\"}]}"

log "waiting for the distribution to finish deploying"
aws cloudfront wait distribution-deployed --id "$DIST_ID" || true

cat <<REPORT

  The site is set up.

  Domain        https://${DOMAIN}
  Bucket        ${BUCKET}  (private; only the distribution can read it)
  Distribution  ${DIST_ID}

  Publish a release onto it with:

      packaging/web/publish.sh [tarball]

REPORT
