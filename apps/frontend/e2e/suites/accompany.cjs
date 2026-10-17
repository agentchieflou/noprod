// #109: the coach's band, a bass and keys part that follow the chords played
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };

  // A fresh browser: nothing saved, an empty project at 120 BPM
  // (one import per call: several in one can hang)
  await page.evaluate(async () => {
    window.__inputs = await import('/src/audio/inputs.ts');
    window.__kb = await import('/src/audio/computerKeyboard.ts');
    return 1;
  });
  await page.evaluate(async () => {
    window.__accompany = await import('/src/audio/accompany.ts');
    return 1;
  });
  await page.evaluate(async () => {
    const st = window.__dawStore.getState();
    st.setSelectedTrackId(st.tracks.find((t) => t.type === 'midi').id);
    window.__kb.setKeyboardEnabled(false);
    return 1;
  });

  const C = [60, 64, 67], F = [65, 69, 72];
  const state = () => page.evaluate(() => {
    const st = window.__dawStore.getState();
    const track = (name) => st.tracks.find((t) => t.name === name);
    return {
      playing: st.isPlaying,
      on: window.__accompany.getAccompanyState().on,
      running: window.__transport.accompany.running(),
      sounding: window.__transport.accompany.sounding(),
      bass: track('Band Bass')?.id ?? null,
      keys: track('Band Keys')?.id ?? null,
      bassSound: track('Band Bass')?.instrument?.parameters?.Library?.sound?.id,
      keysSound: track('Band Keys')?.instrument?.parameters?.Library?.sound?.id,
      selected: st.selectedTrackId,
      button: document.querySelector('.coach-accompany')?.classList.contains('active') ?? null
    };
  });
  // the master's level (dBFS RMS) over `ms`
  const level = (ms = 300) => page.evaluate(async (ms) => {
    const an = window.__transport.masterAnalyser;
    const buf = new Float32Array(an.fftSize);
    let sum = 0, n = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) { sum += x * x; n++; }
      await new Promise((r) => setTimeout(r, 20));
    }
    return 10 * Math.log10(sum / n + 1e-20);
  }, ms);
  // Lets go of `release` and puts down `notes` `ms` before a bar line (one
  // at least 0.4 s off), on the audio clock
  const beforeBar = (ms, notes, release = []) => page.evaluate(async (ms, notes, release) => {
    const t = window.__transport, ac = t.audioContext;
    const bar = (4 * 60) / window.__dawStore.getState().bpm;
    const pos = t.getPosition(), now = ac.currentTime;
    let next = Math.ceil((pos + 1e-6) / bar) * bar;
    if (next - pos < ms / 1000 + 0.4) next += bar;
    const barTime = now + (next - pos), fireAt = barTime - ms / 1000;
    while (ac.currentTime < fireAt - 0.012) await new Promise((r) => setTimeout(r, Math.max(1, (fireAt - ac.currentTime) * 1000 - 10)));
    while (ac.currentTime < fireAt) { /* the last few milliseconds */ }
    const time = ac.currentTime;
    for (const pitch of release) window.__inputs.publishMidi({ type: 'off', pitch, velocity: 0, channel: 1, source: 'test-midi', time });
    for (const pitch of notes) window.__inputs.publishMidi({ type: 'on', pitch, velocity: 0.8, channel: 1, source: 'test-midi', time });
    return { barTime, before: barTime - time };
  }, ms, notes, release);
  const release = (notes) => page.evaluate((notes) => {
    for (const pitch of notes) window.__inputs.publishMidi({ type: 'off', pitch, velocity: 0, channel: 1, source: 'test-midi', time: window.__transport.audioContext.currentTime });
    return 1;
  }, notes);
  const played = () => page.evaluate(() => window.__transport.accompany.played());

  // 1. Accompany sits in the coach's Chords mode
  await page.click('.coach-toggle');
  await page.waitForSelector('.kb-coach', { timeout: 15000 }).catch(() => {}); // the coach loads when first opened
  await ctx.sleep(200);
  const inChords = await page.evaluate(() => !!document.querySelector('.coach-accompany'));
  await page.evaluate(() => [...document.querySelectorAll('.coach-modes button')].find((b) => b.textContent === 'Melody').click());
  await ctx.sleep(100);
  const inMelody = await page.evaluate(() => !!document.querySelector('.coach-accompany'));
  await page.evaluate(() => [...document.querySelectorAll('.coach-modes button')].find((b) => b.textContent === 'Chords').click());
  await ctx.sleep(100);
  const styles = await page.evaluate(() => [...document.querySelectorAll('.coach-accompany + select option')].map((o) => o.value));
  check('Accompany is in Chords mode, with its styles', inChords && !inMelody && styles.length >= 3, JSON.stringify({ inChords, inMelody, styles }));

  // 2. Turning it on makes the band's tracks and starts the transport; the band waits for a chord
  const before = await state();
  await page.click('.coach-accompany');
  await ctx.sleep(600);
  const on = await state();
  check('Accompany starts the transport and makes a bass and a keys track',
    !before.playing && on.playing && on.on && on.running && on.button && on.bass && on.keys && on.bassSound === 'bass-finger' && on.keysSound === 'piano-electric',
    JSON.stringify(on));
  check('The track you play stays selected', on.selected === before.selected, `${before.selected} → ${on.selected}`);
  const waiting = await played();
  const quiet = await level(200);
  check('Before the first chord the band is silent', waiting.length === 0 && quiet < -70, `${waiting.length} notes, ${quiet.toFixed(1)} dBFS`);
  // Its sounds render in the background meanwhile
  const ready = await page.evaluate(async () => {
    const start = performance.now();
    while (window.__transport.accompany.warming() > 0 && performance.now() - start < 30000) await new Promise((r) => setTimeout(r, 50));
    return { ms: performance.now() - start, left: window.__transport.accompany.warming() };
  });
  check('The band\'s sounds are ready within seconds', ready.left === 0 && ready.ms < 15000, `${(ready.ms / 1000).toFixed(1)} s more`);

  // 3. C held, then F put down a 16th before the next bar: bass C, then F, from the bar lines
  const c = await beforeBar(120, C);
  const f = await beforeBar(120, F, C);
  await ctx.sleep(1200);
  const both = await level();
  await page.evaluate((id) => { window.__dawStore.getState().toggleMuteTrack(id); return 1; }, on.bass);
  await ctx.sleep(250);
  const keysAlone = await level();
  await page.evaluate((id) => { window.__dawStore.getState().toggleMuteTrack(id); return 1; }, on.bass);
  await ctx.shot('accompany_playing');
  const all = await played();
  const notes = all.filter((n) => n.end > n.start);
  // C's notes for that bar were committed before F came, then taken back
  const takenBack = all.filter((n) => n.end === n.start && Math.abs(n.start - f.barTime) < 0.003);
  const bass = notes.filter((n) => n.part === 'bass');
  const keys = notes.filter((n) => n.part === 'keys');
  const near = (a, b) => Math.abs(a - b) < 0.003;
  const firstC = bass[0], firstF = bass.find((n) => n.start >= f.barTime - 0.003);
  const cBar = bass.filter((n) => n.start < f.barTime - 0.003);
  check('Holding C, the bass plays C from the bar line',
    firstC && near(firstC.start, c.barTime) && cBar.length >= 4 && cBar.every((n) => n.pitch % 12 === 0 && n.track === on.bass),
    `${c.before.toFixed(3)} s before; ${cBar.map((n) => `${n.pitch}@${(n.start - c.barTime).toFixed(3)}`).join(' ')}`);
  check('F put down a 16th before the next bar: the bass plays F from that bar line',
    firstF && near(firstF.start, f.barTime) && firstF.pitch % 12 === 5 && bass.filter((n) => n.start >= f.barTime - 0.003).every((n) => n.pitch % 12 === 5)
      && takenBack.some((n) => n.part === 'bass' && n.pitch % 12 === 0),
    `${f.before.toFixed(3)} s before; first after: ${firstF && `${firstF.pitch}@${(firstF.start - f.barTime).toFixed(3)}`}; taken back: ${takenBack.map((n) => n.pitch)}`);
  const keysAt = (time) => keys.filter((n) => near(n.start, time)).map((n) => n.pitch % 12).sort((a, b) => a - b).join();
  check('The keys comp C, then F, on the keys track', keysAt(c.barTime) === '0,4,7' && keysAt(f.barTime) === '0,5,9' && keys.every((n) => n.track === on.keys),
    `${keysAt(c.barTime)} | ${keysAt(f.barTime)}`);
  check('The comping is audible on the master, with the bass muted too', both > -45 && keysAlone > -50, `${both.toFixed(1)} dBFS, keys alone ${keysAlone.toFixed(1)} dBFS`);
  const overlapping = notes.filter((a) => notes.some((b) => a !== b && a.track === b.track && a.pitch === b.pitch && a.start < b.end - 1e-4 && b.start < a.end - 1e-4));
  check('No note doubled', overlapping.length === 0, JSON.stringify(overlapping.slice(0, 2)));

  // 4. Stopping the transport stops the band, mid-note
  const stopAt = await page.evaluate(() => { window.__dawStore.getState().togglePlayback(); return window.__transport.audioContext.currentTime; });
  await ctx.sleep(150);
  const stopped = await state();
  await ctx.sleep(600);
  const after = await level();
  // (a note taken back before it sounded ends where it starts)
  const late = (await played()).filter((n) => n.end > n.start && n.end > stopAt + 0.02);
  check('Stopping the transport stops the band and every note', !stopped.playing && !stopped.running && stopped.sounding === 0 && after < -70 && late.length === 0,
    `${after.toFixed(1)} dBFS, ${late.length} notes past the stop`);

  // 5. Playing again, it goes on with the last chord; closing the coach stops it
  await page.evaluate(() => { window.__dawStore.getState().togglePlayback(); return 1; });
  await ctx.sleep(1500);
  const again = await state();
  const resumed = await level();
  await page.click('.coach-toggle');
  await ctx.sleep(150);
  const closed = await state();
  await ctx.sleep(600);
  const closedLevel = await level();
  check('Played again, the band goes on with the last chord', again.running && again.on && resumed > -45, `${resumed.toFixed(1)} dBFS`);
  check('Closing the coach mid-note stops the band (the transport plays on)', closed.playing && !closed.on && !closed.running && closedLevel < -70,
    `${JSON.stringify(closed)}, ${closedLevel.toFixed(1)} dBFS`);
  await release(F);
  await page.evaluate(() => { const st = window.__dawStore.getState(); if (st.isPlaying) st.togglePlayback(); return 1; });

  // 6. No stuck notes, and no errors
  await ctx.sleep(800);
  const silent = await level();
  check('No stuck notes', silent < -80, `${silent.toFixed(1)} dBFS`);
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808\d/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
