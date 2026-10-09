// Arrangement recording. While the transport plays with Record on (after
// any count-in), every armed track records its input: audio tracks through a
// recorder worklet on their audio input, MIDI tracks from the MIDI bus. When
// recording stops, each pass through the timeline (one per loop pass) becomes
// a take: the store puts it on a new take lane and comps it into the track.

import { audioContext } from './engine';
import { getAudioInputNode, openAudioInput, onMidiEvent, midiEventTargets, type MidiEvent } from './inputs';
import { getSegments, onSegmentScheduled, getCountInEnd, type SegmentInfo } from './transport';

interface AudioCapture {
  kind: 'audio';
  node: AudioWorkletNode;
  source: AudioNode;
  chunks: { time: number; channels: Float32Array[] }[];
  done: Promise<void>;
}

interface MidiCapture {
  kind: 'midi';
  events: MidiEvent[];
}

interface Recording {
  startCtx: number;
  log: SegmentInfo[];
  captures: Map<string, AudioCapture | MidiCapture>;
  cleanup: (() => void)[];
  punch: [number, number] | null;
}

let rec: Recording | null = null;
let getState: () => any = () => ({});
const recordedListeners = new Set<(n: number) => void>();
export const onTakesRecorded = (fn: (n: number) => void) => { recordedListeners.add(fn); return () => { recordedListeners.delete(fn); }; };

// The silent sink that keeps recorder worklets pulled by the graph
const sink = audioContext.createGain();
sink.gain.value = 0;
sink.connect(audioContext.destination);

export function initRecorder(store: { getState: () => any; subscribe: (fn: (s: any, p: any) => void) => unknown }) {
  getState = store.getState;
  // With punch on, capture the whole pass and crop to the punch range
  // afterwards: the UI flips isRecording at the punch points a frame late,
  // but the crop is sample-exact.
  const recording = (s: any) => s.isPlaying && (s.isRecording || s.isPunchEnabled);
  store.subscribe((st, prev) => {
    const active = recording(st);
    const was = recording(prev);
    if (active && !was) startRecording(st);
    else if (!active && was) stopRecording();
  });
}

function startRecording(st: any) {
  const startCtx = Math.max(audioContext.currentTime, getCountInEnd());
  const r: Recording = {
    startCtx,
    log: getSegments().filter((s) => s.posEnd > 0),
    captures: new Map(),
    cleanup: [],
    punch: st.isPunchEnabled ? [st.punchInTime, st.punchOutTime] : null
  };
  r.cleanup.push(onSegmentScheduled((s) => r.log.push(s)));

  (st.tracks || []).filter((t: any) => t.isArmed).forEach((t: any) => {
    if (t.type === 'audio') {
      const inp = t.input || { type: 'ext', device: 'default', channel: '1/2' };
      if (inp.type !== 'ext') return;
      const device = inp.device || 'default';
      let source = getAudioInputNode(device, inp.channel || '1/2');
      const node = new AudioWorkletNode(audioContext, 'noprod-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit'
      });
      const cap: AudioCapture = { kind: 'audio', node, source: source as AudioNode, chunks: [], done: Promise.resolve() };
      cap.done = new Promise((resolve) => {
        node.port.onmessage = (e) => {
          if (e.data.done) resolve();
          else cap.chunks.push(e.data);
        };
      });
      node.connect(sink);
      const attach = (src: AudioNode) => { cap.source = src; src.connect(node); node.port.postMessage('start'); };
      if (source) attach(source);
      else openAudioInput(device).then((open) => { if (open && rec === r) attach(open.outputs[inp.channel || '1/2']); });
      r.captures.set(t.id, cap);
    } else if (t.type === 'midi') {
      r.captures.set(t.id, { kind: 'midi', events: [] });
    }
  });

  // MIDI goes to whichever tracks the event plays on (armed tracks, or the
  // track the computer keyboard is playing), created on first note
  r.cleanup.push(onMidiEvent((e) => {
    midiEventTargets(getState(), e).forEach((t: any) => {
      let cap = r.captures.get(t.id);
      if (!cap) { cap = { kind: 'midi', events: [] }; r.captures.set(t.id, cap); }
      if (cap.kind === 'midi') cap.events.push(e);
    });
  }));
  rec = r;
}

// ctx time -> timeline position (and which pass) using the segment log
const locate = (log: SegmentInfo[], t: number) => {
  for (let i = log.length - 1; i >= 0; i--) {
    if (t >= log[i].ctxStart) return { pass: i, pos: Math.min(log[i].posEnd, log[i].posStart + (t - log[i].ctxStart)) };
  }
  return null;
};

