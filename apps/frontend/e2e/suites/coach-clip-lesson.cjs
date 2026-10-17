// #101: "From the selected clip" in the coach's Lessons mode
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

  await page.evaluate(() => { localStorage.removeItem('noprod-coach'); return 1; });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    window.__inputs = await import('/src/audio/inputs.ts');
    window.__coach = await import('/src/audio/coach.ts');
    return 1;
  });
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    st.setSelectedTrackId(st.tracks.find((t) => t.type === 'midi').id);
    window.__coach.setCoachOpen(true);
    window.__coach.setCoachMode('lesson');
    return 1;
  });
  await ctx.sleep(300);

  const makeClip = (notes) => page.evaluate((notes) => {
    const st = window.__dawStore.getState();
    const track = st.tracks.find((t) => t.type === 'midi');
    st.addMidiRegion(track.id, 0, 8, notes.map(([pitch, start, duration], i) => ({ id: `t${i}`, pitch, start, duration, velocity: 0.8 })));
    return 1;
  }, notes);
  const option = () => page.evaluate(() => {
    const o = [...document.querySelectorAll('.coach-select option')].find((o) => o.textContent === 'From the selected clip');
    return o ? { disabled: o.disabled, value: o.value } : null;
  });
  // Like a user: picking the value the select already holds fires no change event
  // (puppeteer's page.select fires one anyway)
  const pick = (value) => page.evaluate((value) => {
    const select = document.querySelector('.coach-select');
    if (select.value === value) return 1;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 1;
  }, value);
  const progress = () => page.evaluate(() => document.querySelector('.coach-progress')?.textContent ?? '');
  const publish = (type, pitches) => page.evaluate((type, pitches) => {
    for (const pitch of pitches) window.__inputs.publishMidi({ type, pitch, velocity: type === 'on' ? 0.8 : 0, channel: 1, source: 'test-midi', time: 0 });
    return 1;
  }, type, pitches);
  const play = async (pitches) => { await publish('on', pitches); await ctx.sleep(80); await publish('off', pitches); await ctx.sleep(80); };

  // 1. Nothing selected: the entry is there, but off
  await page.evaluate(() => { window.__dawStore.getState().setSelectedRegionId(null); return 1; });
  await ctx.sleep(100);
  const none = await option();
  check('The entry is disabled with no clip selected', none?.disabled === true, JSON.stringify(none));

  // 2. C–G–Am–F block chords
  const chords = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]];
  await makeClip(chords.flatMap((c, i) => c.map((p) => [p, i * 2, 2])));
  await ctx.sleep(150);
  const some = await option();
  check('The entry is enabled once a MIDI clip is selected', some?.disabled === false, JSON.stringify(some));
  await pick('clip-pick');
  await page.evaluate(() => { document.activeElement?.blur?.(); return 1; });
  await ctx.sleep(200);
  const p1 = await progress();
  check('Picking it gives "Step 1 / 4 C (I)"', p1.startsWith('Step 1 / 4') && p1.includes('C (I)'), p1);
  await ctx.shot('coach_clip_lesson_step1');
  const labels = [];
  for (const c of chords) {
    await play(c);
    labels.push(await progress());
  }
  const done = await page.evaluate(() => !!document.querySelector('.coach-readout.done'));
  check('Playing the chords advances through the steps to done', done && labels[0].startsWith('Step 2 / 4') && labels[1].includes('Am (vi)') && labels[3].includes('Done!'), labels.join(' | '));

  // 3. A melody clip
  await makeClip([[60, 0, 0.5], [64, 0.5, 0.5], [67, 1, 0.5], [64, 1.5, 0.5]]);
  await ctx.sleep(150);
  await pick('clip-pick');   // a second time, straight from the first clip's lesson
  await page.evaluate(() => { document.activeElement?.blur?.(); return 1; });
  await ctx.sleep(200);
  const m1 = await progress();
  const held = await page.evaluate(() => document.querySelector('.coach-select').value);
  await play([60]);
  const m2 = await progress();
  check('Picking it again takes the newly selected clip: melody steps', held === 'clip' && m1.startsWith('Step 1 / 4') && m1.includes('C4') && m2.startsWith('Step 2 / 4') && m2.includes('E4'), `${m1} → ${m2}`);

  // 4. Not saved across a reload
  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    window.__coach = await import('/src/audio/coach.ts');
    return 1;
  });
  await page.evaluate(() => {
    window.__coach.setCoachOpen(true);
    window.__coach.setCoachMode('lesson');
    return 1;
  });
  await ctx.sleep(200);
  const after = await page.evaluate(() => document.querySelector('.coach-select')?.value ?? null);
  check('After a reload the picker shows no lesson', (after === '' || after === null), String(after));

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808\d/.test(l)); // no orchestrator here
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(results.join('\n'));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
