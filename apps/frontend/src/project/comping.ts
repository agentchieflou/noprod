// Take comping: pure helpers that slice clips by timeline range and cut
// ranges out of a track's main lane. A slice keeps playing exactly what the
// original played over that range (source offset, loop, warp, transposition).

import { v4 as uuidv4 } from 'uuid';
import { clipRate, clipTimelineLength, sourcePosAt, expandMidiNotes } from '../audio/clipPlayback';

const EPS = 0.002;

// The part of `clip` between timeline positions [a, b) as a new clip, or null
export function sliceClip(clip: any, a: number, b: number, bpm: number): any | null {
  const start = clip.startTime;
  const end = start + clipTimelineLength(clip, bpm);
  const s = Math.max(a, start), e = Math.min(b, end);
  if (e - s < EPS) return null;
  if (clip.type === 'midi') {
    // materialize what plays (loops, transposition) so the slice is plain
    const from = s - start, to = e - start;
    const notes = expandMidiNotes(clip)
      .filter((n) => n.start >= from - 1e-6 && n.start < to)
      .map((n) => ({ id: uuidv4(), pitch: n.pitch, velocity: n.velocity, start: n.start - from, duration: Math.min(n.end, to) - n.start }));
    return { ...clip, id: uuidv4(), startTime: s, duration: e - s, notes, transpose: 0, loopEnabled: false };
  }
  return {
    ...clip,
    id: uuidv4(),
    startTime: s,
    startOffset: sourcePosAt(clip, bpm, s - start),
    duration: (e - s) * clipRate(clip, bpm)
  };
}

// Main-lane regions of `trackId` with [a, b) removed (clips split around it)
export function cutRange(regions: any[], trackId: string, a: number, b: number, bpm: number): any[] {
  const out: any[] = [];
  regions.forEach((r) => {
    if (r.trackId !== trackId) { out.push(r); return; }
    const end = r.startTime + clipTimelineLength(r, bpm);
    if (end <= a + EPS || r.startTime >= b - EPS) { out.push(r); return; }
    const left = sliceClip(r, r.startTime, a, bpm);
    const right = sliceClip(r, b, end, bpm);
    if (left) out.push({ ...left, id: r.id }); // the left part keeps the clip's identity
    if (right) out.push(right);
  });
  return out;
}

// Main-lane regions overlapping [a, b) on a track
export const overlapping = (regions: any[], trackId: string, a: number, b: number, bpm: number) =>
  regions.filter((r) => r.trackId === trackId && r.startTime < b - EPS && r.startTime + clipTimelineLength(r, bpm) > a + EPS);
