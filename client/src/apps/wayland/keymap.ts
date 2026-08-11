/**
 * `KeyboardEvent.code` → Linux evdev keycode.
 *
 * Wayland keyboards carry *physical keys*, not characters: the application
 * runs the code through the xkb keymap the compositor gave it and decides for
 * itself what character that is. So this table must describe key *positions*,
 * which is exactly what `code` already does — both are derived from the same
 * physical layout, which is why this is a table and not a guess.
 *
 * The consequence is that the layout the compositor advertises has to match
 * the one the person is really typing on. If it does not, an AZERTY user
 * pressing `a` sends `KeyQ` and the application sees `q`. That is a setting,
 * not something this file can fix.
 */
export const EVDEV_BY_CODE: Readonly<Record<string, number>> = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20,
  KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34,
  KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48,
  KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
  F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  IntlBackslash: 86, F11: 87, F12: 88, IntlRo: 89,
  Convert: 92, KanaMode: 93, NonConvert: 94,
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98,
  PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
  End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
  AudioVolumeMute: 113, AudioVolumeDown: 114, AudioVolumeUp: 115,
  NumpadEqual: 117, Pause: 119, NumpadComma: 121,
  IntlYen: 124, MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
  BrowserStop: 128, Again: 129, Undo: 131, Copy: 133, Paste: 135,
  Find: 136, Cut: 137, Help: 138,
  F13: 183, F14: 184, F15: 185, F16: 186, F17: 187,
  F18: 188, F19: 189, F20: 190, F21: 191, F22: 192, F23: 193, F24: 194,
};

/**
 * Combinations the shell and the browser keep for themselves.
 *
 * Everything else is forwarded and its default prevented, so the application
 * gets Ctrl+W, Ctrl+T and friends rather than the browser closing the tab.
 * `Alt+Tab` stays with the shell because window switching has to work from
 * inside a focused application, and F11/F12 stay with the browser because
 * fullscreen and devtools are how someone gets out of trouble.
 */
export function isReservedByShell(event: KeyboardEvent): boolean {
  if (event.code === 'Tab' && event.altKey) return true;
  if (event.code === 'F11' || event.code === 'F12') return true;
  // The shell's own accelerators are all Ctrl+Alt+something.
  if (event.ctrlKey && event.altKey) return true;
  if (event.code === 'F4' && event.altKey) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Which layout is the person actually typing on?                      */
/* ------------------------------------------------------------------ */

/**
 * Because keys travel as physical positions, the xkb layout the compositor
 * loads has to match the one in front of the user — otherwise an AZERTY user
 * pressing `a` sends `KeyQ` and the application receives `q`.
 *
 * Chromium can tell us what each physical key produces, which is enough to
 * recognise the common layouts. Everywhere else this returns null and the
 * setting decides.
 */
const PROBE_CODES = ['KeyQ', 'KeyW', 'KeyY', 'KeyZ', 'KeyA', 'Semicolon'];

/** Signature → xkb layout name. Same order as PROBE_CODES. */
const SIGNATURES: Record<string, string> = {
  'q,w,y,z,a,;': 'us',
  'a,z,y,w,q,m': 'fr',
  'q,w,z,y,a,ö': 'de',
  'q,w,y,z,a,ñ': 'es',
  'q,w,y,z,a,ò': 'it',
  'q,w,y,z,a,´': 'pt',
  "',,f,;,a,s": 'us(dvorak)',
};

interface KeyboardLayoutApi {
  getLayoutMap?(): Promise<Map<string, string>>;
}

export async function detectLayout(): Promise<string | null> {
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardLayoutApi }).keyboard;
  if (!keyboard?.getLayoutMap) return null;

  let map: Map<string, string>;
  try {
    map = await keyboard.getLayoutMap();
  } catch {
    // Not permitted, or not implemented behind the property.
    return null;
  }

  const signature = PROBE_CODES.map((code) => map.get(code) ?? '?').join(',');
  return SIGNATURES[signature] ?? (signature.startsWith('q,w') ? 'us' : null);
}

/** Layouts offered in the menu, for when detection cannot help. */
export const KNOWN_LAYOUTS = [
  { id: 'us', name: 'English (US)' },
  { id: 'gb', name: 'English (UK)' },
  { id: 'de', name: 'German' },
  { id: 'fr', name: 'French' },
  { id: 'es', name: 'Spanish' },
  { id: 'it', name: 'Italian' },
  { id: 'pt', name: 'Portuguese' },
  { id: 'se', name: 'Swedish' },
  { id: 'no', name: 'Norwegian' },
  { id: 'dk', name: 'Danish' },
  { id: 'fi', name: 'Finnish' },
  { id: 'pl', name: 'Polish' },
  { id: 'ru', name: 'Russian' },
  { id: 'us(dvorak)', name: 'Dvorak' },
];
