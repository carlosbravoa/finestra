# Apps a sysadmin actually needs

What a remote desktop needs to be worth opening instead of just running `ssh`.

The bar for each of these is: **would you reach for this rather than the
terminal that is already one click away?** An app that is a worse `htop` is
worth nothing. The ones that earn their place either show more at once than a
terminal can, keep state across a reconnect, or turn a fiddly multi-command
operation into one that is hard to get wrong.

Sorted by value per unit of effort.

## Build these first

### Text editor — `fs.read` / `fs.write`
The single highest-value app. Editing `/etc/nginx/nginx.conf` in a real editor
with syntax highlighting beats `vi` over a laggy link, and it is the thing that
makes file associations mean something. CodeMirror 6 is the obvious choice.

Must have: dirty-state guard in `onClose`, an explicit save (never autosave to
`/etc`), and a visible warning when the file is not writable by the current
user. Should show the file's mode and owner — half of config editing is
discovering you needed `sudo`.

*Needs:* nothing new. `fs.read`/`fs.write` already exist, though the 8 MB cap
and full-buffer reads should be revisited for large logs.

### Log viewer — new `logs` service
Tailing is what a terminal is worst at: you lose scrollback, you cannot search
without stopping, and you cannot follow four files at once. A viewer with live
follow, a filter box, level highlighting, and a pause button is strictly
better.

Should cover both files (`/var/log/*`) and `journalctl -fu <unit>`. Follow is a
channel; filtering happens client-side on a bounded ring buffer so it never
grows without limit.

*Needs:* a `logs` service. Non-trivial: it must handle rotation, and cap the
backlog it reads on open.

### Service manager — new `systemd` service
`systemctl status` for one unit is fine. Finding the failed unit among two
hundred is not. A sortable, filterable list with state, sub-state and a
description, plus start/stop/restart/enable and a jump to that unit's logs.

This is the first app that *changes* things, so it needs care: confirm
destructive actions, show the actual error when polkit refuses, and never
pretend a request succeeded because the command exited zero.

*Needs:* a `systemd` service. Use `systemctl --output=json` where available
rather than scraping human output.

### Process manager
`htop` in a window is not obviously better than `htop` in a terminal — but
sortable columns, a persistent filter, and a details panel with open files and
the full command line are. Include the terminal's own PTYs so you can see what
the desktop itself is costing.

*Needs:* a `proc` service reading `/proc`, plus a guarded `kill`.

### Disk usage
"Why is `/` full" is a routine emergency and answering it with `du | sort` is
miserable. A treemap or a drill-down list with sizes, scanned incrementally
over a channel so a huge tree streams in rather than hanging.

*Needs:* a scanning channel in `fs`. Must be cancellable — a scan of `/` on a
big disk has to stop when the window closes.

## Build these once the basics work

### System monitor
CPU, memory, load, network and disk I/O over time. `sys.stats` already returns
most of it. Genuinely better than a terminal because it can show history and
several metrics side by side. Cheap to build; worth doing early for the
dashboard feel even if it is not the most useful.

### Network / ports
Listening sockets with the owning process, plus active connections. Answers
"what is on 8080" without remembering `ss -ltnp` flags.

### User and group manager
Listing users, group membership, shell, last login. Editing them is riskier —
consider read-only first.

### Package manager
Updates available, install, remove, and crucially *what needs a reboot*. Big
surface and distro-specific; a read-only "what is out of date" view delivers
most of the value for a fraction of the work.

### Cron / timer editor
Both `crontab` and systemd timers, showing next run time. Editing cron in a
form with a human-readable schedule preview prevents a whole class of mistakes.

### Firewall
`nftables`/`ufw` rules. High risk of locking yourself out of the machine, which
argues for read-only first, and for a confirm-then-auto-revert pattern if it
ever becomes writable.

## Worth it for a particular server

- **Docker / Podman** — containers, images, logs, exec into one. Effectively a
  second desktop's worth of work; only if the box runs containers.
- **Database client** — Postgres/MySQL/SQLite browser and query runner.
- **Backup status** — last run, size, failures for whatever tool is in use.
- **Certificate manager** — what expires when. Small, and prevents a specific
  recurring outage.
- **Hardware / SMART** — disk health, temperatures, RAID state.

## Support apps the desktop itself needs

- **Settings** — wallpaper, theme, terminal defaults, enabled apps, file
  associations, session-restore toggle. These options exist today but are
  scattered across context menus. This is also the natural home for the app
  enable/disable UI from `docs/app-installation.md`.
- **File transfer** — upload and download. Not really an app, but it needs a UI
  and it is the most-missed capability after an editor.

## What not to build

- **A second terminal.** Multiplexing, splits and tabs belong *in* the terminal
  app, not in a rival one.
- **A generic "run a command" app.** That is the terminal, with worse
  ergonomics and the same privileges.
- **Anything that only reformats one command's output.** If it is not showing
  more at once, keeping state, or preventing a mistake, it is not worth a
  window.
