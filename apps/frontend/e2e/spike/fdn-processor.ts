// The FDN reverb as a device on the native graph (variant a-fdn and c-fdn):
// the same reverb as the engine worklet, so the reverb algorithm can be
// taken out of the comparison between native nodes and our own DSP.

import { FdnReverb } from './dsp.ts';

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; }

class FdnProcessor extends AudioWorkletProcessor {
  private reverb = new FdnReverb(sampleRate);
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = inputs[0], out = outputs[0];
    if (!inp.length) { out[0].fill(0); if (out[1]) out[1].fill(0); return true; }
    out[0].set(inp[0]); out[1].set(inp[1] || inp[0]);
    this.reverb.process(out[0], out[1]);
    return true;
  }
}

registerProcessor('bench-fdn', FdnProcessor);
