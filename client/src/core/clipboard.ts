import { Emitter } from './events';
import type { ClipboardAPI, ClipboardScope, NotifyOptions } from './types';

/** What we last saw somewhere, and when we last saw it there. */
interface Entry {
  text: string;
  at: number;
}

/**
 * The desktop's own clipboard.
 *
 * The browser only hands over the system clipboard on a secure origin, and
 * this server is plain http reached through an SSH tunnel — so on most
 * installs `navigator.clipboard` is either absent or refused. Losing the
 * machine the browser runs on is tolerable. What is not is that it also broke
 * copy and paste *between windows of this desktop* — a path number that never
 * left the browser, a command line from the process list into the terminal —
 * which involves nobody's system clipboard at all and is what an
 * administrator does all day.
 *
 * So every copy is kept here first, and the system clipboard is attempted on
 * top of it: `writeText` where it is allowed, and `execCommand('copy')` —
 * deprecated, and the only writer that still works outside a secure context —
 * where it is not. Reading is the harder half, because nothing lets a page
 * *read* the system clipboard without permission; what a page does get for
 * free is the text of a real `paste` event, which is why `fromEvent` exists
 * and why the two sources are dated rather than ranked.
 *
 * It deliberately lives in the page and not in `settings`: what someone copies
 * is as often a password as a path, and localStorage would keep it readable by
 * anything that runs on this origin afterwards, long after the tab that copied
 * it was closed. A clipboard that does not survive a reload is the lesser
 * surprise.
 */
export class ClipboardStore implements ClipboardAPI {
  /** What was copied inside this desktop. */
  private local: Entry = { text: '', at: 0 };
  /** The last text the browser let us see, and when we saw it change. */
  private system: Entry = { text: '', at: 0 };
  private seenSystem = false;
  // Only the order of the two matters, and two events can land in the same
  // millisecond — so they are counted rather than dated. Zero means "was
  // already there when this desktop opened".
  private clock = 0;
  private refused = false;
  private explained = false;
  private events = new Emitter<{ change: string }>();

  constructor(private readonly notify: (options: NotifyOptions) => void = () => {}) {
    // A plain Ctrl+C on a selection never reaches an app's own copy handler —
    // the browser does the work — so the desktop would not know about the one
    // copy the user is most likely to make. The event itself carries nothing
    // readable, hence reading the selection instead.
    document.addEventListener('copy', () => this.rememberSelection());
    document.addEventListener('cut', () => this.rememberSelection());
    // Every real paste is a free look at the system clipboard. Capture, so
    // this still runs when an app stops the event on its own element.
    document.addEventListener('paste', (ev) => this.observe(textOf(ev)), true);
  }

  /** The desktop's own last copy, without asking the browser anything. */
  get text(): string {
    return this.resolve();
  }

  /** True once the browser has refused to hand the system clipboard over. */
  get blocked(): boolean {
    return this.refused;
  }

  async write(text: string): Promise<ClipboardScope> {
    // Locally first, and unconditionally: pasting into the next window along
    // must not depend on any of what follows working.
    this.remember(text);
    if (await this.writeSystem(text)) {
      this.refused = false;
      this.observe(text);
      return 'system';
    }
    this.explainOnce();
    this.refused = true;
    return 'local';
  }

  async read(): Promise<string> {
    try {
      const text = await navigator.clipboard.readText();
      this.refused = false;
      this.observe(text);
    } catch {
      // No permission, or no secure context. The desktop's own copy stands in
      // silently: nothing is lost here, unlike a copy that never reached the
      // machine, so this is not the failure worth explaining.
      this.refused = true;
    }
    return this.resolve();
  }

  /** What a real paste event should actually paste. */
  fromEvent(ev: ClipboardEvent): string {
    this.observe(textOf(ev));
    return this.resolve();
  }

  watch(fn: (text: string) => void): () => void {
    return this.events.on('change', fn);
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * What the browser is about to put on the clipboard for a native copy.
   *
   * A field's own selection is not part of the document's, so an editor's
   * plain Ctrl+C is invisible to `getSelection()` and has to be read off the
   * element. Some input types refuse to report a selection at all, and that
   * is not worth an exception.
   */
  private rememberSelection(): void {
    const active = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      try {
        const { selectionStart: from, selectionEnd: to } = active;
        if (from != null && to != null && from !== to) {
          this.remember(active.value.slice(from, to));
          return;
        }
      } catch {
        // Selection is unsupported on this input type; fall through.
      }
    }
    this.remember(document.getSelection()?.toString() ?? '');
  }

  private remember(text: string): void {
    if (!text || text === this.local.text) {
      // Copying the same thing again still says it is the current one.
      if (text) this.local.at = this.tick();
      return;
    }
    this.local = { text, at: this.tick() };
    this.events.emit('change', text);
  }

  /**
   * Note what the browser just showed us of the system clipboard.
   *
   * The *first* value seen is dated to the beginning of time on purpose: it
   * was already on the clipboard before this page looked, so it cannot be
   * assumed newer than something copied inside the desktop since. Whoever
   * copied a path in the terminal a moment ago meant that, not the sentence
   * left on the host's clipboard yesterday. Every later change did happen
   * while we were watching, so it is dated now and wins.
   */
  private observe(text: string): void {
    if (!text || text === this.system.text) return;
    this.system = { text, at: this.seenSystem ? this.tick() : 0 };
    this.seenSystem = true;
  }

  private tick(): number {
    return ++this.clock;
  }

  private resolve(): string {
    if (this.local.at >= this.system.at) return this.local.text || this.system.text;
    return this.system.text || this.local.text;
  }

  private async writeSystem(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Absent outside a secure context, and refused without permission.
    }
    return this.execCopy(text);
  }

  /**
   * The pre-permissions way to copy, which still works over plain http.
   *
   * It needs the text to be *selected*, so this borrows the focus for the
   * length of one synchronous call and gives it straight back — losing it
   * would take the caret out of the terminal or the editor the user is
   * copying from, which is worse than the copy failing.
   */
  private execCopy(text: string): boolean {
    const active = document.activeElement as HTMLElement | null;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    // Off-screen but not display:none, which would make it unselectable.
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(area);
    let ok = false;
    try {
      area.select();
      area.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    } finally {
      area.remove();
      active?.focus?.();
    }
    return ok;
  }

  /**
   * Say once why a copy did not reach the machine's own clipboard, and then
   * never again: it is a property of the origin, so it will be true of every
   * copy for the rest of the session and one notification per copy is a
   * nuisance rather than news.
   */
  private explainOnce(): void {
    if (this.explained) return;
    this.explained = true;
    this.notify({
      kind: 'info',
      title: 'The clipboard stays in this desktop',
      message:
        'The browser only shares the system clipboard over https, and this desktop is plain http. ' +
        'Copy and paste between its own windows still work.',
      timeout: 8000,
    });
  }
}

function textOf(ev: ClipboardEvent): string {
  return ev.clipboardData?.getData('text/plain') ?? '';
}
