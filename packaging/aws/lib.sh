#!/usr/bin/env bash
# Shared helpers for the throwaway EC2 instances the packaging scripts use.
#
# Every instance this creates is disposable and must die on its own even if the
# machine driving it is unplugged. Three independent guarantees, because an
# orphaned instance bills forever:
#
#   1. --instance-initiated-shutdown-behavior terminate, plus a `shutdown -h`
#      timer in user-data: the instance kills itself, needing nothing from us.
#   2. A trap in the calling script terminates on any exit path.
#   3. wd_ci_sweep terminates anything tagged past its expiry, and is run at the
#      start of every script as well as the end.
#
# Nothing here ever terminates by instance id alone. Every destructive call
# filters on our own tag first and re-checks the tag on the instance itself, so
# a machine we did not create cannot be caught by it.

set -euo pipefail

WD_CI_TAG_KEY="Project"
WD_CI_TAG_VALUE="fleet-desktop-ci"
WD_CI_TTL_MIN="${WD_CI_TTL_MIN:-45}"
WD_CI_REGION="${WD_CI_REGION:-us-east-1}"
# How old a leftover key pair or security group must be before the sweep will
# take it. See wd_ci_sweepable for why this exists at all.
WD_CI_SWEEP_GRACE_MIN="${WD_CI_SWEEP_GRACE_MIN:-20}"

# Where the person who typed the command was standing.
#
# Every script here cds to the repository root before doing anything, so a
# relative path on the command line silently changes meaning on the way in:
# `verify-distros.sh dist-release/x.tar.gz` typed from dist-release/ resolves
# against the repository root and is simply not there. Scripts set this before
# their own cd; the fallback is for anything that sources this directly.
WD_CI_CALLER_PWD="${WD_CI_CALLER_PWD:-$PWD}"

# Which distribution this run is against. Ubuntu 24.04 is the default and the
# build target: native artifacts built against its glibc run on everything
# newer, and the reverse is not true — which is exactly the claim
# verify-distros.sh exists to test rather than assume.
source "$(dirname "${BASH_SOURCE[0]}")/distros.sh"
wd_ci_use_distro "${WD_CI_DISTRO:-ubuntu-24.04}"

WD_CI_RUN_ID=""
WD_CI_KEY_NAME=""
WD_CI_KEY_FILE=""
WD_CI_SG_ID=""
WD_CI_SUBNET="${WD_CI_SUBNET:-}"
WD_CI_VPC=""
WD_CI_INSTANCES=()

aws_() { aws --region "$WD_CI_REGION" "$@"; }

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# ---------------------------------------------------------------------------
# Sweeping: the backstop that runs even when nothing else did
# ---------------------------------------------------------------------------

# Resolves a path the way the person typing it meant it, before any cd.
wd_ci_abs() {
  case "$1" in
    ''| /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "${WD_CI_CALLER_PWD%/}" "$1" ;;
  esac
}

# How many minutes ago the run named `wd-ci-<YYYYMMDD>-<HHMMSS>-<pid>` started,
# or -1 when the name carries no timestamp we can read.
#
# The name is the only clock available: a security group reports no creation
# time at all, and the key pair's is absent from the API version in use here.
wd_ci_name_age_min() {
  local stamp epoch
  stamp="${1#wd-ci-}"     # 20260820-143858-3414025
  stamp="${stamp%-*}"     # 20260820-143858
  case "$stamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) printf '%s\n' -1; return 0 ;;
  esac
  epoch=$(date -u -d \
    "${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2} UTC" \
    +%s 2>/dev/null) || { printf '%s\n' -1; return 0; }
  printf '%s\n' $(( ($(date -u +%s) - epoch) / 60 ))
}

# Whether a leftover is old enough that no live run can still be using it.
#
# It was not, and that cost four of six verifiers in one run: they died at
# RunInstances with `InvalidKeyPair.NotFound` about a key pair created eleven
# seconds earlier, because a *different* script's cleanup swept everything not
# named by its own run while those instances were still launching. Skipping the
# young ones is the fix; skipping the unreadable ones too is deliberate, since
# a key pair or an empty security group left behind costs nothing and deleting
# something we cannot date costs a run.
wd_ci_sweepable() {
  local age
  age=$(wd_ci_name_age_min "$1")
  [ "$age" -ge "$WD_CI_SWEEP_GRACE_MIN" ]
}

