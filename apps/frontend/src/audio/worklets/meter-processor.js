// NoProd meter tap (AudioWorklet): hands the master's stereo samples to the
// main thread in blocks of 2048, where the LoudnessMeter from @noprod/sound
// measures them, so the browser and the tests share one K-weighting.

const BLOCK = 2048;

class NoProdMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(BLOCK);
    this.right = new Float32Array(BLOCK);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const l = input[0];
    if (!l) return true;
    const r = input[1] || l;
    for (let i = 0; i < l.length; i++) {
      this.left[this.n] = l[i];
      this.right[this.n] = r[i];
      if (++this.n === BLOCK) {
        this.port.postMessage([this.left.slice(), this.right.slice()]);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('noprod-meter', NoProdMeterProcessor);
