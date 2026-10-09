// NoProd recorder (AudioWorklet): while armed, copies its input to the main
// thread in ~4096-frame batches, each tagged with the audio-context time of
// its first sample so the main thread can place the audio on the timeline.
// Outputs silence (it only needs to be pulled by the graph to run).

class NoProdRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.batch = null;
    this.batchTime = 0;
    this.filled = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.active = true; this.filled = 0; this.batch = null; }
      else if (e.data === 'stop') { this.flush(); this.active = false; this.port.postMessage({ done: true }); }
    };
  }

  flush() {
    if (!this.batch || this.filled === 0) return;
    const chans = this.batch.map((c) => c.slice(0, this.filled));
    this.port.postMessage({ time: this.batchTime, channels: chans }, chans.map((c) => c.buffer));
    this.batch = null;
    this.filled = 0;
  }

  process(inputs) {
    if (!this.active) return true;
    const input = inputs[0];
    const frames = input[0] ? input[0].length : 128;
    if (!this.batch) {
      const n = Math.max(1, input.length);
      this.batch = Array.from({ length: Math.min(2, n) }, () => new Float32Array(4096));
      this.batchTime = currentTime;
      this.filled = 0;
    }
    for (let c = 0; c < this.batch.length; c++) {
      const src = input[c] || input[0];
      if (src) this.batch[c].set(src, this.filled);
    }
    this.filled += frames;
    if (this.filled + 128 > 4096) this.flush();
    return true;
  }
}

registerProcessor('noprod-recorder', NoProdRecorderProcessor);
