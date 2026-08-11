import { h, listen } from '../../core/dom';
import { cssCursor } from './cursor';
import {
  EVDEV_BY_CODE,
  KNOWN_LAYOUTS,
  detectLayout,
  isReservedByShell,
} from './keymap';
import type {
  AppManifest,
  AppContext,
  AppInstance,
  DesktopAPI,
  MenuItem,
} from '../../core/types';
import './wayland.css';

/**
 * A real Linux application, in a window.
 *
 * The server runs a headless Wayland compositor (`compositor/wdcomp`) which
 * hands us the damaged rectangle of each frame, deflated. We blit it onto a
 * canvas and acknowledge, which is what releases the application's frame
 * callback and lets it draw the next one. Resizing the window reconfigures the
 * toplevel, so the application relayouts for real rather than being scaled.
 *
 * An application is more than one surface: the window, its menus — popups,
 * positioned against the window by the compositor — and its dialogs. Each gets
 * its own canvas, and input is routed by whichever one it landed on.
 *
 * Input goes back the other way: pointer events carry surface coordinates, and
 * keys carry evdev codes rather than characters, because the application does
 * its own xkb translation. See keymap.ts.
 *
 * Stages 2–4 of docs/wayland.md.
 */

/** Matches the header wdcomp writes; see compositor/src/ipc.h. */
const FRAME_HEADER_BYTES = 29;
const FLAG_DEFLATE = 0x01;

/** Long enough that a drag does not spam the application with relayouts. */
const RESIZE_DEBOUNCE_MS = 120;

/**
 * What the shell opens the window at, before an application has said what size
 * it would like to be. Only ever seen while nothing is running: the picker, and
 * the moment before the first frame.
 */
const DEFAULT_WINDOW = { width: 900, height: 640 };

/**
 * How many device pixels the application should draw per CSS pixel.
 *
 * Everything below used to be in CSS pixels, and the browser magnified the
 * result to fill a HiDPI box — with `image-rendering: pixelated`, which on text
 * is not blur but nearest-neighbour doubling, uneven at fractional ratios and
 * unpleasant at all of them. Asking the application for the pixels the screen
 * actually has costs a `-g` four times larger at 2x, and is the whole
 * difference between readable text and not.
 *
 * Rounded and clamped because wl_output's scale is an integer by protocol; a
 * 1.5x screen gets 2 and the browser resamples down, which is a resample of a
 * denser image and looks right.
 */
function displayScale(): number {
  return Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
}

/** Pointer kinds, mirrored from compositor/src/ipc.h. */
const POINTER_ENTER = 0;
const POINTER_MOTION = 1;
const POINTER_LEAVE = 2;
const POINTER_BUTTON = 3;
const POINTER_AXIS = 4;

/** xdg_toplevel resize edges. */
const EDGE_TOP = 1;
const EDGE_BOTTOM = 2;
const EDGE_LEFT = 4;
const EDGE_RIGHT = 8;

/** A wheel notch in DOM_DELTA_LINE units, in pixels. */
const LINE_HEIGHT = 16;

interface AvailableResult {
  available: boolean;
  reason?: string;
}

interface RemoteApp {
  id: string;
  name: string;
  comment?: string;
  categories: string[];
  /** Pinned applications also appear as apps of this desktop in their own right. */
  pinned?: boolean;
}

/** An icon as the server found it in the host's icon theme. */
export interface IconData {
  mime: string;
  data: string;
}

/**
 * Wrap image bytes so the shell's `iconEl` renders them: it inlines a string
 * starting with `<svg` and otherwise treats it as text. An `<image>` also
 * cannot run script, which an inlined SVG document could.
 */
export function iconMarkup(icon: IconData | null | undefined): string | null {
  if (!icon) return null;
  return (
    `<svg viewBox="0 0 64 64" aria-hidden="true">` +
    `<image href="data:${icon.mime};base64,${icon.data}" x="0" y="0" width="64" height="64"/>` +
    `</svg>`
  );
}

/** One Wayland surface: the window itself, a menu, or a dialog. */
interface Surface {
  id: number;
  kind: 'window' | 'popup' | 'dialog';
  parent: number;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
  /** Wrapper that positions popups and dialogs; absent for the window. */
  holder: HTMLElement | null;
  detach: Array<() => void>;
}

interface FrameHeader {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  deflated: boolean;
}

