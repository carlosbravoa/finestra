# Third-party notices

Finestra itself is licensed under [`LICENSE`](LICENSE). This file covers the
third-party components in the source tree and in the release tarball, and exists
because two audiences ask for it: anyone taking a commercial licence, whose legal
review will want it, and anyone who wants to check what they are installing.

The short version: **everything Finestra redistributes is under a permissive
licence.** Nothing copyleft is bundled, and nothing here restricts commercial
distribution. The pieces that *are* copyleft — the GUI applications the
compositor draws — are never redistributed and never linked against.

## Redistributed in the release tarball

### Node.js runtime — MIT

The release carries its own Node runtime at `runtime/bin/node`, because
`node-pty` has no Linux prebuild and pins the Node ABI (see
[`docs/packaging.md`](docs/packaging.md)). It is the unmodified official binary
for the oldest LTS we support; the exact version is recorded in the release
metadata alongside the tarball.

Node.js is MIT-licensed and its own licence file additionally carries the notices
for the components it embeds, among them V8, libuv, OpenSSL, ICU, zlib, llhttp,
c-ares, nghttp2, brotli and simdjson. That file ships as `runtime/LICENSE-node`
inside the tarball and is the authoritative notice for all of them.

### npm packages — all MIT

Bundled under `app/node_modules`:

| Package | Version | Copyright |
|---|---|---|
| `node-pty` | 1.1.0 | Copyright (c) 2012-2015, Christopher Jeffrey; Copyright (c) 2016, Daniel Imms; Copyright (c) Microsoft Corporation |
| `ws` | 8.21.2 | Copyright (c) 2011 Einar Otto Stangvik |
| `@xterm/xterm` | 5.5.0 | Copyright (c) 2017-2019, The xterm.js authors |
| `@xterm/addon-fit` | 0.10.0 | Copyright (c) 2019, The xterm.js authors |
| `@xterm/addon-web-links` | 0.11.0 | Copyright (c) 2017, The xterm.js authors |

The MIT text is reproduced once at the end of this file; each package's own
`LICENSE` is present in its directory in the release.

### wdcomp

`libexec/wdcomp`, the Wayland compositor in `compositor/`, is part of Finestra
and carries Finestra's licence. It is dynamically linked and bundles nothing —
see the next section.

## Linked at runtime, not redistributed

`wdcomp` links against libraries the operating system provides. They are the
distribution's copies, installed and updated by it, and Finestra ships none of
them:

| Library | Licence |
|---|---|
| `libwayland-server` | MIT |
| `libxkbcommon` | MIT |
| `zlib` (`libz`) | zlib licence |
| `libffi` | MIT |
| `glibc` (`libc`, `libm`, …) | LGPL-2.1-or-later — dynamically linked, unmodified, not distributed |

## In the source tree, not in the release

### Wayland protocol definitions — `compositor/protocols/`

The protocol XML is vendored on purpose: which files a distribution ships is a
property of its release date, and 24.04 as released was missing one we need (the
long version is in [`docs/wayland.md`](docs/wayland.md)). Each file carries its
own notice in its header — MIT or HPND, depending on the protocol — and copying
them keeps that notice attached, which is exactly why they were copied rather
than referenced.

These files generate glue at build time. They are not part of the release tarball.

### Build and development tooling

TypeScript, Vite, tsx, `@types/*` and `concurrently` are development
dependencies. They build the product; they are not shipped in it.

## Not redistributed at all

The Linux applications the compositor displays — GTK and Qt programs, GNOME
Disks, Firefox, whatever the user installs — are installed by the user through
their own package manager and run as ordinary Wayland clients. Finestra speaks a
protocol to them across a socket. It does not link them, contain them, or
distribute them, and their licences, copyleft included, do not reach it.

---

## The MIT License

All packages listed above as MIT are under these terms, with the copyright notice
as attributed:

```
Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Keeping this accurate

Adding a runtime dependency means adding it here. `npm ls --omit=dev --all` in
`server/` and `client/` lists exactly what the release bundles; anything in that
output and absent from this file is a gap.
