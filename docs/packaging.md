# Packaging: getting it onto a machine that has never seen it

Status: **works, and is checked on a real machine every time it is built.**
`packaging/aws/build.sh` produces a tarball; `packaging/aws/verify.sh` installs
it on a pristine cloud instance and proves it runs.

## Why this is not just `npm install`

Three things in this project are native, and each one pins something:

| Thing | Pinned to |
|---|---|
| `wdcomp`, the Wayland compositor | glibc, and the architecture |
| `node-pty` | **the Node ABI**, glibc, and the architecture |
| everything else | nothing — plain JavaScript |

`node-pty` ships no Linux prebuilt binary, so it is compiled from source at
install time by anyone doing this the ordinary way — which means a toolchain,
Python, and node-gyp on every server that runs this. That is a poor thing to ask
of a machine whose entire job is to be a server.

So the release carries **its own Node runtime**, and the native modules are
compiled against *that* runtime rather than whatever the host happens to have.
The ABI matches by construction instead of by luck, and installing needs no
compiler, no `npm`, and no third-party apt repository.

## Where it is built, and why that matters

On **Ubuntu 24.04**, in the cloud, not on a workstation.

A binary linked against a newer glibc will not start on an older one — the
reverse is fine. This project is developed on Ubuntu 26.04 (glibc 2.43); a
tarball built there would fail on every 24.04 server with a `GLIBC_2.4x not
found` that arrives only at run time, on someone else's machine. Building on the
oldest release we intend to support removes the whole class of problem.

The builder is a throwaway instance that is destroyed when the build ends. It
also means the build is reproducible by anyone with an AWS account and no
particular workstation setup.

## What ships

```
finestra-<version>-linux-x64.tar.gz
└── finestra-<version>/
    ├── MANIFEST            version, node, distro it was built on, glibc, arch, date
    ├── install.sh
    ├── runtime/bin/node    the runtime the native modules were compiled against
    ├── app/
    │   ├── server/src/     compiled server
    │   ├── shared/         compiled shared protocol
    │   ├── client/         the built client, served as static files
    │   └── node_modules/   production dependencies, ws + node-pty
    └── libexec/wdcomp      the compositor
```

Roughly 70–90 MB compressed, most of which is the Node runtime. That is the
price of not needing a compiler on the target, and it is worth paying.

## Versions

For a long time every build was `0.1.0`, plus a commit sha to tell them apart.
That is not a version, it is a serial number: nobody can say it out loud, two
installs cannot be compared without looking up which sha came first, and a bug
report that says "0.1.0" narrows nothing.

The convention now:

- **`package.json` holds the number a human chose.** One place; the workspaces
  and the lockfile follow it.
- **A tag `v<version>` claims a commit for that number.** `build.sh` runs
  `git describe --tags --match 'v[0-9]*' --long --dirty` and **refuses to build
  if the nearest tag disagrees with `package.json`** — a mismatch means one of
  the two was forgotten, and either number would misdescribe the tarball.
- **On the tag, the version is bare: `0.2.0`.** That is the release, and it is
  the whole point of the arrangement.
- **Off the tag it says how far off:** `0.2.0+3.g1a2b3c4` is three commits past
  `v0.2.0`. A dirty tree appends `.dirty`. A source tree with no build at all
  reports `0.2.0+dev`.

Everything after the `+` is semver build metadata, and the separator inside it
is a dot rather than a dash so a sha can never be read as a pre-release suffix.
Keep it to `[0-9A-Za-z.-]`: `publish.sh` has to rewrite that `+` into something
S3 will not read as a space, and anything exotic makes the substitution a guess.
`tests/version.mjs` pins the shape.

Cutting a release is therefore: bump `package.json`, commit, `git tag v0.2.1`,
build.

### Where a version can be read

Six places, all from the same string:

| | |
|---|---|
| `finestra version` | The first thing to ask for in a bug report. Answers with no desktop connected, because that is usually why someone is asking |
| The About dialog | Desktop menu → About. Names the **shell** and the **server** separately |
| The startup banner | `Finestra 0.2.0 · user@host (linux/x64)`, on both the listening and the dialling paths |
| `MANIFEST` | In the install tree. What `install.sh` and `update.sh` compare |
| `hello` | `host.build` on every connection, so the shell learns it without asking |
| The tarball name | `finestra-<version>-linux-x64.tar.gz` |

