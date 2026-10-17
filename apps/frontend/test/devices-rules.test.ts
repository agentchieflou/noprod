// The rules every device kernel keeps (#159, step 5): the same output
// twice, in any block length, with nothing shared between instances; no
// allocation while processing; no slowdown once a tail has decayed into
// the subnormal range; and what a block costs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { PerformanceObserver } from 'node:perf_hooks';
import { KERNEL_KINDS, makeKernel, type DeviceKernel } from '../src/audio/dsp/devices/index.ts';
import { BLOCK, SR, concat, hasSubnormal, identical, median, noise, run, set, silence } from './kernels.ts';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

// Settings that make every kernel do its full work (a band on, a
// compressor compressing, a reverb reverberating)
const WORKING: Record<string, Record<string, number | boolean | string>> = {
  eq3: { GainLo: 3, GainMid: -2, GainHi: 1.5, FreqLo: 200, FreqHi: 3000 },
  eq8: { '1 On': true, '1 Type': 'Low Cut 48', '8 On': true, '8 Type': 'High Cut 12', '3 Gain': 4, '5 Gain': -3, Output: 1 },
  compressor: { Threshold: -30, Ratio: 4, Attack: 5, Release: 80, Makeup: 3 },
  glue: { Threshold: -24, Makeup: 2, Release: 'Auto', 'Soft Clip': true },
  panner: { Pan: -0.3 },
  limiter: { Ceiling: -3, Release: 50 },
  delay: { Time: 0.3, Feedback: 60, 'Dry/Wet': 50 },
  reverb: { Decay: 2.5, 'Dry/Wet': 50 }
};

// A lane for one of the kernel's automatable parameters, on every other block
const RAMPED: Record<string, [string, number, number]> = {
  eq3: ['GainMid', -6, 6], eq8: ['3 Freq', 200, 400], compressor: ['Threshold', -30, -20], glue: ['Makeup', 0, 3],
  panner: ['Pan', -1, 1], limiter: ['Ceiling', -6, -1], delay: ['Dry/Wet', 20, 60], reverb: ['Dry/Wet', 20, 60]
};

const working = (kind: string) => set(makeKernel(kind, SR)!, WORKING[kind]);
const inL = noise(SR, 0.3, 11), inR = noise(SR, 0.3, 12);

