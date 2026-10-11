/**
 * The public surface an app package is written against — `apiVersion: 1`.
 *
 * Nothing here is runtime code. `tsconfig.sdk.json` emits declarations for
 * this file and whatever it reaches, which is what an author outside this
 * repository points a `paths` entry at. Everything a package can touch
 * arrives through `AppContext`, so these types are the whole contract, and
 * from this point on they only grow: a field may be added, never renamed or
 * removed, or the version number moves.
 */
export type {
  AppContext,
  AppInstance,
  AppManifest,
  ClipboardAPI,
  ClipboardScope,
  ConnectionState,
  DesktopAPI,
  DesktopEvents,
  DialogOptions,
  FileAssociation,
  FileHandlerInfo,
  FileRef,
  LaunchOptions,
  MenuAction,
  MenuHeader,
  MenuItem,
  MenuSeparator,
  NotifyOptions,
  OpenFileOptions,
  PromptOptions,
  Rect,
  SessionControls,
  SettingsStore,
  Size,
  UploadedFile,
  UploadSummary,
  WindowEvents,
  WindowHandle,
  WindowState,
} from './core/types';
export type { RpcClient, Channel, ChannelHandlers } from './core/rpc';
export type { ShortcutRegistry, ShortcutBinding } from './core/shortcuts';
export type {
  HostInfo,
  BuildInfo,
  PackageManifest,
  PackageAssociation,
  InstalledApp,
} from '../../shared/protocol';
export { APP_API_VERSION } from '../../shared/protocol';