// Each pass's [ctxStart, ctxEnd) clipped to the recording window (and punch range)
function passes(r: Recording, stopCtx: number) {
  const out: { tA: number; tB: number; posA: number }[] = [];
  r.log.forEach((s) => {
    const segEnd = Number.isFinite(s.posEnd) ? s.ctxStart + (s.posEnd - s.posStart) : Infinity;
    let tA = Math.max(r.startCtx, s.ctxStart);
    let tB = Math.min(stopCtx, segEnd);
    if (r.punch) {
      tA = Math.max(tA, s.ctxStart + (r.punch[0] - s.posStart));
      tB = Math.min(tB, s.ctxStart + (r.punch[1] - s.posStart));
    }
    if (tB - tA > 0.05) out.push({ tA, tB, posA: s.posStart + (tA - s.ctxStart) });
  });
  return out;
}

async function stopRecording() {
  const r = rec;
  if (!r) return;
  rec = null;
  const stopCtx = audioContext.currentTime;
  r.cleanup.forEach((fn) => fn());
  const st = getState();
  const sr = audioContext.sampleRate;
  // What was heard happened earlier than it reached the recorder
  const latency = (audioContext.outputLatency || 0) + (audioContext.baseLatency || 0);
  let total = 0;

  for (const [trackId, cap] of r.captures) {
    const track = st.tracks.find((t: any) => t.id === trackId);
    if (!track) continue;
    const clips: any[] = [];

    if (cap.kind === 'audio') {
      // keep capturing a little longer: latency compensation shifts the
      // audio earlier, so the last `latency` seconds arrive after stop
      await new Promise((res) => setTimeout(res, (latency + 0.05) * 1000));
      cap.node.port.postMessage('stop');
      await Promise.race([cap.done, new Promise((res) => setTimeout(res, 500))]);
      try { cap.source?.disconnect(cap.node); } catch { /* not connected */ }
      cap.node.disconnect();
      if (!cap.chunks.length) continue;
      cap.chunks.sort((a, b) => a.time - b.time);
      const t0 = cap.chunks[0].time - latency;
      const frames = cap.chunks.reduce((n, c) => n + c.channels[0].length, 0);
      const data = [new Float32Array(frames), new Float32Array(frames)];
      let at = 0;
      cap.chunks.forEach((c) => {
        data[0].set(c.channels[0], at);
        data[1].set(c.channels[1] || c.channels[0], at);
        at += c.channels[0].length;
      });
      passes(r, stopCtx).forEach(({ tA, tB, posA }) => {
        const i0 = Math.max(0, Math.round((tA - t0) * sr));
        const i1 = Math.min(frames, Math.round((tB - t0) * sr));
        if (i1 - i0 < sr * 0.05) return;
        const buf = audioContext.createBuffer(2, i1 - i0, sr);
        buf.copyToChannel(data[0].subarray(i0, i1), 0);
        buf.copyToChannel(data[1].subarray(i0, i1), 1);
        clips.push({ trackId, file: 'Take', audioBuffer: buf, startTime: posA, duration: buf.duration, startOffset: 0 });
      });
    } else {
      passes(r, stopCtx).forEach(({ tA, tB, posA }) => {
        const notes: any[] = [];
        const open = new Map<string, MidiEvent>();
        cap.events.forEach((e) => {
          const key = `${e.source}:${e.pitch}`;
          if (e.type === 'on') { if (e.time >= tA && e.time < tB) open.set(key, e); return; }
          const on = open.get(key);
          if (!on) return;
          open.delete(key);
          notes.push({ on, offTime: Math.min(e.time, tB) });
        });
        open.forEach((on) => notes.push({ on, offTime: tB })); // still held when recording stopped
        if (!notes.length) return;
        const posB = posA + (tB - tA);
        clips.push({
          trackId, type: 'midi', file: 'Take', audioBuffer: null, startTime: posA, duration: posB - posA, startOffset: 0,
          notes: notes.map(({ on, offTime }, i) => ({
            id: `rec-${Date.now()}-${i}`,
            pitch: on.pitch,
            velocity: on.velocity,
            start: Math.max(0, (locate(r.log, on.time)?.pos ?? posA) - posA),
            duration: Math.max(0.02, offTime - on.time)
          }))
        });
      });
    }

    if (clips.length) {
      st.addRecordedTakes(trackId, clips);
      total += clips.length;
    }
  }
  recordedListeners.forEach((fn) => fn(total));
}