# Terminates every instance carrying our tag whose ExpiresAt has passed. Safe to
# run at any time, including before a run starts — that is the point.
wd_ci_sweep() {
  local now ids id expires stale=()
  now=$(date -u +%s)
  ids=$(aws_ ec2 describe-instances \
    --filters "Name=tag:${WD_CI_TAG_KEY},Values=${WD_CI_TAG_VALUE}" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null || true)

  # No early return here. An earlier version bailed out when there were no
  # stale instances — which is the *normal* case — and so never reached the key
  # pairs and security groups below. It looked fixed because the check that
  # "proved" it called the leftovers sweep directly, past this line.
  for id in ${ids:-}; do
    expires=$(aws_ ec2 describe-instances --instance-ids "$id" \
      --query "Reservations[].Instances[].Tags[?Key=='ExpiresAt'].Value|[0][0]" \
      --output text 2>/dev/null || echo "")
    # No expiry tag, or past it: it is ours and it is stale either way.
    if [ -z "$expires" ] || [ "$expires" = "None" ] || [ "$now" -ge "$expires" ]; then
      stale+=("$id")
    fi
  done

  if [ ${#stale[@]} -gt 0 ]; then
    log "sweeping stale CI instances: ${stale[*]}"
    wd_ci_terminate "${stale[@]}"
  fi

  wd_ci_sweep_leftovers
}

# Key pairs and security groups cost nothing, so they are easy to forget — and a
# run that is killed from outside leaves them behind, because the trap never
# gets to run. They accumulate. Both live in our own `wd-ci-` namespace, and a
# security group still attached to something refuses to delete, so this is safe
# to run at any time.
#
# The `|| true` on both deletions is the load-bearing part. A security group is
# still attached while the instance holding it finishes terminating, so deleting
# it answers DependencyViolation — the harmless case this function was written
# to tolerate. But that call is the last statement in the loop body, so its
# failure is the loop's exit status, and under `set -e` it killed the whole run:
# starting a verifier eleven seconds after the previous one released its
# instance aborted it at startup with exit 254, before it did anything. Every
# script here begins with a sweep, so a housekeeping call that can fail must
# never be the thing that decides whether the run happens.
wd_ci_sweep_leftovers() {
  local name id
  for name in $(aws_ ec2 describe-key-pairs \
      --query 'KeyPairs[?starts_with(KeyName, `wd-ci-`)].KeyName' \
      --output text 2>/dev/null); do
    if [ "$name" = "$WD_CI_KEY_NAME" ]; then continue; fi
    # Another run's, and possibly one still launching instances with it.
    if ! wd_ci_sweepable "$name"; then continue; fi
    aws_ ec2 delete-key-pair --key-name "$name" 2>/dev/null \
      && log "swept key pair $name" || true
  done

  # The name, not just the id: it is what carries the age.
  while read -r id name; do
    [ -n "${id:-}" ] || continue
    if [ "$id" = "$WD_CI_SG_ID" ]; then continue; fi
    if ! wd_ci_sweepable "${name:-}"; then continue; fi
    # Fails while an instance still holds it; the next run gets it.
    aws_ ec2 delete-security-group --group-id "$id" 2>/dev/null \
      && log "swept security group $id" || true
  done < <(aws_ ec2 describe-security-groups \
      --query 'SecurityGroups[?starts_with(GroupName, `wd-ci-`)].[GroupId,GroupName]' \
      --output text 2>/dev/null)
  return 0
}

# Terminates instances, but only after confirming each one carries our tag.
wd_ci_terminate() {
  local id tag confirmed=()
  for id in "$@"; do
    [ -z "$id" ] && continue
    tag=$(aws_ ec2 describe-instances --instance-ids "$id" \
      --query "Reservations[].Instances[].Tags[?Key=='${WD_CI_TAG_KEY}'].Value|[0][0]" \
      --output text 2>/dev/null || echo "")
    if [ "$tag" = "$WD_CI_TAG_VALUE" ]; then
      confirmed+=("$id")
    else
      log "REFUSING to terminate $id — it does not carry ${WD_CI_TAG_KEY}=${WD_CI_TAG_VALUE}"
    fi
  done
  [ ${#confirmed[@]} -eq 0 ] && return 0
  aws_ ec2 terminate-instances --instance-ids "${confirmed[@]}" \
    --query 'TerminatingInstances[].InstanceId' --output text >/dev/null
  log "terminated: ${confirmed[*]}"
}

# ---------------------------------------------------------------------------
# Run setup and teardown
# ---------------------------------------------------------------------------

# Everything this run created, asked of AWS rather than remembered locally.
#
# wd_ci_launch is normally called inside $( ), which is a subshell — so an array
# appended to there never reaches the trap in the parent. The first build here
# leaked a running instance for exactly that reason. Asking EC2 what carries this
# run's tag cannot go wrong that way.
wd_ci_own_instances() {
  aws_ ec2 describe-instances \
    --filters "Name=tag:RunId,Values=${WD_CI_RUN_ID}" \
              "Name=tag:${WD_CI_TAG_KEY},Values=${WD_CI_TAG_VALUE}" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null || true
}

wd_ci_cleanup() {
  local rc=$?
  set +e
  log "cleanup starting (exit ${rc})"

  local mine
  mine=$(wd_ci_own_instances)
  if [ -n "$mine" ]; then
    # shellcheck disable=SC2086
    wd_ci_terminate $mine
  else
    log "nothing of ours is running"
  fi

  if [ -n "$WD_CI_SG_ID" ]; then
    # The security group cannot go until its instances really are gone.
    if [ -n "$mine" ]; then
      # shellcheck disable=SC2086
      aws_ ec2 wait instance-terminated --instance-ids $mine 2>/dev/null
    fi
    aws_ ec2 delete-security-group --group-id "$WD_CI_SG_ID" 2>/dev/null && \
      log "deleted security group $WD_CI_SG_ID"
  fi
  if [ -n "$WD_CI_KEY_NAME" ]; then
    aws_ ec2 delete-key-pair --key-name "$WD_CI_KEY_NAME" 2>/dev/null && \
      log "deleted key pair $WD_CI_KEY_NAME"
  fi
  [ -n "$WD_CI_KEY_FILE" ] && rm -f "$WD_CI_KEY_FILE"
  wd_ci_sweep
  log "cleanup done"
  return $rc
}

wd_ci_init() {
  command -v aws >/dev/null || die "aws cli not found"
  aws_ sts get-caller-identity >/dev/null || die "aws credentials not usable"

  # Anything left behind by an earlier run goes now, before we add more.
  wd_ci_sweep

  WD_CI_RUN_ID="$(date -u +%Y%m%d-%H%M%S)-$$"
  WD_CI_KEY_NAME="wd-ci-${WD_CI_RUN_ID}"
  WD_CI_KEY_FILE="$(mktemp -t wd-ci-key-XXXXXX.pem)"
  trap wd_ci_cleanup EXIT INT TERM

  aws_ ec2 create-key-pair --key-name "$WD_CI_KEY_NAME" \
    --query 'KeyMaterial' --output text > "$WD_CI_KEY_FILE"
  chmod 600 "$WD_CI_KEY_FILE"
  log "key pair $WD_CI_KEY_NAME"

  wd_ci_pick_subnet

  # One flaky moment on the workstation's own connection should not throw away
  # a run — a ten-second timeout here killed one that had nothing else wrong.
  local my_ip=""
  local attempt
  for attempt in 1 2 3; do
    my_ip=$(curl -fsS --max-time 15 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]')
    if [ -n "$my_ip" ]; then break; fi
    log "  could not reach checkip (try ${attempt}/3), retrying"
    sleep 5
  done
  [ -n "$my_ip" ] || die "could not determine this machine's public IP"

  WD_CI_SG_ID=$(aws_ ec2 create-security-group \
    --group-name "wd-ci-${WD_CI_RUN_ID}" \
    --description "throwaway: web-desktop packaging CI" \
    --vpc-id "$WD_CI_VPC" \
    --query 'GroupId' --output text)
  aws_ ec2 authorize-security-group-ingress --group-id "$WD_CI_SG_ID" \
    --protocol tcp --port 22 --cidr "${my_ip}/32" >/dev/null
  log "security group $WD_CI_SG_ID (ssh from ${my_ip}/32 only)"
}

# ---------------------------------------------------------------------------
# Launching
# ---------------------------------------------------------------------------

# This account has no default VPC, so a subnet has to be chosen deliberately.
# The requirement is a route to an internet gateway — without one the instance
# comes up unreachable and the run wastes ten minutes discovering it.
wd_ci_pick_subnet() {
  if [ -n "$WD_CI_SUBNET" ]; then
    WD_CI_VPC=$(aws_ ec2 describe-subnets --subnet-ids "$WD_CI_SUBNET" \
      --query 'Subnets[0].VpcId' --output text)
    log "subnet $WD_CI_SUBNET (given) in $WD_CI_VPC"
    return
  fi

  local subnet vpc rt igw
  while read -r subnet vpc; do
    [ -z "$subnet" ] && continue
    rt=$(aws_ ec2 describe-route-tables \
      --filters "Name=association.subnet-id,Values=$subnet" \
      --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null || echo None)
    if [ "$rt" = "None" ] || [ -z "$rt" ]; then
      rt=$(aws_ ec2 describe-route-tables \
        --filters "Name=vpc-id,Values=$vpc" "Name=association.main,Values=true" \
        --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null || echo None)
    fi
    [ "$rt" = "None" ] && continue
    igw=$(aws_ ec2 describe-route-tables --route-table-ids "$rt" \
      --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].GatewayId|[0]" \
      --output text 2>/dev/null || echo None)
    case "$igw" in
      igw-*) WD_CI_SUBNET="$subnet"; WD_CI_VPC="$vpc"
             log "subnet $subnet in $vpc (routes to $igw)"; return ;;
    esac
  done < <(aws_ ec2 describe-subnets \
             --query 'Subnets[].[SubnetId,VpcId]' --output text)

  die "no subnet with a route to an internet gateway; set WD_CI_SUBNET"
}

# The image for the distribution in force. An SSM parameter where the vendor
# publishes one, otherwise newest-first by owner and name.
#
# `--owners` is not decoration. A name glob on its own matches any account's
# image, so the owner id is the only part of this that makes the answer
# trustworthy; architecture is filtered here too rather than left to the glob,
# because an aarch64 image resolves perfectly and then fails to boot our x86_64
# tarball twenty minutes later.
wd_ci_ami() {
  if [ -n "$WD_CI_AMI_SSM" ]; then
    aws_ ssm get-parameters --names "$WD_CI_AMI_SSM" \
      --query 'Parameters[0].Value' --output text
    return
  fi
  aws_ ec2 describe-images \
    --owners "$WD_CI_AMI_OWNER" \
    --filters "Name=name,Values=${WD_CI_AMI_GLOB}" \
              "Name=state,Values=available" \
              "Name=architecture,Values=x86_64" \
    --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' --output text
}

# wd_ci_launch <role> <instance-type> -> prints "<instance-id> <public-ip>"
wd_ci_launch() {
  local role="$1" itype="$2" ami expires id ip
  ami=$(wd_ci_ami)
  [ -n "$ami" ] && [ "$ami" != "None" ] || die "could not resolve an AMI for ${WD_CI_DISTRO}"
  expires=$(( $(date -u +%s) + WD_CI_TTL_MIN * 60 ))

  # The deadman. If everything else fails — the script dies, the network drops,
  # the laptop closes — the instance still shuts down, and shutdown terminates.
  local userdata
  userdata=$(printf '#!/bin/bash\nshutdown -h +%s "web-desktop CI deadman"\n' "$WD_CI_TTL_MIN" | base64 -w0)

  id=$(aws_ ec2 run-instances \
    --image-id "$ami" \
    --instance-type "$itype" \
    --key-name "$WD_CI_KEY_NAME" \
    --security-group-ids "$WD_CI_SG_ID" \
    --subnet-id "$WD_CI_SUBNET" \
    --associate-public-ip-address \
    --instance-initiated-shutdown-behavior terminate \
    --user-data "$userdata" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=12,VolumeType=gp3,DeleteOnTermination=true}' \
    --tag-specifications \
      "ResourceType=instance,Tags=[{Key=${WD_CI_TAG_KEY},Value=${WD_CI_TAG_VALUE}},{Key=Name,Value=wd-ci-${role}-${WD_CI_DISTRO}},{Key=ExpiresAt,Value=${expires}},{Key=Role,Value=${role}},{Key=Distro,Value=${WD_CI_DISTRO}},{Key=RunId,Value=${WD_CI_RUN_ID}}]" \
      "ResourceType=volume,Tags=[{Key=${WD_CI_TAG_KEY},Value=${WD_CI_TAG_VALUE}}]" \
    --query 'Instances[0].InstanceId' --output text)

  WD_CI_INSTANCES+=("$id")
  log "launched $role as $id ($itype, ${WD_CI_PRETTY}, $ami), self-terminates in ${WD_CI_TTL_MIN}m"

  aws_ ec2 wait instance-running --instance-ids "$id"
  ip=$(aws_ ec2 describe-instances --instance-ids "$id" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
  [ -n "$ip" ] && [ "$ip" != "None" ] || die "$id has no public IP"

  wd_ci_wait_ssh "$ip"
  echo "$id $ip"
}

wd_ci_ssh_opts=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
                -o LogLevel=ERROR -o ConnectTimeout=10)

wd_ci_wait_ssh() {
  local ip="$1" i
  for i in $(seq 1 60); do
    if ssh "${wd_ci_ssh_opts[@]}" -i "$WD_CI_KEY_FILE" "${WD_CI_LOGIN}@${ip}" true 2>/dev/null; then
      log "ssh up on $ip (after ${i} tries)"
      return 0
    fi
    sleep 5
  done
  die "ssh never came up on $ip"
}

wd_ci_ssh() {
  local ip="$1"; shift
  ssh "${wd_ci_ssh_opts[@]}" -i "$WD_CI_KEY_FILE" "${WD_CI_LOGIN}@${ip}" "$@"
}

# A fresh cloud image is busy for its first few minutes: cloud-init is still
# going, and the distribution's own update timer takes the package lock and
# restarts services. The first build here died with "Connection reset by peer"
# mid-apt, because one of the services it restarted was sshd. Settle all of that
# before doing any work.
#
# Two families, and the split is real: apt/unattended-upgrades on Debian and
# Ubuntu, dnf/dnf-automatic on Fedora, Rocky and Amazon Linux. The MTU fix
# below is deliberately *not* split that way — it detects the network manager
# in use rather than inferring it from the distribution, because that is the
# thing that actually decides, and Debian 12 and Ubuntu 24.04 disagree about it
# while being the same family.
wd_ci_prepare_host() {
  local ip="$1"
  log "settling the host (cloud-init, package timers, MTU)"
  wd_ci_ssh "$ip" "bash -s '$WD_CI_FAMILY'" <<'REMOTE' || true
set -uo pipefail
family="$1"
sudo cloud-init status --wait >/dev/null 2>&1 || true

case "$family" in
  debian)
    # Ubuntu's AMIs point apt at the in-region mirror,
    # <region>.ec2.archive.ubuntu.com. CI does not use it, because it is a pool
    # of addresses and individual backends in that pool die without being taken
    # out of DNS. Three 0.3.3 builds burned the full 2400s limit inside
    # `apt-get update` before this was understood, all with the same signature:
    # established HTTP sockets and empty queues, which is exactly what the MTU
    # blackhole further down looks like, and it was not that — the MTU was 1500
    # and pinned.
    #
    # What it actually was, from `apt-get -o Debug::Acquire::http=1 update`:
    #
    #   noble/InRelease            Hit                       (fine)
    #   noble-updates/InRelease    54.144.148.213 -> failed   (ignored)
    #   noble-backports/InRelease  54.165.17.230  -> "Waiting for headers"
    #                              3.209.10.109   -> "Waiting for headers" ...
    #
    # The connection completes and the headers never come. Acquire::Retries
    # then walks the rest of the pool, so one dead backend costs a timeout each
    # and the step outlives any limit put on it.
    #
    # This was first "fixed" by probing the mirror with curl and falling back
    # only when the probe failed. That does not work and is worth recording:
    # curl resolves the name once and tests a single address, so it kept
    # reporting the mirror healthy while apt hit the dead members of the same
    # pool. A probe cannot see a partly-dead DNS pool; only using a different
    # host can.
    #
    # So: archive.ubuntu.com, unconditionally. Measured against the sick pool
    # from the same instance it served 71 MB/s to that pool's 4 B/s. In-region
    # is a bandwidth optimisation for a build that runs a few times a week, and
    # trading a little speed for a step that cannot hang is the right way round.
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources; do
      [ -f "$f" ] && sudo sed -i \
        's|http://[a-z0-9.-]*ec2\.archive\.ubuntu\.com|http://archive.ubuntu.com|g' "$f"
    done
    grep -rqE 'ec2\.archive\.ubuntu\.com' /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null \
      && echo "  WARNING: an in-region mirror survived the rewrite" \
      || echo "  apt points at archive.ubuntu.com"

    sudo systemctl disable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
    sudo systemctl stop unattended-upgrades apt-daily.service apt-daily-upgrade.service >/dev/null 2>&1 || true
    sudo pkill -f unattended-upgr >/dev/null 2>&1 || true
    printf 'APT::Periodic::Unattended-Upgrade "0";\n' | sudo tee /etc/apt/apt.conf.d/99-wd-ci >/dev/null
    # Secondary hardening, not the fix: make a fetch that goes wrong fail and
    # retry rather than block indefinitely.
    sudo tee /etc/apt/apt.conf.d/99-wd-ci-net >/dev/null <<'APTCONF'
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
Acquire::Retries "3";
APTCONF
    # needrestart restarts services in the middle of an install, sshd among
    # them. Absent on Debian's cloud image, which is why this is not fatal.
    sudo mkdir -p /etc/needrestart/conf.d
    printf "\$nrconf{restart} = 'a';\n\$nrconf{kernelhints} = 0;\n" \
      | sudo tee /etc/needrestart/conf.d/99-wd-ci.conf >/dev/null
    for _ in $(seq 1 60); do
      sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
      sleep 5
    done
    ;;
  rhel)
    # dnf-makecache wakes up on a timer and holds the rpm lock; dnf-automatic
    # is Fedora's answer to unattended-upgrades and will restart services under
    # us in exactly the same way. Amazon Linux carries neither by default, so
    # every one of these is allowed to be absent.
    sudo systemctl disable --now dnf-makecache.timer dnf-automatic.timer \
         dnf-automatic-install.timer packagekit >/dev/null 2>&1 || true
    printf 'timeout=20\nretries=3\n' | sudo tee -a /etc/dnf/dnf.conf >/dev/null 2>&1 || true
    for _ in $(seq 1 60); do
      sudo fuser /var/lib/rpm/.rpm.lock >/dev/null 2>&1 || break
      sleep 5
    done
    ;;
esac

# The interface comes up at MTU 9001 — jumbo frames, the VPC default — but the
# path to the internet only carries 1500, and the ICMP that path-MTU discovery
# depends on is filtered somewhere along it. The result is a connection that
# establishes perfectly and then dies the moment a bulk transfer starts: apt
# downloads a few tens of megabytes, stalls with an established socket and empty
# queues, and waits forever holding its own lock. It looks exactly like a hung
# mirror, and it cost two builds before it was understood.
#
# Dropping to 1500 fixed it instantly — a stalled download resumed mid-flight.
#
# And it has to be dropped *durably*. `ip link set mtu` lasts until the DHCP
# lease renews, at which point AWS's option set puts 9001 back and the stall
# returns — mid-build, long after the log said the fix had been applied. That
# cost a whole run: apt succeeded, the build succeeded, and then the 58 MB
# artifact came home at six kilobytes a second.
#
# Where "durably" lives is a property of the image, not of the distribution:
# Ubuntu has netplan, Fedora/Rocky/Amazon Linux have NetworkManager, and Debian
# 12's cloud image has neither — it is ifupdown driving dhclient, where the
# lease is overridden with `supersede`. So this asks the machine what it is
# running instead of looking it up by name, and applies the immediate `ip link`
# either way so the current boot does not wait for anything to settle.
iface=$(ip -o -4 route show to default | awk 'NR==1 { print $5 }')
if [ -n "$iface" ]; then
  sudo ip link set dev "$iface" mtu 1500 2>/dev/null || true
  pinned="not pinned"
  if [ -d /etc/netplan ]; then
    printf 'network:\n  version: 2\n  ethernets:\n    %s:\n      mtu: 1500\n' "$iface" \
      | sudo tee /etc/netplan/99-wd-ci-mtu.yaml >/dev/null
    sudo chmod 600 /etc/netplan/99-wd-ci-mtu.yaml
    sudo netplan apply 2>/dev/null || true
    pinned="netplan"
  elif systemctl is-active --quiet NetworkManager 2>/dev/null; then
    # `connection modify` writes the profile so it survives a renewal;
    # `device set` applies it now without the down/up that would drop the SSH
    # session we are giving this instruction over.
    con=$(nmcli -t -f NAME connection show --active 2>/dev/null | awk 'NR==1')
    if [ -n "$con" ]; then
      sudo nmcli connection modify "$con" 802-3-ethernet.mtu 1500 >/dev/null 2>&1 || true
      pinned="NetworkManager"
    fi
  elif [ -d /etc/dhcp ]; then
    # `supersede` beats whatever the server offers, at every renewal. `default`
    # would only apply when the offer omits the option, which is never here.
    grep -q 'supersede interface-mtu' /etc/dhcp/dhclient.conf 2>/dev/null \
      || printf 'supersede interface-mtu 1500;\n' | sudo tee -a /etc/dhcp/dhclient.conf >/dev/null
    pinned="dhclient"
  fi
  echo "  $iface $(ip -o link show "$iface" | grep -o 'mtu [0-9]*') ($pinned)"
fi
echo "  host settled"
REMOTE
}

# Runs a script on the host detached from our SSH connection, so the work keeps
# going if the link drops — which it will, sooner or later, on a machine that is
# restarting its own services. Polls for completion, then returns the script's
# real exit code.
#
#   wd_ci_run_detached <ip> <name> <local-script> [timeout-sec]
wd_ci_run_detached() {
  local ip="$1" name="$2" script="$3" limit="${4:-1800}"
  local waited=0 rc=""

  wd_ci_scp_to "$script" "$ip" "/tmp/${name}.sh"
  wd_ci_ssh "$ip" "rm -f /tmp/${name}.done /tmp/${name}.log; \
    setsid nohup bash -c 'bash /tmp/${name}.sh >/tmp/${name}.log 2>&1; \
    echo \$? >/tmp/${name}.done' >/dev/null 2>&1 </dev/null & sleep 1" || true

  while [ "$waited" -lt "$limit" ]; do
    sleep 10; waited=$((waited + 10))
    rc=$(wd_ci_ssh "$ip" "cat /tmp/${name}.done 2>/dev/null" 2>/dev/null || echo "")
    [ -n "$rc" ] && break
    if [ $((waited % 60)) -eq 0 ]; then
      log "  ${name}: $(wd_ci_ssh "$ip" "tail -1 /tmp/${name}.log 2>/dev/null | cut -c1-70" 2>/dev/null || echo '...') (${waited}s)"
    fi
  done

  wd_ci_ssh "$ip" "cat /tmp/${name}.log 2>/dev/null" 2>/dev/null | sed 's/^/    /' || true
  [ -n "$rc" ] || { log "${name} did not finish within ${limit}s"; return 124; }
  return "$rc"
}

wd_ci_scp_to() {
  local src="$1" ip="$2" dst="$3"
  scp "${wd_ci_ssh_opts[@]}" -i "$WD_CI_KEY_FILE" -q "$src" "${WD_CI_LOGIN}@${ip}:${dst}"
}

wd_ci_scp_from() {
  local ip="$1" src="$2" dst="$3"
  scp "${wd_ci_ssh_opts[@]}" -i "$WD_CI_KEY_FILE" -q "${WD_CI_LOGIN}@${ip}:${src}" "$dst"
}
