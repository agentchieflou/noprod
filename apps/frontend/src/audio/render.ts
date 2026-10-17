// Offline render: the project, or a range of it, through the same engine
// and the same mixer as playback (sources on the engine worklet, devices,
// sends, returns and the master on a Mixer of its own), on an
// OfflineAudioContext, a window at a time. The mix is the master's output,
// after its devices and the limiter; stems are strips' outputs post-fader
// and post-pan, master devices not applied, so the top-level stems sum to
// the master's input. A render runs past the end by the devices' tails and
// trims the silence after them. Export (export.ts) writes the result.
//
// Native plug-ins (GhostDAW inserts) are not rendered yet: they pass
// through, and the count is reported, so the Export dialog can say so.

import { createDeviceDSP, deviceTail, loadDeviceWorklets } from './devices';
import { isNativeDevice } from '../native/trackBridge';
import { Engine, loadEngine } from './engineNode';
import { Scheduler, driveOffline } from './scheduler';
import { Mixer, MASTER_ID, flattenDevices, loadMixer } from './mixer';
import { envelopeAt } from './transport';

const MAX_TAIL = 30;     // seconds a render runs past the end for device tails, at most
const SILENT = 3.16e-5;  // -90 dBFS: trailing samples below it are trimmed
const PAIRS = 16;        // stereo pairs a context can hold

export interface RenderRequest {
  state: any;
  from: number;                 // timeline seconds
  to: number;
  sampleRate: number;
  stems?: string[] | null;      // strip ids rendered each on its own; null or absent: the mix
  tail?: number | 'auto';       // seconds past `to` (the devices' longest tail when 'auto'; 0 for none)
  onProgress?: (done: number) => void; // 0..1 as the windows render
  signal?: AbortSignal;         // cancels at the next window
}

export interface RenderResult {
  buffers: AudioBuffer[];       // one for the mix, or one per stem in `stems` order
  tail: number;                 // seconds rendered past `to` before trimming
  nativeSkipped: number;        // native inserts that passed through
}

// What a track's automation lane says at `t`, scheduled onto the mixer's
// AudioParams: a value at the start, linear ramps through each breakpoint
function scheduleAutomation(mixer: Mixer, state: any, from: number, to: number) {
  (state.tracks || []).forEach((t: any) => {
    Object.entries(t.automation || {}).forEach(([key, pts]: [string, any]) => {
      if (!pts?.length) return;
      mixer.getAutomationTargets(t.id, key).forEach(({ param, map }) => {
        param.setValueAtTime(map(envelopeAt(pts, from)), 0);
        pts.forEach((pt: any) => { if (pt.time > from && pt.time < to) param.linearRampToValueAtTime(map(pt.value), pt.time - from); });
        param.linearRampToValueAtTime(map(envelopeAt(pts, to)), to - from);
      });
    });
  });
}

const allDevices = (state: any): any[] =>
  [state.masterPlugins || [], ...(state.returns || []).map((r: any) => r.plugins || []), ...(state.tracks || []).map((t: any) => t.plugins || [])]
    .flatMap((pl) => flattenDevices(pl));

const nativeCount = (state: any) => allDevices(state).filter(isNativeDevice).length;

// The longest tail any device leaves (a reverb's decay, a delay ringing out)
export const projectTail = (state: any) => Math.min(MAX_TAIL, Math.max(0, ...allDevices(state).map(deviceTail)));

// The last frame above the floor, across channels, from `atLeast` on
function lastAudible(buffer: AudioBuffer, atLeast: number): number {
  let last = atLeast;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const x = buffer.getChannelData(c);
    for (let i = x.length - 1; i >= last; i--) { if (Math.abs(x[i]) > SILENT) { last = i + 1; break; } }
  }
  return last;
}

