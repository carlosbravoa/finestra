import { DBus, Variant, type Message } from './dbus.js';

/*
 * The file-chooser half of xdg-desktop-portal, answered by the browser.
 *
 * A confined application — the Firefox snap above all — does not open its own
 * file dialog. It asks `org.freedesktop.portal.Desktop` on the session bus
 * for one and waits for a `Response` signal; with nobody owning that name the
 * dialog never appears and nothing says why. A headless server has no portal,
 * so this owns the name on every bus this server hands an application, and
 * each request becomes a dialog in the browser window that launched it.
 *
 * Only `org.freedesktop.portal.FileChooser` is implemented. The other portals
 * (settings, notifications, screenshots) are refused with UnknownMethod, which
 * is what an application gets from a machine with no portal at all.
 */

export const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const CHOOSER = 'org.freedesktop.portal.FileChooser';
const REQUEST = 'org.freedesktop.portal.Request';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const INTROSPECTABLE = 'org.freedesktop.DBus.Introspectable';
const PEER = 'org.freedesktop.DBus.Peer';
const CHOOSER_VERSION = 3;

/** What the browser is asked to show. Plain JSON, built from the options. */
export interface PortalRequest {
  id: string;
  kind: 'open' | 'save' | 'save-files';
  title: string;
  acceptLabel: string | null;
  multiple: boolean;
  directory: boolean;
  /** Suggested file name, for save. */
  currentName: string | null;
  /** Where to start, when the application says. */
  currentFolder: string | null;
  filters: Array<{ name: string; patterns: string[] }>;
  /** save-files: the names the application wants written into one folder. */
  files: string[];
}

/** One browser session that can show a dialog. */
export interface PortalTarget {
  deliver(request: PortalRequest): void;
  /** The application closed its own request; take the dialog down. */
  dismiss(id: string): void;
}

interface Pending {
  path: string;
  sender: string;
  target: PortalTarget;
}

/* Response codes, from the Request interface. */
const SUCCESS = 0;
const CANCELLED = 1;
const ENDED = 2;

const INTROSPECTION = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${CHOOSER}">
    <property name="version" type="u" access="read"/>
    <method name="OpenFile"><arg type="s" name="parent_window" direction="in"/><arg type="s" name="title" direction="in"/><arg type="a{sv}" name="options" direction="in"/><arg type="o" name="handle" direction="out"/></method>
    <method name="SaveFile"><arg type="s" name="parent_window" direction="in"/><arg type="s" name="title" direction="in"/><arg type="a{sv}" name="options" direction="in"/><arg type="o" name="handle" direction="out"/></method>
    <method name="SaveFiles"><arg type="s" name="parent_window" direction="in"/><arg type="s" name="title" direction="in"/><arg type="a{sv}" name="options" direction="in"/><arg type="o" name="handle" direction="out"/></method>
  </interface>
