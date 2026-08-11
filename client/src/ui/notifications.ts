import { h } from '../core/dom';
import type { NotifyOptions } from '../core/types';

const DEFAULT_TIMEOUT_MS = 5000;

const KIND_ICONS: Record<string, string> = {
  info: 'ℹ',
  success: '✓',
  warning: '⚠',
  error: '✕',
};

/** Stacked transient messages in the corner of the screen. */
export class NotificationCenter {
  private container: HTMLElement;

  constructor(parent: HTMLElement) {
    this.container = h('div', { class: 'notification-stack' });
    parent.appendChild(this.container);
  }

  show(options: NotifyOptions): void {
    const kind = options.kind ?? 'info';
    let timer: number | null = null;

    const dismiss = () => {
      if (timer !== null) clearTimeout(timer);
      el.classList.add('is-leaving');
      // Remove after the exit transition, or immediately if it never runs.
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400);
    };

    const el = h(
      'div',
      { class: `notification is-${kind}`, attrs: { role: 'status' } },
      h('div', { class: 'notification-icon', text: KIND_ICONS[kind] ?? 'ℹ' }),
      h(
        'div',
        { class: 'notification-body' },
        options.title ? h('div', { class: 'notification-title', text: options.title }) : null,
        h('div', { class: 'notification-message', text: options.message }),
        options.actions?.length
          ? h(
              'div',
              { class: 'notification-actions' },
              ...options.actions.map((action) =>
                h('button', {
                  class: 'notification-action',
                  text: action.label,
                  on: {
                    click: () => {
                      dismiss();
                      action.onSelect();
                    },
                  },
                }),
              ),
            )
          : null,
      ),
      h('button', {
        class: 'notification-close',
        text: '✕',
        title: 'Dismiss',
        on: { click: dismiss },
      }),
    );

    this.container.appendChild(el);
    // Let the element land in the DOM before starting the entry transition.
    requestAnimationFrame(() => el.classList.add('is-visible'));

    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    if (timeout > 0) timer = window.setTimeout(dismiss, timeout);
  }
}
