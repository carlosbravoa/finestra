// Exercises the desktop's clipboard against a browser that refuses to share
// the system one, which is what every plain-http install is.
import type { NotifyOptions } from '../client/src/core/types';

const results: boolean[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/* --- as much of a browser as this needs ----------------------------- */

/** The machine's own clipboard, which the page may or may not be allowed at. */
let systemText = '';
let writeAllowed = true;
let readAllowed = true;
let execAllowed = false;
let selectionText = '';
let focused: FakeElement | null = null;
let area: FakeElement | null = null;

interface FakeElement {
  tagName: string;
  value: string;
  style: { cssText: string };
  selectionStart: number | null;
  selectionEnd: number | null;
  setAttribute(name: string, value: string): void;
  setSelectionRange(from: number, to: number): void;
  select(): void;
  focus(): void;
  remove(): void;
}

const element = (tagName: string): FakeElement => ({
  tagName,
  value: '',
  style: { cssText: '' },
  selectionStart: null,
  selectionEnd: null,
  setAttribute: () => {},
  setSelectionRange(from, to) {
    this.selectionStart = from;
    this.selectionEnd = to;
  },
  select() {
    focused = this;
  },
  focus() {
    focused = this;
  },
  remove: () => {},
});

const listeners = new Map<string, Array<(ev: unknown) => void>>();
const fire = (type: string, text: string) => {
  const ev = { clipboardData: { getData: () => text } };
  for (const fn of listeners.get(type) ?? []) fn(ev);
};

const g = globalThis as unknown as Record<string, unknown>;
g.document = {
  addEventListener(type: string, fn: (ev: unknown) => void) {
    const list = listeners.get(type) ?? [];
    list.push(fn);
    listeners.set(type, list);
  },
  get activeElement() {
    return focused;
  },
  getSelection: () => ({ toString: () => selectionText }),
  createElement: (tag: string) => {
    area = element(tag.toUpperCase());
    return area;
  },
  body: { appendChild: () => {} },
  execCommand: (command: string) => {
    if (command !== 'copy' || !execAllowed) return false;
    systemText = area?.value ?? '';
    return true;
  },
};
g.navigator = {
  clipboard: {
    writeText: async (text: string) => {
      if (!writeAllowed) throw new Error('refused');
      systemText = text;
    },
    readText: async () => {
      if (!readAllowed) throw new Error('refused');
      return systemText;
    },
  },
};

const { ClipboardStore } = await import('../client/src/core/clipboard');

const notices: NotifyOptions[] = [];
const store = () => {
  notices.length = 0;
  return new ClipboardStore((options) => notices.push(options));
};

// --- a browser that plays along --------------------------------------
{
  writeAllowed = readAllowed = true;
  systemText = '';
  const clip = store();
  const scope = await clip.write('systemd-resolved');
  check('a permitted copy reaches the machine', scope === 'system', scope);
  check('…and the machine has it', systemText === 'systemd-resolved', systemText);
  check('nothing is explained when nothing went wrong', notices.length === 0);

  // Someone copies in another application entirely.
  systemText = 'from another window of the browser';
  check('a read prefers what the machine holds now', (await clip.read()) === systemText);
}

// --- the http install: writeText refused, execCommand still there ----
{
  writeAllowed = false;
  execAllowed = true;
  systemText = '';
  const before = element('TEXTAREA');
  focused = before;
  const clip = store();
  const scope = await clip.write('journalctl -u finestra -f');
  check('the deprecated copy still reaches the machine', scope === 'system', scope);
  check('…with the right text', systemText === 'journalctl -u finestra -f', systemText);
  check('and the caret is given back', focused === before);
}

// --- the http install with nothing left ------------------------------
{
  writeAllowed = false;
  execAllowed = false;
  readAllowed = false;
  systemText = 'something the machine had before this desktop opened';
  const clip = store();

  const scope = await clip.write('/etc/nginx/nginx.conf');
  check('a refused copy is kept in the desktop', scope === 'local', scope);
  check('the desktop says so, once', notices.length === 1);
  await clip.write('10.0.3.14');
  check('…and not again for every copy', notices.length === 1, `${notices.length} notices`);
  check('the refusal is visible to apps', clip.blocked === true);

  check('a refused read pastes the desktop’s own copy', (await clip.read()) === '10.0.3.14');

  // The paste event carries the machine's clipboard, which here is older than
  // the copy just made in another window — the whole point of the exercise.
  check(
    'a stale machine clipboard does not beat a copy made here',
    clip.fromEvent({ clipboardData: { getData: () => systemText } } as unknown as ClipboardEvent) === '10.0.3.14',
  );

  // Now someone really does copy something outside the browser.
  const external = 'ssh-ed25519 AAAAC3Nz…';
  check(
    'a machine clipboard that changes since wins',
    clip.fromEvent({ clipboardData: { getData: () => external } } as unknown as ClipboardEvent) === external,
  );
  await clip.write('back in the desktop');
  check('and copying here again takes it back', clip.text === 'back in the desktop', clip.text);
}

// --- copies the shell never gets asked about -------------------------
{
  writeAllowed = readAllowed = execAllowed = false;
  const clip = store();

  focused = null;
  selectionText = 'a line selected with the mouse';
  fire('copy', '');
  check('a plain Ctrl+C on a selection is remembered', clip.text === selectionText, clip.text);

  const field = element('TEXTAREA');
  field.value = 'PermitRootLogin no';
  field.selectionStart = 0;
  field.selectionEnd = 15;
  focused = field;
  selectionText = '';
  fire('cut', '');
  check("a field's own selection is read off the field", clip.text === 'PermitRootLogin', clip.text);

  let seen = '';
  const off = clip.watch((text) => (seen = text));
  await clip.write('/var/lib/finestra');
  check('watchers hear about a copy', seen === '/var/lib/finestra', seen);
  off();
  await clip.write('and not after unsubscribing');
  check('…and stop when they let go', seen === '/var/lib/finestra');
}

console.log('');
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} of ${results.length} checks FAILED` : `All ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
