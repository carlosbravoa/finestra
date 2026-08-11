#!/usr/bin/env bash
# The product's name, where it is load-bearing.
#
# Two failure modes this exists to catch, both of which have happened:
#
#   A half-renamed tree. The name is the systemd unit, the install prefix, the
#   state directory, the tarball, the directory inside the tarball and the
#   bucket. Rename some and not others and the result installs, starts, answers
#   /healthz, and is broken in a way no other test looks at.
#
#   A rename that quietly took the internals with it. `wd:`, `WD_*`, `wd_token`,
#   `WEB_DESKTOP=1` and `# wd-choice=1` are deliberately *not* the product name.
#   Renaming them orphans every stored setting, every existing unit's answer to
#   the who-runs-as question, and any .bashrc that tests for the environment.
#
# It reads files rather than running anything, so it costs nothing and runs in
# the ordinary suite.

set -uo pipefail
cd "$(dirname "$0")/.."

# The one place the expected identity is written down. Change these together
# with the code, in the same commit — that is what makes the flip atomic.
SERVICE_NAME="finestra"
STATE_LEAF="finestra"
# Deliberately the old one: the server has to keep finding a state directory
# written before the rename, or an upgrade rotates the token silently.
PREVIOUS_STATE_LEAF="web-desktop"

fails=0
check() { # check <name> <condition-result> [detail]
  if [ "$2" = "0" ]; then
    printf 'PASS  %s%s\n' "$1" "${3:+  — $3}"
  else
    printf 'FAIL  %s%s\n' "$1" "${3:+  — $3}"
    fails=$((fails + 1))
  fi
}
# grep -c rather than a pipeline into wc: a match count of 0 must be a value,
# not a failed pipeline under a shell that may be running with pipefail.
has() { grep -qF -- "$2" "$1"; }
says() { # says <name> <file> <literal>
  has "$2" "$3" && check "$1" 0 || check "$1" 1 "$2 does not contain: $3"
}

echo "-- identity, one name in every place that installs it"
says "configure.sh names the service"        packaging/configure.sh "SERVICE_NAME=\"${SERVICE_NAME}\""
says "configure.sh derives the unit name"    packaging/configure.sh 'UNIT_NAME="${SERVICE_NAME}.service"'
says "configure.sh derives the prefix"       packaging/configure.sh 'PREFIX="${PREFIX:-/opt/${SERVICE_NAME}}"'
says "configure.sh derives the state leaf"   packaging/configure.sh 'STATE_LEAF="${SERVICE_NAME}"'
says "install.sh installs to that prefix"    packaging/install.sh "/opt/${SERVICE_NAME}"
says "install.sh targets that unit"          packaging/install.sh "/etc/systemd/system/${SERVICE_NAME}.service"
says "update.sh targets that unit"           packaging/update.sh "UNIT=\"${SERVICE_NAME}.service\""
says "update.sh installs to that prefix"     packaging/update.sh "/opt/${SERVICE_NAME}"
says "build.sh names the tarball"            packaging/aws/build.sh "TARBALL=\"${SERVICE_NAME}-"
says "build.sh names the inner directory"    packaging/aws/build.sh "pkg=~/pkg/${SERVICE_NAME}-"
says "get.sh expects that tarball"           packaging/web/get.sh "${SERVICE_NAME}-*.tar.gz"
says "get.sh expects that inner directory"   packaging/web/get.sh "-name '${SERVICE_NAME}-*'"
says "update.sh expects that inner directory" packaging/update.sh "-name '${SERVICE_NAME}-*'"
says "publish.sh names the bucket"           packaging/web/publish.sh "${SERVICE_NAME}-dl-"
# The command a person types is the product's name too, and it is a symlink
# into the install: rename one without the other and it points nowhere.
says "the command is named for the product"  packaging/install.sh "/usr/local/bin/${SERVICE_NAME}"
says "and points at the current install"     packaging/install.sh "current/bin/${SERVICE_NAME}"
says "the package carries it"                packaging/aws/build.sh "bin/${SERVICE_NAME}"
says "publish.sh strips that prefix"         packaging/web/publish.sh "VERSION=\"\${NAME#${SERVICE_NAME}-}\""

echo ""
echo "-- the state leaf: the server and the installer must agree"
says "the server appends the leaf"           server/src/config.ts "const STATE_LEAF = '${STATE_LEAF}'"
says "the server can still find the old one" server/src/config.ts "const PREVIOUS_STATE_LEAF = '${PREVIOUS_STATE_LEAF}'"

echo ""
echo "-- there is one definition of where state lives, and everyone asks it"
says "configure.sh answers --state-dir"      packaging/configure.sh '--state-dir)      STATE_DIR_QUERY=1'
says "install.sh asks it"                    packaging/install.sh 'configure.sh" --state-dir'
says "update.sh asks it"                     packaging/update.sh 'configure.sh" --state-dir'
says "verify.sh asks it"                     packaging/aws/verify.sh 'configure.sh --state-dir'
says "verify-update.sh asks it"              packaging/aws/verify-update.sh 'configure.sh --state-dir'
# Nobody re-derives it. This is the check that would have caught the five copies.
strays=$(grep -rln "XDG_STATE_HOME=//p" packaging/ | grep -v 'packaging/configure.sh' || true)
check "nobody re-derives it from the unit" "$([ -z "$strays" ] && echo 0 || echo 1)" "${strays:-none}"

echo ""
echo "-- the internals are NOT the product name, and must not be renamed with it"
says "the localStorage prefix"               client/src/core/settings.ts "const PREFIX = 'wd:'"
says "the token key"                         client/src/main.ts "const TOKEN_KEY = 'wd:token'"
says "the session cookie"                    server/src/auth.ts "TOKEN_COOKIE = 'wd_token'"
says "the PTY environment marker"            server/src/services/pty.ts "WEB_DESKTOP: '1'"
says "the compositor binary"                 compositor/Makefile '$(BUILD)/wdcomp'
says "the relay ticket header"               server/src/outbound.ts "x-wd-ticket"
says "the CI namespace"                      packaging/aws/lib.sh "wd_ci_launch"

echo ""
echo "-- the choice marker is frozen: it must match units written before a rename"
says "the writer"                            packaging/configure.sh '${CHOICE_MARKER}'
says "the matcher"                           packaging/configure.sh 'grep -qxF "$CHOICE_MARKER"'
says "the literal, unchanged"                packaging/configure.sh 'CHOICE_MARKER="# wd-choice=1"'

echo ""
echo "-- the migration must not be tidied away"
says "it knows the unit it supersedes"       packaging/configure.sh 'LEGACY_UNIT='
says "it knows the prefix it supersedes"     packaging/configure.sh 'LEGACY_PREFIX='
says "it knows the leaf it supersedes"       packaging/configure.sh 'LEGACY_LEAF='

echo ""
if [ "$fails" -gt 0 ]; then
  echo "$fails name check(s) FAILED"
  exit 1
fi
echo "every name is where it should be"
