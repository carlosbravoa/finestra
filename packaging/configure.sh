#!/usr/bin/env bash
# Chooses who Finestra runs as, writes the systemd unit, and restarts it.
# Ships inside the install, so the choice can be changed at any time without
# the tarball it was installed from:
#
#   sudo /opt/finestra/current/configure.sh              ask
#   sudo /opt/finestra/current/configure.sh --show       what it is now
#        /opt/finestra/current/configure.sh --state-dir  where its state lives
#   sudo /opt/finestra/current/configure.sh --as-me      run as you, with sudo
#   sudo /opt/finestra/current/configure.sh --as-me --no-privilege
#   sudo /opt/finestra/current/configure.sh --user NAME  some other account
#   sudo /opt/finestra/current/configure.sh --system-account
#
# install.sh hands over to this with --keep, which means "if a choice is already
# recorded, keep it" — an upgrade must not re-ask a question that was answered.
# Run by hand, with no flags, it asks: changing the answer is the whole point.
#
# This is separate from install.sh for a plain reason: install.sh takes itself
# out of the install tree (it is what removes that tree, and a script cannot
# safely delete the file it is being read from), so nothing it contains can be
# run again later. Everything that might need changing after the fact lives
# here instead.

set -euo pipefail

# What this install is called, in one place each. The unit name is derived from
# the service name rather than written twice, because the two literal copies of
# it are exactly what went stale last time something moved.
SERVICE_NAME="finestra"
UNIT_NAME="${SERVICE_NAME}.service"
UNIT="/etc/systemd/system/${UNIT_NAME}"
PREFIX="${PREFIX:-/opt/${SERVICE_NAME}}"
SYSTEM_ACCOUNT="${SERVICE_NAME}"
# The leaf the server appends to XDG_STATE_HOME (server/src/config.ts). The unit
# carries only the parent, so these two must agree or the token moves and every
# bookmarked URL stops working.
STATE_LEAF="${SERVICE_NAME}"
# The port the unit binds. Named here because the migration has to wait for
# it to be free between the old service stopping and the new one starting.
PORT="${PORT:-7070}"

# Where a system account keeps its state, and where every install kept it before
# the desktop learned to run as a person. Still read, to carry the token forward
# — see "Carrying the old state over" below.
LEGACY_STATE="/var/lib/${SERVICE_NAME}"

# The install this one supersedes, if it is on the machine. Overridable so the
# sandbox harness can point them at a fabricated tree; see tests/install-sandbox.sh.
LEGACY_SERVICE="${LEGACY_SERVICE:-web-desktop}"
LEGACY_UNIT="${LEGACY_UNIT:-/etc/systemd/system/${LEGACY_SERVICE}.service}"
LEGACY_PREFIX="${LEGACY_PREFIX:-/opt/${LEGACY_SERVICE}}"
LEGACY_ACCOUNT="${LEGACY_ACCOUNT:-${LEGACY_SERVICE}}"
LEGACY_LEAF="${LEGACY_LEAF:-${LEGACY_SERVICE}}"
LEGACY_SYSTEM_HOME="${LEGACY_SYSTEM_HOME:-/var/lib/${LEGACY_SERVICE}}"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# Empty means "not chosen on the command line", which is what lets --keep keep
# whatever the installed unit already says.
WANT_USER=""
WANT_PRIVILEGE=""
KEEP=""
SHOW=""
STATE_DIR_QUERY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --keep)           KEEP=1 ;;
    --show)           SHOW=1 ;;
    --state-dir)      STATE_DIR_QUERY=1 ;;
    --as-me)          WANT_USER="${SUDO_USER:-}"
                      [ -n "$WANT_USER" ] || die "--as-me needs sudo from a login account; use --user NAME" ;;
    --user)           shift; WANT_USER="${1:-}"; [ -n "$WANT_USER" ] || die "--user needs a name" ;;
    --user=*)         WANT_USER="${1#--user=}" ;;
    --system-account) WANT_USER="$SYSTEM_ACCOUNT"; WANT_PRIVILEGE="no" ;;
    --privilege)      WANT_PRIVILEGE="yes" ;;
    --no-privilege)   WANT_PRIVILEGE="no" ;;
    -h|--help)        sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                die "unknown option: $1" ;;
  esac
  shift
done

# The environment variable the earlier installer used still works, so a machine
# that scripted it keeps installing the same way.
WANT_USER="${WANT_USER:-${SERVICE_USER:-}}"

