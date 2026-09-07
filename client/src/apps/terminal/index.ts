import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { h } from '../../core/dom';
import type { Channel } from '../../core/rpc';
import type { AppContext, AppInstance, AppManifest, DesktopAPI, MenuItem } from '../../core/types';
import './terminal.css';

const TERMINAL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="2" y="4" width="20" height="16" rx="2"/>
  <path d="M6 9l3.5 3L6 15"/><path d="M12.5 15H18"/>
</svg>`;

const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24];
const DEFAULT_FONT_SIZE = 14;

/** Matches the shell's palette so the terminal does not look pasted in. */
const THEME = {
  background: '#0e1116',
  foreground: '#d7dce3',
  cursor: '#8ab4ff',
  cursorAccent: '#0e1116',
  selectionBackground: '#2c4a72',
  black: '#1b1f27',
  red: '#f2777a',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#565f89',
  brightRed: '#ff7a93',
  brightGreen: '#b9f27c',
  brightYellow: '#ff9e64',
  brightBlue: '#8ab4ff',
  brightMagenta: '#c7a9ff',
  brightCyan: '#a4e2ff',
  brightWhite: '#eef1f7',
};

interface TerminalParams {
  cwd?: string;
  shell?: string;
  /** A shell still running on the server, to pick up instead of starting one. */
  attach?: string;
}

interface TerminalInfo {
  id?: string;
  pid?: number;
  shell?: string;
  cwd?: string;
  keep?: boolean;
  /** Whether what follows continues the output already drawn, or replaces it. */
  replay?: 'partial' | 'full';
  /** Stream offset of the first byte about to arrive. */
  offset?: number;
}

/** One shell on the server, as `pty.list` describes it. */
interface RunningTerminal {
  id: string;
  pid: number;
  shell: string;
  cwd: string;
  keep: boolean;
  attached: boolean;
  detachedAt: number | null;
  running: string | null;
}

interface TerminalStatus {
  /** The command holding the terminal, or null when the shell is at a prompt. */
  foreground: { pid: number; command: string } | null;
  /** Background jobs, which die with the shell even though nothing is in front. */
  jobs: Array<{ pid: number; command: string }>;
  busy: boolean;
}

/** Names what closing would kill, so the warning is specific enough to act on. */
function describeRunning(status: TerminalStatus): string {
  if (status.foreground) {
    const others = status.jobs.length;
    return others > 0
      ? `"${status.foreground.command}" and ${others} background job${others === 1 ? '' : 's'}`
      : `"${status.foreground.command}"`;
  }
  const names = status.jobs.map((job) => `"${job.command}"`);
  if (names.length === 1) return `The background job ${names[0]}`;
  return `${names.length} background jobs (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`;
}

/** "bash — ~/src (running make, alone 3 h)": enough to tell them apart. */
function describeTerminal(t: RunningTerminal, home: string | undefined): string {
  const shell = t.shell.split('/').pop() ?? t.shell;
  const cwd = home && t.cwd.startsWith(home) ? `~${t.cwd.slice(home.length)}` : t.cwd;
  const notes: string[] = [];
  if (t.running) notes.push(`running ${t.running}`);
  if (t.attached) notes.push('open in another window');
  else if (t.detachedAt) notes.push(`alone ${describeAge(Date.now() - t.detachedAt)}`);
  if (t.keep) notes.push('kept');
  return `${shell} — ${cwd}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 2) return 'a moment';
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * Opens a window onto every shell on this server that no window is showing.
 *
 * Run once at startup, after session restore. The same browser gets its
 * terminals back from the saved session; this is for the other cases — a
 * different machine, a cleared session — where the job left running
 * yesterday would otherwise sit unseen until its window found it by
 * accident. Returns how many were picked up.
 */
export async function pickUpRunningTerminals(desktop: DesktopAPI): Promise<number> {
  if (!desktop.rpc.hasService('pty') || !desktop.isAppEnabled('terminal')) return 0;
  let terminals: RunningTerminal[];
  try {
    terminals = await desktop.rpc.call<RunningTerminal[]>('pty', 'list');
  } catch {
    return 0;
  }
  let opened = 0;
  for (const t of terminals) {
    if (t.attached) continue;
    const win = await desktop.launch('terminal', { params: { attach: t.id, cwd: t.cwd, shell: t.shell } });
    if (win) opened++;
  }
  return opened;
}

