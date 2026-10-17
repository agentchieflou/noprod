// How long sound takes to reach the speakers, for placing a recording where
// it was heard. Safari has no `outputLatency`; there it is the base latency
// plus a setting the user can change.

const KEY = 'noprod.extraLatencyMs';
const DEFAULT_EXTRA_MS = 30;

export const hasOutputLatency = (ctx: AudioContext) => typeof ctx.outputLatency === 'number';

export function getExtraLatencyMs(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (localStorage.getItem(KEY) !== null && Number.isFinite(v) && v >= 0) return v;
  } catch { /* storage blocked */ }
  return DEFAULT_EXTRA_MS;
}

export function setExtraLatencyMs(ms: number) {
  try { localStorage.setItem(KEY, String(Math.max(0, Math.min(500, ms)))); } catch { /* storage blocked */ }
}

export function playbackLatencySeconds(ctx: AudioContext): number {
  const base = ctx.baseLatency || 0;
  return hasOutputLatency(ctx) ? ctx.outputLatency + base : base + getExtraLatencyMs() / 1000;
}
