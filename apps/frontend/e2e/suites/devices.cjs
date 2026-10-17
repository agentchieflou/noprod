// #159 step 5: the device kernels against the native devices they replace.
// The same input goes through the native DeviceDSP on an OfflineAudioContext
// and through the kernel in the page, and the two are compared: the EQs'
// magnitude responses within 0.1 dB of the BiquadFilterNode chains, the
// compressors within 1e-6 of the dynamics worklet to the sample, the panner
// within 0.01 dB of StereoPannerNode.
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);

  await page.evaluate(async () => { window.__dev = await import('/src/audio/devices.ts'); return 1; });
  await page.evaluate(async () => { window.__k = await import('/src/audio/dsp/devices/index.ts'); return 1; });

  await page.evaluate(() => {
    const SR = 48000;
    window.__SR = SR;
    const seeded = (seed) => { const s = new Uint32Array([seed >>> 0]); return () => { s[0] += 0x6d2b79f5; let t = s[0]; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    window.__noise = (frames, level, seed) => { const r = seeded(seed); const o = new Float32Array(frames); for (let i = 0; i < frames; i++) o[i] = (r() * 2 - 1) * level; return o; };
    window.__sine = (frames, hz, level, phase = 0) => Float32Array.from({ length: frames }, (_, i) => level * Math.sin(phase + (2 * Math.PI * hz * i) / SR));
    window.__concat = (...parts) => { const o = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { o.set(p, at); at += p.length; } return o; };
    window.__freqs = Float32Array.from({ length: 200 }, (_, i) => 20 * Math.pow(1000, i / 199));
    window.__maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
    window.__peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    window.__rms = (a, from = 0) => { let s = 0; for (let i = from; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length - from)); };
    window.__db = (x) => 20 * Math.log10(Math.max(1e-12, x));
    const device = (kind, params) => ({ id: 'e2e', name: kind, type: 'audio-fx', kind, parameters: params });
    // The native device's response, on a context that never renders
    const quiet = new OfflineAudioContext(2, 128, SR);
    window.__nativeResponse = (kind, params) => {
      const dsp = window.__dev.createDeviceDSP(quiet, device(kind, params));
      const r = dsp.getResponse(window.__freqs);
      dsp.dispose();
      return r;
    };
    window.__kernelResponse = (kind, params) => {
      const k = window.__k.makeKernel(kind, SR);
      for (const [n, v] of Object.entries(params)) k.set(n, v, 0);
      return k.response(window.__freqs);
    };
    // The same stereo input rendered through the native device and the kernel
    window.__renderNative = async (kind, params, l, r) => {
      const off = new OfflineAudioContext(2, l.length, SR);
      await window.__dev.loadDeviceWorklets(off);
      const buf = off.createBuffer(2, l.length, SR);
      buf.copyToChannel(l, 0); buf.copyToChannel(r, 1);
      const src = off.createBufferSource();
      src.buffer = buf;
      if (kind === 'panner') {
        const p = off.createStereoPanner();
        p.pan.value = params.Pan;
        src.connect(p); p.connect(off.destination);
      } else {
        const dsp = window.__dev.createDeviceDSP(off, device(kind, params));
        src.connect(dsp.input); dsp.output.connect(off.destination);
      }
      src.start(0);
      const out = await off.startRendering();
      return { l: out.getChannelData(0), r: out.getChannelData(1) };
    };
    window.__renderKernel = (kind, params, l, r) => {
      const k = window.__k.makeKernel(kind, SR);
      for (const [n, v] of Object.entries(params)) k.set(n, v, 0);
      const outL = new Float32Array(l.length), outR = new Float32Array(r.length);
      const bl = new Float32Array(128), br = new Float32Array(128), ol = new Float32Array(128), or = new Float32Array(128);
      for (let at = 0; at < l.length; at += 128) {
        const n = Math.min(128, l.length - at);
        bl.set(l.subarray(at, at + n)); br.set(r.subarray(at, at + n));
        k.process(bl, br, ol, or, n);
        outL.set(ol.subarray(0, n), at); outR.set(or.subarray(0, n), at);
      }
      return { l: outL, r: outR };
    };
    window.__compare = async (kind, params, l, r) => {
      const a = await window.__renderNative(kind, params, l, r);
      const b = window.__renderKernel(kind, params, l, r);
      return { diff: Math.max(window.__maxDiff(a.l, b.l), window.__maxDiff(a.r, b.r)), peak: Math.max(window.__peak(a.l), window.__peak(a.r)),
        nativeDb: [window.__db(window.__rms(a.l)), window.__db(window.__rms(a.r))], kernelDb: [window.__db(window.__rms(b.l)), window.__db(window.__rms(b.r))] };
    };
    // Magnitude response difference between native and kernel, in dB, the worst over 20 Hz..20 kHz
    window.__responseGap = (kind, params) => {
      const a = window.__nativeResponse(kind, params), b = window.__kernelResponse(kind, params);
      let worst = 0, at = 0;
      for (let i = 0; i < a.length; i++) {
        // both floor at -120 dB; a notch's bottom is noise either side of it
        if (a[i] < -100 && b[i] < -100) continue;
        const d = Math.abs(a[i] - b[i]);
        if (d > worst) { worst = d; at = window.__freqs[i]; }
      }
      return { worst, at };
    };
    return 1;
  });

  // 1. EQ Three: responses within 0.1 dB over a sweep of gains, kills and crossovers
  {
    const presets = [
      {}, { GainLo: 6, GainMid: -12, GainHi: 3 }, { GainLo: -48, GainMid: 6, GainHi: -48 }, { 'Kill Mid': true, GainLo: 2 },
      { FreqLo: 50, FreqHi: 18000, GainLo: 6, GainHi: 6 }, { FreqLo: 5000, FreqHi: 200, GainMid: 6 }, { FreqLo: 1000, FreqHi: 1000, GainLo: -6, GainHi: 6 }
    ];
    const gaps = await page.evaluate((ps) => ps.map((p) => window.__responseGap('eq3', p)), presets);
    const worst = gaps.reduce((m, g) => (g.worst > m.worst ? g : m), { worst: 0 });
    check('EQ Three: the response matches the native biquad chain within 0.1 dB over 7 presets', worst.worst < 0.1, `worst ${worst.worst.toFixed(4)} dB at ${worst.at.toFixed(0)} Hz`);
    const r = await page.evaluate(async (p) => {
      const l = window.__noise(window.__SR, 0.5, 1), r = window.__noise(window.__SR, 0.5, 2);
      return window.__compare('eq3', p, l, r);
    }, presets[1]);
    check('EQ Three: a noise render through the kernel matches the native render', r.diff < 1e-3 && Math.abs(r.nativeDb[0] - r.kernelDb[0]) < 0.01, `max sample difference ${r.diff.toExponential(2)} of a peak ${r.peak.toFixed(3)}; levels ${r.nativeDb[0].toFixed(3)} vs ${r.kernelDb[0].toFixed(3)} dB`);
  }

  // 2. EQ Eight: every type over a sweep of frequency, gain and Q, alone on band 4
  {
    const { EQ8_TYPES } = await page.evaluate(() => ({ EQ8_TYPES: window.__dev.EQ8_TYPES }));
    const presets = [];
    for (const type of EQ8_TYPES) for (const freq of [40, 1000, 12000]) for (const gain of [-15, 0, 15]) for (const q of [0.1, 0.71, 18]) {
      const p = {};
      for (let i = 1; i <= 8; i++) p[`${i} On`] = false;
      Object.assign(p, { '4 On': true, '4 Type': type, '4 Freq': freq, '4 Gain': gain, '4 Q': q });
      presets.push(p);
    }
    presets.push({});
    presets.push({ '1 On': true, '1 Type': 'Low Cut 48', '1 Freq': 60, '2 Gain': -4, '3 Freq': 300, '3 Gain': 5, '3 Q': 2, '5 Gain': -6, '5 Q': 0.5, '6 Type': 'Notch', '6 Freq': 3000, '6 Q': 4, '7 Gain': 3, '8 On': true, '8 Type': 'High Cut 12', '8 Freq': 12000, Output: -2 });
    const gaps = await page.evaluate((ps) => ps.map((p) => window.__responseGap('eq8', p)), presets);
    let worst = { worst: 0 }, worstPreset = null;
    gaps.forEach((g, i) => { if (g.worst > worst.worst) { worst = g; worstPreset = presets[i]; } });
    check(`EQ Eight: the response matches the native biquad chain within 0.1 dB over ${presets.length} presets (every type × 3 frequencies × 3 gains × 3 Qs, the defaults, a full preset)`, worst.worst < 0.1, `worst ${worst.worst.toFixed(4)} dB at ${worst.at.toFixed(0)} Hz (${JSON.stringify(worstPreset).slice(0, 120)})`);
    const r = await page.evaluate(async (p) => {
      const l = window.__noise(window.__SR, 0.5, 3), r = window.__noise(window.__SR, 0.5, 4);
      return window.__compare('eq8', p, l, r);
    }, presets[presets.length - 1]);
    check('EQ Eight: a noise render through the kernel matches the native render on the full preset', r.diff < 1e-3 && Math.abs(r.nativeDb[0] - r.kernelDb[0]) < 0.01, `max sample difference ${r.diff.toExponential(2)} of a peak ${r.peak.toFixed(3)}; levels ${r.nativeDb[0].toFixed(3)} vs ${r.kernelDb[0].toFixed(3)} dB`);
  }

  // 3. Compressor and Glue: the same program, sample for sample within 1e-6 of the worklet
  {
    const cases = [
      ['compressor', {}], ['compressor', { Threshold: -24, Ratio: 20, Attack: 0.5, Release: 30, Knee: 0, Makeup: 6 }], ['compressor', { Threshold: -12, Ratio: 2, Attack: 50, Release: 400, Knee: 30, 'Dry/Wet': 50 }],
      ['glue', {}], ['glue', { Threshold: -20, Ratio: '10:1', Attack: '0.1 ms', Release: '0.4 s', Knee: 'Soft', 'Soft Clip': true, Range: 6, Makeup: 8 }], ['glue', { Threshold: -30, Ratio: '2:1', Attack: '30 ms', Release: '1.2 s', 'Dry/Wet': 50 }]
    ];
    for (const [kind, params] of cases) {
      const r = await page.evaluate(async (kind, params) => {
        const SR = window.__SR;
        const l = window.__concat(window.__noise(0.1 * SR, 0.9, 21), window.__sine(0.4 * SR, 220, 0.3), window.__noise(0.05 * SR, 1.0, 22), window.__sine(0.6 * SR, 110, 0.6), new Float32Array(0.3 * SR));
        const r = window.__concat(window.__noise(0.1 * SR, 0.8, 23), window.__sine(0.4 * SR, 330, 0.3, 1), window.__noise(0.05 * SR, 0.9, 24), window.__sine(0.6 * SR, 110, 0.5, 0.5), new Float32Array(0.3 * SR));
        return window.__compare(kind, params, l, r);
      }, kind, params);
      check(`${kind === 'glue' ? 'Glue' : 'Compressor'} ${JSON.stringify(params)}: within 1e-6 of the dynamics worklet, sample for sample`, r.diff < 1e-6, `max difference ${r.diff.toExponential(2)}, reduced level ${r.nativeDb[0].toFixed(2)} dB`);
    }
  }

  // 4. Panner: StereoPannerNode's law within 0.01 dB across the range
  {
    const pans = [-1, -0.8, -0.5, -0.2, 0, 0.3, 0.6, 0.9, 1];
    const rs = await page.evaluate(async (pans) => {
      const out = [];
      for (const pan of pans) {
        const l = window.__noise(4096, 0.5, 5), r = window.__noise(4096, 0.5, 6);
        const a = await window.__renderNative('panner', { Pan: pan }, l, r), b = window.__renderKernel('panner', { Pan: pan }, l, r);
        const gap = Math.max(Math.abs(window.__db(window.__rms(a.l)) - window.__db(window.__rms(b.l))), Math.abs(window.__db(window.__rms(a.r)) - window.__db(window.__rms(b.r))));
        out.push({ pan, gap: Number.isFinite(gap) ? gap : 0, diff: Math.max(window.__maxDiff(a.l, b.l), window.__maxDiff(a.r, b.r)) });
      }
      return out;
    }, pans);
    const worst = rs.reduce((m, x) => (x.gap > m.gap ? x : m));
    const worstDiff = rs.reduce((m, x) => Math.max(m, x.diff), 0);
    check('Panner: each channel\'s level matches StereoPannerNode within 0.01 dB from -1 to 1', worst.gap < 0.01, `worst ${worst.gap.toFixed(5)} dB at pan ${worst.pan}; max sample difference ${worstDiff.toExponential(2)}`);
  }

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
