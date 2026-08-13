#!/usr/bin/env bash
# What can reach an installed Finestra, proved on a real machine with a real
# systemd — and proved from OUTSIDE it.
#
#   packaging/multipass/verify-reach.sh            build if needed, then check
#   packaging/multipass/verify-reach.sh --rebuild  rebuild the package first
#   packaging/multipass/verify-reach.sh --clean    delete the VM and stop
#
# This exists alongside packaging/aws/verify.sh rather than inside it, because
# of one thing EC2 structurally cannot do here. The verifier's security group
# allows nothing but SSH, so the instance can only curl its *own* address —
# which tells you the socket is not on loopback, but never that another machine
# can open the desktop. A multipass VM sits on a bridge this workstation can
# route to, so `--bind 0.0.0.0` is measured from a second machine instead of
# inferred from `ss` output. It also costs nothing and needs no credentials.
#
# The package is built inside the VM for the same reason build.sh builds on
# EC2: node-pty and wdcomp are native, and a binary linked against this
# workstation's glibc will not start on the LTS we ship for.
#
# Two things this script got wrong on its first run, both worth keeping in
# mind when adding a check — neither was a fault in the product, and both
# reported a correct behaviour as a failure:
#
#   * `curl -w '%{http_code}'` already prints 000 when the connection is
#     refused. A `|| echo 000` on top of it appends a second one, and every
#     comparison against "000" then fails on exactly the runs that behaved.
#   * `something | grep -q x` under `set -o pipefail` reports failure even when
#     x matched: grep exits at the first match, the writer dies of SIGPIPE, and
#     the pipeline takes the writer's status. Use a here-string. This is the
#     same bite CLAUDE.md records for `cmd | head -1`, and it is easy to write
#     again in a hurry.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"

VM="${VM:-finestra-reach}"
NODE_MAJOR="${NODE_MAJOR:-22}"
# Not the real version. This package never leaves the VM, and a number that
# cannot be confused with a release is the point — plus the update check below
# needs a second, higher one to update *to*.
VERSION="${VERSION:-0.0.0+reach}"
NEXT_VERSION="0.0.1+reach"

fails=0
check() { if [ "$2" = 0 ]; then printf 'PASS  %s%s\n' "$1" "${3:+  — $3}"
          else printf 'FAIL  %s%s\n' "$1" "${3:+  — $3}"; fails=$((fails+1)); fi }
yn()    { [ "$1" = 0 ] && echo 0 || echo 1; }
head1() { printf '\n\033[1m%s\033[0m\n' "$*"; }
log()   { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()   { printf '\nerror: %s\n' "$*" >&2; exit 1; }

command -v multipass >/dev/null || die "this needs multipass (snap install multipass)"

REBUILD=""
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --clean)   multipass delete --purge "$VM" 2>/dev/null; echo "removed $VM"; exit 0 ;;
    -h|--help) sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "unknown option: $arg" ;;
  esac
done

# Everything below runs commands in the VM through these. Note the </dev/null:
# without it multipass hands the VM this script's stdin, and the first command
# that reads (install.sh asking its question) swallows the rest of the script.
vm()  { multipass exec "$VM" -- bash -c "$1" </dev/null 2>&1; }
vmq() { multipass exec "$VM" -- bash -c "$1" </dev/null >/dev/null 2>&1; }
# From this workstation, across the bridge, to the VM. No `|| echo` — see above.
code() { curl -s -m 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }
body() { curl -s -m 5 "$1" 2>/dev/null; }

# ---------------------------------------------------------------------------
# The machine
# ---------------------------------------------------------------------------

if ! multipass info "$VM" >/dev/null 2>&1; then
  log "launching $VM (Ubuntu 24.04)"
  multipass launch 24.04 --name "$VM" --cpus 2 --memory 4G --disk 20G || die "could not launch $VM"
  REBUILD=1
elif [ "$(multipass info "$VM" --format csv | awk -F, 'NR==2 { print $2 }')" != Running ]; then
  log "starting $VM"
  multipass start "$VM" || die "could not start $VM"
fi

