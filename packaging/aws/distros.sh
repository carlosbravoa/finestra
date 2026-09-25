#!/usr/bin/env bash
# The distributions the packaging is verified against, and how to find each one
# on EC2.
#
# Three things differ per distribution and nothing else does: which AMI, which
# account the image's cloud-init creates, and which family it settles like.
# Everything past that — install.sh, configure.sh, the acceptance checks — is
# the same script on every row, which is the point. A row that needs a special
# case in the checks is a portability bug in the product, not a fact about the
# distribution.
#
# Finding the AMI splits two ways. Canonical, Amazon and Debian publish their
# current image as a public SSM parameter, which is a name that never goes
# stale. Fedora and Rocky do not, so those are found by owner account plus a
# name glob, newest first — and the owner id is the load-bearing part: it is
# what stops a name glob matching some stranger's image that happens to be
# called the right thing.
#
# Each image is chosen for the architecture in force (wd_ci_use_arch in
# lib.sh), and every vendor spells it differently: amd64/arm64 for Canonical
# and Debian, x86_64/arm64 for Amazon, x86_64/aarch64 in the Fedora and Rocky
# image names. Hence the several variables rather than one.
#
# The Fedora release is pinned rather than "whatever is newest", because that
# account also publishes Rawhide, ELN and prereleases under names one careless
# glob away from the stable one. Bumping it is meant to be an edit somebody
# made on purpose.

WD_CI_FEDORA_RELEASE="${WD_CI_FEDORA_RELEASE:-44}"

# Every distribution this knows how to launch. The first is the default and is
# also the one the release is built on.
WD_CI_DISTROS=(ubuntu-24.04 debian-12 amazonlinux-2023 fedora rocky-9 rocky-10)

# wd_ci_use_distro <id> — sets the globals the rest of the run reads.
#
#   WD_CI_DISTRO   the id, for logs and file names
#   WD_CI_PRETTY   what to call it in a sentence
#   WD_CI_LOGIN    the account cloud-init made, which is who we ssh in as
#   WD_CI_FAMILY   debian | rhel — only wd_ci_prepare_host cares
#   WD_CI_AMI_*    how to resolve the image
wd_ci_use_distro() {
  WD_CI_DISTRO="${1:-ubuntu-24.04}"
  WD_CI_AMI_SSM=""
  WD_CI_AMI_OWNER=""
  WD_CI_AMI_GLOB=""

  case "$WD_CI_DISTRO" in
    ubuntu-24.04)
      WD_CI_PRETTY="Ubuntu 24.04 LTS"
      WD_CI_LOGIN="ubuntu"
      WD_CI_FAMILY="debian"
      WD_CI_AMI_SSM="/aws/service/canonical/ubuntu/server/24.04/stable/current/${WD_CI_DEB_ARCH}/hvm/ebs-gp3/ami-id"
      ;;
    ubuntu-22.04)
      WD_CI_PRETTY="Ubuntu 22.04 LTS"
      WD_CI_LOGIN="ubuntu"
      WD_CI_FAMILY="debian"
      # gp2, not gp3: Canonical never published a gp3 parameter for 22.04, on
      # either architecture, and asking for one resolves to "None".
      WD_CI_AMI_SSM="/aws/service/canonical/ubuntu/server/22.04/stable/current/${WD_CI_DEB_ARCH}/hvm/ebs-gp2/ami-id"
      ;;
    debian-12)
      WD_CI_PRETTY="Debian 12 (bookworm)"
      # Not "debian". Debian's cloud images have used `admin` for years, and
      # guessing the distribution's own name here costs a ten-minute round trip
      # to find out.
      WD_CI_LOGIN="admin"
      WD_CI_FAMILY="debian"
      WD_CI_AMI_SSM="/aws/service/debian/release/12/latest/${WD_CI_DEB_ARCH}"
      ;;
    amazonlinux-2023)
      WD_CI_PRETTY="Amazon Linux 2023"
      WD_CI_LOGIN="ec2-user"
      WD_CI_FAMILY="rhel"
      WD_CI_AMI_SSM="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${WD_CI_EC2_ARCH}"
      ;;
    fedora)
      WD_CI_PRETTY="Fedora ${WD_CI_FEDORA_RELEASE}"
      WD_CI_LOGIN="fedora"
      WD_CI_FAMILY="rhel"
      WD_CI_AMI_OWNER="125523088429"
      # The release number is inside the glob, which is what keeps Rawhide,
      # ELN and `-45-Prerelease-` out: none of them carry a bare number here.
      WD_CI_AMI_GLOB="Fedora-Cloud-Base-*${WD_CI_UNAME}-${WD_CI_FEDORA_RELEASE}-*"
      ;;
    rocky-10)
      WD_CI_PRETTY="Rocky Linux 10"
      WD_CI_LOGIN="rocky"
      WD_CI_FAMILY="rhel"
      WD_CI_AMI_OWNER="792107900819"
      # -Base-, not just Rocky-10-: the same account publishes an -LVM- variant
      # under a name identical up to that word, and it is a different disk
      # layout rather than a different distribution — testing it would be
      # testing EC2, not us.
      WD_CI_AMI_GLOB="Rocky-10-EC2-Base-*.${WD_CI_UNAME}"
      ;;
    rocky-9)
      WD_CI_PRETTY="Rocky Linux 9"
      WD_CI_LOGIN="rocky"
      WD_CI_FAMILY="rhel"
      WD_CI_AMI_OWNER="792107900819"
      # Ends in the architecture rather than containing it: both sit in the
      # same account under names identical up to that suffix.
      WD_CI_AMI_GLOB="Rocky-9-EC2-Base-*.${WD_CI_UNAME}"
      ;;
    *)
      echo "unknown distribution: $WD_CI_DISTRO" >&2
      echo "known: ${WD_CI_DISTROS[*]} ubuntu-22.04" >&2
      return 1
      ;;
  esac
}
