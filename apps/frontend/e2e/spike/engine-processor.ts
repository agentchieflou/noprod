// Variant (b): the whole engine in one worklet, in TypeScript. Every track
// is a voice queue, an EQ Eight, a compressor and a reverb of our own; the
// tracks are summed and limited here, and the main thread only sends notes.

import { VoiceQueue, EqEight, Compressor, FdnReverb, Limiter, BLOCK, type Buf, type NoteEvent } from './dsp.ts';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(options?: unknown); }

type Message =
  | { type: 'buffer'; id: number; l: Float32Array; r: Float32Array }
  | { type: 'notes'; track: number; notes: NoteEvent[] }
  | { type: 'stats' };

interface Track { queue: VoiceQueue; eq: EqEight; comp: Compressor; reverb: FdnReverb; l: Float32Array; r: Float32Array }

class EngineProcessor extends AudioWorkletProcessor {
  private tracks: Track[];
  private buffers = new Map<number, Buf>();
  private limiter = new Limiter(sampleRate);
  private busy = 0;   // ms spent in process()
  private blocks = 0;
  constructor(options: { processorOptions: { tracks: number; devices: boolean } }) {
    super(options);
    const { tracks, devices } = options.processorOptions;
    this.tracks = Array.from({ length: tracks }, () => ({
      queue: new VoiceQueue(sampleRate),
      eq: new EqEight(sampleRate), comp: new Compressor(sampleRate), reverb: new FdnReverb(sampleRate),
      l: new Float32Array(BLOCK), r: new Float32Array(BLOCK)
    }));
    this.devices = devices;
    this.port.onmessage = (e: MessageEvent<Message>) => {
      const m = e.data;
      if (m.type === 'buffer') { const buf = { l: m.l, r: m.r }; this.buffers.set(m.id, buf); for (const t of this.tracks) t.queue.addBuffer(m.id, buf); }
      else if (m.type === 'notes') for (const n of m.notes) this.tracks[m.track].queue.add(n, currentFrame);
      else if (m.type === 'stats') this.port.postMessage({
        type: 'stats',
        late: this.tracks.reduce((s, t) => s + t.queue.late, 0),
        worstLateMs: 1000 * Math.max(...this.tracks.map((t) => t.queue.worstLate)) / sampleRate,
        played: this.tracks.reduce((s, t) => s + t.queue.played, 0),
        load: this.blocks ? this.busy / (this.blocks * 1000 * BLOCK / sampleRate) : 0
      });
    };
  }
  private devices: boolean;
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const t0 = Date.now();
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    L.fill(0); if (R !== L) R.fill(0);
    const frame = currentFrame;
    for (const t of this.tracks) {
      t.l.fill(0); t.r.fill(0);
      t.queue.render(frame, t.l, t.r);
      if (this.devices) { t.eq.process(t.l, t.r); t.comp.process(t.l, t.r); t.reverb.process(t.l, t.r); }
      for (let i = 0; i < BLOCK; i++) { L[i] += t.l[i] * 0.8; R[i] += t.r[i] * 0.8; }
    }
    this.limiter.process(L, R);
    this.busy += Date.now() - t0;
    this.blocks++;
    return true;
  }
}

registerProcessor('bench-engine', EngineProcessor);
