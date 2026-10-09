// Shared log-frequency axis (20 Hz - 20 kHz) for response-curve displays.

const RESPONSE_POINTS = 240;

export const RESPONSE_FREQS = (() => {
  const f = new Float32Array(RESPONSE_POINTS);
  for (let i = 0; i < RESPONSE_POINTS; i++) f[i] = 20 * Math.pow(1000, i / (RESPONSE_POINTS - 1));
  return f;
})();

export const freqToX = (f: number, width: number) => (Math.log(f / 20) / Math.log(1000)) * width;
export const xToFreq = (x: number, width: number) => 20 * Math.pow(1000, Math.max(0, Math.min(1, x / width)));