The About dialog shows two numbers on purpose. The shell is whatever the browser
loaded and the server is whatever that machine has installed, and after an
update they disagree until the page is reloaded — which looks exactly like an
update that did nothing. It reports the *target* host, because with several
servers in one shell an answer that does not say which machine it describes is
worse than no answer.

The shell's copy is baked in by Vite from `WD_VERSION`, which `build.sh`
exports, so both halves name one build rather than each guessing from what it
can see. The server's copy comes from `MANIFEST` if there is one and from
`package.json` if there is not — `server/src/version.ts` walks up from itself
looking for each in turn.

## Installing

```bash
tar xzf finestra-<version>-linux-x64.tar.gz
cd finestra-<version>
sudo ./install.sh
```

It asks who the desktop should run as, installs to `/opt/finestra/<version>`
with a `current` symlink, puts state in that account's `~/.local/state/`, writes
a systemd unit, and starts it. `sudo ./install.sh --uninstall` reverses all of
that and deliberately keeps the state directory, so an uninstall does not throw
away the token and settings.

Two deliberate defaults that people will ask about:

- **It listens on 127.0.0.1.** Reaching a root-capable UI from elsewhere should
  be a decision, taken by forwarding a port over SSH or putting a reverse proxy
  in front — never the default.
- **It runs as the person who installed it.** See below; the alternative is
  offered at install time and is a different product.

And one deliberate omission:

- **It installs nothing from a package manager.** The compositor needs two
  shared libraries at runtime — `libwayland-server.so.0` and
  `libxkbcommon.so.0` — and the installer reports whether they are there
  instead of fetching them. They buy exactly one feature, native Linux
  applications in a window; a machine that will only ever use the terminal, the
  files and the system tools should not acquire a Wayland library because a
  desktop was installed on it. `install.sh` prints the install line for the
  manager it finds, and so does the applications window, which runs the same
  check (`available()` in `server/src/services/wayland.ts`) every time it opens
  — so installing them takes effect on **Try again**, with no restart and no
  reload. This is also why the release tarball is still an install with no
  network dependency at all beyond fetching the tarball itself.

  Both places name packages per manager rather than assuming `apt`, because a
  soname is the same everywhere and a package name is not: Debian's
  `libwayland-server0` is Fedora's `libwayland-server` and Arch's `wayland`.
  `apt`, `dnf`, `zypper` and `pacman` are covered; anything else is told the
  sonames and left to name its own packages, because an install command that is
  wrong costs more than one that is missing.

### Who it runs as

This was got wrong once, in the direction that looks responsible. The installer
created a `web-desktop` system account with no home, no login shell and no
groups, and ran everything as that. Every check passed. The result was a desktop
that could draw windows over a machine it could not read: no home directory to
open or upload into, an empty log viewer because reading the journal is a group
membership, `/var/lib/web-desktop` as the only writable place to put a file, and
`NoNewPrivileges=yes` making every `sudo` in the terminal fail however complete
the sudoers entry was. What is left of a desktop, at that point, is
observability.

The hardening also bought nothing. Reaching the port means reaching loopback,
and reaching loopback means already holding an SSH session as the account that
installed this — the tunnel is the authentication boundary, and always was. A
desktop that runs as that same account can do what that session can do and no
more. Locking it down further protects the machine from its own owner.

So the installer asks, and the answer is recorded in the unit so that upgrades
keep it:

| choice | account | what it is |
|---|---|---|
| 1 (default) | the installing user | a desktop: home, journal, sudo |
| 2 `--no-privilege` | the installing user | home and journal, nothing privileged |
| 3 `--system-account` | `finestra` | observability, and nothing else |

The asking lives in `configure.sh`, not `install.sh`, and that split is the
point: `install.sh` deletes itself from the tree it writes — it is also what
removes that tree, and a script cannot be read from a file it has deleted — so
anything left inside `install.sh` could never be run again. `configure.sh` stays
behind next to `update.sh`, which makes the choice changeable on a machine that
no longer has the tarball it was installed from:

```bash
sudo /opt/finestra/current/configure.sh --show
sudo /opt/finestra/current/configure.sh --system-account
```

It rewrites the unit, moves the state directory to follow the account, carries
the token across so an open tab and a bookmark keep working, and restarts.
`install.sh` hands over to it with `--keep`, which is what makes an upgrade
quiet: with a recorded answer it keeps it rather than asking. Only a unit
carrying the `# wd-choice=1` marker counts as recorded — every install predating
the question says `User=web-desktop` because nothing else was on offer, and
treating that as a decision would preserve this fault on exactly the machines
that have it.

Two things fall out of that, both learned the hard way:

- **Privilege and the sandbox are one choice, not two.** In the privileged
  shape the unit carries no `Protect*` or `Restrict*` options at all, because
  each of them takes back part of what the choice just granted:
  `ProtectKernelModules`, `ProtectKernelTunables`, `RestrictSUIDSGID`,
  `RestrictRealtime` and `LockPersonality` each imply `NoNewPrivileges` back on
  — and with it every setuid binary, `sudo` included, becomes inert — while
  `ProtectSystem=full` leaves `/usr` read-only, so `sudo apt install` gets as
  far as unpacking and then fails. `systemctl show` reports the value that was
  written rather than the one in force; `/proc/<pid>/status` is the only answer
  that counts, which is what the verifier checks.
- **The journal is a group, not a permission.** Any account gets an empty log
  viewer unless it is in `adm` or `systemd-journal`. An ordinary cloud-image
  account already is; the system account is in nothing, so the installer adds
  it — otherwise the one thing that mode is *for* would not work either.

### What can reach it

The other half of the same question, and the same script owns it:

```bash
sudo /opt/finestra/current/configure.sh --bind 0.0.0.0     # every interface
sudo /opt/finestra/current/configure.sh --bind 100.83.0.4  # one address
sudo /opt/finestra/current/configure.sh --no-token         # no login at all
sudo /opt/finestra/current/configure.sh --bind local --token
```

Loopback and a token remain the defaults, and the reasoning above is why: the
tunnel is the authentication boundary, so the port is only reachable by someone
who already has a shell here. But that reasoning is an argument for a default,
not for a refusal. A machine on a network its owner controls — a tailnet, a
LAN behind their own router, a lab with no route out — is a real thing to
install onto, and there the tunnel is a tax rather than a boundary.

Neither flag asks for confirmation and neither can be refused. The alternative
is not a safer install; it is a hand-edited unit, and `configure.sh` rewrites
that whole file on every upgrade — so the person who worked around the tool
loses their setting on a routine update, in the one place nothing will explain
it. What the tool owes them instead is an accurate account: it warns at the
point of choosing, records the choice in the unit, prints what it opened, and
answers for it in `--show`.

Four details that are not obvious:

- **No marker, unlike the account.** `User=` needed `# wd-choice=1` because
  `User=web-desktop` is ambiguous — it is what every unit written before the
  question existed says. `WD_HOST=127.0.0.1` and an absent `WD_NO_AUTH` are not
  ambiguous: they are exactly what someone who never touched this wants kept.
  So the unit is read, and reading it is the record.
- **It is read whether or not `--keep` was passed.** The account is re-asked
  when `configure.sh` is run by hand, so `--keep` is what distinguishes an
  upgrade from a change. Reach is never asked, so there is no run that re-asks
  it — and without this, a `configure.sh` invoked months later to move the
  desktop to another account would silently close the port on the way past.
- **The health check follows the bind.** A service bound to one VPN address
  answers nothing on `127.0.0.1`, and both callers of the health check treat no
  answer as a reason to roll back — so a loopback assumption would turn every
  update of an opened install into a failed one, and every `configure.sh` run
  into a rollback. `configure.sh --health-url` is the one definition; `update.sh`
  asks it, the same way it already asks `--state-dir`.
- **A drop-in still wins.** `systemctl edit` writes
  `finestra.service.d/override.conf`, which is merged after the unit, so
  anything set there overrides what `configure.sh` just wrote. It reads the
  effective environment back out of `systemctl show` after `daemon-reload` and
  says so rather than reporting a bind it did not get. It never removes the
  drop-in: a file someone wrote by hand in `/etc` is theirs.

Binding one address of a VPN is tighter than `0.0.0.0` and more fragile. The
address exists only once the tunnel is up, the unit is not ordered against
`tailscaled` or `wg-quick`, and a service that wins that race exits with
`EADDRNOTAVAIL` — after which `Restart=on-failure` gives up within seconds and
what anyone sees is a service that will not start for no visible reason.
`configure.sh` warns when no interface currently carries the address. The shape
that survives a reboot is `--bind 0.0.0.0` with the firewall deciding
(`ufw allow in on tailscale0 to any port 7070`), or loopback with
`tailscale serve` in front of it.

The token file is left in place under `--no-token` rather than deleted, so
`--token` later gives back the same token and every bookmarked `?t=` URL still
works. The server never writes one while `WD_NO_AUTH=1` is set, so a first
install made with `--no-token` simply has no token file until it is turned on.

## Verifying