# ---------------------------------------------------------------------------
# What is installed now
# ---------------------------------------------------------------------------
# Only a unit carrying the marker counts as an answer, and that distinction
# matters. Every install made before this question existed says
# `User=web-desktop` because it had no alternative, not because anyone decided —
# treating those as a decision would preserve the fault this exists to fix, on
# exactly the machines that have it.
#
# Each of these is read into `x="$(...)"`, and a failed command substitution ends
# the script under `set -e` — so "nothing was recorded" has to be a successful
# answer of nothing, not a non-zero exit.
#
# The marker string is frozen. It has to keep matching a unit written by an
# older version — including one written under a different product name — so it
# is deliberately not derived from anything above.
CHOICE_MARKER="# wd-choice=1"

# All of these take the unit to read, because after a rename there are two: the
# one this version writes and the one it is taking over from.
unit_field() {  # <unit> <Key>
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | awk 'NR==1'
}
unit_env() {    # <unit> <ENVKEY>
  [ -f "$1" ] || return 0
  sed -n "s/^Environment=$2=//p" "$1" | awk 'NR==1'
}
choice_recorded_in()     { [ -f "$1" ] && grep -qxF "$CHOICE_MARKER" "$1"; }
installed_user_in()      { choice_recorded_in "$1" || return 0; unit_field "$1" User; }
installed_privilege_in() {
  choice_recorded_in "$1" || return 0
  if grep -q '^NoNewPrivileges=no$' "$1"; then echo yes; else echo no; fi
}
# The leaf is a parameter, not a literal. The unit records only the parent, and
# after a rename the leaf this version writes and the leaf the old install used
# are different words — a helper that hardcoded one of them would look correct
# and quietly fail to find the token it was written to find.
state_dir_in() {  # <unit> <leaf>
  local parent
  parent="$(unit_env "$1" XDG_STATE_HOME)"
  [ -n "$parent" ] || return 0
  printf '%s/%s\n' "$parent" "$2"
}

choice_recorded()    { choice_recorded_in "$UNIT"; }
installed_user()     { installed_user_in "$UNIT"; }
installed_privilege() { installed_privilege_in "$UNIT"; }
# Unlike the two above this reads any unit, marker or not: an upgrade from
# before the question existed still has to find the token it left behind.
installed_state_dir() { state_dir_in "$UNIT" "$STATE_LEAF"; }

# The one implementation of "where does this install keep its state", so that
# install.sh, update.sh and the verifiers ask rather than each re-deriving it.
# Before the root check on purpose: reading a unit needs no privilege.
if [ -n "$STATE_DIR_QUERY" ]; then
  dir="$(installed_state_dir)"
  [ -n "$dir" ] || exit 1
  printf '%s\n' "$dir"
  exit 0
fi

if [ -n "$SHOW" ]; then
  [ -f "$UNIT" ] || die "nothing is installed at ${UNIT}"
  now_user="$(unit_field "$UNIT" User)"
  if grep -q '^NoNewPrivileges=no$' "$UNIT"; then now_priv="with privilege"; else now_priv="unprivileged"; fi
  step "${SERVICE_NAME} runs as ${now_user}, ${now_priv}"
  say "home   $(unit_env "$UNIT" HOME)"
  say "state  $(installed_state_dir)"
  say "chosen $(choice_recorded && echo 'at install time' || echo 'before this was a question — run this with no flags to choose')"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "run this with sudo"
command -v systemctl >/dev/null || die "this needs systemd"
[ -x "${PREFIX}/current/runtime/bin/node" ] || die "no installation at ${PREFIX}/current"

# ---------------------------------------------------------------------------
# An install under the previous name
# ---------------------------------------------------------------------------
# Everything here reads; nothing is changed until the new service has answered
# /healthz. That ordering is the whole design: the old install is the fallback,
# so it is the last thing removed and the first thing put back.
#
# While the two names are the same — which is the case until the rename lands —
# there is no legacy install by definition, every branch below is skipped, and
# this file behaves exactly as it did before.

LEGACY_DISTINCT=0
if [ "$LEGACY_UNIT" != "$UNIT" ]; then LEGACY_DISTINCT=1; fi
legacy_present() {
  [ "$LEGACY_DISTINCT" = 1 ] || return 1
  [ -f "$LEGACY_UNIT" ] || [ -d "$LEGACY_PREFIX" ]
}

