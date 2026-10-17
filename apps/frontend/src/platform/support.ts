// What noprod needs from the browser, and what differs between browsers.
// The pure functions take their environment so tests can feed them one.

export interface Env {
  AudioContext?: unknown;
  AudioWorkletNode?: unknown;
  isSecureContext?: boolean;
  userAgent?: string;
}

export const browserEnv = (): Env => ({
  AudioContext: (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext,
  AudioWorkletNode: (globalThis as any).AudioWorkletNode,
  isSecureContext: globalThis.isSecureContext,
  userAgent: globalThis.navigator?.userAgent ?? '',
});

// What is missing, as a reason a visitor can act on. Empty: noprod can run.
export function missingFeatures(env: Env = browserEnv()): string[] {
  const out: string[] = [];
  if (!env.isSecureContext) out.push('This page is not in a secure context. Open it over https:// (or http://localhost); the browser turns off audio processing otherwise.');
  if (!env.AudioContext) out.push('This browser has no Web Audio.');
  else if (!env.AudioWorkletNode) out.push('This browser has no AudioWorklet, which noprod uses for its instruments and effects.');
  return out;
}

export const isFirefox = (ua = browserEnv().userAgent ?? '') => /\bFirefox\//.test(ua);

// Phones and small windows: noprod's layout is built for larger screens
export const SMALL_SCREEN_PX = 900;

// Listing a folder of plugins needs the File System Access API (Chromium only)
export const canScanFolders = () => typeof (globalThis as any).showDirectoryPicker === 'function';
export const FOLDER_SCAN_REASON = isFirefox()
  ? "Firefox can't list a folder's files from a page, so plugin scanning is off here. Add the folder's path above for the Audio Core to scan, or use a Chromium-based browser."
  : "This browser can't list a folder's files from a page, so plugin scanning is off here. Add the folder's path above for the Audio Core to scan, or use a Chromium-based browser.";
