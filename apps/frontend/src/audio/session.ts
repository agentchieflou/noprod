// Session View launcher: quantized clip and scene launching on top of the
// transport clock, looping session clips scheduled in short windows, scene
// tempo / time-signature overrides and scene follow actions.
//
// Store data: state.scenes[i] = { id, name, tempo, signature, follow }
// and state.sessionClips[trackId][sceneIndex] = clip (same clip properties as
// arrangement clips, looping by default). Runtime state lives here and is
// exposed to React through subscribe()/getSessionSnapshot().

import { audioContext, getStripInput } from './engine';
import { scheduleClip, clipTimelineLength, clipLoop } from './clipPlayback';
import {
  isPlaying as transportPlaying, nextQuantizedTime, releaseTrackFromArrangement,
  sessionOwnedTracks, reschedule, onTransportChange, getPosition
} from './transport';
import { barAt, barSeconds } from './timeline';

type Stoppable = { stop: (when?: number) => void };

interface PlayingClip {
  slot: number;
  clip: any;
  startCtx: number;     // context time the clip (re)starts from offset 0
  cursor: number;       // clip-time offset scheduled up to
  sources: Stoppable[];
  stopAt: number | null;
}

interface Pending { slot: number | null; atCtx: number } // slot null = stop

export interface SessionSnapshot {
  playing: Record<string, number>;   // trackId -> slot index
  queued: Record<string, number | null>;
  playingScene: number | null;
  queuedScene: number | null;
  followAt: number | null;           // ctx time of the next follow action
  arrangementOverridden: boolean;    // some track is held by the session (Back to Arrangement lights up)
}

const LOOKAHEAD = 0.3;
const CHUNK = 0.5;
const TICK_MS = 40;

let getState: () => any = () => ({});
const playing = new Map<string, PlayingClip>();
const pending = new Map<string, Pending>();
let follow: { atCtx: number; fromScene: number } | null = null;
let playingScene: number | null = null;
let queuedScene: { index: number; atCtx: number; applied?: boolean } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// ------------------------------------------------------------ subscriptions

const listeners = new Set<() => void>();
let snapshot: SessionSnapshot = { playing: {}, queued: {}, playingScene: null, queuedScene: null, followAt: null, arrangementOverridden: false };
let snapshotKey = '';
// Publish a new snapshot only when something visible changed (tick runs 25x/s)
const emit = () => {
  const p: Record<string, number> = {};
  playing.forEach((pc, id) => { p[id] = pc.slot; });
  const q: Record<string, number | null> = {};
  pending.forEach((pe, id) => { q[id] = pe.slot; });
  const next = {
    playing: p, queued: q, playingScene, queuedScene: queuedScene?.index ?? null,
    followAt: follow?.atCtx ?? null, arrangementOverridden: sessionOwnedTracks.size > 0
  };
  const key = JSON.stringify(next);
  if (key === snapshotKey) return;
  snapshotKey = key;
  snapshot = next;
  listeners.forEach((fn) => fn());
};
export const subscribeSession = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getSessionSnapshot = () => snapshot;

// ------------------------------------------------------------------ helpers

const clipAt = (st: any, trackId: string, slot: number) => st.sessionClips?.[trackId]?.[slot];

// Launching starts the transport. Returns the launch time: the next
// quantization point while already playing, else the transport's start.
const ensureRunning = (atCtx?: number) => {
  const st = getState();
  const wasPlaying = transportPlaying();
  const when = atCtx ?? (wasPlaying ? nextQuantizedTime(st.launchQuantization) : audioContext.currentTime + 0.05);
  if (!st.isPlaying) st.togglePlayback();
  if (!timer) timer = setInterval(tick, TICK_MS);
  return when;
};

const stopSources = (pc: PlayingClip, atCtx?: number) =>
  pc.sources.forEach((s) => { try { s.stop(atCtx); } catch { /* already stopped */ } });

// Bars of the current signature, in seconds, at a given tempo
const barLength = (st: any, bpm: number) => barSeconds(bpm, barAt(st.bpm || 120, getPosition(), st.timeSignatures));

// ------------------------------------------------------------------ actions

export function initSession(store: { getState: () => any }) {
  getState = store.getState;
  // Stopping the transport stops the session
  onTransportChange(() => { if (!transportPlaying() && (playing.size || pending.size)) stopAllNow(); });
}

export function launchClip(trackId: string, slot: number, atCtx?: number) {
  const st = getState();
  if (!clipAt(st, trackId, slot)) return;
  pending.set(trackId, { slot, atCtx: ensureRunning(atCtx) });
  emit();
  tick();
}

export function stopTrack(trackId: string, atCtx?: number) {
  if (!playing.has(trackId) && !pending.has(trackId)) return;
  pending.set(trackId, { slot: null, atCtx: atCtx ?? nextQuantizedTime(getState().launchQuantization) });
  emit();
}

export function launchScene(index: number, atCtx?: number) {
  const st = getState();
  const scene = st.scenes?.[index];
  if (!scene) return;
  const when = ensureRunning(atCtx);
  (st.tracks || []).forEach((t: any) => {
    if (t.type === 'group') return;
    if (clipAt(st, t.id, index)) pending.set(t.id, { slot: index, atCtx: when });
    else if (playing.has(t.id)) pending.set(t.id, { slot: null, atCtx: when }); // empty slot stops the track
  });
  queuedScene = { index, atCtx: when };
  emit();
  tick();
}

