// NoProd onset detector (AudioWorklet): per 256-sample hop, the half-wave
// rectified rise in RMS level (an onset-strength envelope), posted to the
// main thread in batches of 32 hops for tempo tracking. Linear (not log)
// level keeps accents - kicks, snares - stronger than quiet off-beat hats,
// which is what makes the beat period stand out.

const HOP = 256;
const BATCH = 32;

class NoProdOnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.acc = 0;
    this.n = 0;
    this.prev = 0;
    this.out = new Float32Array(BATCH);
    this.k = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const l = input[0];
    if (!l) return true;
    const r = input[1] || l;
    for (let i = 0; i < l.length; i++) {
      const x = (l[i] + r[i]) * 0.5;
      this.acc += x * x;
      if (++this.n === HOP) {
        const rms = Math.sqrt(this.acc / HOP);
        this.out[this.k++] = Math.max(0, rms - this.prev);
        this.prev = rms;
        this.acc = 0;
        this.n = 0;
        if (this.k === BATCH) {
          this.port.postMessage(this.out.slice());
          this.k = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('noprod-onset', NoProdOnsetProcessor);