# A package from an earlier run is reused unless asked otherwise: the build is
# ten minutes and the checks are one, and iterating on the checks is the common
# case.
vmq "test -d ~/pkg/finestra-${VERSION}" || REBUILD=1

if [ -n "$REBUILD" ]; then
  log "sending the working tree"
  # The tree, not HEAD — this is how you find out whether what you are about to
  # commit actually behaves.
  tar czf - --exclude=./node_modules --exclude=./.git --exclude='*/node_modules' \
    --exclude=./client/dist --exclude=./server/dist --exclude=./compositor/build \
    --exclude=./dist-release --exclude='*.o' . \
    | multipass exec "$VM" -- bash -c 'rm -rf ~/src && mkdir -p ~/src && tar xzf - -C ~/src' \
    || die "could not send the working tree"

  log "building the package in the VM"
  multipass exec "$VM" -- bash -s <<REMOTE || die "the build failed in the VM"
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
export WD_VERSION="${VERSION}"
version="${VERSION}"

echo "== build dependencies"
sudo apt-get -o DPkg::Lock::Timeout=600 update -qq
sudo apt-get -o DPkg::Lock::Timeout=600 install -y -qq \\
  build-essential pkg-config python3 curl xz-utils \\
  libwayland-dev libxkbcommon-dev zlib1g-dev >/dev/null

echo "== the Node runtime we will ship"
ver=\$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c "
import json,sys
rows=[r for r in json.load(sys.stdin)
      if r['version'].startswith('v'+'${NODE_MAJOR}'+'.') and r.get('lts')]
print(rows[0]['version'] if rows else '')")
[ -n "\$ver" ] || { echo 'could not resolve a Node LTS release'; exit 1; }
echo "   \$ver"
curl -fsSL "https://nodejs.org/dist/\${ver}/node-\${ver}-linux-x64.tar.xz" -o /tmp/node.tar.xz
sudo rm -rf /opt/node && sudo mkdir -p /opt/node
sudo tar xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
export PATH=/opt/node/bin:\$PATH

echo "== client, server, compositor"
cd ~/src
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
make -C compositor >/dev/null
test -x compositor/build/wdcomp

echo "== production dependencies, compiled against the shipped runtime"
rm -rf ~/prod && mkdir -p ~/prod
python3 - <<'PY'
import json
src = json.load(open('/home/ubuntu/src/server/package.json'))
json.dump({"name": "finestra-runtime", "private": True, "type": "module",
           "dependencies": src["dependencies"]},
          open('/home/ubuntu/prod/package.json', 'w'), indent=2)
PY
cd ~/prod && npm install --omit=dev --no-audit --no-fund --loglevel=error

echo "== assembling"
pkg=~/pkg/finestra-\${version}
rm -rf ~/pkg && mkdir -p "\$pkg"/{runtime/bin,app,libexec,bin}
cp /opt/node/bin/node               "\$pkg/runtime/bin/node"
cp /opt/node/LICENSE                "\$pkg/runtime/LICENSE-node"
cp -a ~/src/server/dist/.           "\$pkg/app/"
cp -a ~/src/client/dist             "\$pkg/app/client"
cp -a ~/prod/node_modules           "\$pkg/app/node_modules"
cp    ~/src/compositor/build/wdcomp "\$pkg/libexec/wdcomp"
cp    ~/src/packaging/install.sh    "\$pkg/install.sh"
cp    ~/src/packaging/configure.sh  "\$pkg/configure.sh"
cp    ~/src/packaging/update.sh     "\$pkg/update.sh"
cp    ~/src/packaging/finestra      "\$pkg/bin/finestra"
cp    ~/src/LICENSE                 "\$pkg/LICENSE"
cp    ~/src/LICENSE-COMMERCIAL.md   "\$pkg/LICENSE-COMMERCIAL.md"
cp    ~/src/THIRD-PARTY-NOTICES.md  "\$pkg/THIRD-PARTY-NOTICES.md"
chmod +x "\$pkg/install.sh" "\$pkg/configure.sh" "\$pkg/update.sh" \\
         "\$pkg/bin/finestra" "\$pkg/libexec/wdcomp" "\$pkg/runtime/bin/node"
{
  echo "version=\${version}"
  echo "node=\$(/opt/node/bin/node -v)"
  echo "built_on=\$(. /etc/os-release && echo \$PRETTY_NAME)"
  # \$NF, not \\\$NF: this heredoc is unquoted, so one backslash is what makes
  # the remote script see a literal $. Two made awk read an escape and print
  # nothing, and the MANIFEST said `glibc=` with no number after it.
  echo "glibc=\$(ldd --version | awk 'NR==1 { print \$NF }')"
  echo "arch=\$(uname -m)"
} > "\$pkg/MANIFEST"
cat "\$pkg/MANIFEST"

