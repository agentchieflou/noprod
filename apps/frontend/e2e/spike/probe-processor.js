// A probe at the end of a graph: when its input goes from silence to sound it
// reports the frame it happened at (live-input latency), and it watches
// the render thread's pace: how far behind real time it falls, and blocks
// that took longer to make than they last (as live-models.ts measures).

const QUIET = 1e-4;

class ProbeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.silent = true;
    this.blocks = 0;
    this.wallStart = 0;
    this.worstBehind = 0;
    this.behindBlocks = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'stats') {
        this.port.postMessage({
          type: 'stats', blocks: this.blocks,
          behindMs: this.worstBehind, behindBlocks: this.behindBlocks
        });
        this.worstBehind = 0; this.behindBlocks = 0;
      }
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    if (inp.length) { out[0].set(inp[0]); if (out[1]) out[1].set(inp[1] || inp[0]); }
    else { out[0].fill(0); if (out[1]) out[1].fill(0); }
    const now = Date.now();
    if (!this.blocks) this.wallStart = now - 1000 * currentFrame / sampleRate;
    this.blocks++;
    // The frames rendered so far against the wall clock since the first block:
    // negative means rendering is behind the device, i.e. an underrun looms
    const behind = (now - this.wallStart) - 1000 * (currentFrame + 128) / sampleRate;
    if (behind > 20) { this.behindBlocks++; if (behind > this.worstBehind) this.worstBehind = behind; }
    if (inp.length) {
      const ch = inp[0];
      let loud = -1;
      for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]) > QUIET) { loud = i; break; }
      if (loud >= 0 && this.silent) { this.silent = false; this.port.postMessage({ type: 'onset', frame: currentFrame + loud }); }
      else if (loud < 0) this.silent = true;
    } else {
      this.silent = true; // every source has ended: the input is gone
    }
    return true;
  }
}

registerProcessor('bench-probe', ProbeProcessor);
