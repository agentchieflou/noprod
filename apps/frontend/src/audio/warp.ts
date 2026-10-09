// Warping: transient detection, tempo estimation, and granular time-stretch
// scheduling. The stretch is simple overlap-add (~90ms grains, 50% overlap):
// audible artifacts on extreme ratios, but true time-stretching — pitch does
// not change with project tempo.

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

const GRAIN = 0.09;
const HOP = 0.045;

// Schedules a warped region as overlapping grains. `stretchRatio` > 1 means the
// project is faster than the clip (output shorter than source).
// `outputOffset` is how far into the (warped) clip playback resumes and
// `outputEnd` (optional) where it stops, e.g. at a loop end.
// Returns the scheduled sources so the caller can stop them.
export function scheduleWarpedRegion(
  ctx: BaseAudioContext,
  destinations: AudioNode[],
  region: { audioBuffer: AudioBuffer; startOffset?: number; duration: number },
  whenBase: number,
  outputOffset: number,
  stretchRatio: number,
  outputEnd = Infinity
): AudioBufferSourceNode[] {
  const sources: AudioBufferSourceNode[] = [];
  const warpedDur = Math.min(region.duration / stretchRatio, outputEnd);
  const buffer = region.audioBuffer;

  for (let out = outputOffset; out < warpedDur; out += HOP) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const env = ctx.createGain();
    const when = whenBase + (out - outputOffset);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(1, when + HOP / 2);
    env.gain.setValueAtTime(1, when + GRAIN - HOP / 2);
    env.gain.linearRampToValueAtTime(0, when + GRAIN);
    src.connect(env);
    destinations.forEach(d => env.connect(d));
    const sourcePos = (region.startOffset || 0) + out * stretchRatio;
    if (sourcePos >= buffer.duration - 0.01) break;
    // the last grain is cut at warpedDur so nothing leaks past a loop end
    src.start(when, sourcePos, Math.min(GRAIN, buffer.duration - sourcePos, warpedDur - out));
    sources.push(src);
  }
  return sources;
}