LEGACY_USER=""
LEGACY_PRIV=""
LEGACY_STATE_DIR=""
LEGACY_WAS_RUNNING=0
TOOK_OVER=()
REMOVED=()
LEFT=()

if legacy_present; then
  step "Found an install under the previous name"
  LEGACY_STATE_DIR="$(state_dir_in "$LEGACY_UNIT" "$LEGACY_LEAF")"
  LEGACY_PRIV="$(installed_privilege_in "$LEGACY_UNIT")"
  systemctl is-active --quiet "${LEGACY_SERVICE}.service" && LEGACY_WAS_RUNNING=1 || true

  # The account it ran as, translated only when it was actually chosen. An
  # unmarked `User=<old system account>` means nobody ever chose — it is the
  # fault the marker exists to record the absence of — so carrying it would
  # reinstall the observability-only product on exactly the machines that were
  # never asked. Marker absent: say nothing, and let the question be asked.
  legacy_user="$(installed_user_in "$LEGACY_UNIT")"
  if [ -n "$legacy_user" ]; then
    if [ "$legacy_user" = "$LEGACY_ACCOUNT" ]; then
      LEGACY_USER="$SYSTEM_ACCOUNT"
    else
      LEGACY_USER="$legacy_user"
    fi
  fi

  say "${LEGACY_SERVICE}.service$([ "$LEGACY_WAS_RUNNING" = 1 ] && echo ' (running)' || echo ' (stopped)')"
  [ -n "$LEGACY_STATE_DIR" ] && say "state ${LEGACY_STATE_DIR}" || true
  [ -n "$LEGACY_USER" ] && say "runs as ${legacy_user}, which is a choice worth keeping" || true
fi

# ---------------------------------------------------------------------------
# Who it runs as
# ---------------------------------------------------------------------------
# This is the whole product decision, so it is asked rather than assumed.
#
# A desktop is the account it runs as. Running as a system account with no home
# directory and no groups leaves something that can draw windows over a machine
# it cannot read: no home to open or upload into, an empty journal, and every
# privileged action refused. That is a defensible thing to install — it is
# observability — but it is not what most people are installing, and the earlier
# default quietly picked it for everyone.
#
# Running as the person installing it grants nothing new. Reaching the port
# means reaching loopback, which means already holding an SSH session as that
# same account; the desktop can do what that session can do and no more. That is
# the same reasoning the shared token rests on — see docs/packaging.md.

step "Who the desktop runs as"

# Whoever is installing this, as best as it can be told. sudo says so directly;
# logname asks the controlling terminal, which survives `su`; failing both, the
# ordinary account on the machine, which on a cloud image is the only one.
default_user() {
  local u
  for u in "${SUDO_USER:-}" "$(logname 2>/dev/null || true)"; do
    if [ -n "$u" ] && [ "$u" != root ] && id -u "$u" >/dev/null 2>&1; then
      printf '%s\n' "$u"; return
    fi
  done
  u="$(getent passwd \
       | awk -F: '$3 >= 1000 && $3 < 65534 && $6 ~ /^\/home\// { print $3" "$1 }' \
       | sort -n | awk 'NR==1 { print $2 }')"
  printf '%s\n' "${u:-$SYSTEM_ACCOUNT}"
}

SERVICE_USER="$WANT_USER"
PRIVILEGE="$WANT_PRIVILEGE"

# --keep is what makes an upgrade quiet: someone who locked this down months ago
# will not remember an option they passed once, and must not have it undone by a
# routine upgrade. Without --keep — this run by hand — the recorded answer is
# only a starting point, because changing it is why anyone runs this.
if [ -n "$KEEP" ]; then
  [ -n "$SERVICE_USER" ] || SERVICE_USER="$(installed_user)"
  [ -n "$PRIVILEGE" ]    || PRIVILEGE="$(installed_privilege)"
  # Only after the new unit has had its say. That ordering is what makes a
  # second run idempotent: once this install has recorded an answer of its own,
  # the superseded one stops being consulted.
  if [ -z "$SERVICE_USER" ] && [ -n "$LEGACY_USER" ]; then
    SERVICE_USER="$LEGACY_USER"
    TOOK_OVER+=("the recorded choice: runs as ${SERVICE_USER}")
  fi
  [ -n "$PRIVILEGE" ]    || PRIVILEGE="$LEGACY_PRIV"
  if [ -z "$WANT_USER" ] && [ -z "$WANT_PRIVILEGE" ] && [ -n "$SERVICE_USER" ]; then
    say "keeping the choice this machine already made"
  fi
