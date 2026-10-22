/**
 * The environment a launched shell or application starts with: this
 * process's, minus the service's own settings.
 *
 * Found the hard way. A Claude Code session running inside a Finestra
 * terminal ran the test suite, and every token check failed: the suite's
 * server had inherited WD_NO_AUTH=1 from the installed service, four shells
 * deep, and was also running the installed compositor (WD_WDCOMP) instead
 * of the one just built. Nothing in a terminal should be able to tell how
 * the service that opened it was configured, and a second copy of the
 * product started from that terminal must not quietly adopt the first one's
 * port, address or lack of a token.
 *
 * Named one by one rather than as a prefix: the suite hands its fixture
 * applications WD_TEST_* variables through exactly this path, and a prefix
 * took those too — "the application saw no pointer", because the file it was
 * to write the pointer position to had no name. This list is every name
 * `process.env.WD_…` is read under in server/src; keep it so.
 */
const SERVICE_SETTINGS = [
  'WD_CLIENT_PORT', 'WD_DEV', 'WD_DIAL', 'WD_DIAL_TICKET', 'WD_HEARTBEAT_MS',
  'WD_HOST', 'WD_NO_AUTH', 'WD_PORT', 'WD_ROOT', 'WD_SERVICES_DIR',
  'WD_SESSION_IDLE', 'WD_SESSION_TTL', 'WD_SNAP_BUS', 'WD_STATIC',
  'WD_TERMINAL_GRACE', 'WD_TOKEN', 'WD_WDCOMP', 'WD_WINDOW_GRACE', 'WD_XWAYLAND',
];

export function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SERVICE_SETTINGS.includes(key)) continue;
    env[key] = value;
  }
  return env;
}
