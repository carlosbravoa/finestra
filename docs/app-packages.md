# App packages: installing an app without rebuilding the shell

Status: **works.** A package is a directory on the server; the shell lists it,
launches it and restores its windows like any built-in app. Installing one is
copying the directory into place. Install and remove as operations, and a
place to get packages from, are the next stage — see `app-installation.md`.

This is the specification. It is written for someone — or something — building
an app against Finestra without reading the shell's source, so it is complete
rather than short. The decisions behind it are in `app-installation.md`.

## Why this is two files and no toolchain

An app is a manifest with a `mount` function (`client/src/core/types.ts`).
Everything it can reach arrives as an argument to `mount`: the window, a DOM
node to render into, the `DesktopAPI`, and its parameters. It imports nothing
from the shell at run time, so there is no SDK to link against, no module graph
to share and no version to agree on. A package is therefore the smallest thing
that can carry a manifest and a function:

```
<state>/apps/<id>/
  app.json     the manifest — read by the server, never executed
  app.js       an ES module exporting `mount`
  app.css      optional; a stylesheet the shell puts on the page once
```

`<state>` is the service's state directory: `/var/lib/finestra` when it runs
as the system account, `~/.local/state/finestra` when it runs as a person —
`configure.sh --state-dir` prints the one in use. The directory must not be
world-writable, and the server will say so and list nothing if it is.

`examples/hello/` in this repository is a complete package in plain
JavaScript. Copy it, rename it, and it runs.

## `app.json`

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "app.js",
  "style": "app.css",
  "icon": "👋",
  "description": "The smallest app package",
  "category": "Utilities",
  "singleton": false,
  "showOnDesktop": false,
  "showInLauncher": true,
  "restorable": true,
  "resizable": true,
  "startMaximized": false,
  "defaultSize": { "width": 520, "height": 360 },
  "minSize": { "width": 300, "height": 200 },
  "handles": [{ "verb": "View", "extensions": [".hello"] }]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `^[a-z0-9][a-z0-9-]{0,63}$`, and **equal to the directory name**. Used by `launch()`, session restore and the enable toggle, so it is forever. Cannot be the id of an app that ships with the shell. |
| `name` | yes | Shown in the launcher and the window title. |
| `version` | yes | Shown in Settings. Not compared, not parsed. |
| `apiVersion` | yes | The contract this package was written against. Today `1`. A shell refuses anything higher than it implements and says so. |
| `entry` | yes | A bare filename in the package: the module exporting `mount`. |
| `style` | no | A bare filename: CSS injected into the page the first time the app is launched. |
| `icon` | no | An emoji, or an inline `<svg>` string using `currentColor`. Default 📦. |
| `description`, `category` | no | Launcher grouping and the hint under the name. Category defaults to `Applications`. |
| `singleton` | no | Launching again focuses the existing window. |
| `showOnDesktop`, `showInLauncher` | no | Defaults: no icon on the desktop; listed in the launcher. |
| `restorable` | no | Default true: windows reopen after a reload, with what `saveState` returned. |
| `resizable`, `startMaximized`, `defaultSize`, `minSize` | no | Window geometry. Sizes are `{ "width", "height" }` in CSS pixels. |
| `handles` | no | File associations: `extensions` (with the dot), `names` (exact), `fallback`, `verb` (`Open` by default), `priority`. Each entry must claim something. |

Every field after `icon` maps onto `AppManifest` by name. The manifest is
JSON, so the one thing it cannot carry is a function: `handles[].matches` does
not exist here. A manifest that fails any rule above is still listed, in
Settings, with the reason — a package that silently does not appear is the one
failure nobody can diagnose from the browser.

## `app.js`

An ES module. The shell reads it over its own socket and evaluates it in the
page the first time a window of the app opens — not when the desktop starts,
and not again. Two export shapes are accepted:

```js
export function mount(ctx) { … }          // or:
export default { mount(ctx) { … } };
```

`mount` receives an `AppContext` and returns an `AppInstance`, directly or as
a promise. Both are in `client/src/core/types.ts`, which is short and is the
whole contract; the parts that matter most:

```ts
interface AppContext {
  window: WindowHandle;            // setTitle, setStatus, setMenu, close, on('resize' | 'focus' | …)
  root: HTMLElement;               // render here; the shell owns everything outside it
  desktop: DesktopAPI;             // rpc, launch, notify, confirm, prompt, contextMenu,
                                   // openFile, clipboard, settings, shortcuts, host, events
  params: Record<string, unknown>; // what launch() was called with, or what saveState() returned
}

interface AppInstance {
  destroy?(): void;                // release every timer, channel and global listener
  onResize?(size): void; onFocus?(): void; onBlur?(): void;
  onClose?(): boolean | Promise<boolean>;   // false vetoes the close
  menu?: MenuItem[];
  saveState?(): Record<string, unknown> | undefined;   // JSON only; called synchronously
}
```

Rules, each of which has already cost someone an afternoon:

- **No bare imports.** There is no import map and no bundler at run time;
  `import x from 'lodash'` fails to resolve. Bundle dependencies into the
  file (see "Building with TypeScript") or do without.
- **Nothing from the shell.** The module cannot import the shell's modules —
  they are hashed into its bundle and not addressable. Everything you need
  arrives through `ctx`. The `h` helper in `examples/hello/app.js` is the one
  thing worth copying.
- **Errors by code, not by class.** `desktop.rpc.call` rejects with an `Error`
  whose `name` is `'RpcError'` and which carries `code` — `'ENOENT'`,
  `'EACCES'`, `'EPERM'`, `'EINVAL'`, `'EOFFLINE'` when disconnected. There is
  no class to `instanceof` against; check `err.code`.
