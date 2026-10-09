// Transport: owns the playhead and schedules everything that plays on the
// arrangement timeline (seconds).
//
// Playback is a sequence of segments. Each segment maps a timeline range
// [posStart, posEnd) onto audio-context time starting at ctxStart and
// schedules every clip, note and frozen buffer overlapping that range, cut at
// posEnd. A loop is just "when the current segment is about to end at the loop
// end, queue another [loopStart, loopEnd) segment exactly where it finishes",
// so loops wrap sample-accurately. Metronome clicks are scheduled with a short
// lookahead from a timer since a segment without a loop has no end.

import { audioContext, getStripInput, getAutomationTargets, setAutomationPlaying } from './engine';
import { triggerNote } from './synth';
import { scheduleWarpedRegion } from './warp';
import { beatsBetween, barAt, barSeconds } from './timeline';

type Stoppable = { stop: (when?: number) => void };

interface Segment {
  ctxStart: number;
  posStart: number;
  posEnd: number;        // Infinity when not looping
  sources: Stoppable[];
  clickCursor: number;   // next timeline position to consider for a metronome click
}

const LOOKAHEAD = 0.25;  // seconds of audio scheduled ahead of the playhead
const TICK_MS = 40;

let getState: () => any = () => ({});
let playing = false;
let stoppedPosition = 0;
let segments: Segment[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let countInEnd = 0;      // ctx time at which a count-in finishes (0 = none)
const listeners = new Set<() => void>();

// What a frozen/unfrozen track plays changes the schedule; mixer moves don't.
const frozenSig = (st: any) => (st.tracks || []).map((t: any) => (t.isFrozen ? t.id : '')).join(',');

let loopDebounce: ReturnType<typeof setTimeout> | null = null;

const automationChanged = (st: any, prev: any) => {
  const before = new Map((prev.tracks || []).map((t: any) => [t.id, t.automation]));
  return (st.tracks || []).some((t: any) => before.get(t.id) !== t.automation);
};

// Follow the store: isPlaying starts/stops the transport, and edits to what
// plays (clips, tempo, loop, freeze) reschedule from the playhead.
export function initTransport(store: { getState: () => any; subscribe: (fn: (s: any, prev: any) => void) => unknown }) {
  getState = store.getState;
  store.subscribe((st, prev) => {
    if (st.isPlaying !== prev.isPlaying) {
      if (!st.isPlaying) stop();
      else if (st.isRecording && st.countInBars > 0) playWithCountIn(st.countInBars);
      else play();
      return;
    }
    if (!playing) return;
    if (st.isLoopEnabled !== prev.isLoopEnabled || st.loopStart !== prev.loopStart || st.loopEnd !== prev.loopEnd) {
      // brace drags fire continuously; rebuild once the drag settles
      if (loopDebounce) clearTimeout(loopDebounce);
      loopDebounce = setTimeout(reschedule, 60);
      return;
    }
    if (st.regions !== prev.regions || st.bpm !== prev.bpm || frozenSig(st) !== frozenSig(prev)) {
      reschedule();
    } else if (st.tracks !== prev.tracks && automationChanged(st, prev)) {
      refreshAutomation();
    }
  });
}

const notify = () => listeners.forEach((fn) => fn());
export const onTransportChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export const isPlaying = () => playing;
export const isCountingIn = () => playing && countInEnd > audioContext.currentTime;

// Timeline position in seconds right now
export function getPosition(): number {
  if (!playing || segments.length === 0) return stoppedPosition;
  const now = audioContext.currentTime;
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (now >= s.ctxStart) return Math.min(s.posEnd, s.posStart + (now - s.ctxStart));
  }
  return segments[0].posStart; // still in a count-in
}

// ------------------------------------------------------------------ helpers

const loopRange = (st: any): [number, number] | null => {
  if (!st.isLoopEnabled) return null;
  const start = st.loopStart ?? 0, end = st.loopEnd ?? 0;
  return end - start > 0.01 ? [start, end] : null;
};

// Metronome: a short sine blip, accented on the first beat of each bar.
// Goes straight to the output so master devices and the limiter don't color it.
export const clickGain = audioContext.createGain();
clickGain.gain.value = 0.35;
clickGain.connect(audioContext.destination);

function playClick(when: number, accent: boolean, sources: Stoppable[]) {
  const osc = audioContext.createOscillator();
  const env = audioContext.createGain();
  osc.frequency.value = accent ? 1600 : 1000;
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(accent ? 1 : 0.6, when + 0.002);
  env.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
  osc.connect(env);
  env.connect(clickGain);
  osc.start(when);
  osc.stop(when + 0.06);
  sources.push(osc);
}

// --------------------------------------------------------------- scheduling

