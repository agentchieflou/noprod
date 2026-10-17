// #99: the coach's Write to clip: the chords you played, or a progression,
// onto the selected MIDI track as one bar per chord
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

  // A fresh browser: nothing saved. One import per call: several in one,
  // early in a page's life, can hang until the promise is collected
  await page.evaluate(async () => { window.__inputs = await import('/src/audio/inputs.ts'); return 1; });
  await page.evaluate(async () => { window.__coach = await import('/src/audio/coach.ts'); return 1; });
  await page.evaluate(async () => { window.__theory = await import(window.__fs + '/packages/theory/src/index.ts'); return 1; });
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    st.setSelectedTrackId(st.tracks.find((t) => t.type === 'midi').id);
    return 1;
  });
  await page.click('.coach-toggle');
  await page.waitForSelector('.kb-coach', { timeout: 15000 }).catch(() => {}); // the coach loads when first opened
  await ctx.sleep(200);

  const publish = (type, pitches) => page.evaluate((type, pitches) => {
    for (const pitch of pitches) window.__inputs.publishMidi({ type, pitch, velocity: type === 'on' ? 0.8 : 0, channel: 1, source: 'test-midi', time: 0 });
    return 1;
  }, type, pitches);
  const chord = async (pitches) => { await publish('on', pitches); await ctx.sleep(120); await publish('off', pitches); await ctx.sleep(120); };
  const button = () => page.evaluate(() => { const b = document.querySelector('.coach-clip'); return b && { disabled: b.disabled, title: b.title }; });
  const regions = () => page.evaluate(() => window.__dawStore.getState().regions.filter((r) => r.type === 'midi').map((r) => ({ ...r, audioBuffer: null })));
  const pick = async (value) => { await page.select('select[aria-label="Chords to write"]', value); await ctx.sleep(100); };
  const click = async () => { await page.click('.coach-clip'); await ctx.sleep(150); };
  const chordsOf = (region) => {
    const bars = [...new Set(region.notes.map((n) => n.start))].sort((a, b) => a - b);
    return bars.map((t) => region.notes.filter((n) => n.start === t).map((n) => n.pitch).sort((a, b) => a - b));
  };

  // 1. Nothing played, nothing picked: disabled, and it says why
  const empty = await button();
  check('Disabled before any chord is played, with a reason', empty && empty.disabled && /play/i.test(empty.title), JSON.stringify(empty));

  // 2. C, G, Am, F, then write what was played
  await chord([60, 64, 67]);
  await chord([55, 59, 62]);
  await chord([57, 60, 64]);
  await chord([53, 57, 60]);
  const ready = await button();
  check('Enabled once chords were played', ready && !ready.disabled, JSON.stringify(ready));
  const { bpm, beats } = await page.evaluate(() => ({ bpm: window.__dawStore.getState().bpm, beats: window.__dawStore.getState().timeSignatures[0].numerator }));
  const barLen = (60 / bpm) * beats;
  await page.evaluate(() => { window.__transport.setPosition(0.3); return 1; });
  await click();
  let all = await regions();
  const clip = all[all.length - 1];
  const groups = clip ? chordsOf(clip) : [];
  check('One MIDI region, starting on a bar and 4 bars long', all.length === 1 && Math.abs(clip.startTime / barLen - Math.round(clip.startTime / barLen)) < 1e-6
    && Math.abs(clip.duration - 4 * barLen) < 1e-6, JSON.stringify({ n: all.length, start: clip?.startTime, duration: clip?.duration }));
  check('Four chords of 3 notes plus 4 bass notes', clip && clip.notes.length === 16 && groups.length === 4 && groups.every((g) => g.length === 4), JSON.stringify(groups));
  const names = [[0, 4, 7], [7, 11, 2], [9, 0, 4], [5, 9, 0]].map((c) => c.sort((a, b) => a - b).join());
  const classes = groups.map((g) => [...new Set(g.map((p) => p % 12))].sort((a, b) => a - b).join());
  check('The chords are C, G, Am and F', classes.join('|') === names.join('|'), `${classes.join(' | ')} vs ${names.join(' | ')}`);
  const bassRoots = groups.map((g) => g[0] % 12);
  check('Each bass note is the root, below the chord', bassRoots.join() === '0,7,9,5' && groups.every((g) => g[1] - g[0] >= 12), bassRoots.join());
  const motion = await page.evaluate((groups) => groups.slice(1).map((g, i) => window.__theory.movement(groups[i].slice(1), g.slice(1))), groups);
  check('Voicings move at most 8 semitones between neighbors', motion.every((m) => m <= 8), motion.join());
  const range = groups.every((g) => g.slice(1).every((p) => p >= 48 && p <= 72));
  check('Voiced within C3–C5, held for the bar at velocity 0.8', range && clip.notes.every((n) => Math.abs(n.duration - barLen) < 1e-6 && n.velocity === 0.8), '');

  // Note ids are unique across clips
  await click();
  all = await regions();
  const ids = all.flatMap((r) => r.notes.map((n) => n.id));
  check('Two written clips share no note id', all.length === 2 && ids.length === 32 && new Set(ids).size === 32, `${all.length} clips, ${new Set(ids).size}/${ids.length} ids`);
  await page.evaluate(() => { window.__dawStore.getState().undo(); return 1; });

  // 3. One undo removes the clip
  await page.evaluate(() => { window.__dawStore.getState().undo(); return 1; });
  check('One undo removes the region', (await regions()).length === 0);

  // 4. Without the bass; then the pop progression in G major
  await page.evaluate(() => { document.querySelector('.coach-bass input').click(); return 1; });
  await click();
  const noBass = (await regions())[0];
  check('Bass off writes 4 chords of 3 notes', noBass && noBass.notes.length === 12, noBass && `${noBass.notes.length} notes`);
  await page.evaluate(() => { window.__dawStore.getState().undo(); document.querySelector('.coach-bass input').click(); window.__coach.setCoachKey({ tonic: 7, mode: 'major' }); return 1; });
  await ctx.sleep(150);
  await pick('I–V–vi–IV');
  await click();
  const pop = (await regions())[0];
  const popBass = pop ? chordsOf(pop).map((g) => g[0] % 12) : [];
  const popClasses = pop ? chordsOf(pop).map((g) => [...new Set(g.slice(1).map((p) => p % 12))].sort((a, b) => a - b).join()) : [];
  check('The pop progression in G major is G, D, Em, C', popBass.join() === '7,2,4,0'
    && popClasses.join('|') === ['7,11,2', '2,6,9', '4,7,11', '0,4,7'].map((c) => c.split(',').map(Number).sort((a, b) => a - b).join()).join('|'), `${popBass} | ${popClasses.join(' | ')}`);
  await ctx.shot('coach_clip');

  // 5. No MIDI track selected: disabled
  await page.evaluate(() => { window.__dawStore.getState().setSelectedTrackId(null); return 1; });
  await ctx.sleep(150);
  const none = await button();
  check('Disabled with no MIDI track selected, with a reason', none && none.disabled && /track/i.test(none.title), JSON.stringify(none));

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808[235]/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(results.join('\n'));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
