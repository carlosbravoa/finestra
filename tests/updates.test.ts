// What each package manager prints, and what is read out of it.
//
// Every block of text here is the real tool's output, captured as an ordinary
// user on the distribution named beside it. That is the point of the file: a
// parser written from a man page reads the format the author imagined, and
// two of these did not survive first contact — dnf 5 prints `\t` in a query
// format as a backslash and a t, and dnf 4 puts a blank line between rows.

import assert from 'node:assert/strict';
import {
  countZypperPatches,
  parseApt,
  parseDnf,
  parseDnfSecurity,
  parseFlatpak,
  parsePacman,
  parseRpmInstalled,
  parseSnap,
  parseSnapInstalled,
  parseZypper,
  zypperError,
} from '../server/src/services/updates.js';

const results: boolean[] = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}  — ${(err as Error).message.split('\n')[0]}`);
  }
}

/* --- apt: Ubuntu 26.04 and Debian 12 ---------------------------------- */

const APT = `Listing...
apt-transport-https/resolute-updates,resolute-updates,resolute-security,resolute-security 3.2.1ubuntu0.1 all [upgradable from: 3.2.0]
base-files/resolute-updates 14ubuntu6.3 amd64 [upgradable from: 14ubuntu6.2]
bind9-host/resolute-updates,resolute-security 1:9.20.24-1ubuntu0.5 amd64 [upgradable from: 1:9.20.24-1ubuntu0.4]
apt/oldstable-security 2.6.2 amd64 [upgradable from: 2.6.1]
bsdutils/oldstable 1:2.38.1-5+deb12u3 amd64 [upgradable from: 1:2.38.1-5+b1]
`;

check('apt: every upgradable line is a row, and "Listing..." is not', () => {
  assert.deepEqual(parseApt(APT).map((p) => p.name),
    ['apt-transport-https', 'base-files', 'bind9-host', 'apt', 'bsdutils']);
});
check('apt: both versions are read, epoch and all', () => {
  const p = parseApt(APT).find((r) => r.name === 'bind9-host')!;
  assert.equal(p.current, '1:9.20.24-1ubuntu0.4');
  assert.equal(p.available, '1:9.20.24-1ubuntu0.5');
  assert.equal(p.arch, 'amd64');
});
check('apt: an update is a security one when a security suite carries it', () => {
  const sec = parseApt(APT).filter((p) => p.security).map((p) => p.name);
  assert.deepEqual(sec, ['apt-transport-https', 'bind9-host', 'apt']);
});
check('apt: a suite listed twice is named once', () => {
  assert.equal(parseApt(APT)[0].origin, 'resolute-updates, resolute-security');
});

/* --- dnf 4 on Rocky 9, dnf 5 on Fedora 41 ----------------------------- */

const DNF4 = `alternatives|x86_64|1.24-2.el9|baseos

audit-libs|x86_64|3.1.5-9.el9|baseos

