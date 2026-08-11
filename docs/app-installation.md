# Design: installing and enabling apps

Status: **proposal**. Nothing here is built yet.

Today `client/src/main.ts` hard-codes `desktop.register(terminalApp)` and
`desktop.register(filesApp)`. Adding an app means editing the shell and
rebuilding it. This describes how to get to installing an app on a running
server without touching the shell.

## What we already have going for us

Two properties of the current design make this much smaller than it looks.

**`AppRegistry.register()` is a runtime call.** The shell has no compile-time
knowledge of which apps exist; the launcher, taskbar and session restore all
work off the registry. Registering an app fetched at runtime is the same
operation as registering a built-in one.

**Apps need nothing from the shell at runtime.** Look at what an app actually
touches: `ctx.window`, `ctx.desktop`, `ctx.root`, `ctx.params`. All of it
arrives as arguments. `AppManifest` is structural — an object with an `id` and
a `mount` function satisfies it. There is no shell runtime to link against, no
global to inject, no module federation. A third-party app needs our *types* at
build time and literally nothing at run time.

That second property is the one to protect. The moment an app has to
`import { h } from '@finestra/sdk'` at runtime, we own a module graph, a
version-skew problem, and a bundling contract. `h` is forty lines — let apps
copy it.

The one wrinkle: the files app does `err instanceof RpcError`. External apps
cannot, since they have no shared class identity. Duck-type on `err.code`
instead, and document that.

## Package format

```
~/.local/share/finestra/apps/<id>/
  app.json        manifest metadata
  app.js          self-contained ES module
  icon.svg        optional
```

`app.json`:

```json
{
  "id": "editor",
  "name": "Text Editor",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "app.js",
  "icon": "icon.svg",
  "description": "Edit files on the server",
  "category": "Utilities",
  "defaultSize": { "width": 800, "height": 560 },
  "minSize": { "width": 380, "height": 240 },
  "services": ["fs"]
}
```

Metadata is split from code deliberately: the launcher must be able to list,
enable and describe an app **without executing it**. `app.js` default-exports
`{ mount }` plus any manifest fields it wants to override.

`app.js` must be self-contained ESM — no bare specifiers, since there is no
import map in the browser. Authors get there with Vite library mode; that
recipe belongs in the app-authoring skill once this lands.

## Server side: an `apps` service

| Member | Args | Notes |
| --- | --- | --- |
| `list` | — | installed packages, their manifests, and enabled state |
| `enable` / `disable` | `{ id }` | persisted server-side, not in localStorage |
| `install` | `{ source }` | a directory path on the host, or an uploaded archive |
| `remove` | `{ id }` | deletes the package directory |

Plus a static route, `GET /apps/<id>/<file>`, behind the same auth as
everything else, resolved with the traversal guard already used for the client
build.

Enabled state moves to the server rather than `settings`, because "which apps
exist" is a property of the machine, not of one browser profile. Built-in apps
join the same list with a `builtin: true` flag so one UI governs both — that is
what makes "enable" meaningful before any of the install machinery exists.

## Client side: an app loader

At boot, after the connection is up and before session restore:

1. `rpc.call('apps', 'list')`.
2. Skip disabled apps and any whose `apiVersion` we do not implement.
3. `import(/apps/<id>/app.js?v=<version>)` — the query string is the cache
   key, so a reinstall is picked up without a hard reload.
4. Validate the default export has a string `id` and a callable `mount`.
5. Merge `app.json` metadata over the module's exports and
   `registry.register()`.

Each app gets its own `try`/`catch`. A broken app must produce a notification
and a disabled entry in the launcher, never a failed boot. Session restore
already skips records whose app is not registered, so a disabled app's saved
window simply does not come back — and, because we rewrite the session after
restoring, its record is then dropped.

Ordering matters: apps must be registered before `restoreSession()`, which
means the loader sits between `rpc.ready()` and restore in `main.ts`.

## Security

An app loaded this way is not sandboxed. It runs in the shell's realm, can
reach `window` and the DOM, and can call any service over its own socket. The
`services: ["fs"]` field is *documentation and intent*, not enforcement.

