// #137: no sound rendering on the main thread, workers that can't stall,
// and caches that keep to their memory budgets
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);

  // Modules first, one import per call (several in one can hang)
  await page.evaluate(async () => { window.__sound = await import(window.__fs + '/packages/sound/src/index.ts'); return 1; });
  await page.evaluate(async () => { window.__lib = await import('/src/audio/library.ts'); return 1; });
  await page.evaluate(async () => { window.__synth = await import('/src/audio/synth.ts'); return 1; });
  await page.evaluate(async () => { window.__transportModule = await import('/src/audio/transport.ts'); return 1; });
  await page.evaluate(async () => { window.__memory = await import('/src/audio/memory.ts'); return 1; });
  await page.evaluate(async () => { window.__designing = await import('/src/audio/designing.ts'); return 1; });

  // 1. A project of library instruments plays from a cold cache: drums, bass
  // and keys, four bars at 120 BPM, started before the warmup could render
  // anything. Long tasks are watched while it plays.
  const cold = await page.evaluate(async () => {
    const { findSound, KITS } = window.__sound;
    const lib = window.__lib;
    const st = window.__dawStore.getState();
    st.setBpm(120);
    const add = (instrument, name) => { window.__dawStore.getState().addMidiTrackWithInstrument(instrument, name); return window.__dawStore.getState().tracks.at(-1).id; };
    const drums = add(lib.createLibraryKit(KITS.find((k) => k.id === 'kit-acoustic')), 'Drums');
    const bass = add(lib.createLibraryInstrument(findSound('bass-pluck')), 'Bass');
    const keys = add(lib.createLibraryInstrument(findSound('piano-grand')), 'Keys');
    const bar = 2;
    const notes = { drums: [], bass: [], keys: [] };
    for (let b = 0; b < 4; b++) {
      for (let i = 0; i < 8; i++) {
        notes.drums.push({ id: `h${b}-${i}`, pitch: 42, start: b * bar + i * 0.25, duration: 0.1, velocity: 0.6 });
        if (i % 4 === 0) notes.drums.push({ id: `k${b}-${i}`, pitch: 36, start: b * bar + i * 0.25, duration: 0.1, velocity: 0.9 });
        if (i % 4 === 2) notes.drums.push({ id: `s${b}-${i}`, pitch: 38, start: b * bar + i * 0.25, duration: 0.1, velocity: 0.8 });
      }
      [36, 36, 43, 41].forEach((pitch, i) => notes.bass.push({ id: `b${b}-${i}`, pitch, start: b * bar + i * 0.5, duration: 0.45, velocity: 0.8 }));
      [[60, 64, 67], [65, 69, 72]].forEach((chord, i) => chord.forEach((pitch) => notes.keys.push({ id: `c${b}-${i}-${pitch}`, pitch, start: b * bar + i, duration: 0.9, velocity: 0.7 })));
    }
    const s2 = window.__dawStore.getState();
    s2.addMidiRegion(drums, 0, 4 * bar, notes.drums);
    s2.addMidiRegion(bass, 0, 4 * bar, notes.bass);
    s2.addMidiRegion(keys, 0, 4 * bar, notes.keys);
    s2.setSelectedTrackId(null);
    // the page draws the new tracks and clips first (well before the warmup
    // starts, 300 ms after the change)
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));

    const before = lib.libraryStats();
    const longTasks = [];
    const t0 = performance.now();
    const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push({ ms: Math.round(e.duration), at: Math.round(e.startTime - t0) }); });
    observer.observe({ type: 'longtask' });
    window.__transport.setPosition(0);
    // Starting schedules all four bars, asking the workers for every note;
    // timed on its own, since the task it runs in also redraws the page for
    // playing (in React's development build that alone runs 50-100 ms; in a
    // production build the whole of this playback has no long task)
    const tStart = performance.now();
    window.__dawStore.getState().togglePlayback();
    const startMs = performance.now() - tStart;
    await new Promise((r) => setTimeout(r, 30));
    const start = window.__transportModule.getTransportSnapshot().segments[0]?.ctxStart ?? window.__transport.audioContext.currentTime;
    // the master's peak while it plays
    const an = window.__transport.masterAnalyser, buf = new Float32Array(an.fftSize);
    let peak = 0;
    const end = performance.now() + 4 * bar * 1000 + 300;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      await new Promise((r) => setTimeout(r, 20));
    }
    window.__dawStore.getState().togglePlayback();
    observer.disconnect();
    const after = lib.libraryStats();
    const waits = after.waits.slice(before.waits.length).sort((a, b) => a - b);
    const q = (p) => (waits.length ? Math.round(waits[Math.min(waits.length - 1, Math.floor(p * waits.length))]) : 0);
    return {
      notes: notes.drums.length + notes.bass.length + notes.keys.length,
      missed: after.missed - before.missed, late: after.late - before.late, skipped: after.skipped - before.skipped,
      skippedAfterBar1: after.skippedAt.slice(before.skippedAt.length).filter((t) => t >= start + bar).length,
      startMs: +startMs.toFixed(1), startTask: longTasks.find((t) => t.at <= tStart - t0)?.ms ?? 0,
      longTasks: longTasks.filter((t) => t.at > tStart - t0), peak: +peak.toFixed(3), workers: after.workers,
      waits: { n: waits.length, p50: q(0.5), p95: q(0.95), max: q(1) }
    };
  });
  check('A cold project plays (audible at the master)', cold.peak > 0.05 && cold.missed > 0, `peak ${cold.peak}; ${cold.missed} of ${cold.notes} notes not ready when scheduled`);
  check('No main-thread task over 50 ms while it plays from a cold cache', cold.startMs < 50 && cold.longTasks.length === 0,
    `starting took ${cold.startMs} ms (its task with the redraw: ${cold.startTask} ms); later long tasks: ${JSON.stringify(cold.longTasks)}`);
  check('No skipped notes after the first bar', cold.skippedAfterBar1 === 0,
    `${cold.skipped} skipped, ${cold.late} late (within ${await page.evaluate(() => window.__lib.LATE_BUDGET * 1000)} ms) in the first bar; renders arrived in ${JSON.stringify(cold.waits)} ms on ${cold.workers} workers`);
  await ctx.shot('perf_cold_project');

  // 2. A live key that isn't rendered yet doesn't block: the first key of a
  // sound plays when its render arrives; a key near one that's rendered
  // plays at once, repitched (the fast path)
  const live = await page.evaluate(async () => {
    const { findSound } = window.__sound;
    const { startVoice } = window.__synth;
    const lib = window.__lib, ac = window.__transport.audioContext;
    const params = { Kit: 'library', Gain: 0.8, Tune: 0, Library: { sound: findSound('kalimba') } };
    const an = window.__transport.masterAnalyser, buf = new Float32Array(an.fftSize);
    const heardWithin = async (ms) => {
      const end = performance.now() + ms, t0 = performance.now();
      while (performance.now() < end) {
        an.getFloatTimeDomainData(buf);
        if (buf.some((x) => Math.abs(x) > 0.02)) return Math.round(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 5));
      }
      return null;
    };
    const press = (pitch) => {
      const t0 = performance.now();
      const v = startVoice(ac, window.__transport.getStripInput('master'), params, pitch, ac.currentTime, 0.9);
      return { v, ms: +(performance.now() - t0).toFixed(2) };
    };
    const before = lib.libraryStats();
    const first = press(60);
    const firstHeard = await heardWithin(3000);
    first.v.release(ac.currentTime);
    await new Promise((r) => setTimeout(r, 1500));
    const near = press(63);
    const nearHeard = await heardWithin(1000);
    near.v.release(ac.currentTime);
    const after = lib.libraryStats();
    await new Promise((r) => setTimeout(r, 1000));
    return { first: first.ms, firstHeard, near: near.ms, nearHeard, fastPath: after.fastPath - before.fastPath };
  });
  check('A live key that misses the cache returns at once and sounds when rendered', live.first < 5 && live.firstHeard !== null, `${live.first} ms to press, heard after ${live.firstHeard} ms`);
  check('A key near a rendered one takes the fast path (heard at once)', live.near < 5 && live.fastPath === 1 && live.nearHeard !== null && live.nearHeard < 100,
    `${live.near} ms to press, heard after ${live.nearHeard} ms, fast path ${live.fastPath}`);

  // 3. A render that throws fails on its own: later renders still arrive,
  // on the note workers and the Sound Designer's
  const errors = await page.evaluate(async () => {
    const lib = window.__lib, { findSound } = window.__sound, ac = window.__transport.audioContext;
    const designing = window.__designing;
    const broken = { id: 'broken', name: 'Broken', category: 'fx', pitched: false, length: 1, layers: null };
    const sink = ac.createGain();
    const before = lib.libraryStats().failed;
    window.__synth.triggerNote(ac, sink, { Kit: 'library', Gain: 1, Library: { sound: broken } }, 60, ac.currentTime + 0.1, 0.2, 1);
    const timeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms))]);
    const later = await timeout(lib.soundAsBuffer(findSound('marimba')), 10000).then((b) => b.duration > 0, (e) => e.message);
    const designed = await timeout(designing.renderSound(broken, { note: 60 }), 10000).then(() => 'resolved', (e) => (/no answer/.test(e.message) ? e.message : 'rejected'));
    const after = await timeout(designing.renderSound(findSound('marimba'), { note: 60 }), 10000).then((s) => s.left.length > 0, (e) => e.message);
    return { failed: lib.libraryStats().failed - before, later, designed, after };
  });
  check('A note render that throws is counted and later renders still arrive', errors.failed === 1 && errors.later === true, JSON.stringify(errors));
  check('The Sound Designer’s render of a broken sound rejects, and the next one renders', errors.designed === 'rejected' && errors.after === true, JSON.stringify(errors));

  // 4. The pool itself: a worker that crashes or hangs is replaced, its
  // request rejected, and what was queued behind it still runs
  const pool = await page.evaluate(async () => {
    const { WorkerPool } = await import('/src/audio/workerPool.ts');
    const code = `onmessage = (e) => {
      if (e.data.hang) return;
      if (e.data.crash) { setTimeout(() => { throw new Error('crashed'); }); return; }
      postMessage({ id: e.data.id, value: e.data.value * 2 });
    };`;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const p = new WorkerPool(() => new Worker(url), 1);
    const outcome = (promise) => promise.then((d) => d.value, (e) => `rejected: ${e.message}`);
    const hung = outcome(p.run({ hang: true }, { timeout: 300 }));
    const queued = outcome(p.run({ value: 2 }));
    const crashed = outcome(p.run({ crash: true }));
    const next = outcome(p.run({ value: 21 }));
    return { hung: await hung, queued: await queued, crashed: await crashed, next: await next, replaced: p.replaced, workers: p.workers };
  });
  check('A hung worker is replaced after its time limit; the queue moves on', /rejected/.test(pool.hung) && pool.queued === 4, JSON.stringify(pool));
  check('A crashed worker is replaced; the next request is answered', /rejected/.test(pool.crashed) && pool.next === 42 && pool.replaced === 2 && pool.workers === 1, JSON.stringify(pool));

  // 5. Auditioning 500 different notes: the render cache stays within its
  // budget (sized from the device's memory) and evicts the oldest
  const audition = await page.evaluate(async () => {
    const { findSound } = window.__sound;
    const { startVoice } = window.__synth;
    const lib = window.__lib, ac = window.__transport.audioContext;
    const sink = ac.createGain(); // not connected: silent
    const sounds = ['pluck-synth', 'lead-chip', 'bass-acid', 'marimba', 'kalimba'].map(findSound);
    let worst = 0, notes = 0;
    const sample = setInterval(() => { const c = lib.libraryStats().cache; worst = Math.max(worst, c.bytes / c.budget); }, 20);
    const t0 = performance.now();
    for (const sound of sounds) {
      const params = { Kit: 'library', Gain: 0.8, Tune: 0, Library: { sound } };
      for (let pitch = 28; pitch < 128; pitch++, notes++) startVoice(ac, sink, params, pitch, ac.currentTime, 0.8).release(ac.currentTime + 0.05);
      await new Promise((r) => setTimeout(r, 0));
    }
    while (lib.libraryStats().rendering > 0 && performance.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 50));
    clearInterval(sample);
    const { cache } = lib.libraryStats();
    worst = Math.max(worst, cache.bytes / cache.budget);
    return { notes, seconds: +((performance.now() - t0) / 1000).toFixed(1), cached: cache.notes, mb: +(cache.bytes / 2 ** 20).toFixed(1), budget: +(cache.budget / 2 ** 20).toFixed(1), worst: +worst.toFixed(3), deviceMemory: navigator.deviceMemory ?? null, left: lib.libraryStats().rendering };
  });
  check('Rendered notes stay within their budget while auditioning 500 notes', audition.worst <= 1 && audition.left === 0 && audition.cached < audition.notes + 40,
    `${audition.notes} notes in ${audition.seconds} s; ${audition.cached} kept, ${audition.mb} of ${audition.budget} MB (worst ${audition.worst} of budget; deviceMemory ${audition.deviceMemory})`);

  // 6. Undo history: audio that only past snapshots hold stays within its
  // budget, and the last edit can still be undone
  await page.evaluate(async () => { window.__history = await import('/src/store/historyBudget.ts'); return 1; });
  const history = await page.evaluate(async () => {
    const { historyBytes } = window.__history;
    const { budgets } = window.__memory;
    const ac = window.__transport.audioContext;
    const s = () => window.__dawStore.getState();
    s().addTrack('audio');
    const track = s().tracks.at(-1).id;
    const seconds = 20; // 20 s stereo: ~7.3 MB at 48 kHz
    for (let i = 0; i < 16; i++) {
      const audioBuffer = ac.createBuffer(2, Math.round(seconds * ac.sampleRate), ac.sampleRate);
      s().addRegion({ trackId: track, file: `take ${i}`, audioBuffer, startTime: 0, duration: seconds });
      s().removeRegion(s().regions.at(-1).id);
    }
    const snapshot = Object.fromEntries(['tracks', 'regions', 'sessionClips', 'returns', 'masterPlugins'].map((k) => [k, s()[k]]));
    const bytes = historyBytes(s().past, snapshot);
    s().undo();
    const restored = s().regions.some((r) => r.file === 'take 15');
    return { mb: +(bytes / 2 ** 20).toFixed(1), budget: +(budgets().history / 2 ** 20).toFixed(1), snapshots: s().past.length, restored };
  });
  check('Undo history keeps deleted audio within its budget; the last delete still undoes', history.mb <= history.budget && history.restored,
    `${history.mb} of ${history.budget} MB in ${history.snapshots} snapshots; undo restored the last take: ${history.restored}`);

  // 7. Sample previews decode into a cache with its own budget
  const decoded = await page.evaluate(async () => (await import('/src/browser/library.ts')).decodedCache());
  const budgets = await page.evaluate(() => window.__memory.budgets());
  check('Every cache has a budget from the device’s memory', decoded.budget === budgets.decoded && budgets.renders > 0 && budgets.history > 0,
    `renders ${budgets.renders / 2 ** 20} MB, decoded previews ${budgets.decoded / 2 ** 20} MB, undo audio ${budgets.history / 2 ** 20} MB`);

  const pageErrors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', pageErrors.length === 0, pageErrors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