for (const kind of KERNEL_KINDS) {
  test(`${kind}: two instances with the same settings render the same twice, and after a reset`, () => {
    const a = run(working(kind), inL, inR), b = run(working(kind), inL, inR);
    assert.ok(identical(a.l, b.l) && identical(a.r, b.r), 'two instances differ');
    const k = working(kind);
    const first = run(k, inL, inR);
    k.reset();
    const again = run(k, inL, inR);
    assert.ok(identical(first.l, again.l) && identical(first.r, again.r), 'a reset instance differs');
  });

  test(`${kind}: the block length makes no difference`, () => {
    const whole = run(working(kind), inL, inR, [BLOCK]);
    const ragged = run(working(kind), inL, inR, [1, 7, 128, 33, 64, 100, 2, 128, 128, 5]);
    assert.ok(identical(whole.l, ragged.l) && identical(whole.r, ragged.r));
  });

  test(`${kind}: instances share nothing`, () => {
    const alone = run(working(kind), inL, inR);
    const a = working(kind), b = working(kind);
    // b is driven with other audio and other settings in between a's blocks
    const outL = new Float32Array(inL.length), outR = new Float32Array(inR.length);
    const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK), ol = new Float32Array(BLOCK), or = new Float32Array(BLOCK);
    const other = noise(BLOCK, 0.9, 99);
    for (let at = 0; at < inL.length; at += BLOCK) {
      bl.set(other); br.set(other);
      b.set(Object.keys(WORKING[kind])[0], 0, 0);
      b.process(bl, br, ol, or, BLOCK);
      bl.set(inL.subarray(at, at + BLOCK)); br.set(inR.subarray(at, at + BLOCK));
      a.process(bl, br, ol, or, BLOCK);
      outL.set(ol, at); outR.set(or, at);
    }
    assert.ok(identical(alone.l, outL) && identical(alone.r, outR));
  });

  test(`${kind}: processes in place`, () => {
    const apart = run(working(kind), inL, inR);
    const k = working(kind);
    const l = new Float32Array(inL), r = new Float32Array(inR);
    for (let at = 0; at < l.length; at += BLOCK) {
      const bl = l.subarray(at, at + BLOCK), br = r.subarray(at, at + BLOCK);
      k.process(bl, br, bl, br, BLOCK);
    }
    assert.ok(identical(apart.l, l) && identical(apart.r, r));
  });

  test(`${kind}: no allocation over 10k blocks`, async () => {
    const k = working(kind);
    const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK), ol = new Float32Array(BLOCK), or = new Float32Array(BLOCK);
    const [name, from, to] = RAMPED[kind];
    const ramp = new Map<string, [number, number]>([[name, [from, to]]]);
    const back = new Map<string, [number, number]>([[name, [to, from]]]);
    const knob = Object.keys(WORKING[kind])[0], knobValue = WORKING[kind][knob];
    // Settings every 50 blocks and a lane on every other block, so the
    // glides and the ramps are counted too
    const block = (i: number) => {
      const at = (i * BLOCK) % (inL.length - BLOCK);
      for (let j = 0; j < BLOCK; j++) { bl[j] = inL[at + j]; br[j] = inR[at + j]; }  // no subarray: that is a view, an allocation of the test's own
      if (i % 50 === 0) k.set(knob, knobValue, 0);
      k.process(bl, br, ol, or, BLOCK, i % 4 === 1 ? ramp : i % 4 === 3 ? back : undefined);
    };
    // The JIT allocates while it compiles and tiers up, so the count starts
    // once that has settled: after a warm-up, the least growth of three runs
    for (let i = 0; i < 20000; i++) block(i);
    let gcs = 0;
    const observer = new PerformanceObserver((list) => { gcs += list.getEntries().length; });
    observer.observe({ entryTypes: ['gc'] });
    const grown: number[] = [];
    for (let rep = 0; rep < 3; rep++) {
      gc();
      await new Promise((r) => setTimeout(r, 20));
      gcs = 0;
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 10000; i++) block(i);
      grown.push(process.memoryUsage().heapUsed - before);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(gcs, 0, `${gcs} collections during 10k blocks`);
    }
    observer.disconnect();
    const least = Math.min(...grown);
    assert.ok(least < 64 * 1024, `heap grew ${grown.join(', ')} bytes over three runs of 10k blocks`);
  });

  test(`${kind}: a block costs no more after a burst has decayed into silence (denormals)`, () => {
    const k = working(kind);
    const burst = 0.5, quiet = 20;
    const l = concat(noise(burst * SR, 0.8, 5), silence(quiet * SR)), r = concat(noise(burst * SR, 0.8, 6), silence(quiet * SR));
    const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK), ol = new Float32Array(BLOCK), or = new Float32Array(BLOCK);
    const times: number[] = [];
    const pass = () => {
      times.length = 0;
      k.reset();
      for (let at = 0; at + BLOCK <= l.length; at += BLOCK) {
        bl.set(l.subarray(at, at + BLOCK)); br.set(r.subarray(at, at + BLOCK));
        const t0 = performance.now();
        k.process(bl, br, ol, or, BLOCK);
        times.push(performance.now() - t0);
      }
    };
    pass();   // warm
    pass();
    const burstBlocks = Math.floor((burst * SR) / BLOCK);
    const loud = median(times.slice(0, burstBlocks));
    const late = median(times.slice(-Math.floor((2 * SR) / BLOCK)));
    assert.ok(late <= 2 * loud + 0.002, `a block took ${late.toFixed(4)} ms after 20 s of silence, ${loud.toFixed(4)} ms during the burst`);
    assert.ok(!hasSubnormal(ol) && !hasSubnormal(or), 'the output holds subnormals');
    assert.ok(ol.every(Number.isFinite) && or.every(Number.isFinite));
  });
}

// What a 128-frame block costs per kernel, and the spike's chain (EQ Eight,
// Compressor and Reverb on each of 32 tracks) against the 2.67 ms a block
// lasts at 48 kHz. Printed, and bounded loosely so a regression shows.
test('cost per block', () => {
  const cost = (k: DeviceKernel) => {
    const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK), ol = new Float32Array(BLOCK), or = new Float32Array(BLOCK);
    const times: number[] = [];
    for (let i = 0; i < 2500; i++) {
      const at = (i * BLOCK) % (inL.length - BLOCK);
      bl.set(inL.subarray(at, at + BLOCK)); br.set(inR.subarray(at, at + BLOCK));
      const t0 = performance.now();
      k.process(bl, br, ol, or, BLOCK);
      if (i >= 500) times.push(performance.now() - t0);
    }
    return median(times) * 1000;
  };
  const us: Record<string, number> = {};
  for (const kind of KERNEL_KINDS) us[kind] = cost(working(kind));
  const lines = KERNEL_KINDS.map((kind) => `  ${kind.padEnd(12)} ${us[kind].toFixed(2)} µs`);
  const chainKinds = ['eq8', 'compressor', 'reverb'].filter((k) => k in us);
  const chain = chainKinds.reduce((s, k) => s + us[k], 0) * 32;
  const period = (BLOCK / SR) * 1e6;
  console.log(`µs per 128-frame block (Node, ${SR} Hz):\n${lines.join('\n')}\n  chain of ${chainKinds.join(' + ')} × 32 tracks: ${chain.toFixed(0)} µs, ${(chain / period).toFixed(2)} of a ${period.toFixed(0)} µs block`);
  for (const kind of KERNEL_KINDS) assert.ok(us[kind] < 150, `${kind} costs ${us[kind].toFixed(1)} µs a block`);
});
