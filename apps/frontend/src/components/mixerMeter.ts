// The Mixer's numbers and drawing. Meters read the engine's analyser taps
// straight into a canvas, so none of this touches React state or the store.

import { getMeterTap, masterLoudness } from '../audio/engine';

export const DB_MIN = -60;
export const DB_MAX = 6;
export const FLOOR = -120;
export const HOLD_SECONDS = 1.5;
const FALL_DB_PER_SECOND = 24;
const CLIP_LEVEL = 0.999;

export const toDb = (x: number) => (x > 1e-6 ? 20 * Math.log10(x) : FLOOR);
export const fromDb = (db: number) => Math.pow(10, db / 20);
export const formatDb = (db: number) => (db <= DB_MIN - 40 || !isFinite(db) ? '-∞' : db.toFixed(1));

// Fader travel (0..1000) <-> linear gain: even in dB from -60 to +6, and the
// bottom of the travel is -∞
export const FADER_MAX = 1000;
export const faderToGain = (pos: number) => (pos <= 0 ? 0 : fromDb(DB_MIN + (pos / FADER_MAX) * (DB_MAX - DB_MIN)));
export const gainToFader = (gain: number) =>
  gain <= 0 ? 0 : Math.max(0, Math.min(FADER_MAX, Math.round(((toDb(gain) - DB_MIN) / (DB_MAX - DB_MIN)) * FADER_MAX)));

const SCALE = [6, 0, -6, -12, -24, -36, -48];
const dbToY = (db: number, h: number) => h - ((Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * h;

interface ChannelState { peak: number; hold: number; holdAt: number; rms: number }
interface MeterState { l: ChannelState; r: ChannelState; clipped: boolean }

const states = new Map<string, MeterState>();
const channel = (): ChannelState => ({ peak: FLOOR, hold: FLOOR, holdAt: 0, rms: FLOOR });

export const clearClip = (id: string) => { const s = states.get(id); if (s) s.clipped = false; };

const buffers = new Map<AnalyserNode, Float32Array<ArrayBuffer>>();
const read = (node: AnalyserNode) => {
  let buf = buffers.get(node);
  if (!buf) { buf = new Float32Array(node.fftSize); buffers.set(node, buf); }
  node.getFloatTimeDomainData(buf);
  let peak = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
    sum += buf[i] * buf[i];
  }
  return { peak, rms: Math.sqrt(sum / buf.length) };
};

// Peak jumps up and falls at a steady rate; the hold line stays 1.5 s, then falls too
const follow = (c: ChannelState, peak: number, rms: number, now: number, dt: number) => {
  const p = toDb(peak);
  c.peak = Math.max(p, c.peak - FALL_DB_PER_SECOND * dt);
  c.rms = Math.max(toDb(rms), c.rms - FALL_DB_PER_SECOND * dt);
  if (p >= c.hold) { c.hold = p; c.holdAt = now; }
  else if (now - c.holdAt > HOLD_SECONDS) c.hold = Math.max(p, c.hold - FALL_DB_PER_SECOND * dt);
};

const color = (db: number) => (db > -3 ? '#ef4444' : db > -12 ? '#eab308' : '#22c55e');

export interface MeterView {
  id: string;
  canvas: HTMLCanvasElement;
  clip: HTMLElement | null;
  readout: HTMLElement | null;
}

// Draw one strip's meter. Returns nothing; the clip light and numbers are
// updated in place.
export function drawMeter(view: MeterView, now: number, dt: number) {
  const { id, canvas } = view;
  const tap = getMeterTap(id);
  const state = states.get(id) ?? { l: channel(), r: channel(), clipped: false };
  states.set(id, state);
  if (tap) {
    const l = read(tap.left), r = read(tap.right);
    follow(state.l, l.peak, l.rms, now, dt);
    follow(state.r, r.peak, r.rms, now, dt);
    if (Math.max(l.peak, r.peak) >= CLIP_LEVEL) state.clipped = true;
  }
  const loudest = Math.max(state.l.peak, state.r.peak);
  canvas.dataset.peak = loudest.toFixed(1);
  canvas.dataset.rms = Math.max(state.l.rms, state.r.rms).toFixed(1);
  canvas.dataset.hold = Math.max(state.l.hold, state.r.hold).toFixed(1);
  if (view.clip) view.clip.classList.toggle('lit', state.clipped);
  if (view.readout) view.readout.textContent = formatDb(Math.max(state.l.hold, state.r.hold));

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const scale = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * scale) || canvas.height !== Math.round(h * scale)) {
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);

  const labelW = 18, barW = Math.floor((w - labelW - 3) / 2);
  [state.l, state.r].forEach((c, i) => {
    const x = labelW + i * (barW + 1);
    const peakY = dbToY(c.peak, h), rmsY = dbToY(c.rms, h);
    ctx.fillStyle = '#2f3b33'; // peak: the bar behind
    ctx.fillRect(x, peakY, barW, h - peakY);
    ctx.fillStyle = color(c.rms); // RMS: the body
    ctx.fillRect(x + 1, rmsY, barW - 2, h - rmsY);
    if (c.hold > DB_MIN) {
      ctx.fillStyle = color(c.hold);
      ctx.fillRect(x, dbToY(c.hold, h), barW, 2);
    }
  });
  ctx.font = '8px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  SCALE.forEach((db) => {
    const y = Math.round(dbToY(db, h)) + 0.5;
    ctx.fillStyle = '#555';
    ctx.fillRect(labelW - 2, y, 3, 1);
    ctx.fillStyle = '#888';
    ctx.fillText(String(db), labelW - 4, Math.max(5, Math.min(h - 5, y)));
  });
}

export interface LoudnessView {
  momentary: HTMLElement | null;
  shortTerm: HTMLElement | null;
  integrated: HTMLElement | null;
  truePeak: HTMLElement | null;
}

const lufs = (v: number) => (v > -100 ? v.toFixed(1) : '-∞');

export function drawLoudness(view: LoudnessView) {
  const set = (el: HTMLElement | null, text: string) => { if (el && el.textContent !== text) el.textContent = text; };
  set(view.momentary, lufs(masterLoudness.momentary));
  set(view.shortTerm, lufs(masterLoudness.shortTerm));
  set(view.integrated, lufs(masterLoudness.integrated));
  set(view.truePeak, lufs(masterLoudness.truePeak <= FLOOR ? -Infinity : masterLoudness.truePeak));
}