- **`desktop.clipboard`, never `navigator.clipboard`.** The desktop is plain
  http behind an SSH tunnel; the browser refuses the system clipboard there,
  and the desktop's own one works between its windows regardless.
- **No `window.alert/confirm/prompt`.** They stall every window's streaming.
  `desktop.notify/confirm/prompt` are the replacements.
- **Guard every continuation after an `await` with a `disposed` flag** set in
  `destroy`, and release intervals, `requestAnimationFrame`, channels and
  listeners on `window`/`document` there. The window can close mid-request.
- **Measure only when there is a size.** A minimized window's content box is
  0×0; anything that lays out from `clientWidth` must bail and redo the work
  in `onFocus`.
- **`params` is untrusted.** It survives reloads and is whatever the last
  `saveState` said, or whatever another app passed to `launch`. Treat every
  field as optional.

### The server, from an app

`desktop.rpc.call(service, method, args)` for request/response and
`desktop.rpc.openChannel(service, method, args, handlers)` for streams.
`desktop.rpc.hasService(name)` says whether a server offers one, so an app
can degrade on an older install instead of failing.

| Service | What it does |
|---|---|
| `fs` | `home`, `list`, `stat`, `read`, `write`, `mkdir`, `rename`, `remove` — files, 8 MB per read |
| `pty` | `spawn` (channel), `shells`, `cwd`, `status` — terminals |
| `sys` | `info`, `stats` — hostname, load, memory, disks |
| `proc` | `list`, `detail`, `kill` — processes |
| `systemd` | `units`, `unit`, `control`, `power` — services and the machine |
| `journal` | `lines`, `follow` (channel) — the log |
| `net` | `sockets` — what is listening and connected |
| `certs` | `scan` — TLS certificates found on the host |
| `shell` | opening paths from a terminal command |
| `wayland` | launching and pinning native Linux applications |
| `apps` | `list`, `read`, `setEnabled` — this document's own machinery |

`server/src/services/<name>.ts` is the authoritative list of methods and
their arguments; the file is the documentation. An app that needs something
no service offers needs a service, not a workaround — see
`server/src/extra-services.ts` for how to add one from outside this repository.

## `app.css`

Optional. Injected once per page, inside a `<style data-finestra-app="<id>">`
element, the first time the app is launched. The page is shared with the shell
and every other app and there is no shadow DOM, so **prefix every selector
with the app id** (`.hello-list`, not `.list`).

Colours and metrics come from the shell's tokens, so an app follows the theme
without knowing which is on:

```
--surface-0 … --surface-4        backgrounds, darkest to most raised
--text  --text-muted  --text-faint  --text-inverse
--accent  --accent-strong  --accent-dim
--border  --border-strong
--danger  --danger-dim  --success  --warning
--radius-sm  --radius  --radius-lg
--font-ui  --font-mono
--transition  --transition-fast
```

The light theme is `:root[data-theme='light']`; an override that needs it is
`:root[data-theme='light'] .hello-app { … }`. The window's content box is
`overflow: hidden` — give the app root `height: 100%` and its own scrolling
region. `container-type: inline-size` on the root lets it adapt to the window
rather than the viewport.

## Installing by hand

```bash
dir="$(sudo /opt/finestra/current/configure.sh --state-dir)/apps"   # or ~/.local/state/finestra/apps
sudo mkdir -p "$dir"
sudo cp -r hello "$dir/hello"
sudo chown -R "$(stat -c %U "$dir/..")" "$dir"
```

Then open Settings in the desktop. The Apps section reads the directory every
time it is shown, registers anything new, and names the directory at the
bottom so there is no guessing. No restart, no reload. A package that cannot
start says why in its row, and in its window if launched anyway.

To update a package, replace its files and reload the page: code is evaluated
once per page. To remove one, delete the directory; its saved windows are
dropped on the next reload.

## Building with TypeScript

Plain JavaScript needs nothing. For TypeScript, or anything with dependencies,
`npm run build` in this repository emits the public types to
`client/dist-sdk/` (entry `client/src/sdk.d.ts`), and Vite's library mode
produces the two files:

```ts
// vite.config.ts in the app's own repository
import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    lib: { entry: 'src/app.ts', formats: ['es'], fileName: () => 'app.js' },
    cssCodeSplit: false,            // one app.css, not one per import
    rollupOptions: { output: { assetFileNames: 'app.css' } },
    outDir: 'dist',
  },
});
```

```json
// tsconfig.json — point at the emitted declarations
{ "compilerOptions": { "paths": { "finestra": ["../finestra/client/dist-sdk/client/src/sdk"] } } }
```

```ts
import type { AppContext, AppInstance } from 'finestra';
export async function mount(ctx: AppContext): Promise<AppInstance> { … }
```

Copy `app.json` into `dist/` and that directory is the package. The
`import './app.css'` in the entry is what makes Vite emit the stylesheet; it
is not needed at run time because the shell injects `style` itself.

## What the shell promises

`apiVersion: 1` is a promise about `AppManifest`, `AppContext`, `AppInstance`,
`DesktopAPI` and `WindowHandle`: fields are added, never renamed or removed. A
package written today keeps working; a package that needs something newer
says so with a higher `apiVersion`, and an older shell refuses it with the
reason rather than breaking at launch.

What it does not promise is isolation. A package runs in the shell's page,
with the shell's reach — the same trust as the terminal one click away, as
`app-installation.md` sets out. Install what you would run.
