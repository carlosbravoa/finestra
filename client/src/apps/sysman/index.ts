import { h, iconEl, listen } from '../../core/dom';
import type { AppContext, AppInstance, AppManifest, MenuItem, Size } from '../../core/types';
import { certificatesSection } from './certificates';
import { placeholder, type Section, type SectionContext, type SectionDef } from './common';
import { journalSection } from './journal';
import { networkSection } from './network';
import { overviewSection } from './overview';
import { processesSection } from './processes';
import { storageSection } from './storage';
import { unitsSection } from './units';
import './sysman.css';

const SYSMAN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="2" y="4" width="20" height="16" rx="2"/>
  <path d="M6 9h4M6 13h8M16 9h2M16 13h2"/>
</svg>`;

const SECTIONS: SectionDef[] = [
  overviewSection,
  processesSection,
  unitsSection,
  journalSection,
  storageSection,
  networkSection,
  certificatesSection,
];

interface SysmanParams {
  section?: string;
  /** Per-section saved state, keyed by section id. */
  sections?: Record<string, Record<string, unknown>>;
}

async function mount({ window: win, root, desktop, params }: AppContext): Promise<AppInstance> {
  const options = params as SysmanParams;

  let disposed = false;
  const cleanup: Array<() => void> = [];

  const saved = (options.sections ?? {}) as Record<string, Record<string, unknown>>;
  const live = new Map<string, Section>();

  let activeId = '';
  let active: Section | null = null;
  /** Suspended by minimizing or by the tab going into the background. */
  let suspended = false;

  const main = h('div', { class: 'sysman-main' });
  const nav = h('nav', { class: 'sysman-nav' });
  root.replaceChildren(h('div', { class: 'sysman-app' }, nav, main));

  const available = (def: SectionDef): boolean =>
    def.requires.every((name) => desktop.rpc.hasService(name));

  const navButtons = new Map<string, HTMLButtonElement>();
  for (const def of SECTIONS) {
    const ok = available(def);
    const btn = h(
      'button',
      {
        class: 'sysman-navitem',
        dataset: { section: def.id },
        title: ok ? def.title : `${def.title} needs the ${def.requires.join(', ')} service`,
        on: { click: () => show(def.id) },
      },
      iconEl(def.icon, 'sysman-navicon'),
      h('span', { class: 'sysman-navlabel', text: def.title }),
    );
    if (!ok) btn.classList.add('is-unavailable');
    navButtons.set(def.id, btn);
    nav.appendChild(btn);
  }

  /* ---------------------------------------------------------------- */
  /* Sections                                                          */
  /* ---------------------------------------------------------------- */

  function sectionContext(): SectionContext {
    return {
      desktop,
      window: win,
      isDisposed: () => disposed,
      setStatus: (text) => {
        // Only the section on screen owns the status strip.
        if (!disposed) win.setStatus(text);
      },
      goto: (id, next) => show(id, next),
    };
  }

  function show(id: string, handover?: Record<string, unknown>): void {
    const def = SECTIONS.find((s) => s.id === id);
    if (!def) return;

    if (!available(def)) {
      activeId = id;
      active?.deactivate?.();
      active = null;
      updateNav();
      main.replaceChildren(
        placeholder(
          `${def.title} is not available`,
          `This server does not provide the ${def.requires.join(', ')} service. It may be an older version, or running on a platform without it.`,
        ),
      );
      win.setStatus(null);
      win.setMenu(buildMenu());
      return;
    }

    if (activeId === id && active) {
      if (handover) active.applyParams?.(handover);
      return;
    }

    active?.deactivate?.();

    let section = live.get(id);
    if (!section) {
      section = def.create(sectionContext(), saved[id] ?? {});
      live.set(id, section);
    }
    if (handover) section.applyParams?.(handover);

    activeId = id;
    active = section;
    main.replaceChildren(section.element);
    updateNav();
    // The title deliberately does not name the section: the taskbar copies it
    // only when a window event fires, so it would sit there contradicting the
    // titlebar. The highlighted sidebar entry says where you are anyway.
    win.setMenu(buildMenu());
    win.setStatus(null);

    if (!suspended) section.activate?.();

    // The element only has a size once it is in the tree, so size-dependent
    // work (canvas, tables) has to happen after this point, not at creation.
    const size = { width: main.clientWidth, height: main.clientHeight };
    if (size.width > 0) section.resize?.(size);
  }

  function updateNav(): void {
    for (const [id, btn] of navButtons) btn.classList.toggle('is-active', id === activeId);
  }

  /* ---------------------------------------------------------------- */
  /* Menu                                                              */
  /* ---------------------------------------------------------------- */

  function buildMenu(): MenuItem[] {
    const def = SECTIONS.find((s) => s.id === activeId);
    const items: MenuItem[] = [
      {
        label: 'View',
        submenu: () => [
          ...SECTIONS.map((s) => ({
            label: s.title,
            checked: s.id === activeId,
            disabled: !available(s),
            onSelect: () => show(s.id),
          })),
          { type: 'separator' as const },
          { label: 'Close', accelerator: 'Alt+F4', danger: true, onSelect: () => win.close() },
        ],
      },
    ];
    if (def && active?.menu) {
      items.push({ label: def.title, submenu: () => active?.menu?.() ?? [] });
    }
    return items;
  }

  /* ---------------------------------------------------------------- */
  /* Suspension                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * A monitor that stops the moment it loses focus is useless — the point is
   * watching it while working elsewhere. So polling continues while the window
   * is merely unfocused, and stops only when nothing can be seen: minimized,
   * or the browser tab in the background.
   */
  function setSuspended(next: boolean): void {
    if (suspended === next) return;
    suspended = next;
    if (suspended) active?.deactivate?.();
    else active?.activate?.();
  }

  cleanup.push(
    win.on('state', (state) => setSuspended(state === 'minimized' || document.hidden)),
  );
  cleanup.push(
    listen(document, 'visibilitychange', () => {
      setSuspended(document.hidden || win.state === 'minimized');
    }),
  );

  // F5 refreshes whatever is on screen. It is bound here rather than through
  // the desktop's registry, which only accepts combos with a modifier.
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'F5' || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    ev.preventDefault();
    for (const item of active?.menu?.() ?? []) {
      if (item.type === 'separator' || item.type === 'header') continue;
      if (!item.disabled && /^(refresh|rescan)/i.test(item.label)) {
        item.onSelect?.();
        break;
      }
    }
  });

  show(typeof options.section === 'string' ? options.section : SECTIONS[0].id);

  return {
    menu: buildMenu(),

    onResize: (size: Size) => {
      if (size.width === 0) return;
      active?.resize?.({ width: main.clientWidth, height: main.clientHeight });
    },

    onFocus: () => {
      // Coming back from minimized arrives as a state event, but a restore
      // that skips it (or a tab that was hidden) still needs the nudge.
      setSuspended(document.hidden || win.state === 'minimized');
      active?.resize?.({ width: main.clientWidth, height: main.clientHeight });
    },

    saveState: () => {
      const sections: Record<string, Record<string, unknown>> = { ...saved };
      for (const [id, section] of live) {
        const state = section.saveState?.();
        if (state) sections[id] = state;
      }
      return { section: activeId, sections };
    },

    destroy: () => {
      disposed = true;
      for (const fn of cleanup.reverse()) fn();
      for (const section of live.values()) {
        section.deactivate?.();
        section.destroy?.();
      }
      live.clear();
      active = null;
    },
  };
}

export const sysmanApp: AppManifest = {
  id: 'sysman',
  name: 'System Manager',
  icon: SYSMAN_ICON,
  description: 'Monitor the machine, its processes, services, disks and ports',
  category: 'System',
  singleton: true,
  showOnDesktop: true,
  defaultSize: { width: 1040, height: 700 },
  minSize: { width: 520, height: 380 },
  mount,
};
