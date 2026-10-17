// Transport: owns the playhead and what plays on the arrangement timeline
// (seconds, until #159's step 4).
//
// Playback is a sequence of spans. Each span maps a timeline range
// [posStart, posEnd) onto audio-context time starting at ctxStart; the
// scheduler (scheduler.ts) posts its notes to the engine worklet a window
// ahead and its clips once, and takes back what an edit undoes. A loop is
// just "when the current span is about to end at the loop end, queue
// another [loopStart, loopEnd) exactly where it finishes", so loops wrap
// sample-accurately. Metronome clicks and automation are scheduled with a
// short lookahead from a timer, as nodes and AudioParam events.

import { audioContext, getStripInput, getAutomationTargets, setAutomationPlaying, getCompensationSeconds, onCompensationChange, onStripInputChange, stripIdOf } from './engine';
import { initLiveEngine, liveEngine, type Engine } from './engineNode';
import { Scheduler, type Span } from './scheduler';
import { beatsBetween, barAt, barSeconds } from './timeline';
import { onStretchReady } from './warp';
import { notify } from '../notify';

type Stoppable = { stop: (when?: number) => void };

const POST_AHEAD = 1.0;  // seconds of notes posted to the engine ahead of the playhead
const LOOKAHEAD = 0.25;  // seconds of clicks scheduled ahead
const TICK_MS = 25;

let getState: () => any = () => ({});
let playing = false;
let stoppedPosition = 0;
let scheduler: Scheduler | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let countInEnd = 0;      // ctx time at which a count-in finishes (0 = none)
let clickSources: Stoppable[] = [];
let dropped = 0;         // events the engine dropped during this playback
let droppedLate = 0;     // ...of which past the late budget (the rest had no buffer to play)
const listeners = new Set<() => void>();

const spans = (): Span[] => scheduler?.spans ?? [];

// Tracks currently playing a Session View clip: their arrangement clips stay
// silent until Back to Arrangement (as in Ableton).
export const sessionOwnedTracks = new Set<string>();

// A session clip is taking over `trackId` at context time `atCtx`
export function releaseTrackFromArrangement(trackId: string, atCtx: number) {
  sessionOwnedTracks.add(trackId);
  scheduler?.silenceTrack(trackId, atCtx);
}

// Context time of the next launch point after now: next beat or bar of the
// arrangement grid while playing (immediately when quantization is off)
export function nextQuantizedTime(quantization: string): number {
  const now = audioContext.currentTime;
  if (!playing || quantization === 'none') return now + 0.03;
  const st = getState();
  const pos = getPosition();
  const grid = quantization === '1/4'
    ? beatsBetween(st.bpm || 120, pos + 0.01, pos + 8, st.timeSignatures).map((b) => b.time)
    : beatsBetween(st.bpm || 120, pos + 0.01, pos + 32, st.timeSignatures).filter((b) => b.accent).map((b) => b.time);
  const next = grid[0];
  return next === undefined ? now + 0.03 : now + (next - pos);
}

// What a frozen/unfrozen track plays changes the schedule; mixer moves don't.
const frozenSig = (st: any) => (st.tracks || []).map((t: any) => (t.isFrozen ? t.id : '')).join(',');

let loopDebounce: ReturnType<typeof setTimeout> | null = null;

const automationChanged = (st: any, prev: any) => {
  const before = new Map((prev.tracks || []).map((t: any) => [t.id, t.automation]));
  return (st.tracks || []).some((t: any) => before.get(t.id) !== t.automation);
};

// Follow the store: isPlaying starts/stops the transport, and edits to what
// plays (clips, notes, tempo, loop, freeze) reach the engine as diffs.
export function initTransport(store: { getState: () => any; subscribe: (fn: (s: any, prev: any) => void) => unknown }) {
  getState = store.getState;
  ready = initLiveEngine(audioContext, {
    stripIdOf, getStripInput, onStripInputChange,
    onReset: () => { if (playing) reschedule(); },
    onDropped: (_key, _lateBy, reason) => { dropped++; if (reason === 'late') droppedLate++; }
  }).then((engine) => {
    scheduler = new Scheduler(engine, audioContext, getState);
    scheduler.owned = sessionOwnedTracks;
  }, (err) => {
    console.error('The engine worklet could not load; nothing on the timeline will play', err);
    notify('The audio engine could not start in this browser, so playback is unavailable.', 'error');
  });
  // A warped clip's stretched render takes over from its grains
  onStretchReady(() => { if (playing) resync(); });
  store.subscribe((st, prev) => {
    if (st.isPlaying !== prev.isPlaying) {
      if (!st.isPlaying) stop();
      else if (st.isRecording && st.countInBars > 0) playWithCountIn(st.countInBars);
      else play();
      return;
    }
    if (!playing) {
      if (st.bpm !== prev.bpm) notify_(); // the transport snapshot's tempo changed
      return;
    }
    if (st.isLoopEnabled !== prev.isLoopEnabled || st.loopStart !== prev.loopStart || st.loopEnd !== prev.loopEnd) {
      // brace drags fire continuously; rebuild once the drag settles
      if (loopDebounce) clearTimeout(loopDebounce);
      loopDebounce = setTimeout(reschedule, 60);
      return;
    }
    if (st.regions !== prev.regions || st.bpm !== prev.bpm || frozenSig(st) !== frozenSig(prev) || st.tracks !== prev.tracks) {
      resync();
    }
    if (st.tracks !== prev.tracks && automationChanged(st, prev)) refreshAutomation();
  });
}