function readHeader(bytes: Uint8Array): FrameHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    id: view.getUint32(0),
    x: view.getUint32(4),
    y: view.getUint32(8),
    width: view.getUint32(12),
    height: view.getUint32(16),
    fullWidth: view.getUint32(20),
    fullHeight: view.getUint32(24),
    deflated: (view.getUint8(28) & FLAG_DEFLATE) !== 0,
  };
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream('deflate'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function mount({ window: win, root, desktop, params }: AppContext): Promise<AppInstance> {
  let disposed = false;
  root.classList.add('wayland-root');

  /** Scroll container; the window's canvas lives here, popups on top of it. */
  const stage = h('div', { class: 'wayland-surface' });

  let channel: ReturnType<typeof desktop.rpc.openChannel> | null = null;
  const surfaces = new Map<number, Surface>();
  let mainId: number | null = null;
  let currentApp: string | null =
    typeof params.appId === 'string' ? params.appId : null;
  let minWidth = 0;
  let minHeight = 0;

  /**
   * How much of the application's own interface fits in the window.
   *
   * Not a magnification of the picture: the frame keeps arriving at the
   * screen's density, and this changes how many *logical* pixels the
   * application believes it has. Zooming out hands it a larger desktop, so its
   * interface occupies less of the window and more of the document fits —
   * which is the direction that actually helps, since a remote window is
   * usually smaller than the one the application was designed for. Zooming in
   * hands it a smaller one, and its own scaling makes everything larger.
   */
  const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];
  // Remembered per application, not globally: a dense settings panel wants a
  // different answer from a text editor, and the person who chose one for it
  // should not have to choose again tomorrow.
  const ZOOM_KEY = `wayland.zoom.${currentApp ?? 'picker'}`;
  let zoom = desktop.settings.get<number>(ZOOM_KEY, 1);
  /** The application's last copy, for the status line and for diagnostics. */
  let remoteClipboard = '';
  /** The xkb layout the compositor loads; see keymap.ts for why it matters. */
  let layout = desktop.settings.get<string>('wayland.layout', '');
  /** Name of whatever is running, for the menu and its notifications. */
  let currentName = '';
  /** Which applications are pinned, so the window can say so and change it. */
  const pinnedIds = new Set<string>();

  /* Frames are inflated asynchronously, so they are applied in a chain to
   * keep them in order — a later frame must never overtake an earlier one. */
  let applying: Promise<void> = Promise.resolve();

  let resizeTimer: number | undefined;
  const cleanups: Array<() => void> = [];

  /* The size the window was opened at, or the one last taken from an
   * application. See windowIsUnclaimed(). */
  let unclaimed = { ...DEFAULT_WINDOW };

  /* Declared up here, and installed before anything is launched, because the
   * menu bar comes out of the window's content box: an application started
   * before it appears is one asked to lay out at a size it will not have. */
  const menu: MenuItem[] = [
    {
      label: 'Application',
      submenu: () => [
        {
          label: 'Choose another…',
          disabled: !desktop.rpc.hasService('wayland'),
          onSelect: () => {
            channel?.close();
            channel = null;
            reset();
            void showPicker();
          },
        },
        {
          label: 'Pin to the desktop',
          checked: currentApp ? pinnedIds.has(currentApp) : false,
          // Nothing to pin until something is running.
          disabled: !currentApp || !desktop.rpc.hasService('wayland'),
          onSelect: () => {
            if (!currentApp) return;
            void setPinned(currentApp, currentName || currentApp, !pinnedIds.has(currentApp));
          },
        },
        { type: 'separator' },
        {
          label: 'Zoom out',
          accelerator: 'more of the application',
          disabled: zoom <= ZOOM_STEPS[0],
          onSelect: () => stepZoom(-1),
        },
        {
          label: 'Zoom in',
          accelerator: 'larger',
          disabled: zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1],
          onSelect: () => stepZoom(1),
        },
        {
          label: `Reset zoom (${Math.round(zoom * 100)}%)`,
          disabled: zoom === 1,
          onSelect: () => setZoom(1),
        },
        { type: 'separator' },
        {
          label: 'Keyboard layout',
          submenu: () =>
            KNOWN_LAYOUTS.map((entry) => ({
              label: entry.name,
              checked: layout === entry.id,
              onSelect: () => setLayout(entry.id),
            })),
        },
        { type: 'separator' },
        { label: 'Close', danger: true, onSelect: () => win.close() },
      ],
    },
  ];
  win.setMenu(menu);

  /**
   * Step the zoom and ask the application to relayout at the new size.
   *
   * The canvas is resized here as well as when the next frame lands, so the
   * window does not sit at the old size while the application thinks about it —
   * a redraw at the new box is instant, the reflowed content follows.
   */
  function setZoom(next: number): void {
    const clamped = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], next));
    if (clamped === zoom) return;
    zoom = clamped;
    desktop.settings.set(ZOOM_KEY, zoom);
    const scale = displayScale();
    for (const surface of surfaces.values()) {
      surface.canvas.style.width = `${(surface.canvas.width * zoom) / scale}px`;
      surface.canvas.style.height = `${(surface.canvas.height * zoom) / scale}px`;
    }
    pushSize();
    win.setMenu(menu);
  }

  function stepZoom(direction: 1 | -1): void {
    const i = ZOOM_STEPS.indexOf(zoom);
    const from = i >= 0 ? i : ZOOM_STEPS.findIndex((z) => z >= zoom);
    setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, from + direction))]);
  }

  /* ---------------------------------------------------------------- */
  /* Pinning                                                           */
  /* ---------------------------------------------------------------- */

  async function loadPins(): Promise<void> {
    try {
      const result = await desktop.rpc.call<{ pinned: PinnedApp[] }>('wayland', 'pins', {});
      if (disposed) return;
      pinnedIds.clear();
      for (const entry of result.pinned) pinnedIds.add(entry.id);
    } catch {
      // An older server. Pinning simply is not offered.
    }
  }

  /**
   * Pin or unpin, from wherever the person happens to be — the browser list
   * or the window of the application itself. Going back to the list to star
   * something you are already looking at is a detour nobody should take.
   */
  async function setPinned(id: string, name: string, next: boolean): Promise<boolean> {
    try {
      const result = await desktop.rpc.call<{ pinned: PinnedApp[] }>(
        'wayland', 'setPinned', { id, pinned: next },
      );
      if (disposed) return false;
      pinnedIds.clear();
      for (const entry of result.pinned) pinnedIds.add(entry.id);

      desktop.notify({
        kind: 'success',
        message: next
          ? `${name} is now an app of this desktop. It has its own icon; ` +
            `reload to see it on the desktop.`
          : `${name} is no longer pinned.`,
        timeout: 4000,
      });
      return true;
    } catch (err) {
      if (disposed) return false;
      desktop.notify({
        kind: 'error',
        title: 'Could not change the pin',
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  function showPanel(...children: Array<Node | string | null>): void {
    root.replaceChildren(h('div', { class: 'wayland-panel' }, ...children));
  }

  function showMessage(title: string, detail: string, retry?: () => void): void {
    showPanel(
      h('h2', { text: title }),
      h('p', { text: detail }),
      retry ? h('button', { class: 'wayland-button', text: 'Try again', on: { click: retry } }) : null,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Surfaces                                                          */
  /* ---------------------------------------------------------------- */

  function createSurface(id: number, kind: Surface['kind'], parent: number): Surface {
    const canvas = h('canvas', { class: 'wayland-canvas' });
    const surface: Surface = {
      id,
      kind,
      parent,
      // Menus and dialogs have rounded corners and shadows, so they need the
      // alpha channel the window itself does not.
      context: canvas.getContext('2d', { alpha: kind !== 'window' }),
      canvas,
      holder: null,
      detach: [],
    };

    if (kind === 'window') {
      stage.replaceChildren(canvas);
    } else if (kind === 'popup') {
      // Positioned by the compositor, in the window's own coordinates.
      surface.holder = h('div', { class: 'wayland-popup' }, canvas);
      stage.appendChild(surface.holder);
    } else {
      // A dialog is its own window on a real desktop; here it sits over its
      // parent, which is where a modal one would appear anyway.
      surface.holder = h('div', { class: 'wayland-dialog' }, canvas);
      root.appendChild(h('div', { class: 'wayland-backdrop' }, surface.holder));
    }

    wireInput(surface);
    surfaces.set(id, surface);
    return surface;
  }

  function destroySurface(id: number): void {
    const surface = surfaces.get(id);
    if (!surface) return;
    for (const off of surface.detach) off();
    surfaces.delete(id);

    if (surface.kind === 'dialog') surface.holder?.parentElement?.remove();
    else if (surface.holder) surface.holder.remove();
    else surface.canvas.remove();
  }

  function placePopup(surface: Surface, x: number, y: number): void {
    if (!surface.holder) return;
    surface.holder.style.left = `${x}px`;
    surface.holder.style.top = `${y}px`;
  }

  /* ---------------------------------------------------------------- */
  /* Frames                                                            */
  /* ---------------------------------------------------------------- */

  function contentSize(): { width: number; height: number } | null {
    // clientWidth is rounded, and rounding *up* asks the application for a
    // frame a fraction of a pixel taller than the box it has to sit in — which
    // is enough to overflow it. Floor the real box instead.
    const box = root.getBoundingClientRect();
    const width = Math.min(root.clientWidth, Math.floor(box.width));
    const height = Math.min(root.clientHeight, Math.floor(box.height));
    // A minimized window has a zero-size content box; asking the application
    // to relayout to that would be worse than waiting.
    if (width < 64 || height < 64) return null;
    return { width, height };
  }

  /**
   * The same box in the pixels the application should actually paint.
   *
   * `* scale` is the density of the screen; `/ zoom` is how much of the
   * application's interface is asked to fit in it. The two are independent on
   * purpose — zooming never costs sharpness, because the pixels-per-CSS-pixel
   * ratio is unchanged by it.
   */
  function frameSize(): { width: number; height: number } | null {
    const css = contentSize();
    if (!css) return null;
    const scale = displayScale();
    return {
      width: Math.round((css.width * scale) / zoom),
      height: Math.round((css.height * scale) / zoom),
    };
  }

  /**
   * The stage scrolls only when the application really is bigger than the
   * space it was given — a window sitting at its own minimum size.
   *
   * Left on `overflow: auto` permanently, the scrollbars sustain themselves: a
   * frame that overflows by a pixel raises them, they take 11px out of the
   * viewport, and that is enough to keep the *next* frame — sized to the
   * window, not to the shrunken viewport — overflowing too. Both bars then
   * stay up for the life of the window, until a resize happens to break the
   * cycle. Deciding it here, from two sizes we already know, means layout
   * never feeds back into the size we ask for.
   */
  function updateScrolling(): void {
    // In the application's pixels, because that is what canvas.width counts.
    const size = frameSize();
    const canvas = mainId === null ? undefined : surfaces.get(mainId)?.canvas;
    stage.classList.toggle(
      'is-scrollable',
      !!size && !!canvas && (canvas.width > size.width || canvas.height > size.height),
    );
  }

  function applyFrame(bytes: Uint8Array): void {
    applying = applying
      .then(async () => {
        if (disposed || bytes.length < FRAME_HEADER_BYTES) return;
        const header = readHeader(bytes);

        const payload = bytes.subarray(FRAME_HEADER_BYTES);
        const pixels = header.deflated ? await inflate(payload) : payload;
        // A surface can be closed while its frame is still inflating.
        const surface = surfaces.get(header.id);
        if (disposed || !surface) return;

        const expected = header.width * header.height * 4;
        if (pixels.length < expected) return;

        const { canvas } = surface;
        // Resizing the canvas clears it, so only do it when it really changed.
        // wdcomp always sends a full frame when the size changes, so nothing
        // is lost by the clear.
        if (canvas.width !== header.fullWidth || canvas.height !== header.fullHeight) {
          canvas.width = header.fullWidth;
          canvas.height = header.fullHeight;
          // The backing store is in the application's pixels; the box it is
          // drawn in is in CSS pixels. Dividing by the scale is what makes a
          // 2x frame occupy the same space and resolve at twice the density,
          // rather than being magnified to twice the size.
          const scale = displayScale();
          canvas.style.width = `${(header.fullWidth * zoom) / scale}px`;
          canvas.style.height = `${(header.fullHeight * zoom) / scale}px`;
        }

        const image = new ImageData(
          // Never a SharedArrayBuffer here: these bytes come off the socket
          // or out of the inflater, both of which allocate their own.
          new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, expected),
          header.width,
          header.height,
        );
        surface.context?.putImageData(image, header.x, header.y);

        if (header.id === mainId) {
          updateScrolling();
          win.setStatus(
            `${header.fullWidth}×${header.fullHeight} · frame ${formatBytes(bytes.length)}`,
          );
        }

        // Acknowledging is what releases the application's frame callback.
        channel?.ctl('ack', { id: header.id });
      })
      .catch((err) => {
        if (!disposed) console.error('[wayland] could not apply a frame:', err);
      });
  }

  /* ---------------------------------------------------------------- */
  /* Messages                                                          */
  /* ---------------------------------------------------------------- */

  interface Message {
    t?: string;
    id?: number;
    parent?: number;
    title?: string;
    message?: string;
    x?: number;
    y?: number;
    /** For a window: the size it chose for itself. */
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    edges?: number;
    shape?: number;
    text?: string;
  }

  function handleMessage(data: unknown): void {
    const message = data as Message;
    const id = message.id ?? 0;

    switch (message.t) {
      case 'window': {
        if (surfaces.has(id)) break;
        // The first parentless toplevel is the window; later ones are dialogs.
        const isMain = mainId === null && !message.parent;
        const surface = createSurface(id, isMain ? 'window' : 'dialog', message.parent ?? 0);
        if (isMain) {
          mainId = id;
          root.replaceChildren(stage);
          if (message.title) win.setTitle(message.title);
          if (win.focused) surface.canvas.focus();
          adoptSize(message.width, message.height);
        }
        break;
      }

      case 'popup': {
        const surface = surfaces.get(id) ?? createSurface(id, 'popup', message.parent ?? 0);
        placePopup(surface, message.x ?? 0, message.y ?? 0);
        break;
      }

      case 'title':
        if (id === mainId && message.title) win.setTitle(message.title);
        break;

      case 'bounds':
        if (id === mainId) {
          minWidth = message.minWidth ?? 0;
          minHeight = message.minHeight ?? 0;
        }
        break;

      case 'closed':
        // The application closing its own window closes ours.
        if (id === mainId) win.close();
        else destroySurface(id);
        break;

      case 'copy':
        // The application copied something. Push it at the system clipboard
        // if the browser allows it unprompted; keep it either way, because
        // the `copy` event below can still serve it without permission.
        remoteClipboard = message.text ?? '';
        void navigator.clipboard?.writeText(remoteClipboard).catch(() => {
          // Firefox wants a user gesture, and a denied permission is not an
          // error worth showing: Ctrl+C still works through the copy event.
        });
        break;

      case 'cursor':
        // On the root, not the stage: dialogs sit outside the stage, and the
        // compositor tracks one cursor for whichever surface the pointer is
        // actually over.
        root.style.cursor = cssCursor(message.shape ?? 1);
        break;

      case 'move':
        beginDrag('move', 0);
        break;

      case 'resize':
        beginDrag('resize', message.edges ?? 0);
        break;

      case 'log':
        console.debug('[wayland]', message.message);
        break;

      default:
        break;
    }
  }

  /**
   * Whether the window's geometry is still ours to give away.
   *
   * It is, while the window is the size the shell opened it at — nobody has
   * dragged it, maximized it, or restored it from a saved session — and then
   * an application may size it to whatever it wants. Once the geometry is the
   * person's, it stays theirs and applications fit into it.
   */
  function windowIsUnclaimed(): boolean {
    if (win.state !== 'normal') return false;
    const bounds = win.getBounds();
    return bounds.width === unclaimed.width && bounds.height === unclaimed.height;
  }

  /**
   * Take the size the application chose for itself.
   *
   * Applications have opinions about how big they are — a calculator is not
   * 900 pixels wide, and one squeezed into a generic frame either wastes the
   * space or, if the frame is below the minimum it will accept, overflows it
   * for as long as it is open. So the window becomes the size the application
   * asked for, plus the shell's own chrome around it.
   */
  function adoptSize(width?: number, height?: number): void {
    if (!width || !height || !windowIsUnclaimed()) {
      pushSize();
      return;
    }

    // Titlebar, menu bar, status strip, borders: what the window costs on top
    // of the box the application draws into. Rounded up, never down — a box a
    // fraction of a pixel short of what the application will accept is one it
    // overflows, and then it is back to being scrolled.
    const box = root.getBoundingClientRect();
    const outer = win.getBounds();
    win.setBounds({
      width: width + Math.ceil(outer.width - box.width),
      height: height + Math.ceil(outer.height - box.height),
    });

    const next = win.getBounds();
    unclaimed = { width: next.width, height: next.height };
    // The window is clamped to the work area, so what the application asked
    // for is not always what it got. Tell it what it actually has.
    pushSize();
  }

  function pushSize(): void {
    if (mainId === null || !channel) return;
    const size = frameSize();
    if (!size) return;
    // A window that cannot follow us down — one already at its minimum — sends
    // no new frame, so this is the only chance to offer it a scrollbar.
    updateScrolling();
    // The compositor clamps to the application's own minimum anyway; not
    // asking for less avoids a round of configure churn on every drag.
    channel.ctl('configure', {
      id: mainId,
      width: Math.max(size.width, minWidth),
      height: Math.max(size.height, minHeight),
    });
  }

  /* ---------------------------------------------------------------- */
  /* The application asking to be moved or resized                     */
  /* ---------------------------------------------------------------- */

  /**
   * Applications draw their own titlebars, so dragging one is the *client*
   * asking the compositor to begin a window drag. The shell already knows how
   * to move its own windows; it just has to accept the request from here.
   */
  function beginDrag(mode: 'move' | 'resize', edges: number): void {
    const start = win.getBounds();
    let originX = 0;
    let originY = 0;
    let started = false;

    const move = (ev: PointerEvent) => {
      if (!started) {
        // The request arrives without a position, so the first movement after
        // it is the origin.
        originX = ev.clientX;
        originY = ev.clientY;
        started = true;
        return;
      }
      const dx = ev.clientX - originX;
      const dy = ev.clientY - originY;

      if (mode === 'move') {
        win.setBounds({ x: start.x + dx, y: start.y + dy });
        return;
      }

      const bounds = { ...start };
      if (edges & EDGE_RIGHT) bounds.width = Math.max(160, start.width + dx);
      if (edges & EDGE_LEFT) {
        bounds.width = Math.max(160, start.width - dx);
        bounds.x = start.x + (start.width - bounds.width);
      }
      if (edges & EDGE_BOTTOM) bounds.height = Math.max(120, start.height + dy);
      if (edges & EDGE_TOP) {
        bounds.height = Math.max(120, start.height - dy);
        bounds.y = start.y + (start.height - bounds.height);
      }
      win.setBounds(bounds);
    };

    const stop = () => {
      offMove();
      offUp();
      offCancel();
      pushSize();
    };

    // On the document: the pointer leaves the canvas almost immediately.
    const offMove = listen(document, 'pointermove', move);
    const offUp = listen(document, 'pointerup', stop);
    const offCancel = listen(document, 'pointercancel', stop);
    cleanups.push(stop);
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  function pointerAt(surface: Surface, ev: MouseEvent): { x: number; y: number } {
    // The canvas *is* CSS-scaled now — it holds the application's pixels and is
    // shown in a smaller CSS box — so a click has to be converted into that
    // pixel space. Taken from the canvas's own two sizes rather than from
    // devicePixelRatio, so it stays right for the frame actually on screen even
    // if the window moved to a display of a different density mid-session.
    const box = surface.canvas.getBoundingClientRect();
    const ratio = box.width > 0 ? surface.canvas.width / box.width : 1;
    return {
      x: Math.round((ev.clientX - box.left) * ratio),
      y: Math.round((ev.clientY - box.top) * ratio),
    };
  }

  function sendPointer(surface: Surface, kind: number, ev: MouseEvent, arg = 0, value = 0): void {
    if (!channel) return;
    const { x, y } = pointerAt(surface, ev);
    channel.ctl('pointer', { id: surface.id, kind, x, y, arg, value });
  }

  function wireInput(surface: Surface): void {
    const { canvas } = surface;
    // The canvas needs to be focusable for key events to reach it at all.
    canvas.tabIndex = 0;

    surface.detach.push(
      listen(canvas, 'pointerenter', (ev: PointerEvent) => sendPointer(surface, POINTER_ENTER, ev)),
      listen(canvas, 'pointerleave', (ev: PointerEvent) => sendPointer(surface, POINTER_LEAVE, ev)),
      listen(canvas, 'pointermove', (ev: PointerEvent) => sendPointer(surface, POINTER_MOTION, ev)),

      listen(canvas, 'pointerdown', (ev: PointerEvent) => {
        ev.preventDefault();
        canvas.focus();
        sendPointer(surface, POINTER_BUTTON, ev, ev.button, 1);
      }),
      listen(canvas, 'pointerup', (ev: PointerEvent) => {
        ev.preventDefault();
        sendPointer(surface, POINTER_BUTTON, ev, ev.button, 0);
      }),
      // Applications draw their own menus; the shell's context menu would sit
      // on top of one and win.
      listen(canvas, 'contextmenu', (ev: Event) => ev.preventDefault()),

      listen(canvas, 'wheel', (ev: WheelEvent) => {
        ev.preventDefault();
        const scale = ev.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_HEIGHT : 1;
        if (ev.deltaY) sendPointer(surface, POINTER_AXIS, ev, 0, Math.round(ev.deltaY * scale));
        if (ev.deltaX) sendPointer(surface, POINTER_AXIS, ev, 1, Math.round(ev.deltaX * scale));
      }, { passive: false }),

      listen(canvas, 'keydown', (ev: KeyboardEvent) => onKey(surface, ev, true)),
      listen(canvas, 'keyup', (ev: KeyboardEvent) => onKey(surface, ev, false)),

      // Losing focus with a key held would leave the application with a stuck
      // modifier, so the compositor is told and releases everything.
      listen(canvas, 'blur', () => channel?.ctl('focus', { id: surface.id, focused: false })),
      listen(canvas, 'focus', () => channel?.ctl('focus', { id: surface.id, focused: true })),
    );
  }

  function onKey(surface: Surface, ev: KeyboardEvent, pressed: boolean): void {
    if (!channel) return;
    if (isReservedByShell(ev)) return;

    const keycode = EVDEV_BY_CODE[ev.code];
    if (!keycode) return;

    /*
     * Paste is the one combination we cannot simply forward. Reading the
     * system clipboard needs a permission prompt, but the browser will hand
     * it over for free in a `paste` event — and only if we let the keystroke
     * through. So this one is deliberately not claimed: the paste handler
     * below puts the text where the application can ask for it, and then
     * replays the key.
     */
    if (pressed && isPasteCombo(ev)) {
      pendingPaste = surface;
      return;
    }

    // The application repeats for itself from the keymap's repeat_info, so the
    // browser's own auto-repeat would double every held key.
    if (!ev.repeat) channel.ctl('key', { id: surface.id, keycode, pressed });

    // Claimed: without this the browser acts on Ctrl+W, Ctrl+S, Tab and space.
    ev.preventDefault();
  }

  /* ---------------------------------------------------------------- */
  /* Clipboard                                                         */
  /* ---------------------------------------------------------------- */

  /** Which surface asked to paste, so the key can be replayed to it. */
  let pendingPaste: Surface | null = null;

  function isPasteCombo(ev: KeyboardEvent): boolean {
    if (ev.code !== 'KeyV' || !(ev.ctrlKey || ev.metaKey)) return false;
    return true;
  }

  /**
   * The browser gives us the clipboard here without asking anyone's
   * permission. Hand it to the compositor, which offers it as a selection,
   * then replay the keystroke so the application pastes as it normally would.
   */
  function onPaste(ev: ClipboardEvent): void {
    const surface = pendingPaste;
    pendingPaste = null;
    if (!surface || !channel) return;

    const text = ev.clipboardData?.getData('text/plain') ?? '';
    ev.preventDefault();
    channel.ctl('paste', { text });

    const keycode = EVDEV_BY_CODE.KeyV;
    channel.ctl('key', { id: surface.id, keycode, pressed: true });
    channel.ctl('key', { id: surface.id, keycode, pressed: false });
  }

  /*
   * There is deliberately no `copy` handler to match the paste one. Ctrl+C is
   * forwarded to the application, so the browser never fires `copy` — and
   * serving it from the last known value would quietly put stale text on the
   * clipboard, which is worse than not answering. Copying out goes through
   * writeText above instead, inside the activation window the keystroke just
   * opened.
   */
  cleanups.push(listen(root, 'paste', onPaste as (ev: Event) => void));

  /* ---------------------------------------------------------------- */
  /* The session                                                       */
  /* ---------------------------------------------------------------- */

  function reset(): void {
    for (const id of [...surfaces.keys()]) destroySurface(id);
    stage.replaceChildren();
    mainId = null;
    minWidth = 0;
    minHeight = 0;
  }

  function start(appId: string): void {
    currentApp = appId;
    reset();

    showMessage('Starting…', 'Waiting for the application to draw its first frame.');
    // Before measuring, not after: the status strip is part of the window's
    // chrome, and one that appears with the first frame takes its ~20px out of
    // the content box the application was just told to fit.
    win.setStatus('Starting…');

    // A window that is still the size the shell opened it at is nobody's yet,
    // so the application is launched without a size and picks its own; the
    // window is then resized to fit it. One the person has sized themselves is
    // theirs, and the application is launched to fit *it* instead.
    const size = windowIsUnclaimed() ? undefined : frameSize();
    channel = desktop.rpc.openChannel(
      'wayland',
      'session',
      {
        appId,
        width: size?.width,
        height: size?.height,
        layout: layout || undefined,
        scale: displayScale(),
      },
      {
        onOpen: (info) => {
          const opened = info as { name?: string } | undefined;
          currentName = opened?.name ?? appId;
        },
        onData: handleMessage,
        onBinary: applyFrame,
        onClose: (error) => {
          channel = null;
          if (disposed) return;
          const started = mainId !== null;
          reset();
          showMessage(
            started ? 'The application closed' : 'The application did not start',
            error ?? (started ? 'It exited normally.' : 'It exited before opening a window.'),
            () => start(appId),
          );
        },
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Choosing what to run                                              */
  /* ---------------------------------------------------------------- */

  async function showPicker(): Promise<void> {
    showMessage('Loading…', 'Looking for installed applications.');

    let apps: RemoteApp[];
    try {
      apps = await desktop.rpc.call<RemoteApp[]>('wayland', 'apps', {});
    } catch (err) {
      if (disposed) return;
      showMessage(
        'Could not list applications',
        err instanceof Error ? err.message : String(err),
        () => void showPicker(),
      );
      return;
    }
    if (disposed) return;

    if (apps.length === 0) {
      // An empty list is the *expected* result on a cloud server, and saying
      // so plainly stops it reading as a broken feature.
      showMessage(
        'No desktop applications installed',
        'This is normal for a server: a headless machine has no reason to carry ' +
          'GUI applications. Installing a desktop package here is a deliberate ' +
          'choice, for the rare case where a particular program has to be run ' +
          'on this machine and seen from the browser.',
      );
      return;
    }

    const list = h('div', { class: 'wayland-list' });
    const filter = h('input', {
      class: 'wayland-filter',
      attrs: { type: 'search', placeholder: 'Search applications…' },
    });

    /** Icons are fetched per row on demand; sending all of them is megabytes. */
    async function fillIcon(id: string, slot: HTMLElement): Promise<void> {
      try {
        const icon = await desktop.rpc.call<IconData | null>('wayland', 'icon', { id });
        const markup = iconMarkup(icon);
        if (!disposed && markup && slot.isConnected) slot.innerHTML = markup;
      } catch {
        // No icon is not a failure; the placeholder glyph stays.
      }
    }

    async function togglePin(app: RemoteApp): Promise<void> {
      if (await setPinned(app.id, app.name, !app.pinned)) {
        app.pinned = pinnedIds.has(app.id);
        render(filter.value);
      }
    }

    const render = (query: string) => {
      const needle = query.trim().toLowerCase();
      const matches = needle
        ? apps.filter(
            (app) =>
              app.name.toLowerCase().includes(needle) ||
              (app.comment ?? '').toLowerCase().includes(needle),
          )
        : apps;

      list.replaceChildren(
        ...matches.map((app) => {
          const iconSlot = h('span', { class: 'wayland-item-icon', text: '🪟' });
          void fillIcon(app.id, iconSlot);

          const pin = h('button', {
            class: `wayland-pin${app.pinned ? ' is-pinned' : ''}`,
            text: app.pinned ? '★' : '☆',
            title: app.pinned
              ? `Unpin ${app.name} from the desktop`
              : `Pin ${app.name} to the desktop, so it gets its own icon`,
            attrs: { 'aria-label': app.pinned ? 'Unpin' : 'Pin' },
            on: {
              click: (ev: MouseEvent) => {
                // The row itself launches; the star must not.
                ev.stopPropagation();
                void togglePin(app);
              },
            },
          });

          return h(
            'div',
            { class: 'wayland-item', on: { click: () => start(app.id) } },
            iconSlot,
            h(
              'span',
              { class: 'wayland-item-text' },
              h('span', { class: 'wayland-item-name', text: app.name }),
              app.comment
                ? h('span', { class: 'wayland-item-comment', text: app.comment })
                : null,
            ),
            pin,
          );
        }),
      );
    };

    filter.addEventListener('input', () => render(filter.value));
    render('');

    root.replaceChildren(
      h('div', { class: 'wayland-picker' },
        h('div', { class: 'wayland-picker-head' },
          h('h2', { text: 'Run an application' }),
          filter,
        ),
        h('div', {
          class: 'wayland-picker-hint',
          text: 'Click to run. Star an application to pin it to the desktop as an app of its own.',
        }),
        list,
      ),
    );
    filter.focus();
  }

  /* ---------------------------------------------------------------- */
  /* Startup                                                           */
  /* ---------------------------------------------------------------- */

  if (typeof DecompressionStream === 'undefined') {
    showMessage(
      'This browser cannot show remote applications',
      'Frames arrive compressed, and DecompressionStream is not available here.',
    );
  } else if (!desktop.rpc.hasService('wayland')) {
    showMessage(
      'Not supported by this server',
      'The server does not offer the wayland service. It may be an older build.',
    );
  } else {
    const status = await desktop.rpc
      .call<AvailableResult>('wayland', 'available', {})
      .catch(() => ({ available: false, reason: 'The server did not answer.' }));

    await loadPins();

    if (!layout) {
      // Keys are physical positions, so the compositor's keymap has to match
      // the real keyboard. The browser knows; ask it before starting.
      layout = (await detectLayout()) ?? 'us';
    }

    if (disposed) {
      // The window closed while we were asking.
    } else if (!status.available) {
      showMessage('Not available on this server', status.reason ?? 'Unknown reason.');
    } else if (currentApp) {
      start(currentApp);
    } else {
      void showPicker();
    }
  }

  function setLayout(next: string): void {
    layout = next;
    desktop.settings.set('wayland.layout', next);
    // The keymap is loaded when the compositor starts, so this takes effect
    // on the next launch rather than mid-session.
    desktop.notify({
      message: `Keyboard layout set to ${next}. Restart the application to apply it.`,
      kind: 'info',
    });
  }

  function focusMain(): void {
    if (mainId === null) return;
    surfaces.get(mainId)?.canvas.focus();
  }

  return {
    menu,

    onResize: () => {
      // Debounced: a drag would otherwise ask the application to relayout on
      // every mouse move.
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!disposed) pushSize();
      }, RESIZE_DEBOUNCE_MS);
    },

    // A minimized window has no size to measure, so the configure that was
    // skipped while hidden has to happen on the way back. Focusing the canvas
    // is what routes keys to the application rather than the shell.
    onFocus: () => {
      pushSize();
      focusMain();
    },

    onBlur: () => {
      if (mainId !== null) channel?.ctl('focus', { id: mainId, focused: false });
    },

    saveState: () => (currentApp ? { appId: currentApp } : undefined),

    destroy: () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      for (const off of cleanups) off();
      reset();
      channel?.close();
      channel = null;
    },
  };
}

export const waylandApp: AppManifest = {
  id: 'wayland',
  name: 'Native Desktop Applications',
  icon: '🪟',
  description: 'Browse and run Linux desktop applications installed on the server',
  category: 'System',
  showOnDesktop: false,
  defaultSize: { ...DEFAULT_WINDOW },
  minSize: { width: 320, height: 240 },
  mount,
};

/** What `pins` returns: enough to build an app manifest from. */
interface PinnedApp {
  id: string;
  name: string;
  comment?: string;
  categories: string[];
  icon: IconData | null;
}

/**
 * Register each pinned native application as an app of this desktop.
 *
 * The runtime is shared — every one of these mounts the same function with a
 * different `appId` — but the *identity* is its own: a desktop icon, a
 * launcher entry, a taskbar name, and a session-restore record under
 * `wayland:<id>`. That is the whole difference between browsing applications
 * and having them.
 *
 * Must run before `restoreSession()`, or a pinned window has no app to
 * restore into.
 */
export async function registerPinnedApps(desktop: DesktopAPI): Promise<void> {
  if (!desktop.rpc.hasService('wayland')) return;

  let pinned: PinnedApp[];
  try {
    const result = await desktop.rpc.call<{ pinned: PinnedApp[] }>('wayland', 'pins', {});
    pinned = result.pinned;
  } catch {
    // An older server, or one that cannot read its state: the wrapper still
    // works, so this is not worth interrupting the boot for.
    return;
  }

  for (const app of pinned) {
    desktop.register({
      id: `wayland:${app.id}`,
      name: app.name,
      icon: iconMarkup(app.icon) ?? '🪟',
      description: app.comment ?? 'A Linux desktop application on the server',
      category: 'Applications',
      showOnDesktop: true,
      defaultSize: { ...DEFAULT_WINDOW },
      minSize: { width: 320, height: 240 },
      // The app id is fixed by the manifest, not by whatever a restored
      // session happens to carry, so a pin always runs what it names.
      mount: (ctx) => mount({ ...ctx, params: { ...ctx.params, appId: app.id } }),
    });
  }
}