async function renderPass(r: RenderRequest, stems: string[] | null, tail: number): Promise<{ buffer: AudioBuffer; tail: number }> {
  const state = r.state;
  const channels = stems ? 2 * stems.length : 2;
  const seconds = r.to - r.from + tail;
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.ceil(seconds * r.sampleRate)), r.sampleRate);
  await Promise.all([loadEngine(ctx), loadMixer(ctx), loadDeviceWorklets(ctx).catch(() => {})]);

  // the mixer: the mix straight to the destination; stems tapped at their
  // strips, the master into a dead end
  const merger = stems ? ctx.createChannelMerger(channels) : null;
  if (merger) merger.connect(ctx.destination);
  const mixer = new Mixer(ctx, {
    createDevice: (c, d) => (isNativeDevice(d) ? null : createDeviceDSP(c, d)),
    output: merger ? ctx.createGain() : ctx.destination
  });
  mixer.setAutomationPlaying(true);
  mixer.sync(state);
  if (stems) {
    stems.forEach((id, k) => {
      const out = mixer.stripOutput(id);
      if (!out) return;
      const split = ctx.createChannelSplitter(2);
      out.connect(split);
      split.connect(merger!, 0, 2 * k);
      split.connect(merger!, 1, 2 * k + 1);
    });
  }
  scheduleAutomation(mixer, state, r.from, r.to + tail);

  // the sources, on an engine feeding the mixer's strips
  const engine = new Engine(ctx, { connect: (node, output, stripId) => node.connect(mixer.getStripInput(stripId), output) }, Math.max(1, (state.tracks || []).length));
  const scheduler = new Scheduler(engine, ctx, () => state);
  const span = scheduler.open(0, r.from, r.to);
  const total = r.to + tail - r.from;
  const rendered = await driveOffline(ctx, scheduler, engine, span, r.from, r.to + tail, (end) => {
    if (r.signal?.aborted) return false;
    r.onProgress?.(Math.min(1, (end - r.from) / total));
  });
  engine.dispose();
  mixer.dispose();
  if (!rendered) throw new DOMException('The render was cancelled', 'AbortError');
  return { buffer: rendered, tail };
}

// Trims the tail's silence: everything after the last audible sample past `keep` seconds
function trimmed(buffer: AudioBuffer, keep: number): AudioBuffer {
  const keepFrames = Math.min(buffer.length, Math.ceil(keep * buffer.sampleRate));
  const end = lastAudible(buffer, keepFrames);
  if (end >= buffer.length) return buffer;
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: Math.max(1, end), sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(0, end), c);
  return out;
}

export async function renderProject(r: RenderRequest): Promise<RenderResult> {
  const tail = r.tail === 'auto' || r.tail === undefined ? projectTail(r.state) : Math.max(0, Math.min(MAX_TAIL, r.tail));
  const nativeSkipped = nativeCount(r.state);
  if (!r.stems) {
    const { buffer, tail: ran } = await renderPass(r, null, tail);
    return { buffers: [trimmed(buffer, r.to - r.from)], tail: ran, nativeSkipped };
  }
  // stems in turns of what a context can hold, each turn a full render
  const buffers: AudioBuffer[] = [];
  let ran = 0;
  for (let i = 0; i < r.stems.length; i += PAIRS) {
    const ids = r.stems.slice(i, i + PAIRS);
    const part = await renderPass({ ...r, onProgress: (p) => r.onProgress?.((i + p * ids.length) / r.stems!.length) }, ids, tail);
    ran = part.tail;
    ids.forEach((_, k) => {
      const stem = new AudioBuffer({ numberOfChannels: 2, length: part.buffer.length, sampleRate: part.buffer.sampleRate });
      stem.copyToChannel(part.buffer.getChannelData(2 * k), 0);
      stem.copyToChannel(part.buffer.getChannelData(2 * k + 1), 1);
      buffers.push(stem);
    });
  }
  // stems trimmed to the same length, so they still sum sample for sample
  const end = Math.max(...buffers.map((b) => lastAudible(b, Math.min(b.length, Math.ceil((r.to - r.from) * r.sampleRate)))));
  return { buffers: buffers.map((b) => (end >= b.length ? b : trimmed(b, end / b.sampleRate))), tail: ran, nativeSkipped };
}

// The stems a project has: its top-level tracks (one routed into a group is
// in the group's) and its returns, in the mixer's order
export function stemIds(state: any): string[] {
  const tracks: any[] = state.tracks || [];
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const topLevel = (t: any): boolean => {
    const target = t.routing && t.routing !== MASTER_ID && t.routing !== t.id && byId.has(t.routing) ? t.routing : t.groupId && byId.has(t.groupId) ? t.groupId : MASTER_ID;
    return target === MASTER_ID;
  };
  return [...tracks.filter(topLevel).map((t) => t.id), ...(state.returns || []).map((r: any) => r.id)];
}
