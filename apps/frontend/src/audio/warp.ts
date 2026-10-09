// Warping analysis: transient detection and tempo estimation. The granular
// time-stretch itself lives in clipPlayback.ts (overlap-add grains sized per
// warp mode): audible artifacts on extreme ratios, but true time-stretching,
// so pitch does not change with project tempo.

export function detectTransients(buffer: AudioBuffer): number[] {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const win = Math.floor(sr * 0.02); // 20ms energy windows
  const energies: number[] = [];
  for (let i = 0; i + win < data.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += data[j] * data[j];
    energies.push(e / win);
  }
  const transients: number[] = [];
  let last = -1;
  for (let i = 1; i < energies.length; i++) {
    const rise = energies[i] / (energies[i - 1] + 1e-6);
    if (rise > 2.5 && energies[i] > 0.0005) {
      const t = (i * win) / sr;
      if (t - last > 0.09) { // 90ms refractory window
        transients.push(t);
        last = t;
      }
    }
  }
  return transients;
}

// Median transient interval folded into 70-180 BPM.
export function estimateBpm(transients: number[], fallback = 120): number {
  if (transients.length < 4) return fallback;
  const intervals: number[] = [];
  for (let i = 1; i < transients.length; i++) intervals.push(transients[i] - transients[i - 1]);
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  if (median <= 0.01) return fallback;
  let bpm = 60 / median;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}
