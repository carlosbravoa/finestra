import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { h } from '../../core/dom';
import type { Channel } from '../../core/rpc';
import type { AppContext, AppInstance, AppManifest, MenuItem } from '../../core/types';
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
  /** Set when the shell died with the socket, so it is respawned on reconnect. */
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

  const connect = () => {
    if (disposed) return;
    setBanner(null);
    win.setStatus('Starting shell…');

    channel = desktop.rpc.openChannel(
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
      {
        onOpen: (info) => {
          const opened = (info ?? {}) as { pid?: number; shell?: string; cwd?: string };
          const shell = opened.shell;
          pid = opened.pid ?? null;
          shellPath = shell ?? '';
          lastCwd = opened.cwd ?? lastCwd;
          win.setStatus(`${shell ?? 'shell'} · pid ${opened.pid ?? '?'}`);
          win.setTitle(titleFor(shell, lastCwd));
          // Resize unconditionally rather than waiting for `onResize`: if the
          // geometry settled before the channel existed, that event has
          // already fired and the PTY would keep the size spawn was given.
          channel?.ctl('resize', { cols: term.cols, rows: term.rows });
          scheduleFit();
          term.focus();
        },

        onBinary: (bytes) => term.write(bytes),

        onClose: (error) => {
          channel = null;
          pid = null;
          stopTrackingCwd();
          if (disposed) return;

          // A shell that died with the socket is a connectivity problem, not a
          // shell that exited. Retrying by hand would just fail again, so wait
          // for the client to reconnect and respawn then.
          if (!desktop.rpc.isOpen()) {
            awaitingReconnect = true;
            win.setStatus('Disconnected — waiting for the server');
            setBanner('Connection to the server was lost. Reconnecting…');
            return;
          }

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
      },
    );
  };

  term.onData((data) => channel?.sendBinary(encoder.encode(data)));

  // Respawn once the client is back, so a dropped connection heals itself.
  // Scrollback is deliberately kept: the new shell prints a fresh prompt under
  // whatever the old one left behind.
  const offRpcState = desktop.rpc.events.on('state', (state) => {
    if (state !== 'open' || disposed || !awaitingReconnect || channel) return;
    awaitingReconnect = false;
    term.write('\r\n\x1b[2m── reconnected, starting a new shell ──\x1b[0m\r\n');
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
  // Both must preventDefault, and Ctrl+Shift+V is why: the browser reads it as
  // paste-as-plain-text and fires a `paste` event of its own. Returning false
  // only tells xterm to keep its hands off the key, so the text arrived twice
  // — once from the handler below servicing that event, and once from paste()
  // here. The same reasoning as the middle-click handler, which has always had
  // to stop the X11 primary-selection paste that comes with it.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.ctrlKey || !ev.shiftKey) return true;
    const key = ev.key.toLowerCase();
    if (key === 'c') {
      ev.preventDefault();
      void copySelection();
      return false;
    }
    if (key === 'v') {
      ev.preventDefault();
      void paste();
      return false;
    }
    return true;
  });

  // Middle-click paste, the X11 habit.
  surface.addEventListener('auxclick', (ev) => {
    if (ev.button === 1) {
      ev.preventDefault();
      void paste();
    }
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

  // A plain Ctrl+V, and the browser's right-click Paste, go through xterm's
  // own hidden textarea and paste what the *browser* holds. That is the stale
  // copy whenever the last one was made in another window of this desktop and
  // never reached the system clipboard, so it is substituted here — in the
  // capture phase, which is what keeps xterm from also pasting its version.
  surface.addEventListener(
    'paste',
    (ev) => {
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
      submenu: () => [
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
          label: 'Ask before closing',
          checked: desktop.settings.get('terminal.confirmClose', true),
          onSelect: () =>
            desktop.settings.set(
              'terminal.confirmClose',
              !desktop.settings.get('terminal.confirmClose', true),
            ),
        },
        { label: 'Close', accelerator: 'Alt+F4', danger: true, onSelect: () => win.close() },
      ],
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
    },

    onBlur: () => {
      // One last read, then stop polling until this terminal is used again.
      void refreshCwd();
      stopTrackingCwd();
    },

    saveState: () => ({ cwd: lastCwd, shell: shellPath || options.shell }),

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
