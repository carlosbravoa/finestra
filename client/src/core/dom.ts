/** Minimal DOM construction helpers. Deliberately not a framework. */

type Child = Node | string | number | null | undefined | false;

export interface ElementProps {
  class?: string;
  id?: string;
  title?: string;
  text?: string;
  html?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null>;
  /** Event listeners, keyed by event name. */
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }> &
    Record<string, (ev: any) => void>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElementProps | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.id) el.id = props.id;
    if (props.title) el.title = props.title;
    if (props.text != null) el.textContent = props.text;
    if (props.html != null) el.innerHTML = props.html;
    if (props.style) Object.assign(el.style, props.style);
    if (props.dataset) Object.assign(el.dataset, props.dataset);
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v === null || v === false) el.removeAttribute(k);
        else el.setAttribute(k, String(v));
      }
    }
    if (props.on) {
      for (const [k, fn] of Object.entries(props.on)) {
        if (fn) el.addEventListener(k, fn as EventListener);
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * An icon is either an emoji/text glyph or an inline `<svg …>` string. Apps
 * choose; the shell renders both the same way.
 */
export function iconEl(icon: string, cls = 'icon'): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  if (icon.trimStart().startsWith('<svg')) el.innerHTML = icon;
  else el.textContent = icon;
  return el;
}

/** Adds a listener and returns the function that removes it. */
export function listen<T extends EventTarget>(
  target: T,
  type: string,
  handler: (ev: any) => void,
  options?: AddEventListenerOptions | boolean,
): () => void {
  target.addEventListener(type, handler as EventListener, options);
  return () => target.removeEventListener(type, handler as EventListener, options);
}