```bash
packaging/aws/build.sh          # → dist-release/finestra-<version>-linux-x64.tar.gz
packaging/aws/verify.sh         # installs it on a bare instance and checks it
```

`verify.sh` launches an instance with no Node, no npm and no compiler, prints
that fact so a pass cannot be explained away, installs from the tarball alone,
and then checks: the unit is active, enabled, and running as its own
non-root user; `/healthz` answers; a missing or wrong token is refused and the
installed one is accepted; the built client is served; every service is
advertised over the WebSocket; **a PTY runs a command and returns its output**
(which is the real proof that `node-pty` matches the shipped runtime); the fs and
sys services answer; the wayland service reports its own availability honestly;
the service survives a restart; and uninstall removes the unit but keeps state.

## The cost, and the safety rails

Instances are `t3.small` to build and `t3.micro` to verify, in `us-east-1`, for
a few minutes each — cents per run. They are disposable, and an orphan bills
forever, so there are three independent guarantees against one:

1. `--instance-initiated-shutdown-behavior terminate` plus a `shutdown -h` timer
   in user-data. **The instance kills itself with no help from us**, even if the
   machine driving the build is switched off mid-run.
2. A `trap` in the calling script terminates on every exit path, including
   failure and interruption.
3. `wd_ci_sweep` terminates anything carrying our tag whose expiry has passed,
   and runs at the *start* of every script as well as the end — so the next run
   cleans up after a previous one that died badly.

Nothing is ever terminated by instance id alone: every destructive call filters
on the CI tag and re-checks the tag on the instance itself, so a machine we did
not create cannot be caught by it.

### Four things that went wrong while building this, and what they cost

Worth writing down, because both are ordinary mistakes with unusually
sharp consequences.

**The cleanup trap leaked an instance.** `wd_ci_launch` is called as
`read ... <<<"$(wd_ci_launch ...)"`, and command substitution is a *subshell* —
so the array of launched instances was appended to in the subshell and the
parent's trap found nothing to terminate. The instance ran on after the script
exited. The deadman timer would have killed it 45 minutes later, which is
precisely why that layer exists, but relying on it is relying on the wrong one.
Cleanup now asks EC2 what carries this run's `RunId` tag instead of remembering
locally, which cannot go wrong that way.

**A fresh Ubuntu image killed the SSH session mid-build.** `unattended-upgrades`
runs on boot, takes the dpkg lock, and restarts services — one of which is sshd.
The build died with `Connection reset by peer` and looked, from the log, exactly
like a hang. Fixed twice over: `wd_ci_prepare_host` waits for cloud-init and
disables the apt timers and needrestart's service restarts, and the long build
now runs *detached* via `wd_ci_run_detached`, so losing the connection costs
nothing.

**Jumbo frames stalled every download, and it took two builds to see it.** `apt`
would run for ten minutes with no output, holding its own lock, nothing in
`dpkg.log`. The evidence that finally named it: downloads stopped partway, and
apt's `http` method sat on an **established socket with empty send and receive
queues** — a connection that was open and idle rather than one that had failed.

The interface comes up at MTU 9001, the VPC default. The path to the internet
carries 1500, and the ICMP that path-MTU discovery needs was filtered somewhere
along it, so large segments were silently blackholed. Small exchanges — DNS,
handshakes, package lists — worked perfectly, which is what makes this one so
good at hiding. Setting the interface to 1500 resumed a stalled download
*mid-flight*, 34 MB → 76 MB in twenty-five seconds.

It came back, and that is the part worth remembering. `ip link set mtu` lasts
until the DHCP lease renews, at which point AWS's option set puts 9001 straight
back — mid-build, long after the log had recorded the fix as applied. It is now
pinned in netplan, where an explicit MTU beats the lease.

**A republished version served a stale checksum for hours.** Publishing 0.2.1
uploaded the tarball and its `.sha256` to S3, invalidated the four files that
change, and passed every check. The site then served the *new* tarball beside
the *old* checksum, because that version number had been published once before
and CloudFront still held the first `.sha256` — release keys were deliberately
left out of the invalidation on the reasoning that a release is immutable and
arrives under a new key. Re-cutting a number is exactly the case that breaks,
and the failure it produces is the worst-looking one available: `sha256sum -c`
fails on a good download, which is indistinguishable from a tampered release.

