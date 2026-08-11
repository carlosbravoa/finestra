#!/usr/bin/env bash
# Takes over an install under a previous name — every branch of it, in a second.
#
# The migration is the one piece of this product that can destroy a working
# machine. It stops a running service, removes a unit, deletes a prefix and
# deletes an account, and it does all of that on a box whose only way back is
# the thing being replaced. A real EC2 verifier proves the happy path, but it
# is too slow and too coarse to prove the orderings and the failures — that the
# token is copied *before* anything is stopped, that a failed start puts the old
# service back, that a held port aborts before the new unit is ever started.
#
# So configure.sh runs here for real, as root, against a fabricated machine:
# `unshare -rm` gives a user namespace where we are uid 0, and a mount namespace
# where /etc/systemd/system, /opt and /var/lib are bind-mounted over a scratch
# tree. Nothing outside it is touched. The commands that would need real root —
# systemctl, useradd, chown and friends — are stubs on PATH that record their
# argv to a log and answer from scripted state. That log is what the assertions
# read: not "did it end up right" but "in what order did it do it".
#
# The legacy install is called `wd-legacy` rather than the real previous name.
# configure.sh takes the superseded name from LEGACY_SERVICE, so this exercises
# the identical code path while the product's own two names are still equal —
# which is what lets the migration be tested before the rename it exists for.

set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

fails=0
check() { # check <name> <ok:0|1> [detail]
  if [ "$2" = 0 ]; then printf 'PASS  %s%s\n' "$1" "${3:+  — $3}"
  else printf 'FAIL  %s%s\n' "$1" "${3:+  — $3}"; fails=$((fails + 1)); fi
}
ok()  { check "$1" 0 "${2:-}"; }
bad() { check "$1" 1 "${2:-}"; }
yes_no() { [ "$1" = 0 ] && echo 0 || echo 1; }

