import { h, listen } from '../core/dom';
import type { DialogOptions, PromptOptions } from '../core/types';

/**
 * Modal dialogs. Deliberately not `window.confirm`, both because that blocks
 * the event loop (killing terminal output mid-prompt) and because it cannot be
 * styled to match the desktop.
 */

interface DialogSpec extends DialogOptions {
  /** Rendered between the message and the buttons. */
  field?: HTMLInputElement;
}

function showDialog<T>(spec: DialogSpec, resolveValue: () => T, cancelValue: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;

    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      offKeys();
      overlay.classList.remove('is-visible');
      setTimeout(() => overlay.remove(), 200);
      resolve(value);
    };

    const confirmButton = h('button', {
      class: `dialog-button is-primary${spec.danger ? ' is-danger' : ''}`,
      text: spec.confirmLabel ?? 'OK',
      on: { click: () => finish(resolveValue()) },
    });

    // An informational dialog has nothing to cancel, so it shows one button.
    const cancelButton =
      spec.cancelLabel === null
        ? null
        : h('button', {
            class: 'dialog-button',
            text: spec.cancelLabel ?? 'Cancel',
            on: { click: () => finish(cancelValue) },
          });

    // noopener is not optional: without it the opened page gets a handle on
    // this one through window.opener, and this one holds a session.
    const link = spec.link
      ? h('a', {
          class: 'dialog-link',
          text: spec.link.label ?? spec.link.href,
          attrs: { href: spec.link.href, target: '_blank', rel: 'noopener noreferrer' },
        })
      : null;

    const panel = h(
      'div',
      { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true' } },
      spec.title ? h('div', { class: 'dialog-title', text: spec.title }) : null,
      h('div', { class: 'dialog-message', text: spec.message }),
      link,
      spec.field ?? null,
      h('div', { class: 'dialog-buttons' }, cancelButton, confirmButton),
    );

    const overlay = h(
      'div',
      {
        class: 'dialog-overlay',
        on: {
          // Clicking the backdrop, but not the panel, cancels.
          pointerdown: (ev: PointerEvent) => {
            if (ev.target === overlay) finish(cancelValue);
          },
        },
      },
      panel,
    );

    const offKeys = listen(
      window,
      'keydown',
      (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          finish(cancelValue);
        } else if (ev.key === 'Enter' && ev.target !== cancelButton) {
          ev.preventDefault();
          finish(resolveValue());
        }
      },
      true,
    );

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-visible'));
    // A destructive dialog opens with the safe button focused, so that Enter —
    // pressed out of habit, or still held from whatever opened the dialog —
    // cancels rather than confirms. The Enter handler above already reads focus
    // this way, so nothing else has to change. Where there is nothing to cancel
    // the single button takes focus as before.
    const initial = spec.field ?? (spec.danger && cancelButton ? cancelButton : confirmButton);
    initial.focus();
    spec.field?.select();
  });
}

export function confirmDialog(options: DialogOptions): Promise<boolean> {
  return showDialog({ confirmLabel: 'OK', ...options }, () => true, false);
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  const field = h('input', {
    class: 'dialog-input',
    attrs: {
      type: 'text',
      value: options.value ?? '',
      placeholder: options.placeholder ?? '',
      spellcheck: 'false',
    },
  });
  return showDialog<string | null>({ ...options, field }, () => field.value, null);
}