function scheduleSegment(ctxStart: number, posStart: number, posEnd: number): Segment {
  const st = getState();
  const seg: Segment = { ctxStart, posStart, posEnd, sources: [], clickCursor: posStart };
  const at = (pos: number) => ctxStart + (pos - posStart);
  const tracks: any[] = st.tracks || [];
  const trackById = new Map(tracks.map((t) => [t.id, t]));

  // Frozen tracks play their rendered buffer instead of live clips
  tracks.forEach((t) => {
    if (!t.isFrozen || !t.frozenBuffer) return;
    const a = Math.max(posStart, 0), b = Math.min(posEnd, t.frozenDuration);
    if (b <= a) return;
    const src = audioContext.createBufferSource();
    src.buffer = t.frozenBuffer;
    src.connect(getStripInput(t.id));
    src.start(at(a), a, b - a);
    seg.sources.push(src);
  });

  (st.regions || []).forEach((region: any) => {
    const track = trackById.get(region.trackId);
    if (!track || track.isFrozen) return;
    const dest = getStripInput(region.trackId);

    if (region.type === 'midi') {
      if (!track.instrument || !region.notes) return;
      const regionEnd = region.startTime + region.duration;
      region.notes.forEach((note: any) => {
        const s = region.startTime + note.start;
        const e = Math.min(regionEnd, s + note.duration);
        const a = Math.max(posStart, s), b = Math.min(posEnd, e);
        if (b <= a) return;
        seg.sources.push(triggerNote(audioContext, dest, track.instrument.parameters, note.pitch, at(a), b - a, note.velocity ?? 1));
      });
      return;
    }

    if (!region.audioBuffer) return;

    // Warped clips: granular time-stretch to follow the project tempo
    if (region.warpEnabled && region.originalBpm) {
      const ratio = (st.bpm || 120) / region.originalBpm;
      const warpedEnd = region.startTime + region.duration / ratio;
      const a = Math.max(posStart, region.startTime), b = Math.min(posEnd, warpedEnd);
      if (b <= a) return;
      seg.sources.push(...scheduleWarpedRegion(
        audioContext, [dest], region, at(a), a - region.startTime, ratio, b - region.startTime
      ));
      return;
    }

    const a = Math.max(posStart, region.startTime);
    const b = Math.min(posEnd, region.startTime + region.duration);
    if (b <= a) return;
    const src = audioContext.createBufferSource();
    src.buffer = region.audioBuffer;
    src.connect(dest);
    src.start(at(a), (region.startOffset || 0) + (a - region.startTime), b - a);
    seg.sources.push(src);
  });

  segments.push(seg);
  scheduleAutomation(seg);
  return seg;
}

// ----------------------------------------------------------------- automation

// Envelope value at a timeline position: linear between breakpoints, held
// flat before the first and after the last.
export function envelopeAt(points: { time: number; value: number }[], t: number): number {
  if (t <= points[0].time) return points[0].value;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (t < b.time) return a.value + ((t - a.time) / Math.max(1e-9, b.time - a.time)) * (b.value - a.value);
  }
  return points[points.length - 1].value;
}

// Write every track's automation lanes for one segment as AudioParam events
// (setValueAtTime at the start, linear ramps through each breakpoint, and a
// ramp to the boundary value at a loop end). `fromCtx` re-applies from a
// later point, e.g. after an envelope edit mid-playback.
function scheduleAutomation(seg: Segment, fromCtx = seg.ctxStart) {
  const st = getState();
  const segCtxEnd = seg.ctxStart + (seg.posEnd - seg.posStart);
  if (fromCtx >= segCtxEnd) return;
  const startCtx = Math.max(seg.ctxStart, fromCtx);
  const a = seg.posStart + (startCtx - seg.ctxStart);
  (st.tracks || []).forEach((t: any) => {
    Object.entries(t.automation || {}).forEach(([key, pts]: [string, any]) => {
      if (!pts?.length) return;
      getAutomationTargets(t.id, key).forEach(({ param, map }) => {
        // the epsilon keeps a previous segment's ramp that ends exactly here
        param.cancelScheduledValues(startCtx + 1e-6);
        param.setValueAtTime(map(envelopeAt(pts, a)), startCtx + 1e-6);
        pts.forEach((pt: any) => {
          if (pt.time > a && pt.time < seg.posEnd) {
            param.linearRampToValueAtTime(map(pt.value), seg.ctxStart + (pt.time - seg.posStart));
          }
        });
        if (Number.isFinite(seg.posEnd)) param.linearRampToValueAtTime(map(envelopeAt(pts, seg.posEnd)), segCtxEnd);
      });
    });
  });
}