The stale checksum was the symptom. The cause was worse and took longer to see:
**that number had already been released, from a different line of work.** Two
branches each bumped to 0.2.1 and each cut a tag; the second publish overwrote
the first release's tarball in a bucket with no versioning, so two different
builds claimed one number and the older one's bytes stopped existing. The
checksum survived only because CloudFront was still serving it, which is what
made the collision visible at all.

Three changes, because the failure, the reason it went unnoticed, and the reason
it was possible are separate.

`publish.sh` **refuses to publish a version that is already published from a
different build**, comparing checksums so that re-running it on the same
artifact still works. `WD_REPUBLISH=1` overrides and says what it is destroying.
That is the one that matters: a version number is a promise about contents.

It now invalidates this release's own two keys as well — six paths out of a
thousand a month, against the previous reasoning that releases are immutable and
arrive under new keys, which is only true if nothing ever republishes one.

And the check that was supposed to cover this asserted the served checksum file
named the right *file*, which it did; it now asserts the right *hash*, and the
tarball check downloads the whole artifact and hashes it rather than
range-requesting the first kilobyte, because a stale edge answers a range
request exactly like a correct one.

**A caution about that second sighting.** It was found because a build packaged
correctly and then dragged its 58 MB artifact home at six kilobytes a second,
and the reverted MTU was confirmed on the instance. But the workstation's own
connection turned out to be failing at the same time — the next run died on a
ten-second timeout to `checkip.amazonaws.com`, and AWS API calls were taking
ninety seconds. So the reverted MTU is certain and the durable fix is right; the
*slow transfer* had two candidate causes and was blamed on one of them before
the other was known. Restoring the MTU on the live instance did not rescue that
transfer, which was read at the time as a wedged path-MTU state in an
established connection — plausible, and equally explained by a bad local link.

Worth recording that the first diagnosis was wrong: the host has no global IPv6
address while the mirrors publish AAAA records, which is a real and well-known
cause of exactly this symptom, and `Acquire::ForceIPv4` was applied on that
theory. The next build stalled in the same place. The apt timeouts and retries
from that attempt are still there because a fetch should fail rather than block
forever — but they are hardening, not the fix, and the comment in `lib.sh` says
so.

## Updating

```bash
sudo /opt/finestra/current/update.sh <tarball or url>
sudo /opt/finestra/current/update.sh --rollback
sudo /opt/finestra/current/update.sh --list
```

The shape is aria-sysadmin's, deliberately: validate, install beside the running
version, switch, prove it came up, and go back on its own if it did not. **A
machine that updates itself must never be able to update itself into being
unreachable** — that is the one failure nobody can fix remotely, and everything
here is arranged around it.

In order:

1. **Fetch and check before anything is touched.** A `.sha256` published beside
   the tarball is used when it is there. That proves the download arrived
   intact; it proves *nothing* about who made it, which is what signing would do
   and this does not have yet.
2. **Run the new runtime.** One second, and it catches a package built for
   another architecture or a newer glibc *before* the service is switched to it
   rather than after.
3. **Install beside, not over.** `/opt/finestra/<version>` with a `current`
   symlink — the layout exists for this.
4. **Switch and prove.** Symlink swap, restart, then `/healthz` must answer.
5. **Go back by itself if it does not**, print the journal, and leave the bad
   version on disk to look at.

Rollback is the same symlink swap with a different argument, not a separate undo
path. An undo path that only runs during failures is one that has never been
run.

The last three versions are kept and the running one is never removed, so there
is always something to go back to.

### What it is checked against

`packaging/aws/verify-update.sh` does this on a throwaway instance, and the case
it exists for is the third one:

| | |
|---|---|
| A good update | applies, `current` moves, the service answers, the token survives |
| **A broken update** | **puts the old version back by itself and answers again** |
| An explicit `--rollback` | returns to the previous version |
| A corrupt or missing package | refused, with the running service untouched |

The broken package is broken the way a bad release actually is: it installs
cleanly and then throws at startup. A test that used a *corrupt* package would
only prove the tarball check works, which is the easy half.

## Known gaps

- **x86-64 only.** arm64 needs the same build on an arm64 builder; the scripts
  take an instance type, so this is mostly a matter of running it twice.
- **Unsigned.** No GPG signature, no apt or yum repository, no checksum
  published anywhere but next to the tarball. Fine for "a stranger can try it",
  not fine for "install this on production" — and that is the next step, not
  this one.
- **arm64.** The scripts take an instance type, so this is mostly a matter of
  running the build twice — but it has not been done, and `node-pty` and
  `wdcomp` are both architecture-specific, so an x86-64 package will not run on
  a Raspberry Pi or a Graviton box.
