// #68: dictation → real Sequencer (Strudel) → library tracks
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);
  await ctx.sleep(1000); // orchestrator connection

  // (one line: the dictation box is a single-line input)
  const code = `setcpm(124/4); stack(
  s("bd*4, ~ cp ~ cp, hh*8").bank("RolandTR909"),
  note("c2 ~ c2 eb2 ~ g1 ~ bb1").s("bass"),
  note("<[c4,eb4,g4]>").s("epiano").gain(0.6),
  s("vinylcrackle")
)`;
  const before = await page.evaluate(() => window.__dawStore.getState().tracks.length);
  // Dictate through the UI
  await page.evaluate((text) => {
    const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').toLowerCase().includes('beat') || (i.placeholder || '').toLowerCase().includes('dictat') || (i.placeholder || '').toLowerCase().includes('describe'));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, code);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Dictate').click());
  let state = null;
  for (let i = 0; i < 60; i++) {
    state = await page.evaluate(() => {
      const st = window.__dawStore.getState();
      return { count: st.tracks.length, bpm: st.bpm };
    });
    if (state.count > 0 && state.count >= 3 + 0) break;
    await ctx.sleep(250);
  }
  await ctx.sleep(500);
  const made = await page.evaluate((before) => {
    const st = window.__dawStore.getState();
    const added = st.tracks.slice(before);
    return {
      bpm: st.bpm,
      tracks: added.map((t) => {
        const region = st.regions.find((r) => r.trackId === t.id);
        const lib = t.instrument.parameters.Library;
        return {
          name: t.name, kit: lib.kit?.id, sound: lib.sound?.id,
          clip: region && { file: region.file, loop: region.loopEnabled, loopEnd: +region.loopEnd.toFixed(3), duration: +region.duration.toFixed(3),
            notes: region.notes.map((n) => n.pitch), starts: region.notes.map((n) => +n.start.toFixed(3)) }
        };
      }),
      result: document.querySelector('.dictation-result')?.textContent
    };
  }, before);
  console.log(JSON.stringify(made));
  const kit = made.tracks.find((t) => t.kit);
  const bass = made.tracks.find((t) => t.sound === 'bass-pluck');
  const keys = made.tracks.find((t) => t.sound === 'piano-electric');
  check('The pattern\'s tempo becomes the project\'s', made.bpm === 124, `${made.bpm} BPM`);
  check('The drums become a 909-style library kit track', kit?.kit === 'kit-electronic' && kit.clip.notes.filter((p) => p === 36).length === 4
    && kit.clip.notes.filter((p) => p === 39).length === 2 && kit.clip.notes.filter((p) => p === 42).length === 8, JSON.stringify(kit?.clip?.notes));
  const bar = 240 / 124;
  check('Clips loop one bar, as long as four', !!kit && Math.abs(kit.clip.loopEnd - bar) < 0.01 && Math.abs(kit.clip.duration - 4 * bar) < 0.01 && kit.clip.loop === true, `bar ${bar.toFixed(3)} s`);
  check('The bass line plays the bass sound at its notes', bass && JSON.stringify(bass.clip.notes) === JSON.stringify([36, 36, 39, 31, 34]), JSON.stringify(bass?.clip?.notes));
  check('The chord plays the electric piano', keys && JSON.stringify([...keys.clip.notes].sort()) === JSON.stringify([60, 63, 67]), JSON.stringify(keys?.clip?.notes));
  check('Unknown sounds are reported, not guessed', /vinylcrackle/.test(made.result || ''), made.result);

  // It plays: arrangement playback at the master
  const peak = await page.evaluate(async () => {
    window.__transport.setPosition(0);
    window.__dawStore.getState().togglePlayback();
    const an = window.__transport.masterAnalyser;
    const buf = new Float32Array(an.fftSize);
    let p = 0;
    const end = performance.now() + 2500;
    while (performance.now() < end) { an.getFloatTimeDomainData(buf); for (const x of buf) p = Math.max(p, Math.abs(x)); await new Promise((r) => setTimeout(r, 10)); }
    window.__dawStore.getState().togglePlayback();
    return p;
  });
  check('The dictated tracks play', peak > 0.05, `peak ${peak.toFixed(3)}`);

  // A second dictation without a tempo doesn't change it
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').toLowerCase().includes('beat') || (i.placeholder || '').toLowerCase().includes('dictat') || (i.placeholder || '').toLowerCase().includes('describe'));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'note("c3 e3 g3 c4")');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Dictate').click());
  await ctx.sleep(2500);
  const second = await page.evaluate(() => { const st = window.__dawStore.getState(); const t = st.tracks.at(-1); return { bpm: st.bpm, sound: t.instrument.parameters.Library?.sound?.id, name: t.name }; });
  check('A melody with no sound name plays Strudel\'s triangle, tempo unchanged', second.sound === 'lead-triangle' && second.bpm === 124, JSON.stringify(second));

  await ctx.shot('dictation');
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
