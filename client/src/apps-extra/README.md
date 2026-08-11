# Apps from outside this repository

Anything dropped in here is registered at startup, alongside the built-in apps.
The directory is otherwise ignored by git, so this desktop stays standalone
while still being extensible.

It exists because some apps do not belong in this project. A console for another
product, an integration with a control plane, anything naming a system this
desktop has no opinion about — carrying those in `apps/` would mean carrying a
dependency it does not want, and a licence boundary it should not cross.

## Adding one

Put a directory here containing an `index.ts` (or `.js`) that exports an
`AppManifest`:

```
client/src/apps-extra/
└── my-app/
    ├── index.ts     exports a manifest — any export name will do
    └── my-app.css
```

```ts
import type { AppManifest } from '../../core/types';

export const myApp: AppManifest = {
  id: 'my-app',
  name: 'My App',
  icon: '★',
  category: 'System',
  mount: async ({ window: win, root, desktop }) => {
    root.textContent = `Hello from ${desktop.host?.hostname ?? 'somewhere'}`;
    return {};
  },
};
```

Then rebuild. Every export of every `index` file here is inspected, and anything
with an `id`, a `name` and a `mount` is registered — so the export name does not
matter and one file may contain several.

A symlink works, which is usually what you want: keep the source in its own
repository and point at it.

```bash
ln -s ~/devel/other-project/integration/finestra/my-app \
      client/src/apps-extra/my-app
npm run build
```

## What it can do

Exactly what a built-in app can do, including reaching the server through
`desktop.rpc`. There is no sandbox — an app here is part of the bundle. If it
needs a capability the server does not offer, see `WD_SERVICES_DIR` in
`server/src/extra-services.ts` for the matching hook on that side.