async function mount(ctx: AppContext): Promise<AppInstance> {
  const { window: win, root, desktop, params } = ctx;
  const options = params as TerminalParams;

  let fontSize = desktop.settings.get('terminal.fontSize', DEFAULT_FONT_SIZE);

  const term = new Terminal({
    fontSize,
    fontFamily:
      '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
    scrollback: 10000,
    macOptionIsMeta: true,
    theme: THEME,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  const surface = h('div', { class: 'terminal-surface' });
  const banner = h('div', { class: 'terminal-banner', attrs: { hidden: true } });
  root.replaceChildren(h('div', { class: 'terminal-app' }, surface, banner));
  term.open(surface);

  const encoder = new TextEncoder();
  let channel: Channel | null = null;
  let shellPath = '';
  let disposed = false;
  let resizeFrame = 0;
  let pid: number | null = null;
  /**
   * The server's name for this shell. Set once it is running and kept across
   * a lost connection, so reconnecting picks the same shell up — and saved
   * with the session, so a reload does too.
   */
  let termId: string | null = options.attach ?? null;
  /**
   * Bytes of output drawn so far, as a stream offset the server shares. A
   * reconnect asks for what came after, so nothing is drawn twice.
   */
  let received = 0;
  /** Whether the server holds this shell indefinitely for us, or only for the grace period. */
  let keep = false;
  /** Other shells on the server, for the menu that picks one up. Refreshed on focus. */
  let others: RunningTerminal[] = [];
  /** Set when the socket went away under a live shell, to reattach on reconnect. */
  let awaitingReconnect = false;
  /** Last directory the shell was seen in, for session restore. */
  let lastCwd: string | undefined = options.cwd;
  let cwdTimer: number | null = null;

  /* ---------------------------------------------------------------- */
  /* Sizing                                                            */
  /* ---------------------------------------------------------------- */

  /** Refits on the next frame; a minimized window has no size to measure. */
  const scheduleFit = () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (disposed || surface.clientWidth === 0 || surface.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // The addon throws while the element is detached; the next fit wins.
      }
    });
  };

  // The PTY only needs telling once xterm has settled on a geometry.
  term.onResize(({ cols, rows }) => channel?.ctl('resize', { cols, rows }));

  /* ---------------------------------------------------------------- */
  /* Session                                                           */
  /* ---------------------------------------------------------------- */

  const setBanner = (message: string | null, action?: { label: string; run(): void }) => {
    if (message === null) {
      banner.hidden = true;
      banner.replaceChildren();
    } else {
      banner.hidden = false;
      banner.replaceChildren(h('span', { class: 'terminal-banner-text', text: message }));
      if (action) {
        banner.appendChild(
          h('button', {
            class: 'terminal-banner-action',
            text: action.label,
            on: { click: action.run },
          }),
        );
      }
    }
    // Showing or hiding the banner changes how much room the terminal has.
    // Without this xterm keeps its old pixel height and its absolutely
    // positioned viewport overlaps the banner, swallowing clicks on the button.
    scheduleFit();
  };

  const showStatus = () => {
    win.setStatus(`${shellPath || 'shell'} · pid ${pid ?? '?'}${keep ? ' · kept while away' : ''}`);
  };

  async function setKeep(next: boolean): Promise<void> {
    if (!termId) return;
    try {
      const result = await desktop.rpc.call<{ keep: boolean }>('pty', 'keep', { id: termId, keep: next });
      keep = result.keep;
      showStatus();
    } catch (err) {
      desktop.notify({ message: `Could not change that: ${(err as Error).message}`, kind: 'error' });
    }
  }

  // The menu is built synchronously, so what it lists is whatever the last
  // refresh saw — on focus, and each time the Shell menu opens for next time.
  async function refreshOthers(): Promise<void> {
    try {
      const all = await desktop.rpc.call<RunningTerminal[]>('pty', 'list');
      if (!disposed) others = all.filter((t) => t.id !== termId);
    } catch {
      // Older server, or offline: the submenu simply stays empty.
    }
  }

  const connect = () => {
    if (disposed) return;
    setBanner(null);
    const resuming = termId;
    let opened = false;
    win.setStatus(resuming ? 'Picking the shell back up…' : 'Starting shell…');

    const handlers = {
      onOpen: (info: unknown) => {
        opened = true;
        const got = (info ?? {}) as TerminalInfo;
        const shell = got.shell;
        termId = got.id ?? null;
        pid = got.pid ?? null;
        shellPath = shell ?? '';
        lastCwd = got.cwd ?? lastCwd;
        // What the server is about to replay starts at `offset`; on a full
        // replay it replaces what is drawn, which a reload has none of and a
        // long absence has too much of.
        if (got.replay === 'full') term.reset();
        received = got.offset ?? 0;
        keep = Boolean(got.keep);
        showStatus();
        win.setTitle(titleFor(shell, lastCwd));
        // Resize unconditionally rather than waiting for `onResize`: if the
        // geometry settled before the channel existed, that event has
        // already fired and the PTY would keep the size spawn was given.
        channel?.ctl('resize', { cols: term.cols, rows: term.rows });
        scheduleFit();
        term.focus();
      },

      onBinary: (bytes: Uint8Array) => {
        received += bytes.length;
        term.write(bytes);
      },

      onClose: (error?: string) => {
        channel = null;
        pid = null;
        stopTrackingCwd();
        if (disposed) return;

        // The socket went, not the shell: the server keeps it for a while,
        // so wait for the client to reconnect and pick it up then.
        if (!desktop.rpc.isOpen()) {
          awaitingReconnect = true;
          win.setStatus('Disconnected — the shell keeps running until you are back');
          setBanner('Connection to the server was lost. Reconnecting…');
          return;
        }

        // The shell we meant to pick up is gone — it exited, or the grace
        // period ran out. Start afresh where it was, and say so.
        if (resuming && !opened) {
          termId = null;
          term.write('\r\n\x1b[2m── the previous shell is gone; starting a new one ──\x1b[0m\r\n');
          connect();
          return;
        }

        termId = null;
        win.setStatus(error ?? 'Shell exited');
        term.write('\r\n');
        setBanner(error ?? 'The shell exited.', {
          label: 'Start a new shell',
          run: () => {
            term.reset();
            connect();
          },
        });
      },
    };

    channel = resuming
      ? desktop.rpc.openChannel('pty', 'attach', { id: resuming, since: received }, handlers)
      : desktop.rpc.openChannel(
          'pty',
          'spawn',
          {
            // Restarting a shell reuses the directory the last one ended in.
            cwd: lastCwd,
            // Explicit param first, then the Settings default, then the server's pick.
            shell: options.shell ?? (desktop.settings.get('terminal.defaultShell', '') || undefined),
            cols: term.cols,
            rows: term.rows,
          },
          handlers,
        );
  };

  term.onData((data) => channel?.sendBinary(encoder.encode(data)));

  // Pick the shell back up once the client is back, so a dropped connection
  // heals itself with nothing lost: the server replays what was missed.
  // Only when the shell is known to be gone does a new one start, and then
  // the scrollback is kept so the new prompt appears under the old output.
  const offRpcState = desktop.rpc.events.on('state', (state) => {
    if (state !== 'open' || disposed || !awaitingReconnect || channel) return;
    awaitingReconnect = false;
    if (!termId) term.write('\r\n\x1b[2m── reconnected, starting a new shell ──\x1b[0m\r\n');
    connect();
  });

  /* ---------------------------------------------------------------- */
  /* Working directory tracking                                        */
  /* ---------------------------------------------------------------- */

  /**
   * `saveState` runs synchronously while the page unloads, so the directory
   * has to already be known by then. Poll it only while this terminal is
   * focused — that is when the user is typing `cd` — and once on blur.
   */
  const CWD_POLL_MS = 4000;

  async function refreshCwd(): Promise<void> {
    if (!pid || disposed) return;
    try {
      const result = await desktop.rpc.call<{ cwd: string }>('pty', 'cwd', { pid });
      if (disposed || !result.cwd || result.cwd === lastCwd) return;
      lastCwd = result.cwd;
      win.setTitle(titleFor(shellPath, lastCwd));
    } catch {
      // The shell may have exited, or the host may not expose /proc.
    }
  }

  function startTrackingCwd(): void {
    if (cwdTimer !== null) return;
    void refreshCwd();
    cwdTimer = window.setInterval(() => void refreshCwd(), CWD_POLL_MS);
  }

  function stopTrackingCwd(): void {
    if (cwdTimer === null) return;
    clearInterval(cwdTimer);
    cwdTimer = null;
  }

  // Ctrl+Shift+C/V, since Ctrl+C must keep reaching the shell as SIGINT.
  //
  // Ctrl+Shift+C must preventDefault — the browser reads it as "open
  // devtools". Ctrl+Shift+V must NOT: the browser reads it as paste and fires
  // a `paste` event, and that event is the one look at the system clipboard
  // this http origin ever gets. Suppressing it to fix the double paste cut
  // the outside world off from the terminal — a copy made in another
  // application resolved to the desktop's own (empty) clipboard and "nothing
  // to paste". So the browser's paste is left to happen and *it* is the
  // paste; ours runs only if no event follows, which is what a browser that
  // does not map the gesture to paste does. The double paste stays fixed
  // because only one of the two ever runs.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey || !ev.shiftKey) return true;
    const key = ev.key.toLowerCase();
    if (key === 'c') {
      ev.preventDefault();
      void copySelection();
      return false;
    }
    if (key === 'v') {
      pasteUnlessTheBrowserDoes();
      return false;
    }
    return true;
  });

  // Middle-click paste, the X11 habit. Same deal as Ctrl+Shift+V: on X11 the
  // browser answers it with a paste event carrying the primary selection,
  // which is both the free look and the paste; elsewhere no event comes and
  // the fallback pastes the desktop's clipboard.
  surface.addEventListener('auxclick', (ev) => {
    if (ev.button === 1) pasteUnlessTheBrowserDoes();
  });

  surface.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    desktop.contextMenu(contextMenuItems(), { x: ev.clientX, y: ev.clientY });
  });

  /* ---------------------------------------------------------------- */
  /* Clipboard                                                         */
  /* ---------------------------------------------------------------- */

  // Both sides go through the desktop's clipboard rather than the browser's:
  // over plain http the browser hands nothing over, and a selection copied
  // here has to reach the editor in the next window regardless.
  async function copySelection(): Promise<void> {
    const selection = term.getSelection();
    if (!selection) return;
    await desktop.clipboard.write(selection);
  }

  // term.paste rather than writing the bytes ourselves: it is what performs
  // the transformations pasted text needs — newlines, and the brackets around
  // it when the program running has asked for bracketed paste. Without that,
  // pasting several lines into an editor is indistinguishable from typing
  // them, which is how a paste arrives auto-indented into a staircase.
  async function paste(): Promise<void> {
    const text = await desktop.clipboard.read();
    if (text) term.paste(text);
    else desktop.notify({ message: 'There is nothing to paste.', kind: 'info', timeout: 2000 });
  }

  // Whether the gesture the user just made will produce a browser paste event
  // is a property of the browser and the platform, and there is no way to ask
  // — so ask by waiting. The event, when it comes, comes in the same input
  // task as the gesture, well inside this deadline; when it does not, the
  // desktop's own clipboard was the only source anyway and paste() serves it.
  let expectedPaste: number | null = null;
  function pasteUnlessTheBrowserDoes(): void {
    if (expectedPaste !== null) return;
    expectedPaste = window.setTimeout(() => {
      expectedPaste = null;
      void paste();
    }, 150);
  }

  // A plain Ctrl+V, and the browser's right-click Paste, go through xterm's
  // own hidden textarea and paste what the *browser* holds. That is the stale
  // copy whenever the last one was made in another window of this desktop and
  // never reached the system clipboard, so it is substituted here — in the
  // capture phase, which is what keeps xterm from also pasting its version.
  surface.addEventListener(
    'paste',
    (ev) => {
      // The browser did answer the gesture; the fallback stands down.
      if (expectedPaste !== null) {
        clearTimeout(expectedPaste);
        expectedPaste = null;
      }
      const event = ev as ClipboardEvent;
      const text = desktop.clipboard.fromEvent(event);
      if (!text || text === event.clipboardData?.getData('text/plain')) return;
      event.preventDefault();
      event.stopPropagation();
      term.paste(text);
    },
    true,
  );

  /* ---------------------------------------------------------------- */
  /* Font size                                                         */
  /* ---------------------------------------------------------------- */

  function setFontSize(next: number): void {
    fontSize = Math.min(FONT_SIZES[FONT_SIZES.length - 1], Math.max(FONT_SIZES[0], next));
    term.options.fontSize = fontSize;
    desktop.settings.set('terminal.fontSize', fontSize);
    scheduleFit();
  }

  function stepFontSize(direction: 1 | -1): void {
    const index = FONT_SIZES.indexOf(fontSize);
    const base = index >= 0 ? index : FONT_SIZES.indexOf(DEFAULT_FONT_SIZE);
    setFontSize(FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, base + direction))]);
  }

  // Ctrl+wheel zooms, as in every other terminal.
  surface.addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      stepFontSize(ev.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  /* ---------------------------------------------------------------- */
  /* Menus                                                             */
  /* ---------------------------------------------------------------- */

  function contextMenuItems(): MenuItem[] {
    const hasSelection = term.hasSelection();
    return [
      { label: 'Copy', accelerator: 'Ctrl+Shift+C', disabled: !hasSelection, onSelect: () => void copySelection() },
      { label: 'Paste', accelerator: 'Ctrl+Shift+V', onSelect: () => void paste() },
      { type: 'separator' },
      { label: 'Select all', onSelect: () => term.selectAll() },
      { label: 'Clear', onSelect: () => term.clear() },
    ];
  }

  const menu: MenuItem[] = [
    {
      label: 'Shell',
      submenu: () => (void refreshOthers(), [
        {
          label: 'New terminal',
          accelerator: 'Ctrl+Alt+T',
          onSelect: () => void desktop.launch('terminal'),
        },
        {
          label: 'New terminal here',
          onSelect: () =>
            void desktop.launch('terminal', { params: { cwd: lastCwd, shell: shellPath } }),
        },
        { type: 'separator' },
        {
          label: 'Restart shell',
          onSelect: () => {
            channel?.close();
            term.reset();
            connect();
          },
        },
        { type: 'separator' },
        {
          label: 'Keep running while I am away',
          checked: keep,
          disabled: !termId,
          onSelect: () => void setKeep(!keep),
        },
        {
          label: 'Pick up a terminal',
          disabled: others.length === 0,
          submenu: () =>
            others.map((t) => ({
              label: describeTerminal(t, desktop.host?.home),
              onSelect: () =>
                void desktop.launch('terminal', { params: { attach: t.id, cwd: t.cwd, shell: t.shell } }),
            })),
        },
        { type: 'separator' },
        {
          label: 'Ask before closing',
          checked: desktop.settings.get('terminal.confirmClose', true),
          onSelect: () =>
            desktop.settings.set(
              'terminal.confirmClose',
              !desktop.settings.get('terminal.confirmClose', true),
            ),
        },
        { label: 'Close', accelerator: 'Alt+F4', danger: true, onSelect: () => win.close() },
      ]),
    },
    { label: 'Edit', submenu: () => contextMenuItems() },
    {
      label: 'View',
      submenu: () => [
        { label: 'Zoom in', accelerator: 'Ctrl+Wheel', onSelect: () => stepFontSize(1) },
        { label: 'Zoom out', onSelect: () => stepFontSize(-1) },
        { label: 'Reset zoom', onSelect: () => setFontSize(DEFAULT_FONT_SIZE) },
        { type: 'separator' },
        { label: 'Scroll to bottom', onSelect: () => term.scrollToBottom() },
      ],
    },
  ];

  // Fit before spawning so the shell starts at the right size and never has to
  // redraw its prompt. The window is already in the DOM by the time mount runs.
  try {
    fit.fit();
  } catch {
    // Not laid out yet; the scheduled fit below will catch it.
  }
  scheduleFit();
  connect();

  return {
    menu,

    onResize: () => scheduleFit(),

    onFocus: () => {
      // Refit first: the window may have been resized while minimized.
      scheduleFit();
      term.focus();
      startTrackingCwd();
      void refreshOthers();
    },

    onBlur: () => {
      // One last read, then stop polling until this terminal is used again.
      void refreshCwd();
      stopTrackingCwd();
    },

    saveState: () => ({ cwd: lastCwd, shell: shellPath || options.shell, attach: termId ?? undefined }),

    onClose: async () => {
      // Nothing to lose: the shell already exited, or never started.
      if (!channel || !pid) return true;
      if (!desktop.settings.get('terminal.confirmClose', true)) return true;

      const status = await desktop.rpc
        .call<TerminalStatus>('pty', 'status', { pid })
        .catch(() => null);

      // An idle shell at a prompt is not worth a dialog.
      if (status && !status.busy) return true;

      return desktop.confirm({
        title: 'Close terminal',
        // When the check failed we cannot say what is running, only that
        // closing kills it — so fall back to the blunt warning.
        message: status
          ? `${describeRunning(status)} will be terminated.`
          : 'The shell and anything running in it will be terminated.',
        confirmLabel: 'Close',
        danger: true,
      });
    },

    destroy: () => {
      disposed = true;
      offRpcState();
      stopTrackingCwd();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      channel?.close();
      channel = null;
      term.dispose();
    },
  };
}

function titleFor(shell: string | undefined, cwd: string | undefined): string {
  const name = shell ? shell.split('/').pop() : 'Terminal';
  return cwd ? `${name} — ${cwd}` : `Terminal — ${name ?? 'shell'}`;
}

export const terminalApp: AppManifest = {
  id: 'terminal',
  name: 'Terminal',
  icon: TERMINAL_ICON,
  description: 'A real shell on this server',
  category: 'System',
  showOnDesktop: true,
  defaultSize: { width: 860, height: 520 },
  minSize: { width: 320, height: 180 },
  mount,
};