vim-minimal|x86_64|2:8.2.2637-44.el9_9|baseos
`;
const DNF5 = `xz-libs|x86_64|1:5.8.1-4.fc41|updates
xz|x86_64|1:5.8.1-4.fc41|updates
`;
const DNF_SECURITY = `RLSA-2025:23343 Moderate/Sec.  binutils-2.35.2-67.el9_7.1.x86_64
RLSA-2025:23343 Moderate/Sec.  binutils-gold-2.35.2-67.el9_7.1.x86_64
RLSA-2025:0925  Moderate/Sec.  bzip2-libs-1.0.8-10.el9_5.x86_64
RLSA-2026:88459 Critical/Sec.  ca-certificates-2026.2.92_v9.0.319-90.3.el9_8.noarch
`;

check('dnf 4: the blank line it puts between rows is not a row', () => {
  assert.deepEqual(parseDnf(DNF4).map((p) => p.name), ['alternatives', 'audit-libs', 'vim-minimal']);
});
check('dnf 5: the same query reads the same way', () => {
  assert.deepEqual(parseDnf(DNF5).map((p) => `${p.name} ${p.available} ${p.origin}`),
    ['xz-libs 1:5.8.1-4.fc41 updates', 'xz 1:5.8.1-4.fc41 updates']);
});
check('dnf: a query answered with literal \\t is not mistaken for rows', () => {
  assert.equal(parseDnf('xz-libs\\tx86_64\\t1:5.8.1-4.fc41\\tupdates\n').length, 0);
});
check('dnf: what is installed is keyed by name and architecture', () => {
  const have = parseRpmInstalled('bash|x86_64|5.2.32-1.fc41\nglibc|x86_64|2.40-28.fc41\npackage nosuch is not installed\n');
  assert.equal(have.get('bash.x86_64'), '5.2.32-1.fc41');
  assert.equal(have.size, 2);
});
check('dnf: an advisory names its package, dashes in the name included', () => {
  assert.deepEqual([...parseDnfSecurity(DNF_SECURITY)].sort(),
    ['binutils', 'binutils-gold', 'bzip2-libs', 'ca-certificates']);
});

/* --- zypper on openSUSE Leap 15.5 ------------------------------------- */

const ZYPPER = `<?xml version='1.0'?>
<stream>
<update-status version="0.6">
<update-list>
<update kind="package" name="aaa_base" edition="84.87+git20180409.04c9dae-150300.10.23.1" arch="x86_64" edition-old="84.87+git20180409.04c9dae-150300.10.20.1"><summary>openSUSE Base Package</summary><description>This package installs several important configuration files and central scripts.</description><license/><source url="http://download.opensuse.org/update/leap/15.5/sle/" alias="repo-sle-update"/></update><update kind="package" name="bash" edition="4.4-150400.27.3.2" arch="x86_64" edition-old="4.4-150400.25.22"><summary>The GNU Bourne-Again Shell</summary><description>Bash is an sh-compatible command interpreter that executes commands
read from standard input or from a file.</description><license/><source url="http://download.opensuse.org/update/leap/15.5/sle/" alias="repo-sle-update"/></update>
</update-list>
</update-status>
</stream>`;
const ZYPPER_PATCHES = `<update kind="patch" name="openSUSE-SLE-15.5-2024-3420" edition="1" arch="noarch" status="needed" category="security" severity="moderate" pkgmanager="true" restart="false" interactive="false"><summary>x</summary></update><update kind="patch" name="openSUSE-SLE-15.5-2024-3718" edition="1" arch="noarch" status="needed" category="security" severity="important"><summary>y</summary></update>`;
const ZYPPER_UNREFRESHED = `<?xml version='1.0'?>
<stream>
<message type="error">Problem
[repo-oss|http://download.opensuse.org/distribution/leap/15.5/repo/oss/] Valid metadata not found at specified URL
History:
 - Can&apos;t create /var/cache/zypp/raw/repo-oss
</message>
</stream>`;

check('zypper: packages are read with the version they replace', () => {
  const rows = parseZypper(ZYPPER);
  assert.deepEqual(rows.map((p) => p.name), ['aaa_base', 'bash']);
  assert.equal(rows[1].current, '4.4-150400.25.22');
  assert.equal(rows[1].available, '4.4-150400.27.3.2');
  assert.equal(rows[1].origin, 'repo-sle-update');
});
check('zypper: patches are counted, and are not packages', () => {
  assert.equal(countZypperPatches(ZYPPER_PATCHES), 2);
  assert.equal(parseZypper(ZYPPER_PATCHES).length, 0);
});
check('zypper: a machine never refreshed says so in words', () => {
  assert.match(zypperError(ZYPPER_UNREFRESHED), /Valid metadata not found/);
});

/* --- pacman on Arch ---------------------------------------------------- */

check('pacman: old and new are either side of the arrow', () => {
  const rows = parsePacman('ca-certificates-mozilla 3.133-1 -> 3.134-1\ncoreutils 9.12-2 -> 9.12-3\n');
  assert.deepEqual(rows.map((p) => `${p.name}:${p.current}:${p.available}`),
    ['ca-certificates-mozilla:3.133-1:3.134-1', 'coreutils:9.12-2:9.12-3']);
});
check('pacman: a warning about a missing database is not an update', () => {
  assert.equal(parsePacman("warning: database file for 'core' does not exist (use '-Sy' to download)\n").length, 0);
});

/* --- snap and flatpak, on this workstation ----------------------------- */

const SNAP = `Name           Version                         Rev   Size    Publisher    Notes
chromium       158.0.8127.36                   3604  198MB   canonical**  -
core22         20261022                        3129  77.6MB  canonical**  base
`;
check('snap: the header is not a snap, and the publisher loses its stars', () => {
  const rows = parseSnap(SNAP);
  assert.deepEqual(rows.map((p) => `${p.name} ${p.available} ${p.origin}`),
    ['chromium 158.0.8127.36 canonical', 'core22 20261022 canonical']);
});
check('snap: "All snaps up to date." is no rows', () => {
  assert.equal(parseSnap('').length, 0);
});
check('snap: the installed version comes from the list', () => {
  const have = parseSnapInstalled('Name  Version  Rev  Tracking  Publisher  Notes\nchromium  157.0.1  3590  latest/stable  canonical**  -\n');
  assert.equal(have.get('chromium'), '157.0.1');
});
check('flatpak: a runtime with no version still has a name and a branch', () => {
  const rows = parseFlatpak('com.github.polymeilex.neothesia\t\tstable\tflathub\norg.freedesktop.Platform.GL.default\t\t25.08\tflathub\n');
  assert.deepEqual(rows.map((r) => `${r.app}/${r.branch}/${r.version}`),
    ['com.github.polymeilex.neothesia/stable/', 'org.freedesktop.Platform.GL.default/25.08/']);
});

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