fi

# Ask, but only when there is someone to ask and nothing has answered already.
# `curl | sudo bash` leaves stdin at the end of the script it is reading, so the
# question goes to the terminal directly or not at all.
#
# Opened rather than tested with `-r`: /dev/tty is a 0666 device node, so a test
# for readability passes even where there is no terminal behind it — an install
# driven over `ssh host bash -s` would print a menu to a log and answer it
# itself. Opening it is the only thing that distinguishes the two.
if [ -z "$SERVICE_USER" ] && { : </dev/tty; } 2>/dev/null; then
  ME="$(default_user)"
  if [ -f "$UNIT" ]; then
    say "now: $(sed -n 's/^User=//p' "$UNIT" | awk 'NR==1')$(grep -q '^NoNewPrivileges=no$' "$UNIT" && echo ', with privilege' || echo ', unprivileged')"
  fi
  cat >/dev/tty <<MENU

    1) ${ME} — you.  Your home directory, the journal, and sudo: the same
       reach as the SSH session you are typing this in.  Nothing more.
    2) ${ME}, without privilege.  Your home directory and the journal, but
       nothing that needs root — no sudo in the terminal, no managing units.
    3) ${SYSTEM_ACCOUNT} — a system account with no home and no login.
       The journal and read-only browsing: observability, and nothing else.

MENU
  printf '  choose [1]: ' >/dev/tty
  read -r answer </dev/tty || answer=""
  case "${answer:-1}" in
    1) SERVICE_USER="$ME";             PRIVILEGE="yes" ;;
    2) SERVICE_USER="$ME";             PRIVILEGE="no"  ;;
    3) SERVICE_USER="$SYSTEM_ACCOUNT"; PRIVILEGE="no"  ;;
    *) die "not one of the choices: $answer" ;;
  esac
fi

# Nobody to ask: install what the question defaults to, and say so loudly enough
# that an unattended install is not a silent one.
if [ -z "$SERVICE_USER" ]; then
  SERVICE_USER="$(default_user)"
  say "nothing to ask on, so: running as ${SERVICE_USER}"
  [ -n "$PRIVILEGE" ] || say "re-run this with --system-account or --no-privilege to lock it down"
fi
# Last, and only for whatever is still unanswered: an explicit --no-privilege
# must survive both branches above.
[ -n "$PRIVILEGE" ] || PRIVILEGE="yes"

# A system account is created on demand; any other name must already exist,
# because inventing an account someone half-remembered is how a desktop ends up
# with a home directory nobody meant to give it.
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  [ "$SERVICE_USER" = "$SYSTEM_ACCOUNT" ] || die "no such account: ${SERVICE_USER}"
  useradd --system --home-dir "$LEGACY_STATE" --create-home \
          --shell /usr/sbin/nologin --comment "${SERVICE_NAME}" "$SERVICE_USER"
  id -u "$SERVICE_USER" >/dev/null 2>&1 || die "could not create ${SERVICE_USER}"
  say "created the system account ${SERVICE_USER}"
fi

SERVICE_UID="$(id -u "$SERVICE_USER")"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
HOME_DIR="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
[ -n "$HOME_DIR" ] || die "${SERVICE_USER} has no home directory in passwd"
say "user ${SERVICE_USER} (uid ${SERVICE_UID}), home ${HOME_DIR}"
if [ "$PRIVILEGE" = "yes" ]; then
  say "privileged: sudo works in the terminal, and units can be managed"
else
  say "unprivileged: no sudo, no unit management, and a read-only /usr and /etc"
fi

# ---------------------------------------------------------------------------
# Directories
# ---------------------------------------------------------------------------
# State goes where the XDG spec already puts it, so the server needs no special
# case: config.ts reads XDG_STATE_HOME and appends its own name. For a real
# account that is ~/.local/state/finestra; for the system account, whose home
# is /var/lib/finestra, it stays exactly where it has always been.

step "Directories"
if [ "$SERVICE_USER" = "$SYSTEM_ACCOUNT" ]; then
  STATE_HOME="${STATE_PARENT:-/var/lib}"