# The update check below needs something newer to update *to*. Same bits, one
# number higher: what is being tested is the health check under a non-loopback
# bind, not anything about the contents.
rm -rf ~/pkg2 && mkdir -p ~/pkg2
cp -a "\$pkg" ~/pkg2/finestra-${NEXT_VERSION}
sed -i 's/^version=.*/version=${NEXT_VERSION}/' ~/pkg2/finestra-${NEXT_VERSION}/MANIFEST
cd ~/pkg2 && tar czf finestra-${NEXT_VERSION}-linux-x64.tar.gz finestra-${NEXT_VERSION}
echo "== build done"
REMOTE
fi

IP="$(multipass info "$VM" --format csv | awk -F, 'NR==2 { print $3 }')"
[ -n "$IP" ] || die "$VM has no address"
PKG="/home/ubuntu/pkg/finestra-${VERSION}"
echo ""
echo "  VM      $VM at $IP"
echo "  here    $(hostname)"

# ---------------------------------------------------------------------------
head1 "1. A default install — loopback and a token"
# --user ubuntu with stdin closed: the unattended path a scripted install takes.
vm "cd $PKG && sudo ./install.sh --user ubuntu" > /tmp/wd-reach-install.log 2>&1
check "install.sh succeeds" "$(yn $?)" \
  "$(grep -iE '^error|did not start' /tmp/wd-reach-install.log | head -1)"
check "the service is active" "$(yn "$(vmq 'systemctl is-active --quiet finestra'; echo $?)")"
check "the unit binds loopback" \
  "$(yn "$(vmq 'grep -qx Environment=WD_HOST=127.0.0.1 /etc/systemd/system/finestra.service'; echo $?)")" \
  "$(vm 'grep -m1 ^Environment=WD_HOST= /etc/systemd/system/finestra.service')"
check "it answers on its own loopback" \
  "$(yn "$(vmq 'curl -sf -o /dev/null http://127.0.0.1:7070/healthz'; echo $?)")"
c="$(code "http://$IP:7070/healthz")"
check "and THIS MACHINE cannot reach it at all" \
  "$(yn "$([ "$c" = 000 ] && echo 0 || echo 1)")" "http $c from $(hostname)"

# ---------------------------------------------------------------------------
head1 "2. --bind 0.0.0.0 --no-token — the trusted-network install"
vm 'sudo /opt/finestra/current/configure.sh --bind 0.0.0.0 --no-token' > /tmp/wd-reach-open.log 2>&1
check "configure.sh succeeds" "$(yn $?)" \
  "$(grep -iE '^error|did not start' /tmp/wd-reach-open.log | head -1)"
check "it warned rather than refusing" \
  "$(yn "$(grep -q 'every interface' /tmp/wd-reach-open.log && echo 0 || echo 1)")"
check "the socket is on 0.0.0.0" \
  "$(yn "$(vmq 'ss -ltnH "sport = :7070" | grep -q "0\.0\.0\.0:7070"'; echo $?)")" \
  "$(vm 'ss -ltnH "sport = :7070"' | tr -s ' ')"
