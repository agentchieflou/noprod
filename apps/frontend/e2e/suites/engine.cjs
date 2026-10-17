// #159 step 2: the engine worklet and the streaming scheduler. Notes posted,
// voices started and onsets heard are counted against each other on the
// spike's project (32 library tracks playing eighth notes at 120 BPM, then
// 96), realtime and offline; late and dropped events are counted and
// reported; edits during playback are diffs; an hour-long project keeps a
// bounded queue; and an offline render is the same twice.
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);

  // Modules first, one import per call (several in one can hang)
  await page.evaluate(async () => { window.__sound = await import(window.__fs + '/packages/sound/src/index.ts'); return 1; });
  await page.evaluate(async () => { window.__lib = await import('/src/audio/library.ts'); return 1; });
  await page.evaluate(async () => { window.__tr = await import('/src/audio/transport.ts'); return 1; });
  await page.evaluate(async () => { window.__sched = await import('/src/audio/scheduler.ts'); return 1; });
  await page.evaluate(async () => { window.__voices = await import('/src/audio/engineVoices.ts'); return 1; });
  await page.evaluate(async () => { window.__node = await import('/src/audio/engineNode.ts'); return 1; });
  await page.evaluate(async () => { await window.__tr.engineReady(); return 1; });

  // Helpers in the page: project builders, a stats reader, and an onset
  // probe on the master (a worklet counting rises out of silence)
  await page.evaluate(async () => {
    const SOUNDS = ['piano-electric', 'marimba', 'bass-finger', 'pad-warm'];
    const SCALE = [0, 2, 4, 7, 9, 12, 9, 7];
    const store = () => window.__dawStore.getState();
    // Eighth notes at 120 BPM (4 a second) for `seconds`, each track's scale shifted
    const eighths = (t, seconds, duration) => {
      const notes = [];
      for (let i = 0; i < seconds * 4; i++) notes.push({ id: `n${i}`, pitch: 60 + SCALE[(i + t) % 8], start: i * 0.25, duration, velocity: 0.8 });
      return notes;
    };
    window.__clear = () => {
      const st = store();
      for (const r of st.regions) store().removeRegion(r.id);
      for (const t of st.tracks) if (t.id.startsWith('e2e-') || t.name.startsWith('E2E')) store().removeTrack(t.id);
    };
    // The spike's project: `tracks` library instruments, 4 sounds in turn
    window.__library = (tracks, seconds) => {
      window.__clear();
      store().setBpm(120);
      const ids = [];
      for (let t = 0; t < tracks; t++) {
        store().addMidiTrackWithInstrument(window.__lib.createLibraryInstrument(window.__sound.findSound(SOUNDS[t % SOUNDS.length])), `E2E ${t}`);
        const id = store().tracks.at(-1).id;
        ids.push(id);
        store().addMidiRegion(id, 0, seconds, eighths(t, seconds, 0.12));
      }
      store().setSelectedTrackId(null);
      return ids;
    };
    // The same grid on the built-in synth, with silence between notes: onsets are exact
    window.__synths = (tracks, seconds) => {
      window.__clear();
      store().setBpm(120);
      const ids = [];
      for (let t = 0; t < tracks; t++) {
        store().addMidiTrackWithInstrument({ name: 'Synth', type: 'instrument', parameters: { Waveform: 'sine', Attack: 0.001, Decay: 0.05, Sustain: 0.8, Release: 0.005, Gain: 0.5 } }, `E2E ${t}`);
        const id = store().tracks.at(-1).id;
        ids.push(id);
        store().addMidiRegion(id, 0, seconds, eighths(t, seconds, 0.1));
      }
      store().setSelectedTrackId(null);
      return ids;
    };
    window.__stats = () => window.__tr.engineStats();
    // What the engine and the scheduler did since `from`
    const since = window.__since = (from, to) => {
      const d = {};
      for (const k in to.engine) if (typeof to.engine[k] === 'number') d[k] = to.engine[k] - from.engine[k];
      d.posted = to.scheduler.posted - from.scheduler.posted;   // notes that reached the engine
      d.takenBack = to.scheduler.retracted - from.scheduler.retracted; // by the scheduler's diffs
      d.spans = to.scheduler.spans;
      d.reported = to.dropped;
      return d;
    };
    // Plays from 0 for `seconds`, watching the master's peak, and stops.
    // Counts are from the start of this playback: every track's output is
    // claimed first, as play() does, since growing them remakes the engine.
    window.__play = async (seconds) => {
      const an = window.__transport.masterAnalyser, buf = new Float32Array(an.fftSize);
      const ctxA = window.__transport.audioContext;
      // the page draws the project first (its long tasks would stall the loop below)
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
      window.__transport.setPosition(0);
      window.__tr.getScheduler().claim();
      await window.__probe.reset();
      const zero = await window.__stats();
      const c0 = ctxA.currentTime;
      const t0 = performance.now();
      store().togglePlayback();
      const startMs = performance.now() - t0;
      let peak = 0;
      const end = performance.now() + seconds * 1000;
      while (performance.now() < end) {
        an.getFloatTimeDomainData(buf);
        for (const x of buf) peak = Math.max(peak, Math.abs(x));
        await new Promise((r) => setTimeout(r, 20));
      }
      const before = since(zero, await window.__stats());
      const elapsed = ctxA.currentTime - c0; // what actually played, if the loop overran
      store().togglePlayback();
      await new Promise((r) => setTimeout(r, 150));
      const after = since(zero, await window.__stats());
      const times = await window.__probe.read();
      return { peak, startMs, elapsed, before, after, onsets: times.length, times };
    };
    // Onsets per channel of a rendered buffer: a sample that isn't zero after 10 ms of zeros
    window.__onsets = (buffer, channel, sampleRate) => {
      const x = buffer.getChannelData(channel);
      const gap = Math.round(sampleRate * 0.01);
      const out = [];
      let zeros = gap;
      for (let i = 0; i < x.length; i++) {
        if (x[i] === 0) { zeros++; continue; }
        if (zeros >= gap) out.push(i);
        zeros = 0;
      }
      return out;
    };
    // The probe: counts rises out of 30 ms of near-silence at the master
    const ctxA = window.__transport.audioContext;
    const code = `class Probe extends AudioWorkletProcessor {
      constructor() { super(); this.times = []; this.quiet = sampleRate; this.t0 = 0; this.port.onmessage = (e) => { if (e.data === 'reset') { this.times = []; this.quiet = sampleRate; this.t0 = currentFrame; } this.port.postMessage(this.times); }; }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch) return true;
        let peak = 0;
        for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
        if (peak > 0.002) { if (this.quiet >= sampleRate * 0.03) this.times.push(+((currentFrame - this.t0) / sampleRate).toFixed(3)); this.quiet = 0; }
        else this.quiet += ch.length;
        return true;
      }
    }
    registerProcessor('e2e-probe', Probe);`;
    await ctxA.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
    const probe = new AudioWorkletNode(ctxA, 'e2e-probe', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const sink = ctxA.createGain(); sink.gain.value = 0;
    window.__transport.masterAnalyser.connect(probe); probe.connect(sink); sink.connect(ctxA.destination);
    const ask = (m) => new Promise((r) => { probe.port.onmessage = (e) => r(e.data); probe.port.postMessage(m); });
    window.__probe = { reset: () => ask('reset'), read: () => ask('read') };
    await ctxA.resume();
    return 1;
  });

  const sampleRate = await page.evaluate(() => window.__transport.audioContext.sampleRate);

  // 1. Offline, 32 library tracks for 8 s, a stereo pair per track: every
  // note posted started, nothing late or dropped, and every track sounds.
  // This also renders the project's 32 notes into the cache.
  const off32 = await page.evaluate(async (sampleRate) => {
    const ids = window.__library(32, 8);
    let report = null;
    const t0 = performance.now();
    const stems = await window.__sched.renderStems({ state: window.__dawStore.getState(), trackIds: ids, from: 0, to: 8, sampleRate, report: (r) => { report = r; } });
    const ms = performance.now() - t0;
    const silent = [];
    stems.forEach((stem, t) => {
      const x = stem.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < x.length; i += 7) peak = Math.max(peak, Math.abs(x[i]));
      if (peak < 0.01) silent.push(t);
    });
    window.__off32 = stems;
    return { ms: Math.round(ms), stems: stems.length, silent, ...report.engine, counts: report.counts };
  }, sampleRate);
  const expected32 = 32 * 8 * 4;
  check('Offline, 32 library tracks: every note posted started, none late or dropped',
    off32.counts.posted === expected32 && off32.started === expected32 && off32.late === 0 && off32.dropped === 0 && off32.retracted === 0,
    `${off32.counts.posted} posted, ${off32.started} started, ${off32.late} late, ${off32.dropped} dropped; ${off32.stems} stems in ${off32.ms} ms (${(8000 / off32.ms).toFixed(1)}× realtime)`);
  check('…and every track sounds in its own stem', off32.silent.length === 0, off32.silent.length ? `silent: ${off32.silent.join(', ')}` : '32 stems');

  // 2. The same render again is bit for bit the same (seeded, a window at a time)
  const same = await page.evaluate(async (sampleRate) => {
    const ids = window.__dawStore.getState().tracks.filter((t) => t.name.startsWith('E2E')).map((t) => t.id);
    const b = await window.__sched.renderStems({ state: window.__dawStore.getState(), trackIds: ids, from: 0, to: 8, sampleRate });
    const a = window.__off32;
    let differ = 0, samples = 0;
    a.forEach((stem, t) => {
      for (let c = 0; c < 2; c++) {
        const x = stem.getChannelData(c), y = b[t].getChannelData(c);
        samples += x.length;
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) differ++;
      }
    });
    return { differ, samples };
  }, sampleRate);
  check('Rendered twice, the project is the same to the sample', same.differ === 0, `${same.differ} of ${same.samples} samples differ`);

  // 3. Offline, 32 synth tracks: onsets found where the notes are, to the sample
  const onsets = await page.evaluate(async (sampleRate) => {
    const ids = window.__synths(32, 4);
    let report = null;
    const stems = await window.__sched.renderStems({ state: window.__dawStore.getState(), trackIds: ids, from: 0, to: 4, sampleRate, report: (r) => { report = r; } });
    let found = 0, worst = 0, off = [];
    for (let t = 0; t < ids.length; t++) {
      const on = window.__onsets(stems[t], 0, sampleRate);
      found += on.length;
      on.forEach((frame, i) => { const d = Math.abs(frame - Math.round(i * 0.25 * sampleRate)); worst = Math.max(worst, d); if (d > 2) off.push(`${t}:${i}@${frame}`); });
    }
    return { found, worst, off: off.slice(0, 5), expected: ids.length * 16, started: report.engine.started, late: report.engine.late };
  }, sampleRate);
  check('Offline, 32 synth tracks: an onset per note, within 2 samples of its time',
    onsets.found === onsets.expected && onsets.started === onsets.expected && onsets.off.length === 0,
    `${onsets.found} of ${onsets.expected} onsets, ${onsets.started} started, worst ${onsets.worst} samples off${onsets.off.length ? `: ${onsets.off.join(' ')}` : ''}`);

  // 4. Realtime, 32 synth tracks for 3 s: posted = started + retracted, no
  // drops, and the probe hears the 4 onsets a second
  const rt = await page.evaluate(async () => { window.__synths(32, 8); return window.__play(3); });
  const closed = (s) => s.after.posted === s.after.started + s.after.retracted + s.after.dropped;
  const sum = (s) => `${s.after.posted} posted = ${s.after.started} started + ${s.after.retracted} retracted + ${s.after.dropped} dropped; ${s.after.late} late; ${s.elapsed.toFixed(2)} s played`;
  // notes a second the grid plays, over what played before the stop (less the 50 ms lead), give or take a beat
  const atLeast = (s, perSecond) => s.before.started >= perSecond * (s.elapsed - 0.3);
  const beats = (s) => Math.ceil((s.elapsed - 0.05) * 4);
  const pace = (s) => `${s.after.blocksLate} blocks late, ${s.after.dropouts} dropouts, worst ${s.after.worst} ms, load ${(s.after.busy / (s.after.seconds * 1000) * 100).toFixed(0)}%`;
  check('Realtime, 32 synth tracks: every note posted started or was taken back at the stop',
    closed(rt) && rt.after.dropped === 0 && rt.after.late === 0 && atLeast(rt, 32 * 4),
    `${sum(rt)}; peak ${rt.peak.toFixed(2)}; play took ${rt.startMs.toFixed(0)} ms`);
  check('…and the master rises out of silence 4 times a second', Math.abs(rt.onsets - beats(rt)) <= 1 && rt.peak > 0.05, `${rt.onsets} onsets in ${rt.elapsed.toFixed(2)} s at ${rt.times.join(' ')}`);

  // 5. Realtime, 32 library tracks (the cache is warm from the offline render)
  const rtl = await page.evaluate(async () => { window.__library(32, 8); return window.__play(3); });
  check('Realtime, 32 library tracks: nothing dropped, every note accounted for',
    closed(rtl) && rtl.after.dropped === 0 && rtl.after.late === 0 && atLeast(rtl, 32 * 4) && rtl.peak > 0.05,
    `${sum(rtl)}; ${pace(rtl)}; peak ${rtl.peak.toFixed(2)}`);

  // 6. 96 tracks, realtime and offline
  const rt96 = await page.evaluate(async () => { window.__library(96, 8); return window.__play(3); });
  check('Realtime, 96 library tracks: nothing dropped, every note accounted for',
    closed(rt96) && rt96.after.dropped === 0 && rt96.after.late === 0 && atLeast(rt96, 96 * 4) && rt96.peak > 0.05,
    `${sum(rt96)}; ${pace(rt96)}`);
  const off96 = await page.evaluate(async (sampleRate) => {
    const ids = window.__dawStore.getState().tracks.filter((t) => t.name.startsWith('E2E')).map((t) => t.id);
    let report = null;
    const t0 = performance.now();
    await window.__sched.renderArrangement({ state: window.__dawStore.getState(), trackIds: ids, from: 0, to: 8, sampleRate, report: (r) => { report = r; } });
    return { ms: Math.round(performance.now() - t0), ...report.engine, counts: report.counts };
  }, sampleRate);
  check('Offline, 96 library tracks: every note posted started, none late or dropped',
    off96.counts.posted === 96 * 32 && off96.started === 96 * 32 && off96.late === 0 && off96.dropped === 0,
    `${off96.counts.posted} posted, ${off96.started} started, ${off96.late} late, ${off96.dropped} dropped; 8 s in ${off96.ms} ms (${(8000 / off96.ms).toFixed(1)}× realtime)`);

  // 7. Looping: a one-second loop plays its notes again each pass, without
  // a seam (spans open ahead and close at the boundary)
  const loop = await page.evaluate(async () => {
    window.__synths(2, 1);
    const st = window.__dawStore.getState();
    st.setLoopRegion(0, 1);
    if (!st.isLoopEnabled) st.toggleLoop();
    const r = await window.__play(3.1);
    window.__dawStore.getState().toggleLoop();
    return r;
  });
  check('A one-second loop plays its 4 notes again each pass', Math.abs(loop.onsets - beats(loop)) <= 1 && closed(loop) && loop.after.dropped === 0 && loop.after.late === 0 && Math.abs(loop.before.started - 2 * beats(loop)) <= 2,
    `${loop.onsets} onsets in ${loop.elapsed.toFixed(2)} s at ${loop.times.join(' ')}; ${sum(loop)}; ${loop.before.spans} spans kept`);

  // 8. Edits during playback are diffs: a clip added while playing posts
  // just its notes in the posted window; removing it takes those back
  const edits = await page.evaluate(async () => {
    window.__synths(4, 8);
    const store = () => window.__dawStore.getState();
    window.__transport.setPosition(0);
    // the added track's output too, so the engine isn't remade mid-play
    for (let i = 0; i < 4; i++) window.__tr.getEngine().output(`e2e-spare-${i}`);
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    const zero = await window.__stats();
    store().togglePlayback();
    await new Promise((r) => setTimeout(r, 500));
    const a = await window.__stats();
    store().addMidiTrackWithInstrument({ name: 'Synth', type: 'instrument', parameters: { Waveform: 'sine', Attack: 0.001, Decay: 0.05, Sustain: 0.8, Release: 0.005, Gain: 0.5 } }, 'E2E added');
    const id = store().tracks.at(-1).id;
    const pos = window.__transport.getPosition();
    // 20 notes every 50 ms from 0.2 s ahead: the first 16 or so inside the second already posted
    const notes = []; for (let i = 0; i < 20; i++) notes.push({ id: `a${i}`, pitch: 72, start: 0.2 + i * 0.05, duration: 0.02, velocity: 0.8 });
    store().addMidiRegion(id, pos, 2, notes);
    const regionId = store().regions.at(-1).id;
    // what the scheduler holds for the new clip (its keys name the region)
    const held = () => window.__tr.getScheduler().spans.reduce((n, s) => n + [...s.notes.keys()].filter((k) => k.includes(`:${regionId}:`)).length, 0);
    await new Promise((r) => setTimeout(r, 100));
    const b = await window.__stats();
    const heldAfterAdd = held();
    const others = (b.scheduler.posted - a.scheduler.posted) - heldAfterAdd; // the 4 tracks' notes posted meanwhile
    store().removeRegion(regionId);
    await new Promise((r) => setTimeout(r, 100));
    const c = await window.__stats();
    const heldAfterRemove = held();
    store().togglePlayback();
    await new Promise((r) => setTimeout(r, 150));
    const e = window.__since(zero, await window.__stats());
    return {
      heldAfterAdd, others, heldAfterRemove,
      takenBack: c.scheduler.retracted - b.scheduler.retracted,
      engineTakenBack: c.engine.retracted - b.engine.retracted,
      final: e, closed: e.posted === e.started + e.retracted + e.dropped
    };
  });
  check('A clip added while playing posts just its notes in the posted window', edits.heldAfterAdd >= 16 && edits.heldAfterAdd <= 20 && edits.others >= 0 && edits.others <= 16 * 0.5,
    `${edits.heldAfterAdd} of its 20 notes posted (the second ahead), ${edits.others} of the other tracks' meanwhile`);
  check('…and removing it takes back the ones that had not started', edits.heldAfterRemove === edits.heldAfterAdd - edits.takenBack && edits.takenBack >= 1 && edits.takenBack <= edits.heldAfterAdd && edits.engineTakenBack <= edits.takenBack && edits.engineTakenBack >= edits.takenBack - 2 && edits.closed,
    `${edits.takenBack} retracted by the scheduler, ${edits.engineTakenBack} never started in the engine, ${edits.heldAfterRemove} had played; ${sum({ after: edits.final, elapsed: edits.final.seconds })}`);

  // 9. An hour-long project: what the engine holds stays a window's worth.
  // A note every 4 s on each track: the page draws every note of a clip as
  // an element and redraws them as the playhead moves, so a denser hour
  // stalls the page (and, in this container, the audio thread with it).
  const hour = await page.evaluate(async () => {
    window.__clear();
    const store = () => window.__dawStore.getState();
    store().setBpm(120);
    for (let t = 0; t < 8; t++) {
      store().addMidiTrackWithInstrument({ name: 'Synth', type: 'instrument', parameters: { Waveform: 'sine', Attack: 0.001, Decay: 0.05, Sustain: 0.8, Release: 0.005, Gain: 0.3 } }, `E2E ${t}`);
      const notes = []; for (let i = 0; i < 900; i++) notes.push({ id: `n${i}`, pitch: 60 + (i % 8), start: 4 * i, duration: 0.1, velocity: 0.8 });
      store().addMidiRegion(store().tracks.at(-1).id, 0, 3600, notes);
    }
    window.__transport.setPosition(1800);
    // the page draws the clips and scrolls to the playhead first (perf.cjs waits the same way)
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    window.__tr.getScheduler().claim();
    const zero = await window.__stats();
    const t0 = performance.now();
    store().togglePlayback();
    const startMs = performance.now() - t0;
    let worst = { pending: 0, sounding: 0 };
    const end = performance.now() + 4500;
    while (performance.now() < end) {
      const s = await window.__stats();
      worst.pending = Math.max(worst.pending, s.engine.pending);
      worst.sounding = Math.max(worst.sounding, s.engine.sounding);
      await new Promise((r) => setTimeout(r, 100));
    }
    const s = await window.__stats();
    store().togglePlayback();
    await new Promise((r) => setTimeout(r, 150));
    return { startMs: Math.round(startMs), ...worst, spans: s.scheduler.spans, started: s.engine.started - zero.engine.started, dropped: s.engine.dropped - zero.engine.dropped, late: s.engine.late - zero.engine.late };
  });
  check('An hour-long project queues about a second of notes, not the hour', hour.pending <= 8 && hour.sounding <= 8 && hour.spans <= 2 && hour.dropped === 0 && hour.late === 0 && hour.started >= 8,
    `at most ${hour.pending} pending and ${hour.sounding} sounding of ${8 * 900} notes; ${hour.spans} span; ${hour.started} started from the middle, ${hour.late} late, ${hour.dropped} dropped; play took ${hour.startMs} ms`);

  // 10. Late and dropped events are counted and reported: a note a little
  // late plays now and counts as late; one past the budget is dropped and
  // reaches the transport's count
  const late = await page.evaluate(async () => {
    const engine = window.__tr.getEngine();
    const ctx = engine.ctx;
    const strip = engine.output('e2e-late');
    const before = await window.__stats();
    const voice = { kind: 'synth', wave: 'sine', hz: 440, attack: 0.001, decay: 0.05, sustain: 0.8, release: 0.005, peak: 0.2 };
    engine.notes([{ key: 'e2e:late', strip, at: ctx.currentTime - 0.01, voice, duration: 0.05 }]);
    engine.notes([{ key: 'e2e:dropped', strip, at: ctx.currentTime - 0.2, voice, duration: 0.05 }]);
    await new Promise((r) => setTimeout(r, 100));
    const after = await window.__stats();
    return { late: after.engine.late - before.engine.late, dropped: after.engine.dropped - before.engine.dropped, started: after.engine.started - before.engine.started, reported: after.dropped - before.dropped };
  });
  check('A note 10 ms late plays and counts as late; one 200 ms late is dropped and reported', late.late === 1 && late.started === 1 && late.dropped === 1 && late.reported === 1,
    `${late.late} late, ${late.started} started, ${late.dropped} dropped, ${late.reported} reported to the transport`);

  // 11. Buffers stay while events play them, however small the budget. An
  // engine of its own on an offline context, with a 1 MB budget: six 1 s
  // stereo clips (0.35 MB each) posted together all start, a buffer
  // forgotten under a posted clip or note still plays (the event pins it),
  // and only with the pin bypassed is the event dropped, with a reason.
  await page.evaluate((sampleRate) => {
    window.__render = async ({ clips, notes = 0, budget = 1 << 20, forget = null, force = false }) => {
      const ctxO = new OfflineAudioContext(2, sampleRate * 1.5, sampleRate);
      await window.__node.loadEngine(ctxO);
      const reported = [];
      const engine = new window.__node.Engine(ctxO, { connect: (n, o) => n.connect(ctxO.destination, o), budget, onDropped: (key, lateBy, reason) => reported.push(`${key}:${reason}`) }, 8);
      engine.span({ id: 1, ctxStart: 0, posStart: 0, posEnd: 1.5 });
      const tone = (i) => {
        const b = ctxO.createBuffer(2, sampleRate, sampleRate);
        const l = b.getChannelData(0);
        for (let k = 0; k < l.length; k++) l[k] = 0.3 * Math.sin((k * 2 * Math.PI * (220 + 55 * i)) / sampleRate);
        b.copyToChannel(l, 1);
        return b;
      };
      const ids = [];
      const events = [];
      for (let i = 0; i < clips; i++) {
        const buf = engine.bufferId(tone(i));
        ids.push(buf);
        events.push({ key: `c${i}`, strip: engine.output(`clip-${i}`), span: 1, pos: 0.1, endPos: 1.1, buf, offset: 0, rate: 1, loop: null, gain: 1, grains: null });
      }
      engine.clips(events);
      for (let i = 0; i < notes; i++) {
        const buf = engine.bufferId(tone(clips + i));
        ids.push(buf);
        engine.notes([{ key: `n${i}`, strip: engine.output(`note-${i}`), span: 1, pos: 0.1, voice: { kind: 'buffer', buf, rate: 1, level: 1 }, duration: 0.5 }]);
      }
      if (forget) engine.forget(forget(ids), force);
      await engine.sync();
      const out = await ctxO.startRendering();
      const stats = await engine.stats();
      engine.dispose();
      const x = out.getChannelData(0);
      let peak = 0;
      for (let k = 0; k < x.length; k += 3) peak = Math.max(peak, Math.abs(x[k]));
      return { started: stats.started, dropped: stats.dropped, retracted: stats.retracted, reported, peak: +peak.toFixed(3) };
    };
    return 1;
  }, sampleRate);
  const past = await page.evaluate(() => window.__render({ clips: 6 }));
  check('Six clips past a 1 MB budget, posted together, all start', past.started === 6 && past.dropped === 0 && past.peak > 0.1,
    `${past.started} started, ${past.dropped} dropped (${past.reported.join(' ')}), peak ${past.peak}`);
  const pinnedClip = await page.evaluate(() => window.__render({ clips: 1, forget: (ids) => ids }));
  check('A buffer forgotten under a posted clip still plays: the clip pins it', pinnedClip.started === 1 && pinnedClip.dropped === 0 && pinnedClip.peak > 0.1,
    `${pinnedClip.started} started, ${pinnedClip.dropped} dropped, peak ${pinnedClip.peak}`);
  const pinnedNote = await page.evaluate(() => window.__render({ clips: 0, notes: 1, forget: (ids) => ids }));
  check('…and so does a note', pinnedNote.started === 1 && pinnedNote.dropped === 0 && pinnedNote.peak > 0.1,
    `${pinnedNote.started} started, ${pinnedNote.dropped} dropped, peak ${pinnedNote.peak}`);
  const forced = await page.evaluate(() => window.__render({ clips: 1, notes: 1, forget: (ids) => ids, force: true }));
  check('With the pin bypassed, the clip and the note are dropped and reported, with the reason',
    forced.started === 0 && forced.dropped === 2 && forced.reported.length === 2 && forced.reported.every((r) => r.endsWith(':buffer')) && forced.peak === 0,
    `${forced.started} started, ${forced.dropped} dropped, reported: ${forced.reported.join(' ')}; peak ${forced.peak}`);

  // 12. A clip restarted under its own key while its last player fades (a
  // gain change mid-play restarts it; the scheduler keys restarts apart,
  // but the worklet must take the same key too): the old player's end must
  // not take the new one's record, a later note on another strip still
  // sounds, and the render runs to its last block.
  const restarted = await page.evaluate(async (sampleRate) => {
    const seconds = 2;
    const ctxO = new OfflineAudioContext(2, sampleRate * seconds, sampleRate);
    await window.__node.loadEngine(ctxO);
    let errors = 0;
    const engine = new window.__node.Engine(ctxO, { connect: (n, o) => n.connect(ctxO.destination, o), onError: () => { errors++; } }, 4);
    engine.span({ id: 1, ctxStart: 0, posStart: 0, posEnd: seconds });
    const b = ctxO.createBuffer(2, sampleRate, sampleRate);
    const l = b.getChannelData(0);
    for (let k = 0; k < l.length; k++) l[k] = 0.3 * Math.sin((k * 2 * Math.PI * 220) / sampleRate);
    b.copyToChannel(l, 1);
    const buf = engine.bufferId(b);
    const strip = engine.output('clip');
    const clip = { key: 'c', strip, span: 1, pos: 0.05, endPos: 0.8, buf, offset: 0, rate: 1, loop: null, gain: 1, grains: null };
    engine.clips([clip]);
    // at 0.3 s: the same clip again, quieter, under the same key
    engine.retract(['c'], 0.3);
    engine.clips([{ ...clip, pos: 0.3, offset: 0.25, gain: 0.5 }]);
    engine.notes([{ key: 'n', strip: engine.output('note'), span: 1, pos: 1.5, voice: { kind: 'synth', wave: 'sine', hz: 440, attack: 0.001, decay: 0.05, sustain: 0.8, release: 0.005, peak: 0.3 }, duration: 0.2 }]);
    await engine.sync();
    const out = await ctxO.startRendering();
    const stats = await Promise.race([engine.stats(), new Promise((r) => setTimeout(() => r(null), 3000))]);
    engine.dispose();
    const x = out.getChannelData(0);
    let late = 0;
    for (let k = Math.round(1.5 * sampleRate); k < Math.round(1.7 * sampleRate); k += 3) late = Math.max(late, Math.abs(x[k]));
    return { blocks: stats?.blocks ?? null, started: stats?.started ?? null, expected: Math.ceil((sampleRate * seconds) / 128), late: +late.toFixed(3), errors };
  }, sampleRate);
  check('A clip restarted under its own key mid-play: the engine runs on, and a later note still sounds',
    restarted.blocks === restarted.expected && restarted.started === 3 && restarted.late > 0.1 && restarted.errors === 0,
    `${restarted.blocks} of ${restarted.expected} blocks processed, ${restarted.started} started, peak after 1.5 s ${restarted.late}, ${restarted.errors} processor errors`);

  // 13. Session clips play on spans of their own: a scene of two looping
  // clips, launched with a follow action to the next scene after a bar,
  // posts its notes pass after pass, the follow action retracts what the
  // first scene had posted ahead, and the stop takes back the rest.
  await page.evaluate(async () => { window.__session = await import('/src/audio/session.ts'); return 1; });
  const session = await page.evaluate(async () => {
    const store = () => window.__dawStore.getState();
    window.__clear();
    store().setBpm(120);
    store().setLaunchQuantization('none');
    const ids = [];
    for (let t = 0; t < 2; t++) {
      store().addMidiTrackWithInstrument({ name: 'Synth', type: 'instrument', parameters: { Waveform: 'sine', Attack: 0.001, Decay: 0.05, Sustain: 0.8, Release: 0.005, Gain: 0.4 } }, `E2E ${t}`);
      ids.push(store().tracks.at(-1).id);
    }
    // a one-bar clip (2 s) of eighth notes, looping; scene 0 follows to scene 1 after a bar
    const clip = (pitch) => ({ type: 'midi', file: 'c', audioBuffer: null, duration: 2, loopStart: 0, loopEnd: 2, notes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, pitch: pitch + (i % 4), start: i * 0.25, duration: 0.1, velocity: 0.8 })) });
    for (const id of ids) { store().setSessionClip(id, 0, clip(60)); store().setSessionClip(id, 1, clip(72)); }
    const scenes = store().scenes.map((sc, i) => (i === 0 ? { ...sc, follow: { enabled: true, action: 'next', bars: 1 } } : sc));
    window.__dawStore.setState({ scenes });
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    window.__tr.getScheduler().claim();
    await window.__probe.reset();
    const zero = await window.__stats();
    const ctxA = window.__transport.audioContext;
    const c0 = ctxA.currentTime;
    window.__session.launchScene(0);
    // scene 0 for a bar (2 s), then scene 1 for about a bar and a half
    await new Promise((r) => setTimeout(r, 3600));
    const snap = window.__session.getSessionSnapshot();
    const mid = window.__since(zero, await window.__stats());
    const elapsed = ctxA.currentTime - c0;
    window.__session.stopAll();
    await new Promise((r) => setTimeout(r, 500));
    const after = window.__since(zero, await window.__stats());
    const sessionSpans = (await window.__stats()).scheduler.sessionSpans;
    store().togglePlayback();
    await new Promise((r) => setTimeout(r, 200));
    const times = await window.__probe.read();
    store().setLaunchQuantization('1 bar');
    return { snap, mid, after, elapsed, onsets: times.length, sessionSpans };
  });
  const sessionBeats = Math.ceil((session.elapsed - 0.05) * 4);
  check('A launched scene plays its clips pass after pass, and its follow action moves to the next scene',
    session.snap.playingScene === 1 && session.snap.playing && Object.keys(session.snap.playing).length === 2 && Math.abs(session.onsets - sessionBeats) <= 1,
    `scene ${session.snap.playingScene} playing on ${Object.keys(session.snap.playing || {}).length} tracks after ${session.elapsed.toFixed(2)} s; ${session.onsets} onsets (${sessionBeats} beats)`);
  check('…its notes are counted: posted = started + retracted, the follow action and the stop taking back what was ahead',
    session.after.posted === session.after.started + session.after.retracted + session.after.dropped && session.after.dropped === 0 && session.mid.retracted >= 2 && session.after.retracted > session.mid.retracted && session.after.started >= 2 * sessionBeats - 4,
    `${session.after.posted} posted = ${session.after.started} started + ${session.after.retracted} retracted (${session.mid.retracted} at the follow action) + ${session.after.dropped} dropped; ${session.after.late} late; ${session.sessionSpans} session spans left`);

  // 14. A key let go before its render arrives still plays, for as long as
  // it was held (WebKit's first press on a just-added instrument): a cold
  // pitched note, pressed for 100 ms
  const cold = await page.evaluate(async () => {
    const store = () => window.__dawStore.getState();
    window.__clear();
    store().addMidiTrackWithInstrument(window.__lib.createLibraryInstrument(window.__sound.findSound('piano-grand')), 'E2E cold');
    const t = store().tracks.at(-1);
    const ctxA = window.__transport.audioContext;
    const synth = await import('/src/audio/synth.ts');
    const zero = await window.__stats();
    const before = window.__lib.libraryStats().waits.length;
    const t0 = performance.now();
    const v = synth.startVoice(ctxA, window.__transport.getStripInput(t.id), t.instrument.parameters, 31, ctxA.currentTime, 0.8);
    await new Promise((r) => setTimeout(r, 100));
    v.release(ctxA.currentTime);
    const an = window.__transport.masterAnalyser, buf = new Float32Array(an.fftSize);
    let peak = 0, heardAt = null;
    const end = performance.now() + 2500;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      if (heardAt === null && peak > 0.01) heardAt = Math.round(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 10));
    }
    const s = window.__since(zero, await window.__stats());
    const waits = window.__lib.libraryStats().waits.slice(before).map(Math.round);
    return { peak: +peak.toFixed(3), heardAt, started: s.started, dropped: s.dropped, waits };
  });
  check('A key let go before its cold render arrives still plays, late, for as long as it was held',
    cold.started === 1 && cold.dropped === 0 && cold.peak > 0.01 && cold.heardAt !== null && cold.waits.length === 1 && cold.heardAt >= cold.waits[0] - 50,
    `render took ${cold.waits.join('/')} ms, heard at ${cold.heardAt} ms, peak ${cold.peak}; ${cold.started} started, ${cold.dropped} dropped`);

  // 15. The engine failing twice in a row stops playback instead of starting
  // over into the same failure (once, it is remade and playback starts over)
  const crash = await page.evaluate(async () => {
    const store = () => window.__dawStore.getState();
    window.__synths(2, 8);
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    window.__transport.setPosition(0);
    store().togglePlayback();
    await new Promise((r) => setTimeout(r, 400));
    const zero = await window.__stats();
    window.__tr.getEngine().crash();
    await new Promise((r) => setTimeout(r, 400));
    const once = { playing: store().isPlaying, ...(await window.__stats()) };
    const an = window.__transport.masterAnalyser, buf = new Float32Array(an.fftSize);
    let peak = 0;
    const end = performance.now() + 600;
    while (performance.now() < end) { an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); await new Promise((r) => setTimeout(r, 10)); }
    window.__tr.getEngine().crash();
    await new Promise((r) => setTimeout(r, 400));
    const twice = { playing: store().isPlaying, ...(await window.__stats()) };
    if (store().isPlaying) store().togglePlayback();
    await new Promise((r) => setTimeout(r, 200));
    return { once: { playing: once.playing, restarts: once.restarts - zero.restarts, halts: once.halts - zero.halts, peak: +peak.toFixed(3) }, twice: { playing: twice.playing, restarts: twice.restarts - zero.restarts, halts: twice.halts - zero.halts } };
  });
  check('The engine failing once is remade and playback starts over', crash.once.playing && crash.once.restarts === 1 && crash.once.halts === 0 && crash.once.peak > 0.05,
    `${crash.once.restarts} restart, still playing, peak ${crash.once.peak} after`);
  check('…failing again within 2 s stops playback instead', !crash.twice.playing && crash.twice.restarts === 2 && crash.twice.halts === 1,
    `${crash.twice.restarts} restarts, ${crash.twice.halts} halt, playing ${crash.twice.playing}`);

  await ctx.shot('engine');
  // the two failures above were asked for: their reports are expected
  const errors = ctx.logs.filter((l) => /^\[(pageerror|error)\]/.test(l) && !l.includes('ws://localhost:8080') && !l.includes('The audio engine failed and was restarted'));
  check('No page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
};