else
  STATE_HOME="${STATE_PARENT:-${HOME_DIR}/.local/state}"
fi
STATE_DIR="${STATE_HOME}/${STATE_LEAF}"

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"
chown "$SERVICE_USER:$SERVICE_GROUP" "$STATE_DIR"
# mkdir -p makes the parents as root, and a ~/.local the account cannot write to
# breaks far more than this product. Only walk up inside the account's own home:
# for the system account the state directory *is* the home, and there is nothing
# above it that should change hands.
case "$STATE_DIR" in
  "${HOME_DIR%/}"/*)
    d="$(dirname "$STATE_DIR")"
    while [ "$d" != "${HOME_DIR%/}" ] && [ "$d" != "/" ]; do
      chown "$SERVICE_USER:$SERVICE_GROUP" "$d"
      d="$(dirname "$d")"
    done
    ;;
esac
say "state $STATE_DIR"

# Carrying the old state over. The token is in a bookmark and in an open tab, so
# moving the state directory must not invalidate it — that would read as the
# change breaking the login. Only the files this product wrote are taken; the
# rest of an old system account's home is not ours to copy.
#
# The order is most-specific first, and every entry earns its place:
#   this install's own previous directory  — a reinstall that moved accounts
#   the superseded install's directory     — read out of its unit; the per-user
#                                            case, which is the common one
#   the superseded system account's home   — for units written before the
#                                            question existed, which carry no
#                                            XDG_STATE_HOME line at all
#   this install's system-account home     — a re-run after a partial migration
PREVIOUS_STATE="$(installed_state_dir)"
for src in "$PREVIOUS_STATE" "$LEGACY_STATE_DIR" "$LEGACY_SYSTEM_HOME" "$LEGACY_STATE"; do
  [ -n "$src" ] && [ "$src" != "$STATE_DIR" ] && [ -e "${src}/token" ] || continue
  [ -e "${STATE_DIR}/token" ] && break
  for f in token last-good disabled-apps.json pinned-applications.json; do
    # The `|| true` is not decoration: a missing last file makes the loop's exit
    # status non-zero, and `set -e` would end the run there.
    [ -e "${src}/${f}" ] && cp -p "${src}/${f}" "${STATE_DIR}/${f}" || true
  done
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$STATE_DIR"
  TOOK_OVER+=("the access token and settings from ${src}")
  say "carried the token and settings over from ${src}"
  break
done

# The log viewer reads the whole journal, not one unit's, and that is a group
# membership rather than a permission the service can ask for. An ordinary
# account on a cloud image is already in adm and this changes nothing; a system
# account is in nothing at all, and without this its log viewer opens empty.
#
# Matched with `case` rather than `id -nG | grep -q`: grep exits on the first
# match and closes the pipe, `id` dies of SIGPIPE, and under `pipefail` the
# pipeline reports failure even though the match succeeded — which would read as
# "not a member" for every account that already is one.
case " $(id -nG "$SERVICE_USER") " in
  *" adm "* | *" systemd-journal "*) ;;
  *)
    for g in systemd-journal adm; do
      if getent group "$g" >/dev/null; then
        usermod -aG "$g" "$SERVICE_USER"
        say "added ${SERVICE_USER} to ${g}, so the journal is readable"
        break
      fi
    done
    ;;
esac

# A system service gets no /run/user/<uid> of its own, and without one the
# compositor has nowhere to put its Wayland socket — the first install reported
# native applications as unavailable for exactly that reason. Lingering makes
# systemd create and keep that directory for a user who never logs in.
#
# It has to be /run/user/<uid> specifically, not a RuntimeDirectory= of our own:
# the AppArmor profile every snap and every confined .deb includes permits the
# socket only under that path. Anywhere else and confined applications cannot
# open it. See docs/wayland.md.
RUNTIME_DIR="/run/user/${SERVICE_UID}"
if command -v loginctl >/dev/null; then
  loginctl enable-linger "$SERVICE_USER" >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do [ -d "$RUNTIME_DIR" ] && break; sleep 1; done
fi
if [ -d "$RUNTIME_DIR" ]; then
  say "runtime directory $RUNTIME_DIR"
else
  say "no $RUNTIME_DIR — native applications will be unavailable"
fi

# Snaps need one thing more than that directory. snap-confine makes its tracking
# cgroup by asking systemd --user for a transient scope over the session bus, so
# there has to be a session bus with systemd on it; without one every snap exits
# before it draws while ordinary .deb applications are perfectly fine, which is
# a confusing way to find out. `dbus-user-session` is the package that puts the
# socket there, and a minimal server image does not always carry it.
#
# Reported, not installed: pulling a package onto someone's machine during an
# upgrade is their decision, not this script's.
if [ -S "${RUNTIME_DIR}/bus" ]; then
  say "session bus ${RUNTIME_DIR}/bus"
else
  say "no ${RUNTIME_DIR}/bus — snap applications will not start"
  say "  (apt install dbus-user-session, then re-run this)"
fi

# ---------------------------------------------------------------------------
# The unit
# ---------------------------------------------------------------------------
# Binding to localhost is deliberate: reaching it from elsewhere should be an
# explicit decision, over SSH or a reverse proxy, and never a default. That is
# also what makes the sandbox below a choice rather than a necessity — the port
# is only reachable by someone who already has a shell on this machine.

step "systemd unit"

# The two shapes this unit comes in. They are one decision, not several: a
# sandbox is what makes a privileged account harmless, so keeping half of it
# produces something that is neither.
#
# Privileged. No sandboxing at all, because each of these options would take
# away something the choice just granted. NoNewPrivileges makes every setuid
# binary inert, so `sudo` in the terminal fails with "the no new privileges flag
# is set" however complete the sudoers entry is — and ProtectKernelModules,
# ProtectKernelTunables, RestrictSUIDSGID, RestrictRealtime and LockPersonality
# each imply it back on, which `systemctl show` will not tell you: it reports
# the configured value, and only /proc/<pid>/status reports the effective one.
# ProtectSystem is just as sharp: with /usr read-only, `sudo apt install`
# reaches the point of unpacking and fails on a read-only filesystem.
#
# Unprivileged. The full sandbox, minus PrivateTmp when it runs as a person —
# a file dropped in /tmp over SSH being invisible to the file manager is its own
# small betrayal of what a desktop is.
if [ "$PRIVILEGE" = "yes" ]; then
  SANDBOX="NoNewPrivileges=no"
else
  SANDBOX="NoNewPrivileges=yes
ProtectSystem=full
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
ReadWritePaths=${HOME_DIR}"
  # For the system account the two are the same directory, and a path listed
  # twice reads as a mistake to whoever opens this next.
  if [ "$STATE_DIR" != "$HOME_DIR" ]; then
    SANDBOX="${SANDBOX} ${STATE_DIR}"
  fi
  if [ "$SERVICE_USER" = "$SYSTEM_ACCOUNT" ]; then
    SANDBOX="${SANDBOX}
PrivateTmp=yes"
  fi
fi

cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Finestra — a desktop environment for a headless server
Documentation=https://finestra.dev
After=network-online.target
Wants=network-online.target

# Someone answered the question about who this runs as, so an upgrade keeps
# their answer instead of asking again. To change it:
#   sudo ${PREFIX}/current/configure.sh
${CHOICE_MARKER}

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${HOME_DIR}

Environment=NODE_ENV=production
Environment=WD_HOST=127.0.0.1
Environment=WD_PORT=${PORT}
# Set explicitly rather than left to systemd: everything the desktop opens by
# default — the file manager, the terminal, an upload — resolves from here, so
# it is not a detail to inherit by luck.
Environment=HOME=${HOME_DIR}
# stateDir() appends "finestra" to this, which lands it on ${STATE_DIR}.
Environment=XDG_STATE_HOME=${STATE_HOME}
Environment=WD_STATIC=${PREFIX}/current/app/client
Environment=WD_WDCOMP=${PREFIX}/current/libexec/wdcomp
# Where the compositor puts its Wayland socket. See the note above on why this
# path and no other.
Environment=XDG_RUNTIME_DIR=${RUNTIME_DIR}

ExecStart=${PREFIX}/current/runtime/bin/node ${PREFIX}/current/app/server/src/index.js
Restart=on-failure
RestartSec=2

${SANDBOX}

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload

# ---------------------------------------------------------------------------
# The hand-off
# ---------------------------------------------------------------------------
# The unit is written but not started yet, and that gap is deliberate: writing
# is reversible with `rm`, starting is what collides on the port. Between the
# two, the superseded service is still running and still serving — so the
# window in which neither is up is one bounded step with a way back.
#
# The invariant: at no instant is there neither a running service nor a
# complete install to put back.

# systemd returns when the main PID is reaped, which is normally enough — but a
# child holding the listening socket surfaces as EADDRINUSE inside the *new*
# unit, after the old one has already been disabled. Better to find out here,
# where rolling back is still cheap.
wait_port_free() {  # <port> <seconds>
  command -v ss >/dev/null || return 0
  local i
  for i in $(seq 1 "$2"); do
    ss -ltnH "sport = :$1" 2>/dev/null | grep -q . || return 0
    sleep 1
  done
  return 1
}

legacy_stand_down() {
  # `disable --now`, not `stop`: stop leaves it enabled, so a reboot in the
  # failure window brings both up to fight over the port — and with
  # Restart=on-failure on the new one, that is a flapping service and a journal
  # nobody can read. This also removes the multi-user.target.wants symlink.
  systemctl disable --now "${LEGACY_SERVICE}.service" >/dev/null 2>&1 || true
  wait_port_free "$PORT" 15
}

legacy_stand_up() {
  rm -f "$UNIT"
  systemctl daemon-reload
  systemctl enable --now "${LEGACY_SERVICE}.service" >/dev/null 2>&1 || true
}

if legacy_present; then
  step "Taking over from ${LEGACY_SERVICE}"
  if ! legacy_stand_down; then
    legacy_stand_up
    die "port ${PORT} did not come free after stopping ${LEGACY_SERVICE}; put it back and changed nothing"
  fi
  REMOVED+=("${LEGACY_SERVICE}.service ($([ "$LEGACY_WAS_RUNNING" = 1 ] && echo 'was running' || echo 'was stopped'))")
  say "stopped and disabled ${LEGACY_SERVICE}.service"
fi

# enable + restart, not `enable --now`: --now is a plain start, and start is a
# no-op on a service that is already running — so reinstalling a new version
# over a running one would keep serving the old process until something else
# restarted it. restart also starts a stopped service, so this covers both.
#
# `|| true` on both, and it is load-bearing: a unit that fails to start makes
# `systemctl restart` exit non-zero, and as a plain statement under `set -e`
# that ends the script *there* — before the health check, before the rollback,
# with the old service already stopped and nothing put back. update.sh learned
# this the same way in switch_to(). The health check below is the judge here,
# not an exit status.
systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
systemctl restart "$UNIT_NAME" >/dev/null 2>&1 || true
say "enabled and started"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

# Both halves, not just `is-active`: the process can be up with nothing
# listening yet, and "started" is not the claim worth making — "answers" is.
# This is update.sh's check, for the same reason it has one.
#
# `-fs`, not `-fsS`. The capital S means "silent, but still print errors", which
# is right for a fetch that happens once and wrong for a poll: not being up yet
# is this loop's normal state, so -S made a successful install print
# "curl: (7) Failed to connect to 127.0.0.1 port 7070" on its way to working.
# When the loop really does give up, the caller prints the journal, which is a
# better answer than curl's one line anyway.
healthy() {
  local i
  for i in $(seq 1 20); do
    if systemctl is-active --quiet "$UNIT_NAME" \
       && curl -fs --max-time 3 -o /dev/null "http://127.0.0.1:${PORT}/healthz"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Everything the superseded install leaves behind, removed only once the new
# one has answered. Each action is separately conditional, so a second run is a
# no-op and a run that resumes a half-finished migration finishes it.
legacy_remove() {
  if [ -f "$LEGACY_UNIT" ]; then
    rm -f "$LEGACY_UNIT"
    systemctl daemon-reload
    systemctl reset-failed "${LEGACY_SERVICE}.service" >/dev/null 2>&1 || true
  fi
  # Also takes out the old configure.sh and update.sh, which is the point:
  # left there, either would rewrite and restart a unit that no longer exists.
  if [ -d "$LEGACY_PREFIX" ]; then
    rm -rf "$LEGACY_PREFIX"
    REMOVED+=("$LEGACY_PREFIX")
  fi

  # The old system account, and only if it really is one. Never touch a login
  # account that happens to carry the name, and never the account the service
  # now runs as.
  local uid
  uid="$(id -u "$LEGACY_ACCOUNT" 2>/dev/null || true)"
  if [ -n "$uid" ] && [ "$uid" -lt 1000 ] && [ "$LEGACY_ACCOUNT" != "$SERVICE_USER" ]; then
    loginctl disable-linger "$LEGACY_ACCOUNT" >/dev/null 2>&1 || true
    rm -f "/var/lib/systemd/linger/${LEGACY_ACCOUNT}"
    # Before the uid is freed: a later `useradd --system` can reuse it and
    # silently inherit ownership of whatever is still lying there.
    [ -d "$LEGACY_SYSTEM_HOME" ] && chown -R root:root "$LEGACY_SYSTEM_HOME" || true
    # Without -r. That directory holds the only other copy of the token, and
    # deleting someone's data is not an installer's call to make.
    userdel "$LEGACY_ACCOUNT" >/dev/null 2>&1 || true
    REMOVED+=("the ${LEGACY_ACCOUNT} system account and its linger")
    [ -d "$LEGACY_SYSTEM_HOME" ] && \
      LEFT+=("${LEGACY_SYSTEM_HOME} — it still holds a copy of the token; delete it when you are satisfied") || true
  fi
  # Group memberships need no action: they go with the account.
}

if healthy; then
  step "Running"
  if legacy_present; then legacy_remove; fi
else
  step "Not running — the last few log lines:"
  journalctl -u "$UNIT_NAME" -n 20 --no-pager || true
  if legacy_present; then
    legacy_stand_up
    say "put ${LEGACY_SERVICE}.service back, and removed the new unit"
    say "nothing was lost: ${LEGACY_PREFIX} and its state are untouched"
  fi
  die "the service did not start"
fi

if [ ${#TOOK_OVER[@]} -gt 0 ] || [ ${#REMOVED[@]} -gt 0 ]; then
  step "Migrated from ${LEGACY_SERVICE}"
  for line in ${TOOK_OVER+"${TOOK_OVER[@]}"}; do say "took over  $line"; done
  for line in ${REMOVED+"${REMOVED[@]}"};   do say "removed    $line"; done
  for line in ${LEFT+"${LEFT[@]}"};         do say "left       $line"; done
fi

TOKEN_FILE="${STATE_DIR}/token"
for _ in $(seq 1 10); do [ -s "$TOKEN_FILE" ] && break; sleep 1; done

# Whoever will be typing the ssh command. Not `id -un`, which under sudo is
# always root and never the account anyone logs in with.
#
# Never root, by any route. A printed `ssh root@host` is a worked example of a
# habit nobody should be taught, and this one is gratuitous: the tunnel needs
# *an* account on this machine, and no privilege whatsoever. Both routes to it
# are real — `logname` answers root for anyone who installed over a root login,
# and the desktop itself can be running as root if someone asked for that — so
# the filter is on the value rather than on where it came from. A placeholder is
# better advice than a bad example, so when nothing else is known, say "you".
LOGIN_USER=""
for candidate in "${SUDO_USER:-}" "$SERVICE_USER" "$(logname 2>/dev/null || true)"; do
  case "$candidate" in
    "" | root | "$SYSTEM_ACCOUNT") continue ;;
  esac
  LOGIN_USER="$candidate"
  break
done
[ -n "$LOGIN_USER" ] || LOGIN_USER="you"

cat <<REPORT

  It runs as ${SERVICE_USER}$([ "$PRIVILEGE" = yes ] && echo ', with privilege' || echo ', unprivileged'), and reads and writes ${HOME_DIR}.
  To change that later, on this machine and without the tarball:

      sudo ${PREFIX}/current/configure.sh          # asks
      sudo ${PREFIX}/current/configure.sh --show   # what it is now

  It is listening on 127.0.0.1:7070, which is not reachable from anywhere else
  on purpose. To use it from your own machine, forward the port over SSH:

      ssh -L 7070:127.0.0.1:7070 ${LOGIN_USER}@$(hostname -f 2>/dev/null || hostname)

  and then open the URL below, which carries the token:

      http://127.0.0.1:7070/?t=$(cat "$TOKEN_FILE" 2>/dev/null || echo '<see '"$TOKEN_FILE"'>')

  The token lives in ${TOKEN_FILE}. Delete that file and restart to rotate it.

      systemctl status ${SERVICE_NAME}
      journalctl -u ${SERVICE_NAME} -f

  To update later, and to go back if an update misbehaves:

      sudo ${PREFIX}/current/update.sh <tarball or url>
      sudo ${PREFIX}/current/update.sh --rollback

REPORT