</node>`;

/** A NUL-terminated byte string, the way the portal carries paths. */
function pathFromBytes(value: unknown): string | null {
  if (!(value instanceof Uint8Array)) return null;
  const end = value.indexOf(0);
  const text = Buffer.from(end < 0 ? value : value.subarray(0, end)).toString('utf8');
  return text.length > 0 ? text : null;
}

function option<T>(options: Map<unknown, unknown>, name: string, check: (v: unknown) => v is T): T | null {
  const v = options.get(name);
  const value = v instanceof Variant ? v.value : v;
  return check(value) ? value : null;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/** Filters arrive as a(sa(us)): name, then (kind, pattern) pairs. */
function filtersFrom(options: Map<unknown, unknown>): PortalRequest['filters'] {
  const raw = options.get('filters');
  const list = raw instanceof Variant ? raw.value : raw;
  if (!Array.isArray(list)) return [];
  const out: PortalRequest['filters'] = [];
  for (const item of list) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || !Array.isArray(item[1])) continue;
    const patterns: string[] = [];
    for (const pair of item[1]) {
      // kind 0 is a glob, 1 a MIME type; the dialog can only use globs.
      if (Array.isArray(pair) && pair[0] === 0 && typeof pair[1] === 'string') patterns.push(pair[1]);
    }
    out.push({ name: item[0], patterns });
  }
  return out;
}

export class FileChooserPortal {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  /** The bus went away under us; whoever shares this portal should forget it. */
  onClosed: (() => void) | null = null;

  private constructor(
    private readonly bus: DBus,
    private readonly route: (senderPid: number | null) => PortalTarget | null,
  ) {
    bus.onMethodCall = (msg) => void this.handle(msg);
    bus.on('error', () => {
      // The close that follows is what matters; an error here is not ours to crash on.
    });
    bus.on('close', () => {
      this.closed = true;
      this.pending.clear();
      this.onClosed?.();
    });
  }

  /**
   * Owns the portal name on the bus at `address`. Resolves null when someone
   * else already does — a machine with a desktop session has the real one,
   * and it keeps it.
   */
  static async open(
    address: string,
    route: (senderPid: number | null) => PortalTarget | null,
  ): Promise<FileChooserPortal | null> {
    const bus = await DBus.connect(address);
    // DO_NOT_QUEUE: either it is ours now or it is not ours at all.
    const granted = await bus.requestName(PORTAL_NAME, 0x4);
    if (granted !== 1) {
      bus.close();
      return null;
    }
    return new FileChooserPortal(bus, route);
  }

  private async handle(msg: Message): Promise<void> {
    const { bus } = this;
    try {
      if (msg.interface === PEER && msg.member === 'Ping') {
        bus.reply(msg);
        return;
      }
      if (msg.interface === INTROSPECTABLE && msg.member === 'Introspect') {
        bus.reply(msg, 's', [msg.path === PORTAL_PATH ? INTROSPECTION : '<node/>']);
        return;
      }
      if (msg.path === PORTAL_PATH && msg.interface === PROPERTIES) {
        const [iface, prop] = msg.body as [string, string];
        if (iface !== CHOOSER) {
          bus.replyError(msg, 'org.freedesktop.DBus.Error.UnknownInterface', `No such interface ${iface}`);
        } else if (msg.member === 'Get' && prop === 'version') {
          bus.reply(msg, 'v', [new Variant('u', CHOOSER_VERSION)]);
        } else if (msg.member === 'GetAll') {
          bus.reply(msg, 'a{sv}', [new Map([['version', new Variant('u', CHOOSER_VERSION)]])]);
        } else {
          bus.replyError(msg, 'org.freedesktop.DBus.Error.InvalidArgs', `No such property ${prop}`);
        }
        return;
      }
      if (msg.path === PORTAL_PATH && msg.interface === CHOOSER) {
        await this.chooser(msg);
        return;
      }
      if (msg.interface === REQUEST && msg.member === 'Close' && msg.path) {
        const pending = this.pending.get(msg.path);
        if (pending && pending.sender === msg.sender) {
          this.pending.delete(msg.path);
          pending.target.dismiss(msg.path);
          this.emitResponse(msg.path, pending.sender, ENDED, []);
        }
        bus.reply(msg);
        return;
      }
      bus.replyError(msg, 'org.freedesktop.DBus.Error.UnknownMethod', `No such method ${msg.member}`);
    } catch (err) {
      bus.replyError(msg, 'org.freedesktop.DBus.Error.Failed', err instanceof Error ? err.message : String(err));
    }
  }

  private async chooser(msg: Message): Promise<void> {
    const { bus } = this;
    const kind =
      msg.member === 'OpenFile' ? 'open' : msg.member === 'SaveFile' ? 'save' : msg.member === 'SaveFiles' ? 'save-files' : null;
    if (!kind) {
      bus.replyError(msg, 'org.freedesktop.DBus.Error.UnknownMethod', `No such method ${msg.member}`);
      return;
    }
    const [, title, rawOptions] = msg.body as [string, string, Map<unknown, unknown>];
    const options = rawOptions instanceof Map ? rawOptions : new Map();

    // The request object has to exist before the reply goes out: the
    // application subscribes to its Response signal by the path it can
    // predict from the token, and the reply merely confirms it.
    const sender = msg.sender ?? '';
    const token = option(options, 'handle_token', isString) ?? `wd${Date.now().toString(36)}`;
    const path = `/org/freedesktop/portal/desktop/request/${sender.replace(/^:/, '').replace(/\./g, '_')}/${token}`;

    const target = this.route(await bus.pidOf(sender));
    if (!target) {
      bus.replyError(msg, 'org.freedesktop.portal.Error.NotAllowed', 'No window to show a dialog in');
      return;
    }

    const files: string[] = [];
    const rawFiles = options.get('files');
    const fileList = rawFiles instanceof Variant ? rawFiles.value : rawFiles;
    if (Array.isArray(fileList)) {
      for (const f of fileList) {
        const name = pathFromBytes(f);
        if (name) files.push(name);
      }
    }

    const request: PortalRequest = {
      id: path,
      kind,
      title: typeof title === 'string' ? title : '',
      acceptLabel: option(options, 'accept_label', isString),
      multiple: option(options, 'multiple', isBoolean) ?? false,
      directory: option(options, 'directory', isBoolean) ?? false,
      currentName: option(options, 'current_name', isString),
      currentFolder: pathFromBytes((options.get('current_folder') as Variant | undefined)?.value),
      filters: filtersFrom(options),
      files,
    };

    this.pending.set(path, { path, sender, target });
    bus.reply(msg, 'o', [path]);
    target.deliver(request);
  }

  /**
   * Unicast, to the connection that asked. That is how xdg-desktop-portal
   * sends it, and GTK counts on it: it subscribes with NO_MATCH_RULE and
   * never asks the bus for the signal, so a broadcast Response — correct in
   * every byte — went past zenity and Firefox without being delivered.
   */
  private emitResponse(path: string, sender: string, code: number, uris: string[]): void {
    if (this.closed) return;
    const results = new Map<string, Variant>();
    if (code === SUCCESS) results.set('uris', new Variant('as', uris));
    this.bus.emitSignal(path, REQUEST, 'Response', 'ua{sv}', [code, results], sender);
  }

  /** The browser answered: chosen files as `file://` URIs, or nothing. */
  respond(id: string, uris: string[] | null): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.emitResponse(id, pending.sender, uris ? SUCCESS : CANCELLED, uris ?? []);
  }

  /** The session behind these dialogs is gone; every open request ends. */
  cancelAll(target: PortalTarget): void {
    for (const [id, pending] of [...this.pending]) {
      if (pending.target !== target) continue;
      this.pending.delete(id);
      this.emitResponse(id, pending.sender, ENDED, []);
    }
  }

  close(): void {
    for (const [id, pending] of [...this.pending]) this.emitResponse(id, pending.sender, ENDED, []);
    this.pending.clear();
    this.closed = true;
    this.bus.close();
  }
}
