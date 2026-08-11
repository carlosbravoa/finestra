import { DEFAULT_UPLOADS_DIR, WALLPAPERS } from '../../core/desktop';
import { h, iconEl } from '../../core/dom';
import type { AppContext, AppInstance, AppManifest } from '../../core/types';
import './settings.css';

const SETTINGS_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="3"/>
  <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34
    1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06
    a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09
    a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34
    h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06
    a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09
    a1.7 1.7 0 0 0-1.55 1z"/>
</svg>`;

const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24];

/**
 * One place for the options that were previously scattered across context
 * menus. It works entirely through `DesktopAPI` and settings keys — the shell
 * watches those keys, so changes apply immediately without private access.
 */
async function mount({ root, desktop }: AppContext): Promise<AppInstance> {
  let disposed = false;

  let shells: string[] = [];
  if (desktop.rpc.hasService('pty')) {
    try {
      shells = await desktop.rpc.call<string[]>('pty', 'shells');
    } catch {
      shells = [];
    }
  }

  const body = h('div', { class: 'settings-app' });
  root.replaceChildren(body);

  const get = <T,>(key: string, fallback: T): T => desktop.settings.get(key, fallback);
  const set = (key: string, value: unknown): void => {
    desktop.settings.set(key, value);
    render();
  };

  /* ---------------------------------------------------------------- */
  /* Controls                                                          */
  /* ---------------------------------------------------------------- */

  function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return h(
      'div',
      { class: 'settings-row' },
      h(
        'div',
        { class: 'settings-row-text' },
        h('div', { class: 'settings-row-label', text: label }),
        hint ? h('div', { class: 'settings-row-hint', text: hint }) : null,
      ),
      control,
    );
  }

  function section(title: string, ...children: Array<HTMLElement | null>): HTMLElement {
    return h(
      'section',
      { class: 'settings-section' },
      h('h2', { class: 'settings-section-title', text: title }),
      ...children,
    );
  }

  function checkbox(checked: boolean, onChange: (value: boolean) => void): HTMLInputElement {
    const el = h('input', { class: 'settings-check', attrs: { type: 'checkbox' } });
    el.checked = checked;
    el.addEventListener('change', () => onChange(el.checked));
    return el;
  }

  function select(
    options: Array<{ value: string; label: string }>,
    value: string,
    onChange: (value: string) => void,
  ): HTMLSelectElement {
    const el = h('select', { class: 'settings-select' });
    for (const option of options) {
      el.appendChild(h('option', { text: option.label, attrs: { value: option.value } }));
    }
    el.value = value;
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  function textInput(
    value: string,
    placeholder: string,
    onCommit: (value: string) => void,
  ): HTMLInputElement {
    const el = h('input', { class: 'settings-input', attrs: { type: 'text', placeholder } });
    el.value = value;
    const commit = () => {
      const next = el.value.trim();
      if (next) onCommit(next);
    };
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        commit();
        el.blur();
      }
    });
    el.addEventListener('blur', commit);
    return el;
  }

  /* ---------------------------------------------------------------- */
  /* Sections                                                          */
  /* ---------------------------------------------------------------- */

  function appearance(): HTMLElement {
    const theme = get('desktop.theme', 'dark');
    const segments = h(
      'div',
      { class: 'settings-seg' },
      ...(['dark', 'light'] as const).map((id) =>
        h('button', {
          class: `settings-seg-btn${theme === id ? ' is-active' : ''}`,
          text: id === 'dark' ? 'Dark' : 'Light',
          on: { click: () => set('desktop.theme', id) },
        }),
      ),
    );

    const paper = get('desktop.wallpaper', 'nebula');
    const swatches = h(
      'div',
      { class: 'settings-swatches' },
      ...WALLPAPERS.map((w) =>
        h('button', {
          class: `settings-swatch${paper === w.id ? ' is-active' : ''}`,
          dataset: { paper: w.id },
          title: w.name,
          attrs: { 'aria-label': `Wallpaper: ${w.name}` },
          on: { click: () => set('desktop.wallpaper', w.id) },
        }),
      ),
    );

    return section(
      'Appearance',
      row('Theme', segments, 'The terminal keeps its own dark palette.'),
      row('Wallpaper', swatches),
    );
  }

  function terminal(): HTMLElement {
    const shellOptions = [
      { value: '', label: 'Automatic (first available)' },
      ...shells.map((s) => ({ value: s, label: s })),
    ];

    return section(
      'Terminal',
      row(
        'Font size',
        select(
          FONT_SIZES.map((n) => ({ value: String(n), label: `${n} px` })),
          String(get('terminal.fontSize', 14)),
          (v) => set('terminal.fontSize', Number(v)),
        ),
        'Applies to new terminals. Ctrl+Wheel zooms an open one.',
      ),
      row(
        'Default shell',
        select(shellOptions, get('terminal.defaultShell', ''), (v) =>
          set('terminal.defaultShell', v),
        ),
      ),
      row(
        'Ask before closing',
        checkbox(get('terminal.confirmClose', true), (v) => set('terminal.confirmClose', v)),
        'Only asks when something is actually running.',
      ),
    );
  }

  function filesAndUploads(): HTMLElement {
    return section(
      'Files & uploads',
      row(
        'Uploads folder',
        textInput(get('transfer.uploadsDir', DEFAULT_UPLOADS_DIR), DEFAULT_UPLOADS_DIR, (v) =>
          set('transfer.uploadsDir', v),
        ),
        'Where files dropped onto the desktop land. Created on first upload.',
      ),
      row(
        'Show hidden files',
        checkbox(get('files.showHidden', false), (v) => set('files.showHidden', v)),
        'Applies when a Files window refreshes.',
      ),
    );
  }

  function apps(): HTMLElement {
    const persisted = desktop.rpc.hasService('apps');
    const rows = desktop
      .apps()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((app) => {
        const isSettings = app.id === 'settings';
        const enabled = desktop.isAppEnabled(app.id);

        const toggle = checkbox(enabled, (v) => {
          void desktop
            .setAppEnabled(app.id, v)
            .catch((err) => {
              desktop.notify({
                kind: 'error',
                message: err instanceof Error ? err.message : String(err),
              });
            })
            .then(() => {
              if (!disposed) render();
            });
        });
        if (isSettings) toggle.disabled = true;

        return h(
          'div',
          { class: `settings-approw${enabled ? '' : ' is-off'}` },
          iconEl(app.icon, 'settings-appicon'),
          h(
            'div',
            { class: 'settings-row-text' },
            h('div', { class: 'settings-row-label', text: app.name }),
            h('div', {
              class: 'settings-row-hint',
              text: isSettings
                ? 'Always on — it is how apps get re-enabled.'
                : (app.description ?? ''),
            }),
          ),
          toggle,
        );
      });

    return section(
      'Apps',
      ...rows,
      persisted
        ? null
        : h('div', {
            class: 'settings-note',
            text: 'This server does not persist app state; changes last until reload.',
          }),
    );
  }

  function associations(): HTMLElement {
    const defaults = get<Record<string, string>>('associations.defaults', {});
    const entries = Object.entries(defaults);

    if (entries.length === 0) {
      return section(
        'File associations',
        h('div', {
          class: 'settings-note',
          text: 'No custom choices yet. Right-click a file in Files → "Always open this kind of file with".',
        }),
      );
    }

    const rows = entries.map(([key, appId]) => {
      const appName = desktop.apps().find((a) => a.id === appId)?.name ?? `${appId} (not installed)`;
      const display = key.startsWith('name:') ? key.slice(5) : `*${key}`;
      return h(
        'div',
        { class: 'settings-row' },
        h(
          'div',
          { class: 'settings-row-text' },
          h('div', { class: 'settings-row-label', text: display }),
          h('div', { class: 'settings-row-hint', text: `Opens with ${appName}` }),
        ),
        h('button', {
          class: 'settings-clear',
          text: '✕',
          title: 'Forget this choice',
          on: {
            click: () => {
              const next = { ...defaults };
              delete next[key];
              set('associations.defaults', next);
            },
          },
        }),
      );
    });

    return section('File associations', ...rows);
  }

  function sessionSection(): HTMLElement {
    return section(
      'Session',
      row(
        'Reopen windows on reload',
        checkbox(desktop.session.enabled, (v) => {
          desktop.session.setEnabled(v);
          render();
        }),
        'Windows come back with their position, size and app state.',
      ),
      row(
        'Saved windows',
        h('button', {
          class: 'settings-button',
          text: 'Forget now',
          on: {
            click: () => {
              desktop.session.clear();
              desktop.notify({ kind: 'success', message: 'Saved session cleared.', timeout: 2500 });
            },
          },
        }),
        'The next reload starts with an empty desktop.',
      ),
    );
  }

  function render(): void {
    if (disposed) return;
    body.replaceChildren(
      appearance(),
      terminal(),
      filesAndUploads(),
      apps(),
      associations(),
      sessionSection(),
    );
  }

  render();

  return {
    onFocus: () => render(),
    destroy: () => {
      disposed = true;
    },
  };
}

export const settingsApp: AppManifest = {
  id: 'settings',
  name: 'Settings',
  icon: SETTINGS_ICON,
  description: 'Desktop preferences and app management',
  category: 'System',
  singleton: true,
  showOnDesktop: false,
  defaultSize: { width: 560, height: 640 },
  minSize: { width: 420, height: 320 },
  mount,
};
