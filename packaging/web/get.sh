#!/usr/bin/env bash
# The one-liner behind the download page:
#
#   curl -fsSL <base>/get.sh | sudo bash
#
# It fetches the current release, checks it against its published SHA-256, and
# hands over to the install.sh inside the tarball — which is the same script
# someone unpacking the tarball by hand would run. Nothing about the install
# itself lives here; this only gets the bytes onto the machine and proves they
# are the right ones.
#
# Piping a script into a root shell deserves the obvious care, so: it is fetched
# over HTTPS from the S3 REST endpoint (the website endpoint is HTTP-only, which
# is why it is not used here), the tarball is verified before anything inside it
# runs, and everything happens under a temporary directory that is removed on
# every exit path.

set -euo pipefail

# Rewritten by publish.sh with the bucket this was published to.
BASE_URL="${WD_BASE_URL:-@@BASE_URL@@}"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo:  curl -fsSL ${BASE_URL}/get.sh | sudo bash"
command -v systemctl >/dev/null || die "this needs systemd"
command -v curl >/dev/null || die "this needs curl"
command -v tar >/dev/null || die "this needs tar"
command -v sha256sum >/dev/null || die "this needs sha256sum (coreutils)"

case "$(uname -m)" in
  x86_64) ;;
  *) die "the published build is x86_64 only; this machine is $(uname -m)" ;;
esac

# A tarball built against a newer glibc will not start, and the failure arrives
# much later and much less clearly than this does. See docs/packaging.md.
#
# Parsed with awk rather than `ldd --version | head -1 | grep …`: `head` closing
# the pipe early kills ldd with SIGPIPE, and under `pipefail` that makes the
# whole pipeline fail *after* grep already matched — so the `|| echo 0` fallback
# appended a second line and the check refused a perfectly good 2.39 machine.
# It is a race, so it refused about one install in two. awk reads its input to
# the end, which is the whole fix.
if command -v ldd >/dev/null; then
  need=2.38
  have="$(ldd --version 2>/dev/null | awk 'NR==1 { print $NF }')"
  case "$have" in
    [0-9]*.[0-9]*)
      if [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | awk 'NR==1')" != "$need" ]; then
        die "this build needs glibc ${need} or newer, and this machine has ${have}.
       Ubuntu 24.04 or newer works; older releases need a build of their own."
      fi
      ;;
    *)
      # Unrecognised output is not evidence of an old machine, and refusing on
      # it would block a valid install. The binary itself fails clearly enough.
      say "could not read the glibc version; continuing"
      ;;
  esac
fi

# Said here rather than at the end, where install.sh prints the tunnel command
# and the tokened URL and deserves the last word. Whoever is watching this
# scroll past is, more often than not, putting Finestra on a machine that
# belongs to a company, and this is the one moment they are certain to be
# looking. A footer on a website is not.
step "Licence"
say "free for personal and internal business use, on as many machines as you like"
say "hosting it as a service or shipping it in a product needs a commercial licence"
say "github.com/carlosbravoa/finestra/blob/main/LICENSE · licensing@finestra.dev"

step "Finding the current release"
# latest.txt names the file rather than a version, so nothing here has to know
# how a version becomes a filename — a rule that already bit once, since S3
# reads a literal "+" in a path as a space and 403s on the miss.
TARBALL="$(curl -fsSL "${BASE_URL}/latest.txt" | tr -d '[:space:]')"
[ -n "$TARBALL" ] || die "could not read ${BASE_URL}/latest.txt"
case "$TARBALL" in
  finestra-*.tar.gz) ;;
  *) die "latest.txt does not name a release: ${TARBALL}" ;;
esac
say "$TARBALL"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step "Downloading"
curl -fL --progress-bar "${BASE_URL}/releases/${TARBALL}" -o "${WORK}/${TARBALL}"
curl -fsSL "${BASE_URL}/releases/${TARBALL}.sha256" -o "${WORK}/${TARBALL}.sha256"
say "$(du -h "${WORK}/${TARBALL}" | cut -f1)"

step "Checking it is the file we published"
# The published .sha256 names the file as it was built; compare the digests
# themselves rather than trusting the filename in it to match our path.
want="$(awk '{print $1}' "${WORK}/${TARBALL}.sha256")"
got="$(sha256sum "${WORK}/${TARBALL}" | awk '{print $1}')"
[ -n "$want" ] || die "the published checksum file is empty"
[ "$want" = "$got" ] || die "checksum mismatch — refusing to install.
       expected $want
       got      $got"
say "sha256 ok"

step "Unpacking"
tar xzf "${WORK}/${TARBALL}" -C "$WORK"
# Found rather than assumed: the directory inside carries the build's own
# version string, which is not always the filename we downloaded.
# -print -quit rather than `| head -1`, for the SIGPIPE-under-pipefail reason
# above: find stops itself instead of being killed for writing to a closed pipe.
DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'finestra-*' -print -quit)"
[ -n "$DIR" ] || die "the tarball did not contain a finestra directory"
[ -x "${DIR}/install.sh" ] || die "the tarball has no install.sh — it may be truncated"

# Hand over, arguments and all: --system-account and friends are answers to a
# question install.sh asks, and someone installing through the one-liner needs
# to be able to answer it in advance —
#
#   curl -fsSL <base>/get.sh | sudo bash -s -- --system-account
#
# install.sh prints the tunnel command and the tokened URL itself, so there is
# deliberately nothing after this.
exec "${DIR}/install.sh" "$@"
