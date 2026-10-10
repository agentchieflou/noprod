// Browser keys -> lpi.gui.keyboard.v1 (apps/audio_core/third_party/lpi/include/lpi/lpi.h).
// Letters map from the typed letter when it is ASCII A-Z (Ctrl+A is Ctrl+A on
// any layout), from the physical key otherwise; digits and a few named keys
// from the physical key.

const NAMED: Record<string, number> = {
  Space: 0x20,
  Enter: 0x101, NumpadEnter: 0x101,
  Escape: 0x102,
  Backspace: 0x103,
  Tab: 0x104,
  Delete: 0x105,
  Home: 0x106,
  End: 0x107,
  ArrowLeft: 0x108, ArrowRight: 0x109, ArrowUp: 0x10a, ArrowDown: 0x10b,
  Minus: 0x10c, NumpadSubtract: 0x10c,
  Period: 0x10d, NumpadDecimal: 0x10d,
  Comma: 0x10e
};

// LPI_VK_* for a key event (0, LPI_VK_NONE, for keys the table lacks)
export function lpiKeyCode(e: KeyboardEvent): number {
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase().charCodeAt(0);
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (digit) return 0x30 + Number(digit[1]);
  if (/^Key[A-Z]$/.test(e.code)) return e.code.charCodeAt(3);
  return NAMED[e.code] ?? 0;
}

// LPI_MOD_*
export const lpiModifiers = (e: KeyboardEvent) =>
  (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);

// The code point a key types, for LPI_KEY_CHAR: one printable character and
// none of Ctrl/Alt/Meta held; otherwise null
export function lpiTypedChar(e: KeyboardEvent): number | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const chars = Array.from(e.key);
  if (chars.length !== 1) return null;
  const cp = chars[0].codePointAt(0)!;
  return cp >= 0x20 && cp !== 0x7f ? cp : null;
}
