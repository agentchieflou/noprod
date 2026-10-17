// Variant (c): one source worklet per track. It holds the track's rendered
// note buffers and a queue of note events (audio time), and plays them
// sample-accurately whatever the main thread is doing.

import { VoiceQueue, BLOCK, type Buf, type NoteEvent } from './dsp.ts';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; }

type Message =
  | { type: 'buffer'; id: number; l: Float32Array; r: Float32Array }
  | { type: 'notes'; notes: NoteEvent[] }
  | { type: 'retract'; from: number }
  | { type: 'stats' };

class PlayerProcessor extends AudioWorkletProcessor {
  private queue = new VoiceQueue(sampleRate);
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Message>) => {
      const m = e.data;
      if (m.type === 'buffer') this.queue.addBuffer(m.id, { l: m.l, r: m.r } as Buf);
      else if (m.type === 'notes') for (const n of m.notes) this.queue.add(n, currentFrame);
      else if (m.type === 'retract') this.queue.retractFrom(Math.round(m.from * sampleRate));
      else if (m.type === 'stats') this.port.postMessage({ type: 'stats', late: this.queue.late, worstLateMs: 1000 * this.queue.worstLate / sampleRate, played: this.queue.played });
    };
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const l = out[0], r = out[1] || out[0];
    l.fill(0); if (r !== l) r.fill(0);
    this.queue.render(currentFrame, l, r);
    return true;
  }
}

void BLOCK;
registerProcessor('bench-player', PlayerProcessor);