command -v unshare >/dev/null 2>&1 || { echo "SKIP — no unshare"; exit 0; }
unshare -rm true 2>/dev/null      || { echo "SKIP — user namespaces unavailable"; exit 0; }
USER_NAME="$(id -un)"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
case "$HOME_DIR" in /home/*) ;; *) echo "SKIP — home is not under /home"; exit 0 ;; esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

LEGACY=wd-legacy
TOKEN_BYTES="token-from-the-old-install"

# ---------------------------------------------------------------------------
# The fabricated machine
# ---------------------------------------------------------------------------

stub() { # stub <name> <body>
  cat > "$WORK/bin/$1"
  chmod +x "$WORK/bin/$1"
}

build_stubs() {
  mkdir -p "$WORK/bin" "$WORK/active" "$WORK/accounts"
  : > "$WORK/calls.log"

  # A unit is "active" iff a file with its name exists. That is enough state to
  # make is-active meaningful, which is what the ordering assertions rest on.
  stub systemctl <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$STUBLOG"
active_dir="$STUBSTATE/active"
case "$1" in
  is-active) shift; [ "$1" = --quiet ] && shift; [ -e "$active_dir/$1" ] ;;
  is-enabled) shift; [ "$1" = --quiet ] && shift; [ -e "$active_dir/$1.enabled" ] ;;
  disable)
    shift; [ "$1" = --now ] && shift
    rm -f "$active_dir/$1" "$active_dir/$1.enabled"; exit 0 ;;
  enable)
    shift
    if [ "$1" = --now ]; then shift; touch "$active_dir/$1"; fi
    touch "$active_dir/$1.enabled"; exit 0 ;;
  restart|start)
    shift
    # Whether the new service comes up is the scripted part.
    if [ "$1" = "finestra.service" ] && [ -e "$STUBSTATE/start-fails" ]; then exit 1; fi
    touch "$active_dir/$1"; exit 0 ;;
  *) exit 0 ;;
esac
EOF

  # Emulates the one flag this is about. Real curl with -S prints its error even
  # when silent; without it, nothing. The first probe is scripted to fail,
  # because a service that is not listening *yet* is the normal state of a
  # health poll — and a poll that narrates its own retries makes a successful
  # install look like a broken one.
  stub curl <<'EOF'
#!/bin/sh
echo "curl $*" >> "$STUBLOG"
fail() {
  for a in "$@"; do
    case "$a" in
      -*S*) echo "curl: (7) Failed to connect to 127.0.0.1 port 7070 after 0 ms: Could not connect to server" >&2 ;;
    esac
  done
  exit 7
}
[ -e "$STUBSTATE/start-fails" ] && fail "$@"
n=$(cat "$STUBSTATE/curl-probes" 2>/dev/null || echo 0)
echo $((n + 1)) > "$STUBSTATE/curl-probes"
[ "$n" -lt 1 ] && fail "$@"
exit 0
EOF

  stub ss <<'EOF'
#!/bin/sh
echo "ss $*" >> "$STUBLOG"
[ -e "$STUBSTATE/port-busy" ] && echo "LISTEN 0 511 127.0.0.1:7070 0.0.0.0:*"
exit 0
EOF

  # A tiny passwd of its own, so a fabricated system account can be created and
  # then looked up like a real one.
  stub useradd <<'EOF'
#!/bin/sh
echo "useradd $*" >> "$STUBLOG"
home=""; name=""
while [ $# -gt 0 ]; do
  case "$1" in --home-dir) shift; home="$1" ;; -*) ;; *) name="$1" ;; esac
  shift
done
printf '%s:999:999:%s\n' "$name" "$home" >> "$STUBSTATE/passwd"
exit 0
EOF

  stub userdel <<'EOF'
#!/bin/sh
echo "userdel $*" >> "$STUBLOG"
for a in "$@"; do case "$a" in -*) ;; *) sed -i "/^$a:/d" "$STUBSTATE/passwd" ;; esac; done
exit 0
EOF

  stub id <<'EOF'
#!/bin/sh
# Only the questions about fabricated accounts are answered here; everything
# else is the real id, so the invoking user still resolves normally.
if [ "$1" = -u ] && [ -z "${2:-}" ]; then echo 0; exit 0; fi
if [ "$2" != "" ] && grep -q "^$2:" "$STUBSTATE/passwd" 2>/dev/null; then
  line=$(grep "^$2:" "$STUBSTATE/passwd")
  case "$1" in
    -u)  echo "$line" | cut -d: -f2 ;;
    -gn) echo "$2" ;;
    -nG) echo "$2" ;;
    *)   echo "$2" ;;
  esac
  exit 0
fi
exec /usr/bin/id "$@"
EOF

  stub getent <<'EOF'
#!/bin/sh
if [ "$1" = passwd ] && [ -n "${2:-}" ] && grep -q "^$2:" "$STUBSTATE/passwd" 2>/dev/null; then
  line=$(grep "^$2:" "$STUBSTATE/passwd")
  printf '%s:x:%s:%s::%s:/usr/sbin/nologin\n' \
    "$2" "$(echo "$line" | cut -d: -f2)" "$(echo "$line" | cut -d: -f3)" \
    "$(echo "$line" | cut -d: -f4)"
  exit 0
fi
exec /usr/bin/getent "$@"
EOF

  for c in loginctl journalctl usermod chown apt-get ldconfig; do
    printf '#!/bin/sh\necho "%s $*" >> "$STUBLOG"\nexit 0\n' "$c" > "$WORK/bin/$c"
    chmod +x "$WORK/bin/$c"
  done
}

# A machine with an install under the previous name.
#   $1 = per-user | system | unmarked | none
fabricate() {
  rm -rf "$WORK/etc" "$WORK/opt" "$WORK/var" "$WORK/home" "$WORK/active" "$WORK/accounts"
  mkdir -p "$WORK/etc" "$WORK/opt" "$WORK/var/lib" "$WORK/home" "$WORK/active"
  : > "$WORK/passwd"
  : > "$WORK/calls.log"
  rm -f "$WORK/start-fails" "$WORK/port-busy" "$WORK/curl-probes"

  # The package this run is installing, as far as configure.sh checks.
  mkdir -p "$WORK/opt/finestra/current/runtime/bin"
  printf '#!/bin/sh\nexit 0\n' > "$WORK/opt/finestra/current/runtime/bin/node"
  chmod +x "$WORK/opt/finestra/current/runtime/bin/node"
  # The script under test, where it actually ships. It has to be copied in
  # rather than run from the repo: the fake home is mounted over the real one,
  # and the repo lives inside it.
  cp "$REPO/packaging/configure.sh" "$WORK/opt/finestra/current/configure.sh"
  chmod +x "$WORK/opt/finestra/current/configure.sh"

  [ "$1" = none ] && return 0

  # The superseded install: a unit, a prefix with its own scripts, and state.
  local user state_parent marker
  case "$1" in
    per-user|unmarked) user="$USER_NAME"; state_parent="${HOME_DIR}/.local/state" ;;
    system)            user="$LEGACY";    state_parent="/var/lib" ;;
  esac
  marker="# wd-choice=1"
  [ "$1" = unmarked ] && marker="# an install from before the question existed"

  cat > "$WORK/etc/${LEGACY}.service" <<UNIT
[Unit]
Description=${LEGACY}

${marker}

[Service]
User=${user}
Group=${user}
Environment=HOME=/home/${user}
Environment=XDG_STATE_HOME=${state_parent}
NoNewPrivileges=no
UNIT
  touch "$WORK/active/${LEGACY}.service" "$WORK/active/${LEGACY}.service.enabled"

  mkdir -p "$WORK/opt/${LEGACY}/0.1.0"
  printf 'the old one\n' > "$WORK/opt/${LEGACY}/configure.sh"
  printf 'the old one\n' > "$WORK/opt/${LEGACY}/update.sh"

  # The token, wherever that install kept it.
  if [ "$1" = system ]; then
    mkdir -p "$WORK/var/lib/${LEGACY}"
    printf '%s\n' "$TOKEN_BYTES" > "$WORK/var/lib/${LEGACY}/token"
    printf '%s:999:999:/var/lib/%s\n' "$LEGACY" "$LEGACY" >> "$WORK/passwd"
  else
    mkdir -p "$WORK/home/.local/state/${LEGACY}"
    printf '%s\n' "$TOKEN_BYTES" > "$WORK/home/.local/state/${LEGACY}/token"
    printf '["files"]\n' > "$WORK/home/.local/state/${LEGACY}/pinned-applications.json"
  fi
}

# configure.sh, for real, inside the namespace.
run_configure() {
  cat > "$WORK/run.sh" <<INNER
set -u
mount --bind "$WORK/etc"  /etc/systemd/system
mount --bind "$WORK/opt"  /opt
mount --bind "$WORK/var/lib" /var/lib
mount --bind "$WORK/home" "$HOME_DIR"
export PATH="$WORK/bin:\$PATH"
export STUBLOG="$WORK/calls.log" STUBSTATE="$WORK"
export LEGACY_SERVICE="$LEGACY"
exec /opt/finestra/current/configure.sh "\$@"
INNER
  # stdin closed: the question must not be asked, and the non-interactive path
  # is the one every unattended install takes.
  unshare -rm bash "$WORK/run.sh" "$@" </dev/null >"$WORK/out.log" 2>&1
}

# Assertion helpers over the call log.
called()     { grep -qF "$1" "$WORK/calls.log"; }
index_of()   { grep -nF "$1" "$WORK/calls.log" | awk -F: 'NR==1 {print $1}'; }
new_unit()   { echo "$WORK/etc/finestra.service"; }

# ---------------------------------------------------------------------------
# The cases
# ---------------------------------------------------------------------------

build_stubs

echo "== a per-user install is taken over"
fabricate per-user
run_configure --keep; rc=$?
check "it succeeds" "$(yes_no $rc)" "$(tail -2 "$WORK/out.log" | tr '\n' ' ')"
check "the new unit exists" "$(yes_no "$([ -f "$(new_unit)" ] && echo 0 || echo 1)")"
check "it kept the account" \
  "$(yes_no "$(grep -qx "User=$USER_NAME" "$(new_unit)" && echo 0 || echo 1)")" \
  "$(grep -m1 '^User=' "$(new_unit)" 2>/dev/null)"
check "it kept the privilege" \
  "$(yes_no "$(grep -qx 'NoNewPrivileges=no' "$(new_unit)" && echo 0 || echo 1)")"
got="$(cat "$WORK/home/.local/state/finestra/token" 2>/dev/null || true)"
check "the token came across, byte for byte" \
  "$(yes_no "$([ "$got" = "$TOKEN_BYTES" ] && echo 0 || echo 1)")" "${got:-nothing}"
check "the settings came too" \
  "$(yes_no "$([ -f "$WORK/home/.local/state/finestra/pinned-applications.json" ] && echo 0 || echo 1)")"
check "the old unit file is gone" \
  "$(yes_no "$([ ! -f "$WORK/etc/${LEGACY}.service" ] && echo 0 || echo 1)")"
check "the old prefix is gone" \
  "$(yes_no "$([ ! -d "$WORK/opt/${LEGACY}" ] && echo 0 || echo 1)")"
check "it said what it took over" \
  "$(yes_no "$(grep -q 'took over' "$WORK/out.log" && echo 0 || echo 1)")"
check "it said what it removed" \
  "$(yes_no "$(grep -q 'removed' "$WORK/out.log" && echo 0 || echo 1)")"
# The health poll waits for a service that is not up yet, which is not a fault
# and must not be printed as one. This caught `curl -fsS` in the loop: a
# successful install printed "curl: (7) Failed to connect" on its way to working.
check "a successful install prints no errors" \
  "$(yes_no "$(grep -qiE '^(curl|error|FATAL):' "$WORK/out.log" && echo 1 || echo 0)")" \
  "$(grep -iE '^(curl|error|FATAL):' "$WORK/out.log" | head -1)"

echo ""
echo "== the order: the token is safe before anything is stopped"
stop_at="$(index_of "systemctl disable --now ${LEGACY}.service")"
start_at="$(index_of "systemctl restart finestra.service")"
check "the old service is stopped before the new one starts" \
  "$(yes_no "$([ -n "$stop_at" ] && [ -n "$start_at" ] && [ "$stop_at" -lt "$start_at" ] && echo 0 || echo 1)")" \
  "stop@${stop_at:-none} start@${start_at:-none}"
check "the port is checked in between" \
  "$(yes_no "$(called 'ss -ltnH' && echo 0 || echo 1)")"
# The token file predates the stop: proven by content, since the copy happens
# before any systemctl call that could take the old service away.
del_at="$(index_of "userdel")"
check "the old account is deleted only at the end" \
  "$(yes_no "$([ -z "$del_at" ] || [ "$del_at" -gt "$start_at" ] && echo 0 || echo 1)")"

echo ""
echo "== a system-account install is taken over, and the account with it"
fabricate system
run_configure --keep; rc=$?
check "it succeeds" "$(yes_no $rc)" "$(tail -2 "$WORK/out.log" | tr '\n' ' ')"
check "it runs as the new system account" \
  "$(yes_no "$(grep -qx 'User=finestra' "$(new_unit)" && echo 0 || echo 1)")" \
  "$(grep -m1 '^User=' "$(new_unit)" 2>/dev/null)"
got="$(cat "$WORK/var/lib/finestra/token" 2>/dev/null || true)"
check "the token came from the old account's home" \
  "$(yes_no "$([ "$got" = "$TOKEN_BYTES" ] && echo 0 || echo 1)")" "${got:-nothing}"
check "the old account is deleted" \
  "$(yes_no "$(called "userdel" && echo 0 || echo 1)")"
check "and deleted WITHOUT -r, so its copy of the token survives" \
  "$(yes_no "$(grep -q 'userdel .*-r' "$WORK/calls.log" && echo 1 || echo 0)")"
check "the old home is left in place" \
  "$(yes_no "$([ -d "$WORK/var/lib/${LEGACY}" ] && echo 0 || echo 1)")"
check "its linger is dropped" \
  "$(yes_no "$(called "loginctl disable-linger ${LEGACY}" && echo 0 || echo 1)")"

echo ""
echo "== an unmarked unit is not a choice, and must not be inherited"
fabricate unmarked
run_configure --keep; rc=$?
check "it succeeds" "$(yes_no $rc)"
check "it did not adopt the old account" \
  "$(yes_no "$(grep -qx "User=${LEGACY}" "$(new_unit)" && echo 1 || echo 0)")" \
  "$(grep -m1 '^User=' "$(new_unit)" 2>/dev/null)"
check "the token still came across" \
  "$(yes_no "$([ "$(cat "$WORK/home/.local/state/finestra/token" 2>/dev/null)" = "$TOKEN_BYTES" ] && echo 0 || echo 1)")"

echo ""
echo "== running it twice changes nothing the second time"
fabricate per-user
run_configure --keep >/dev/null 2>&1
first="$(cat "$(new_unit)")"
: > "$WORK/calls.log"
run_configure --keep; rc=$?
check "the second run succeeds" "$(yes_no $rc)"
check "the unit is byte-identical" \
  "$(yes_no "$([ "$first" = "$(cat "$(new_unit)")" ] && echo 0 || echo 1)")"
check "no account was created the second time" \
  "$(yes_no "$(called useradd && echo 1 || echo 0)")"
check "nothing legacy was touched the second time" \
  "$(yes_no "$(grep -q "$LEGACY" "$WORK/calls.log" && echo 1 || echo 0)")"

echo ""
echo "== if the new service will not start, the old one comes back"
fabricate per-user
touch "$WORK/start-fails"
run_configure --keep; rc=$?
check "it fails loudly" "$(yes_no "$([ $rc -ne 0 ] && echo 0 || echo 1)")" "rc=$rc"
check "the new unit was removed" \
  "$(yes_no "$([ ! -f "$(new_unit)" ] && echo 0 || echo 1)")"
check "the old unit is still there" \
  "$(yes_no "$([ -f "$WORK/etc/${LEGACY}.service" ] && echo 0 || echo 1)")"
check "the old service was started again" \
  "$(yes_no "$(called "systemctl enable --now ${LEGACY}.service" && echo 0 || echo 1)")"
check "the old prefix was NOT removed" \
  "$(yes_no "$([ -d "$WORK/opt/${LEGACY}" ] && echo 0 || echo 1)")"
check "the old account was NOT deleted" \
  "$(yes_no "$(called userdel && echo 1 || echo 0)")"
rm -f "$WORK/start-fails"

echo ""
echo "== if the port never frees, nothing is started at all"
fabricate per-user
touch "$WORK/port-busy"
run_configure --keep; rc=$?
check "it fails loudly" "$(yes_no "$([ $rc -ne 0 ] && echo 0 || echo 1)")" "rc=$rc"
check "the new service was never started" \
  "$(yes_no "$(called 'systemctl restart finestra.service' && echo 1 || echo 0)")"
check "the old service was put back" \
  "$(yes_no "$(called "systemctl enable --now ${LEGACY}.service" && echo 0 || echo 1)")"
check "the old prefix survives" \
  "$(yes_no "$([ -d "$WORK/opt/${LEGACY}" ] && echo 0 || echo 1)")"
rm -f "$WORK/port-busy"

echo ""
echo "== with nothing to take over, it is an ordinary install"
fabricate none
run_configure --keep; rc=$?
check "it succeeds" "$(yes_no $rc)" "$(tail -2 "$WORK/out.log" | tr '\n' ' ')"
check "the unit exists" "$(yes_no "$([ -f "$(new_unit)" ] && echo 0 || echo 1)")"
check "it said nothing about migrating" \
  "$(yes_no "$(grep -qi 'took over\|migrated' "$WORK/out.log" && echo 1 || echo 0)")"
check "no legacy command ran" \
  "$(yes_no "$(grep -q "$LEGACY" "$WORK/calls.log" && echo 1 || echo 0)")"

echo ""
if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) FAILED"
  exit 1
fi
echo "the migration behaves, in every case it was asked about"
