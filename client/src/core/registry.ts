import type { AppManifest } from './types';

/**
 * The catalogue of installed apps.
 *
 * Registration is a runtime call rather than a build-time import list, which
 * is what will let a future package manager fetch an app bundle over HTTP,
 * `import()` it, and call `register()` with no change to the shell.
 */
export class AppRegistry {
  private apps = new Map<string, AppManifest>();
  /** Apps turned off in Settings. They stay registered, listed only there. */
  private disabled = new Set<string>();

  setDisabled(ids: Iterable<string>): void {
    this.disabled = new Set(ids);
  }

  setAppDisabled(id: string, isDisabled: boolean): void {
    if (isDisabled) this.disabled.add(id);
    else this.disabled.delete(id);
  }

  isEnabled(id: string): boolean {
    return !this.disabled.has(id);
  }

  /** What the rest of the shell should offer: everything not turned off. */
  enabledApps(): AppManifest[] {
    return this.all().filter((a) => this.isEnabled(a.id));
  }

  register(app: AppManifest): void {
    if (!app.id) throw new Error('An app manifest needs an id');
    if (this.apps.has(app.id)) {
      console.warn(`App "${app.id}" is already registered; replacing it.`);
    }
    this.apps.set(app.id, app);
  }

  unregister(id: string): void {
    this.apps.delete(id);
  }

  get(id: string): AppManifest | undefined {
    return this.apps.get(id);
  }

  all(): AppManifest[] {
    return [...this.apps.values()];
  }

  /** Apps the launcher should list, grouped by category and sorted by name. */
  byCategory(): Array<{ category: string; apps: AppManifest[] }> {
    const groups = new Map<string, AppManifest[]>();
    for (const app of this.apps.values()) {
      if (app.showInLauncher === false || !this.isEnabled(app.id)) continue;
      const category = app.category ?? 'Applications';
      const list = groups.get(category);
      if (list) list.push(app);
      else groups.set(category, [app]);
    }
    return [...groups.entries()]
      .map(([category, apps]) => ({
        category,
        apps: apps.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }

  desktopApps(): AppManifest[] {
    return this.all().filter((a) => a.showOnDesktop && this.isEnabled(a.id));
  }
}
