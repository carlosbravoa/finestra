#!/usr/bin/env bash
# Builds a release tarball on a throwaway Ubuntu 24.04 instance, and brings it
# back here.
#
# It builds there rather than locally because two of the things we ship are
# native: the compositor, and node-pty (which has no Linux prebuild and so is
# compiled from source). A binary linked against this workstation's glibc 2.43
# will not start on an older LTS, and 24.04 is the oldest we intend to support —
# so that is where the artifacts are made. Everything newer runs them fine; the
# reverse is not true.
#
#   packaging/aws/build.sh [output-dir]

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
source packaging/aws/lib.sh

OUT_DIR="${1:-$REPO/dist-release}"
NODE_MAJOR="${NODE_MAJOR:-22}"
BUILDER_TYPE="${BUILDER_TYPE:-t3.small}"   # 1GB is too little for vite + node-gyp

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.1.0)"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
git diff --quiet 2>/dev/null || SHA="${SHA}-dirty"
FULL_VERSION="${VERSION}+${SHA}"
TARBALL="finestra-${FULL_VERSION}-linux-x64.tar.gz"

log "building finestra ${FULL_VERSION} on ${BUILDER_TYPE} (Ubuntu 24.04)"
wd_ci_init
read -r BUILDER_ID BUILDER_IP <<<"$(wd_ci_launch builder "$BUILDER_TYPE")"
wd_ci_prepare_host "$BUILDER_IP"

# The working tree, not HEAD: this is how you find out whether what you are
# about to commit actually builds.
log "sending the working tree"
tar czf - --exclude=./node_modules --exclude=./.git --exclude='*/node_modules' \
  --exclude=./client/dist --exclude=./server/dist --exclude=./compositor/build \
  --exclude=./dist-release --exclude='*.o' . \
  | wd_ci_ssh "$BUILDER_IP" 'mkdir -p ~/src && tar xzf - -C ~/src'

# ---------------------------------------------------------------------------
# One script, run detached. A dropped connection must not kill a ten-minute
# build, and on a machine that restarts its own services it eventually will.
# ---------------------------------------------------------------------------

REMOTE_SCRIPT=$(mktemp)
cat > "$REMOTE_SCRIPT" <<REMOTE
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
version="${FULL_VERSION}"
major="${NODE_MAJOR}"

# wayland-protocols is deliberately absent: the XML the compositor needs is in
# compositor/protocols/. Adding it back would reintroduce the bug it fixed —
# this series only carries stable/tablet-v2 through an -updates SRU, so the
# build depended on that landing. wayland-scanner comes from libwayland-bin,
# which libwayland-dev already pulls in.
echo "== build dependencies"
sudo apt-get -o DPkg::Lock::Timeout=600 update -qq
sudo apt-get -o DPkg::Lock::Timeout=600 install -y -qq \\
  build-essential pkg-config python3 curl xz-utils \\
  libwayland-dev libxkbcommon-dev zlib1g-dev >/dev/null
echo "   ok"

echo "== the Node runtime we will ship"
ver=\$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c "
import json,sys
rows=[r for r in json.load(sys.stdin)
      if r['version'].startswith('v'+'\${major}'+'.') and r.get('lts')]
print(rows[0]['version'] if rows else '')")
[ -n "\$ver" ] || { echo 'could not resolve a Node LTS release'; exit 1; }
echo "   \$ver"
curl -fsSL "https://nodejs.org/dist/\${ver}/node-\${ver}-linux-x64.tar.xz" -o /tmp/node.tar.xz
sudo rm -rf /opt/node && sudo mkdir -p /opt/node
sudo tar xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
export PATH=/opt/node/bin:\$PATH
node -v

echo "== client, server, compositor"
cd ~/src
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
make -C compositor >/dev/null
test -x compositor/build/wdcomp
echo "   ok"