let ready: Promise<void> = Promise.resolve();
// Resolves once the engine is up (the tests wait on it)
export const engineReady = () => ready;
export const getEngine = (): Engine | null => liveEngine();
export const getScheduler = () => scheduler;

const notify_ = () => listeners.forEach((fn) => fn());
export const onTransportChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export const isPlaying = () => playing;
export const isCountingIn = () => playing && countInEnd > audioContext.currentTime;

// Timeline position in seconds right now
export function getPosition(): number {
  const list = spans();
  if (!playing || list.length === 0) return stoppedPosition;
  const now = audioContext.currentTime;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (now >= s.ctxStart) return Math.min(s.posEnd, s.posStart + (now - s.ctxStart));
  }
  return list[0].posStart; // still in a count-in
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
// The click is delayed as much as latency compensation delays the mix
const clickDelay = audioContext.createDelay(2);
clickGain.connect(clickDelay);
clickDelay.connect(audioContext.destination);
onCompensationChange(() => { clickDelay.delayTime.value = getCompensationSeconds(); });

function playClick(when: number, accent: boolean) {
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
  osc.onended = () => { osc.disconnect(); env.disconnect(); };
  clickSources.push(osc);
  if (clickSources.length > 64) clickSources = clickSources.slice(-32);
}

// --------------------------------------------------------------- scheduling

// Recording places captured audio/MIDI on the timeline by replaying this
// ctx-time -> position map, so it hears about every span (loop pass).
export interface SegmentInfo { ctxStart: number; posStart: number; posEnd: number }
const segmentListeners = new Set<(s: SegmentInfo) => void>();
export const onSegmentScheduled = (fn: (s: SegmentInfo) => void) => {
  segmentListeners.add(fn);
  return () => { segmentListeners.delete(fn); };
};
export const getSegments = (): SegmentInfo[] =>
  spans().map(({ ctxStart, posStart, posEnd }) => ({ ctxStart, posStart, posEnd }));

function openSpan(ctxStart: number, posStart: number, posEnd: number): Span {
  if (!scheduler) throw new Error('the engine is not ready');
  const span = scheduler.open(ctxStart, posStart, posEnd);
  scheduleAutomation(span);
  segmentListeners.forEach((fn) => fn({ ctxStart, posStart, posEnd }));
  return span;
}

// Everything needed to work out the musical position at any context time
// (tempo-synced plugins on browser tracks, trackBridge.ts). Changes are
// announced through onTransportChange and onSegmentScheduled.
export interface TransportSnapshot {
  playing: boolean;
  bpm: number;
  stoppedPosition: number; // seconds
  countInEnd: number;      // ctx time; 0 = no count-in
  segments: SegmentInfo[]; // the most recent ones
}
export const getTransportSnapshot = (): TransportSnapshot => ({
  playing,
  bpm: getState().bpm || 120,
  stoppedPosition,
  countInEnd,
  segments: getSegments().slice(-8)
});
export const getCountInEnd = () => countInEnd;

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

// Write every track's automation lanes for one span as AudioParam events
// (setValueAtTime at the start, linear ramps through each breakpoint, and a
// ramp to the boundary value at a loop end). `fromCtx` re-applies from a
// later point, e.g. after an envelope edit mid-playback.
function scheduleAutomation(span: Span, fromCtx = span.ctxStart) {
  const st = getState();
  const segCtxEnd = span.ctxStart + (span.posEnd - span.posStart);
  if (fromCtx >= segCtxEnd) return;
  const startCtx = Math.max(span.ctxStart, fromCtx);
  const a = span.posStart + (startCtx - span.ctxStart);
  (st.tracks || []).forEach((t: any) => {
    Object.entries(t.automation || {}).forEach(([key, pts]: [string, any]) => {
      if (!pts?.length) return;
      getAutomationTargets(t.id, key).forEach(({ param, map }) => {
        // the epsilon keeps a previous span's ramp that ends exactly here
        param.cancelScheduledValues(startCtx + 1e-6);
        param.setValueAtTime(map(envelopeAt(pts, a)), startCtx + 1e-6);
        pts.forEach((pt: any) => {
          if (pt.time > a && pt.time < span.posEnd) {
            param.linearRampToValueAtTime(map(pt.value), span.ctxStart + (pt.time - span.posStart));
          }
        });
        if (Number.isFinite(span.posEnd)) param.linearRampToValueAtTime(map(envelopeAt(pts, span.posEnd)), segCtxEnd);
      });
    });
  });
}

// An envelope changed while playing: re-apply from just ahead of now
function refreshAutomation() {
  const from = audioContext.currentTime + 0.02;
  spans().forEach((span) => { if (span.engine) scheduleAutomation(span, from); });
}

