// NoProd meter tap (AudioWorklet): hands the master's stereo samples, in
// blocks of 2048, to the loudness worker over a port the main thread passes
// in. The samples never touch the main thread. The worker measures them with
// the LoudnessMeter from @noprod/sound (one K-weighting for the browser and
// the tests) and sends the blocks back to be reused, so nothing is allocated
// while audio runs.

const BLOCK = 2048;
const POOL = 4;

class NoProdMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.free = Array.from({ length: POOL }, () => [new Float32Array(BLOCK), new Float32Array(BLOCK)]);
    this.current = this.free.pop();
    this.n = 0;
    this.out = null;
    this.port.onmessage = (e) => {
      this.out = e.data.port;
      this.out.onmessage = (back) => this.free.push(back.data);
    };
  }

  process(inputs) {
    const input = inputs[0];
    const l = input[0];
    if (!l || !this.out) return true;
    const r = input[1] || l;
    for (let i = 0; i < l.length; i++) {
      this.current[0][this.n] = l[i];
      this.current[1][this.n] = r[i];
      if (++this.n === BLOCK) {
        const block = this.current;
        this.out.postMessage(block, [block[0].buffer, block[1].buffer]);
        // out of blocks only if the worker is far behind: that block is lost
        this.current = this.free.pop() || [new Float32Array(BLOCK), new Float32Array(BLOCK)];
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('noprod-meter', NoProdMeterProcessor);