// An envelope changed while playing: re-apply from just ahead of now
function refreshAutomation() {
  const from = audioContext.currentTime + 0.02;
  segments.forEach((seg) => scheduleAutomation(seg, from));
}

function tick() {
  if (!playing) return;
  const st = getState();
  const now = audioContext.currentTime;
  const horizon = now + LOOKAHEAD;

  // Queue the next loop pass just before the current one ends
  const last = segments[segments.length - 1];
  const loop = loopRange(st);
  if (last && loop && last.posEnd === loop[1]) {
    const lastCtxEnd = last.ctxStart + (last.posEnd - last.posStart);
    if (horizon >= lastCtxEnd) scheduleSegment(lastCtxEnd, loop[0], loop[1]);
  }

  // Metronome clicks within the lookahead window. Cursors advance even with
  // the click off so switching it on mid-play doesn't replay past beats.
  segments.forEach((s) => {
    const segCtxEnd = s.ctxStart + (s.posEnd - s.posStart);
    const windowEndPos = Math.min(s.posEnd, s.posStart + (Math.min(horizon, segCtxEnd) - s.ctxStart));
    if (windowEndPos <= s.clickCursor) return;
    if (st.isMetronomeEnabled) {
      beatsBetween(st.bpm || 120, s.clickCursor, windowEndPos, st.timeSignatures).forEach((b) => {
        const when = s.ctxStart + (b.time - s.posStart);
        if (when >= now - 0.005) playClick(Math.max(now, when), b.accent, s.sources);
      });
    }
    s.clickCursor = windowEndPos;
  });

  // Drop segments that finished long enough ago that their sources are done
  segments = segments.filter((s, i) => i === segments.length - 1
    || s.ctxStart + (s.posEnd - s.posStart) > now - 5);
}

function startSegmentsAt(pos: number, ctxStart: number) {
  const loop = loopRange(getState());
  // Ableton-style: a loop only engages when playback starts before its end
  const end = loop && pos < loop[1] ? loop[1] : Infinity;
  scheduleSegment(ctxStart, pos, end);
}

function stopAllSources() {
  segments.forEach((s) => s.sources.forEach((src) => { try { src.stop(); } catch { /* already stopped */ } }));
  segments = [];
}

// ------------------------------------------------------------------ control

// Start playback from the current position. With a count-in, the given click
// grid (times relative to the count-in start) plays for countInSeconds before
// the timeline starts moving.
export function play(countInSeconds = 0, countInGrid?: { time: number; accent: boolean }[]) {
  if (playing) return;
  if (audioContext.state === 'suspended') audioContext.resume();
  playing = true;
  setAutomationPlaying(true);
  const startCtx = audioContext.currentTime + 0.05;
  countInEnd = 0;
  if (countInSeconds > 0 && countInGrid) {
    const pre: Segment = { ctxStart: startCtx, posStart: stoppedPosition - countInSeconds, posEnd: stoppedPosition, sources: [], clickCursor: Infinity };
    countInGrid.forEach((b) => playClick(startCtx + b.time, b.accent, pre.sources));
    segments.push(pre);
    countInEnd = startCtx + countInSeconds;
  }
  startSegmentsAt(stoppedPosition, startCtx + countInSeconds);
  timer = setInterval(tick, TICK_MS);
  tick();
  notify();
}

// Count-in: N bars of clicks in the signature at the playhead, then play.
export function playWithCountIn(bars: number) {
  const st = getState();
  const bpm = st.bpm || 120;
  const sig = barAt(bpm, stoppedPosition, st.timeSignatures);
  const barLen = barSeconds(bpm, sig);
  const beat = barLen / sig.numerator;
  const grid: { time: number; accent: boolean }[] = [];
  for (let b = 0; b < bars; b++) {
    for (let k = 0; k < sig.numerator; k++) grid.push({ time: b * barLen + k * beat, accent: k === 0 });
  }
  play(bars * barLen, grid);
}

export function stop() {
  if (!playing) return;
  stoppedPosition = Math.max(0, getPosition());
  playing = false;
  countInEnd = 0;
  if (timer) clearInterval(timer);
  timer = null;
  stopAllSources();
  setAutomationPlaying(false, getState());
  notify();
}

// Move the playhead. While playing, playback continues from the new spot.
export function setPosition(pos: number) {
  const p = Math.max(0, pos);
  if (!playing) {
    stoppedPosition = p;
    notify();
    return;
  }
  stopAllSources();
  countInEnd = 0;
  startSegmentsAt(p, audioContext.currentTime + 0.03);
  tick();
  notify();
}

// Clips, notes, tempo or loop settings changed: rebuild what's scheduled
// from the current playhead so edits are heard straight away.
export function reschedule() {
  if (!playing || isCountingIn()) return;
  setPosition(getPosition());
}