This is the ordinary desktop trust model, and worth stating plainly so it is
neither over- nor under-sold. Installing a `.deb`, running a downloaded binary,
or `npm install`ing a package with a postinstall script all execute code as
your user with your full authority — `~/.ssh`, browser cookies, everything.
Sandboxing (Flatpak portals, macOS App Sandbox, UWP) is a recent and still
partial retreat from that default. Installing an app here is the same trust
level as the terminal we already ship, so it is not a regression, and it does
not warrant treating third-party code as a special category of danger.

### The one asymmetry that is not the normal model

The credential is a **bearer token to a remote machine**.

A native app that goes bad owns the machine it runs on — bounded by that
machine, and it ends when the machine is wiped. A Finestra app that goes bad
runs in the browser but holds a token granting shell access to the *server*.
One `fetch()` copies it off-box, and whoever holds it then has a shell on that
server from anywhere, indefinitely, whether or not the browser is still open.
The amplification is remoteness and persistence, not the privilege level.

That is worth fixing on its own merits, independent of any app-install work,
and it is cheap:

1. **Keep the token out of reach of page JavaScript.** The server already sets
   an `HttpOnly` cookie, which script cannot read. The `localStorage` copy in
   `main.ts` exists only to put `?t=` on the WebSocket URL. If the cookie rides
   the WS upgrade unaided — very likely in production, and plausibly through
   the Vite dev proxy — the `localStorage` copy is redundant and should go.
   **Verify before relying on it**, in both dev and production.
2. **Give rotation a UI.** Today rotating means deleting a file on the host and
   restarting. If a token is the thing worth stealing, revoking one should not
   require shell access.

Do these two and the gap between this and a native install largely closes,
without the cost of the next paragraph.

### Real isolation, if it is ever wanted

Genuine containment means the app in an `<iframe>` on a separate origin, with
`DesktopAPI` bridged over `postMessage` and the token never crossing. That is a
much larger project: every API becomes async, direct DOM access goes away, and
an app like the terminal needs its rendering rethought. Browsers do at least
offer origins and iframes as a real boundary, which is more than most operating
systems gave their users for decades — so this is achievable, just not small.

A proxied `DesktopAPI` that refuses undeclared services (Stage 4) is worth
doing to catch honest mistakes and keep manifests truthful, but it is not a
boundary: a hostile app ignores the proxy and opens its own socket.

Meanwhile the sequencing below keeps installation a **local, explicit,
host-side act** — a path on the machine, not a URL from the internet. That is a
deliberate choice to avoid building the frictionless-install path before there
is anything to make it safe.

## Suggested sequencing

**Stage 1 — enable/disable, built-ins only.** An `apps` service with `list`,
`enable`, `disable` over the built-in registry; a settings panel to toggle
them; enabled state persisted server-side. No dynamic loading at all. Small,
useful immediately, and it builds the UI that everything later plugs into.

**Stage 2 — load packages from disk.** The package format, the static route,
the loader. Install by dropping a directory into the apps folder and hitting
refresh. This is the step that ends shell rebuilds.

**Stage 3 — install/remove as operations.** Archive upload, validation, an
installed-apps UI. Needs Stage 2's format to be settled first.

**Stage 4 — declared-service proxying.** Advisory permissions, honestly
labelled.

**Stage 5 — iframe isolation.** Only if third-party apps become a real goal.

Stage 1 is worth doing on its own even if Stage 2 never happens. Stages 2 and 3
are where a "desktop you install on a server" starts to mean
something.

## Open questions

- **Does an app get server-side storage?** A `store` service scoped per app id
  would cover settings, recent files and drafts, and would keep apps from
  polluting the shared `settings` namespace. Probably wanted at Stage 2.
- **File associations.** The files app currently says "no app is registered for
  this". A `handles: ["*.txt", "text/*"]` field plus a resolver in the registry
  would make Open work — and would give an editor somewhere to be launched
  from.
- **Multiple versions / upgrade.** Ignored for now: one version per id,
  reinstall replaces. Revisit only if apps get dependencies.
- **Do built-ins stay compiled in?** Keeping terminal and files in the bundle
  guarantees a working desktop even if the apps directory is broken. Suggest
  yes, permanently.