echo "== production dependencies, compiled against the shipped runtime"
rm -rf ~/prod && mkdir -p ~/prod
python3 - <<'PY'
import json
src = json.load(open('/home/ubuntu/src/server/package.json'))
json.dump({"name": "finestra-runtime", "private": True, "type": "module",
           "dependencies": src["dependencies"]},
          open('/home/ubuntu/prod/package.json', 'w'), indent=2)
PY
cd ~/prod
npm install --omit=dev --no-audit --no-fund --loglevel=error
find node_modules -name '*.node' -printf '   native: %p\\n'

echo "== assembling"
pkg=~/pkg/finestra-\${version}
rm -rf ~/pkg && mkdir -p "\$pkg"/{runtime/bin,app,libexec}
cp /opt/node/bin/node               "\$pkg/runtime/bin/node"
# Node is MIT, and its licence file is also where the notices for everything it
# embeds live — V8, libuv, OpenSSL, ICU, zlib. Carrying it alongside the binary is
# the one redistribution obligation this tarball actually has, and it was missing
# until THIRD-PARTY-NOTICES.md was written and went looking for it.
cp /opt/node/LICENSE                "\$pkg/runtime/LICENSE-node"
cp -a ~/src/server/dist/.           "\$pkg/app/"
cp -a ~/src/client/dist             "\$pkg/app/client"
cp -a ~/prod/node_modules           "\$pkg/app/node_modules"
cp    ~/src/compositor/build/wdcomp "\$pkg/libexec/wdcomp"
cp    ~/src/packaging/install.sh    "\$pkg/install.sh"
# configure.sh and update.sh stay in the install tree after install.sh removes
# itself, so that who-it-runs-as and which-version can both be changed later
# without the tarball they came from.
cp    ~/src/packaging/configure.sh  "\$pkg/configure.sh"
mkdir -p "\$pkg/bin"
cp    ~/src/packaging/finestra       "\$pkg/bin/finestra"
cp    ~/src/packaging/update.sh     "\$pkg/update.sh"
# The terms travel with the install. Someone auditing a machine should be able to
# find out what they may do with what is on it without going to a website.
cp    ~/src/LICENSE                 "\$pkg/LICENSE"
cp    ~/src/LICENSE-COMMERCIAL.md   "\$pkg/LICENSE-COMMERCIAL.md"
cp    ~/src/THIRD-PARTY-NOTICES.md  "\$pkg/THIRD-PARTY-NOTICES.md"
chmod +x "\$pkg/install.sh" "\$pkg/configure.sh" "\$pkg/update.sh" \
         "\$pkg/bin/finestra" "\$pkg/libexec/wdcomp" "\$pkg/runtime/bin/node"

{
  echo "version=\${version}"
  echo "node=\$(/opt/node/bin/node -v)"
  echo "built_on=\$(. /etc/os-release && echo \$PRETTY_NAME)"
  echo "glibc=\$(ldd --version | awk 'NR==1 { print \$NF }')"
  echo "arch=\$(uname -m)"
  echo "built_at=\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "\$pkg/MANIFEST"
cat "\$pkg/MANIFEST"

cd ~/pkg
tar czf "${TARBALL}" "finestra-\${version}"
sha256sum "${TARBALL}" | tee "${TARBALL}.sha256"
du -h "${TARBALL}"
echo "== done"
REMOTE

log "building (detached; survives a dropped connection)"
if ! wd_ci_run_detached "$BUILDER_IP" build "$REMOTE_SCRIPT" 2400; then
  rm -f "$REMOTE_SCRIPT"
  die "the build failed on the builder"
fi
rm -f "$REMOTE_SCRIPT"

mkdir -p "$OUT_DIR"
log "retrieving $TARBALL"
wd_ci_scp_from "$BUILDER_IP" "pkg/${TARBALL}" "$OUT_DIR/$TARBALL"
wd_ci_scp_from "$BUILDER_IP" "pkg/${TARBALL}.sha256" "$OUT_DIR/${TARBALL}.sha256"

log "done: $OUT_DIR/$TARBALL"
echo "$OUT_DIR/$TARBALL"