export function stopAll() {
  const when = nextQuantizedTime(getState().launchQuantization);
  playing.forEach((_, id) => pending.set(id, { slot: null, atCtx: when }));
  follow = null;
  queuedScene = null;
  emit();
}

function stopAllNow() {
  playing.forEach((pc) => stopSources(pc));
  playing.clear();
  pending.clear();
  follow = null;
  playingScene = null;
  queuedScene = null;
  if (timer) clearInterval(timer);
  timer = null;
  emit();
}

// Give every track back to the arrangement
export function backToArrangement() {
  playing.forEach((pc) => stopSources(pc));
  playing.clear();
  pending.clear();
  follow = null;
  playingScene = null;
  sessionOwnedTracks.clear();
  reschedule();
  emit();
}

// ------------------------------------------------------------------ engine

function applySceneSettings(index: number, atCtx: number) {
  const st = getState();
  const scene = st.scenes?.[index];
  if (!scene) return;
  // The scene becomes current (and its tempo / signature overrides apply)
  // exactly at the launch point, not when it enters the lookahead window
  const delay = Math.max(0, (atCtx - audioContext.currentTime) * 1000);
  const launched = queuedScene;
  setTimeout(() => {
    if (queuedScene === launched) queuedScene = null;
    playingScene = index;
    emit();
  }, delay);
  if (scene.tempo || scene.signature) {
    setTimeout(() => {
      const s = getState();
      if (scene.tempo) s.setBpm(scene.tempo);
      if (scene.signature) {
        const bar = barAt(s.bpm, getPosition(), s.timeSignatures);
        const cur = barAt(s.bpm, bar.time + 1e-6, s.timeSignatures);
        if (cur.numerator !== scene.signature.numerator || cur.denominator !== scene.signature.denominator) {
          s.setTimeSignature(bar.index, scene.signature.numerator, scene.signature.denominator);
        }
      }
    }, delay);
  }
  // Follow action: after N bars (at the scene's tempo), act on the next scene
  const f = scene.follow;
  if (f?.enabled && f.action !== 'none') {
    const bpm = scene.tempo || st.bpm || 120;
    follow = { atCtx: atCtx + Math.max(1, f.bars) * barLength(st, bpm), fromScene: index };
  } else {
    follow = null;
  }
}

function runFollowAction(fromScene: number, atCtx: number) {
  const st = getState();
  const n = (st.scenes || []).length;
  const action = st.scenes?.[fromScene]?.follow?.action;
  follow = null;
  if (action === 'stop') {
    playing.forEach((_, id) => pending.set(id, { slot: null, atCtx }));
    return;
  }
  let target = fromScene;
  if (action === 'next') target = (fromScene + 1) % n;
  else if (action === 'previous') target = (fromScene - 1 + n) % n;
  else if (action === 'first') target = 0;
  else if (action === 'random') target = n > 1 ? (fromScene + 1 + Math.floor(Math.random() * (n - 1))) % n : fromScene;
  else if (action === 'again') target = fromScene;
  launchScene(target, atCtx);
}

function tick() {
  const st = getState();
  const now = audioContext.currentTime;
  const horizon = now + LOOKAHEAD;
  const bpm = st.bpm || 120;

  // Follow actions fire exactly at their scheduled time
  if (follow && follow.atCtx <= horizon) runFollowAction(follow.fromScene, follow.atCtx);
  if (queuedScene && !queuedScene.applied && queuedScene.atCtx <= horizon) {
    queuedScene.applied = true;
    applySceneSettings(queuedScene.index, queuedScene.atCtx);
  }

  // Launches and stops whose time has come
  pending.forEach((pe, trackId) => {
    if (pe.atCtx > horizon) return;
    pending.delete(trackId);
    const prev = playing.get(trackId);
    if (prev) { stopSources(prev, pe.atCtx); playing.delete(trackId); }
    if (pe.slot === null) return;
    const clip = clipAt(st, trackId, pe.slot);
    if (!clip) return;
    releaseTrackFromArrangement(trackId, pe.atCtx);
    playing.set(trackId, { slot: pe.slot, clip, startCtx: pe.atCtx, cursor: 0, sources: [], stopAt: null });
  });

  // Schedule each playing clip a window ahead
  const tracks = new Map((st.tracks || []).map((t: any) => [t.id, t]));
  playing.forEach((pc, trackId) => {
    const track: any = tracks.get(trackId);
    // Edits in Clip View apply from the next window
    const latest = clipAt(st, trackId, pc.slot);
    if (latest) pc.clip = latest;
    const length = clipTimelineLength(pc.clip, bpm);
    const looping = !!clipLoop(pc.clip);
    while (pc.startCtx + pc.cursor < horizon) {
      const to = looping ? pc.cursor + CHUNK : Math.min(length, pc.cursor + CHUNK);
      if (to <= pc.cursor) { // one-shot clip finished
        pc.stopAt = pc.startCtx + length;
        break;
      }
      pc.sources.push(...scheduleClip(
        audioContext, pc.clip, track?.instrument?.parameters, getStripInput(trackId),
        pc.startCtx + pc.cursor, pc.cursor, to, bpm, { noteStartsOnly: true, midiEffects: track?.midiEffects }
      ));
      pc.cursor = to;
    }
    // keep the source list from growing without bound
    if (pc.sources.length > 400) pc.sources = pc.sources.slice(-200);
  });
  playing.forEach((pc, id) => { if (pc.stopAt !== null && pc.stopAt < now) playing.delete(id); });

  if (playing.size === 0 && pending.size === 0 && !follow && !queuedScene && timer) {
    clearInterval(timer);
    timer = null;
  }
  emit();
}