// What plays changed: every open span re-reads the store (a diff, not a rebuild)
function resync() {
  if (!playing || !scheduler || isCountingIn()) return;
  const now = audioContext.currentTime;
  for (const span of spans()) if (span.engine) scheduler.resync(span, now);
}

function tick() {
  if (!playing || !scheduler) return;
  const st = getState();
  const now = audioContext.currentTime;
  const horizon = now + LOOKAHEAD;
  const list = spans();

  // Queue the next loop pass just before the current one ends
  const last = list[list.length - 1];
  const loop = loopRange(st);
  if (last && loop && last.posEnd === loop[1]) {
    const lastCtxEnd = last.ctxStart + (last.posEnd - last.posStart);
    if (now + POST_AHEAD >= lastCtxEnd) openSpan(lastCtxEnd, loop[0], loop[1]);
  }

  for (const s of spans()) {
    if (!s.engine) continue;
    // Notes a window ahead
    scheduler.advance(s, s.posStart + (now + POST_AHEAD - s.ctxStart));
    // Metronome clicks within the lookahead window. Cursors advance even with
    // the click off so switching it on mid-play doesn't replay past beats.
    const segCtxEnd = s.ctxStart + (s.posEnd - s.posStart);
    const windowEndPos = Math.min(s.posEnd, s.posStart + (Math.min(horizon, segCtxEnd) - s.ctxStart));
    if (windowEndPos <= s.clickCursor) continue;
    if (st.isMetronomeEnabled) {
      beatsBetween(st.bpm || 120, s.clickCursor, windowEndPos, st.timeSignatures).forEach((b) => {
        const when = s.ctxStart + (b.time - s.posStart);
        if (when >= now - 0.005) playClick(Math.max(now, when), b.accent);
      });
    }
    s.clickCursor = windowEndPos;
  }

  scheduler.prune(now);
}

function startSpanAt(pos: number, ctxStart: number) {
  const loop = loopRange(getState());
  // Ableton-style: a loop only engages when playback starts before its end
  const end = loop && pos < loop[1] ? loop[1] : Infinity;
  openSpan(ctxStart, pos, end);
}

function stopAllSources(at = audioContext.currentTime) {
  scheduler?.clear(at);
  clickSources.forEach((src) => { try { src.stop(); } catch { /* already stopped */ } });
  clickSources = [];
}

// ------------------------------------------------------------------ control

// Start playback from the current position. With a count-in, the given click
// grid (times relative to the count-in start) plays for countInSeconds before
// the timeline starts moving.
export function play(countInSeconds = 0, countInGrid?: { time: number; accent: boolean }[]) {
  if (playing) return;
  if (!scheduler) {
    // the engine is still loading: start once it is
    ready.then(() => { if (getState().isPlaying && !playing) play(countInSeconds, countInGrid); });
    return;
  }
  if (audioContext.state === 'suspended') audioContext.resume();
  scheduler.claim(); // outputs for every track first: growing them resets the engine
  scheduler.prepare(stoppedPosition, stoppedPosition + POST_AHEAD);
  playing = true;
  dropped = 0;
  droppedLate = 0;
  setAutomationPlaying(true);
  const startCtx = audioContext.currentTime + 0.05;
  countInEnd = 0;
  if (countInSeconds > 0 && countInGrid) {
    scheduler.open(startCtx, stoppedPosition - countInSeconds, stoppedPosition, false).clickCursor = Infinity;
    countInGrid.forEach((b) => playClick(startCtx + b.time, b.accent));
    countInEnd = startCtx + countInSeconds;
  }
  startSpanAt(stoppedPosition, startCtx + countInSeconds);
  timer = setInterval(tick, TICK_MS);
  tick();
  notify_();
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
  if (dropped > 0) {
    const why = droppedLate === dropped ? 'the audio thread fell behind. A smaller project, or fewer devices, helps'
      : droppedLate === 0 ? 'their audio was no longer in the engine'
      : `${droppedLate} because the audio thread fell behind, the rest because their audio was no longer in the engine`;
    notify(`The audio engine dropped ${dropped} note${dropped === 1 ? '' : 's'}: ${why}.`, 'error');
  }
  notify_();
}

// Move the playhead. While playing, playback continues from the new spot.
export function setPosition(pos: number) {
  const p = Math.max(0, pos);
  if (!playing) {
    stoppedPosition = p;
    notify_();
    return;
  }
  scheduler?.prepare(p, p + POST_AHEAD);
  const at = audioContext.currentTime + 0.03;
  stopAllSources(at);
  countInEnd = 0;
  startSpanAt(p, at);
  tick();
  notify_();
}

// Loop or freeze settings changed: rebuild what's scheduled from the current
// playhead so the change is heard straight away.
export function reschedule() {
  if (!playing || isCountingIn()) return;
  setPosition(getPosition());
}

// For the tests: what the engine has done and what the scheduler posted
export async function engineStats() {
  const engine = liveEngine();
  return { engine: engine ? await engine.stats() : null, scheduler: scheduler ? { ...scheduler.counts, spans: scheduler.spans.length } : null, dropped };
}
