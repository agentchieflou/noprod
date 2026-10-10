// A native plugin insert on a browser track. The track's audio is cut into
// fixed-size blocks and sent (through a MessagePort to the bridge worker,
// then a WebSocket) to the Audio Core, which runs it through the plugin and
// sends it back. Output is played a fixed `latency` frames after input, so
// the delay never changes and the engine can compensate other tracks for it:
// a block that comes back in time plays processed; one that doesn't (Audio
// Core offline, or a hiccup) plays the dry signal from the same moment.
//
// Blocks are numbered by position (block n starts at input frame n * block),
// and the number travels with the block, so a late reply can't land in the
// wrong place.
//
// Each block also carries the transport at its first frame (tempo, position
// in quarter notes, playing/looping), for tempo-synced plugins. The main
// thread sends the transport's map of context time to timeline position
// (trackBridge.ts); the position is worked out here, per block, so it is
// sample-accurate. Header layout: apps/audio_core/src/TrackStreams.h.

const RENDER_QUANTUM = 128;
const HEADER = 16 + 24; // block header + transport block
const PLAYING = 1, LOOPING = 2, TEMPO_VALID = 4, PPQ_VALID = 8;

class NativeInsertProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { latency = 2048, block = 256 } = options.processorOptions || {};
    this.block = block;
    this.latency = Math.max(block * 2, Math.ceil(latency / RENDER_QUANTUM) * RENDER_QUANTUM);
    this.slots = 2 ** Math.ceil(Math.log2((this.latency + block * 4) / block)); // blocks the rings hold
    this.size = this.slots * block;
    this.dry = [new Float32Array(this.size), new Float32Array(this.size)];
    this.wet = [new Float32Array(this.size), new Float32Array(this.size)];
    this.wetBlock = new Float64Array(this.slots).fill(-1); // which block each wet slot holds
    this.frame = 0;          // input frames seen so far
    this.link = null;        // MessagePort to the bridge worker
    this.pool = [];          // spare send buffers (replies come back as reusable buffers)
    this.stats = { sent: 0, returned: 0, late: 0, minSlack: Infinity };
    this.lastReport = 0;
    this.transport = null;   // { playing, bpm, stoppedPosition, countInEnd, segments }

    this.port.onmessage = (e) => {
      if (e.data?.type === 'transport') {
        this.transport = e.data.transport;
        return;
      }
      if (e.data?.type !== 'link') return;
      this.link = e.data.port;
      this.link.onmessage = (m) => this.receive(m.data);
    };
  }

  // The transport at context time t: [tempo, ppq, flags]
  transportAt(t) {
    const tr = this.transport;
    if (!tr) return [120, 0, 0];
    const qn = tr.bpm / 60; // quarter notes per second
    let segment = null;
    for (const s of tr.segments) if (s.ctxStart <= t) segment = s;
    if (!tr.playing || !segment || t < tr.countInEnd) return [tr.bpm, tr.stoppedPosition * qn, TEMPO_VALID | PPQ_VALID];
    const pos = Math.min(segment.posEnd, segment.posStart + (t - segment.ctxStart));
    return [tr.bpm, pos * qn, PLAYING | TEMPO_VALID | PPQ_VALID | (Number.isFinite(segment.posEnd) ? LOOPING : 0)];
  }

  // A processed block (or a buffer handed back unused): { block, buffer }
  receive({ block, buffer, processed }) {
    if (processed) {
      const start = block * this.block;
      const slack = start + this.latency - this.frame; // frames until it must play
      this.stats.returned++;
      if (slack < 0) { // its first frame already played dry
        this.stats.late++;
      } else {
        this.stats.minSlack = Math.min(this.stats.minSlack, slack);
        const samples = new Float32Array(buffer, HEADER, this.block * 2);
        const at = start % this.size;
        this.wet[0].set(samples.subarray(0, this.block), at);
        this.wet[1].set(samples.subarray(this.block), at);
        this.wetBlock[block % this.slots] = block;
      }
    }
    if (this.pool.length < 32) this.pool.push(buffer);
  }

  // `start`: the context time of the block's first frame
  sendBlock(block, start) {
    if (!this.link) return;
    const buffer = this.pool.pop() || new ArrayBuffer(HEADER + this.block * 2 * 4);
    const [tempo, ppq, flags] = this.transportAt(start);
    new Uint32Array(buffer, 0, 4).set([block, this.block, 2, 1]); // flags bit 0: a transport block follows
    new Float64Array(buffer, 16, 2).set([tempo, ppq]);
    new Uint32Array(buffer, 32, 2).set([flags, 0]);
    const samples = new Float32Array(buffer, HEADER, this.block * 2);
    const at = (block * this.block) % this.size;
    samples.set(this.dry[0].subarray(at, at + this.block), 0);
    samples.set(this.dry[1].subarray(at, at + this.block), this.block);
    this.link.postMessage({ block, buffer }, [buffer]);
    this.stats.sent++;
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0];
    const inL = input[0];
    const inR = input[1] || input[0];
    const n = output[0].length;

    for (let i = 0; i < n; i++) {
      const f = this.frame + i;
      const w = f % this.size;
      this.dry[0][w] = inL ? inL[i] : 0;
      this.dry[1][w] = inR ? inR[i] : 0;

      const o = f - this.latency;
      if (o < 0) {
        output[0][i] = 0;
        if (output[1]) output[1][i] = 0;
        continue;
      }
      const r = o % this.size;
      const ring = this.wetBlock[Math.floor(o / this.block) % this.slots] === Math.floor(o / this.block) ? this.wet : this.dry;
      output[0][i] = ring[0][r];
      if (output[1]) output[1][i] = ring[1][r];
    }
    this.frame += n;

    if (this.frame % this.block === 0) this.sendBlock(this.frame / this.block - 1, (currentFrame + n - this.block) / sampleRate);

    if (currentTime - this.lastReport > 0.5) {
      this.lastReport = currentTime;
      this.port.postMessage({ type: 'stats', ...this.stats, minSlack: Number.isFinite(this.stats.minSlack) ? this.stats.minSlack : null });
      this.stats = { sent: 0, returned: 0, late: 0, minSlack: Infinity };
    }
    return true;
  }
}

registerProcessor('noprod-native-insert', NativeInsertProcessor);
