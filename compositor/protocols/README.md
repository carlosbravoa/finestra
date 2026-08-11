# Vendored Wayland protocol definitions

Copied verbatim from **wayland-protocols 1.47**. `wayland-scanner` generates the
marshalling code from these at build time, so none of the protocol code is
hand-written — it is just no longer read out of `/usr/share/wayland-protocols`.

| File | Upstream path |
| --- | --- |
| `xdg-shell.xml` | `stable/xdg-shell/xdg-shell.xml` |
| `cursor-shape-v1.xml` | `staging/cursor-shape/cursor-shape-v1.xml` |
| `tablet-v2.xml` | `stable/tablet/tablet-v2.xml` |

Each file carries its own MIT copyright notice in a `<copyright>` element; that
is the licence they are used under, and copying them keeps it attached.

## Why they are here and not read from the system

Because which of them a distribution has is not a property of the protocol, it
is a property of the year:

| Distribution | wayland-protocols | `cursor-shape-v1` | `stable/tablet-v2` |
| --- | --- | --- | --- |
| Ubuntu 22.04 | 1.25 | no | no — `unstable/` only |
| Ubuntu 24.04, as released | 1.34 | yes | **no** |
| Ubuntu 24.04 with `-updates` | 1.45 | yes | yes |
| Ubuntu 25.10 and later | 1.45+ | yes | yes |

The release is built on 24.04, so until now the build worked only because
`build.sh` runs `apt-get update` first and picks up 1.45 from `-updates`: a
stable-release build quietly depending on an SRU. On 22.04 there is no such
update to pick up, and two of the three files simply do not exist — which is
what made "just build on an older base to lower the glibc floor" impossible.

`tablet-v2` is here for one reason only: `cursor-shape-v1` references
`zwp_tablet_tool_v2` in a request we do not implement, and the symbol still has
to exist at link time.

## Will an older wayland-scanner parse them?

Vendoring newer XML than the build host's libwayland would be a trap if these
used anything recent. They do not. Every attribute across the three files is
`name`, `summary`, `type`, `value`, `interface`, `since`, `version`, `enum`,
`allow-null`, `bitfield` and `encoding` — the newest of those, `enum` and
`bitfield`, have been understood since wayland 1.11 in 2016. In particular
there is **no `deprecated-since`**, which is the attribute that would demand a
scanner from 1.23 or later.

So 22.04's wayland-scanner 1.20 should handle them. Only a real build there
proves it, but the risk is characterised rather than assumed.

## Updating them

Copy the newer file over, rebuild, and run `npm test` — `tests/wayland.mjs`
exercises the protocol paths against a real application. Record the new version
in the heading above. There is no reason to track upstream closely: these are
stable protocols, and moving costs more than it gains unless something is
actually needed from a newer revision.