c="$(code "http://$IP:7070/healthz")"
check "THIS MACHINE reaches /healthz" "$(yn "$([ "$c" = 200 ] && echo 0 || echo 1)")" "http $c"
c="$(code "http://$IP:7070/api/session")"
check "THIS MACHINE is let in with no token" "$(yn "$([ "$c" = 200 ] && echo 0 || echo 1)")" "http $c"
check "and the session really says ok" \
  "$(yn "$(grep -q '"ok":true' <<<"$(body "http://$IP:7070/api/session")" && echo 0 || echo 1)")"
c="$(code "http://$IP:7070/")"
check "THIS MACHINE is served the desktop itself" "$(yn "$([ "$c" = 200 ] && echo 0 || echo 1)")" "http $c"
check "--show admits what it opened" \
  "$(yn "$(grep -q 'every interface' <<<"$(vm 'sudo /opt/finestra/current/configure.sh --show')" && echo 0 || echo 1)")"

# ---------------------------------------------------------------------------
head1 "3. A routine upgrade must not close it"
# The property that matters more than the flag: someone who opened this months
# ago must not lose it to an upgrade, in the one place nothing explains it.
vm "cd $PKG && sudo ./install.sh" > /tmp/wd-reach-reinstall.log 2>&1
check "a plain reinstall succeeds" "$(yn $?)"
check "the unit is still open" \
  "$(yn "$(vmq 'grep -qx Environment=WD_HOST=0.0.0.0 /etc/systemd/system/finestra.service'; echo $?)")" \
  "$(vm 'grep -m1 ^Environment=WD_HOST= /etc/systemd/system/finestra.service')"
check "the token is still off" \
  "$(yn "$(vmq 'grep -qx Environment=WD_NO_AUTH=1 /etc/systemd/system/finestra.service'; echo $?)")"
c="$(code "http://$IP:7070/api/session")"
check "THIS MACHINE still gets in afterwards" "$(yn "$([ "$c" = 200 ] && echo 0 || echo 1)")" "http $c"

# ---------------------------------------------------------------------------
head1 "4. One address only — what a loopback health check would have killed"
# configure.sh health-checks the service it just started. Against a hardcoded
# http://127.0.0.1:7070/healthz this bind answers nothing, so a working install
# reports "the service did not start" and, mid-migration, rolls itself back.
vm "sudo /opt/finestra/current/configure.sh --bind $IP --token" > /tmp/wd-reach-one.log 2>&1
check "configure.sh survives a non-loopback bind" "$(yn $?)" \
  "$(grep -iE 'did not start|^error' /tmp/wd-reach-one.log | head -1)"
check "the socket is on that address alone" \
  "$(yn "$(vmq "ss -ltnH 'sport = :7070' | grep -q '$IP:7070'"; echo $?)")" \
  "$(vm 'ss -ltnH "sport = :7070"' | tr -s ' ')"
vmq 'curl -sf -m 3 -o /dev/null http://127.0.0.1:7070/healthz'
check "while its own loopback answers nothing" "$(yn "$([ $? -ne 0 ] && echo 0 || echo 1)")" \
  "which is exactly why the health check had to follow the bind"
check "--health-url names that address" \
  "$(yn "$([ "$(vm '/opt/finestra/current/configure.sh --health-url' | tr -d '\r')" = "http://$IP:7070/healthz" ] && echo 0 || echo 1)")" \
  "$(vm '/opt/finestra/current/configure.sh --health-url')"
c="$(code "http://$IP:7070/api/session")"
check "THIS MACHINE is refused without a token" "$(yn "$([ "$c" = 401 ] && echo 0 || echo 1)")" "http $c"
TOK="$(vm 'sudo cat /home/ubuntu/.local/state/finestra/token' | tr -d '\r')"
c="$(code "http://$IP:7070/api/session?t=$TOK")"
check "and accepted with one" "$(yn "$([ "$c" = 200 ] && echo 0 || echo 1)")" "http $c"

# ---------------------------------------------------------------------------
head1 "5. update.sh, while bound to that address"
# The health check's other caller, with the same trap and a worse consequence:
# an update that worked, rolled back because loopback did not answer.
vm "sudo /opt/finestra/current/update.sh ~/pkg2/finestra-${NEXT_VERSION}-linux-x64.tar.gz" \
  > /tmp/wd-reach-update.log 2>&1
check "update.sh succeeds against a non-loopback bind" "$(yn $?)" \
  "$(grep -iE 'rolled back|did not|^error' /tmp/wd-reach-update.log | head -1)"
check "it did not roll back" \
  "$(yn "$(grep -qiE 'rolling back|rolled back' /tmp/wd-reach-update.log && echo 1 || echo 0)")"
check "the new version is the one running" \
  "$(yn "$(grep -q "$NEXT_VERSION" <<<"$(vm 'readlink -f /opt/finestra/current')" && echo 0 || echo 1)")" \
  "$(vm 'readlink -f /opt/finestra/current')"
check "the bind survived the update" \
  "$(yn "$(vmq "grep -qx Environment=WD_HOST=$IP /etc/systemd/system/finestra.service"; echo $?)")"
c="$(code "http://$IP:7070/healthz")"
check "THIS MACHINE still reaches it" "$(yn "$([ "$c" = 200 ] && echo 0 || echo 1)")" "http $c"

# ---------------------------------------------------------------------------
head1 "6. A drop-in still wins, and must be said out loud"
# What someone reached for before --bind existed. systemctl edit writes it, it
# is merged after the unit, and it wins — so reporting what was just written
# would report a bind that is not in force, and health-check the wrong address.
vm 'sudo mkdir -p /etc/systemd/system/finestra.service.d && \
    printf "[Service]\nEnvironment=WD_HOST=0.0.0.0\n" \
    | sudo tee /etc/systemd/system/finestra.service.d/override.conf' >/dev/null 2>&1
vm 'sudo /opt/finestra/current/configure.sh --bind local' > /tmp/wd-reach-dropin.log 2>&1
check "configure.sh succeeds anyway" "$(yn $?)"
check "the unit records what was asked for" \
  "$(yn "$(vmq 'grep -qx Environment=WD_HOST=127.0.0.1 /etc/systemd/system/finestra.service'; echo $?)")"
check "but it says the drop-in overrides it" \
  "$(yn "$(grep -q 'something else sets WD_HOST=0.0.0.0' /tmp/wd-reach-dropin.log && echo 0 || echo 1)")"
c="$(code "http://$IP:7070/healthz")"
check "and the drop-in is what took effect" "$(yn "$([ "$c" = 200 ] && echo 0 || echo 1)")" \
  "http $c from here, though the unit says loopback"
check "the drop-in file was left alone" \
  "$(yn "$(vmq 'test -f /etc/systemd/system/finestra.service.d/override.conf'; echo $?)")"

# ---------------------------------------------------------------------------
head1 "7. Closing it again"
vm 'sudo rm -rf /etc/systemd/system/finestra.service.d && sudo systemctl daemon-reload' >/dev/null 2>&1
vm 'sudo /opt/finestra/current/configure.sh --bind local --token' > /tmp/wd-reach-close.log 2>&1
check "configure.sh succeeds" "$(yn $?)" \
  "$(grep -iE 'did not start|^error' /tmp/wd-reach-close.log | head -1)"
c="$(code "http://$IP:7070/healthz")"
check "THIS MACHINE is shut out again" "$(yn "$([ "$c" = 000 ] && echo 0 || echo 1)")" "http $c"
check "it still answers on its own loopback" \
  "$(yn "$(vmq 'curl -sf -o /dev/null http://127.0.0.1:7070/healthz'; echo $?)")"
vmq 'curl -sf -o /dev/null http://127.0.0.1:7070/api/session'
check "and a token is required again" "$(yn "$([ $? -ne 0 ] && echo 0 || echo 1)")"
check "the same token as before, so bookmarks still work" \
  "$(yn "$(vmq "curl -sf -o /dev/null 'http://127.0.0.1:7070/api/session?t=$TOK'"; echo $?)")"

echo ""
if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) FAILED — the VM is left running; multipass shell $VM"
  exit 1
fi
echo "what can reach it behaves, on a real machine, checked from another one"
echo "  multipass stop $VM     # when you are done"
echo "  $0 --clean   # and to get the disk back"
