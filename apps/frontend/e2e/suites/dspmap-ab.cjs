// #103: the DSP Map's A/B, Revert and Save to My Sounds
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  const track = () => page.evaluate(() => {
    const st = window.__dawStore.getState();
    const t = st.tracks.find((x) => x.id === st.selectedTrackId);
    return { id: t.id, sound: t.instrument.parameters.Library.sound, past: st.past.length };
  });
  const same = (a, b) => page.evaluate(async (a, b) => {
    const { render } = await import(window.__fs + '/packages/sound/src/index.ts');
    const x = render(a, { sampleRate: 22050, gate: 0.5, normalize: false }).left, y = render(b, { sampleRate: 22050, gate: 0.5, normalize: false }).left;
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }, a, b);
  const played = () => page.evaluate(async () => (await import('/src/components/dspMapState.ts')).lastPlayed);
  await page.mouse.click(5, 5);

  // A violin on a track, the DSP Map open on it
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'DSP Map').click());
  await ctx.sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Strings')).click());
  await ctx.sleep(150);
  await page.evaluate(() => [...document.querySelectorAll('.browser-item')].find((e) => e.querySelector('.browser-item-label')?.textContent === 'Violin').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await ctx.sleep(500);
  const t0 = await track();
  const col = `track:${t0.id}`;
  const head = `.dsp-map-head[data-col="${col}"]`;
  const count = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

  check('Unedited: no Revert, no A/B', (await count(`${head} .dsp-revert`)) === 0 && (await count(`${head} .dsp-ab`)) === 0);

  // 1. The body off: Revert and A/B appear
  await page.click(`.dsp-map-cell[data-col="${col}"] .dsp-block[data-id="radiator:0"] .dsp-power`);
  await ctx.sleep(200);
  const t1 = await track();
  check('Body off: Revert shows and A/B is available', (await count(`${head} .dsp-revert`)) === 1 && (await count(`${head} .dsp-ab`)) === 1 && !(await same(t0.sound, t1.sound)));

  // 2. Play B (the edit), then A (the original)
  await page.click(`${head} .designer-play`);
  await ctx.sleep(300);
  const b = await played();
  await page.click(`${head} [data-ab="A"]`);
  await page.click(`${head} .designer-play`);
  await ctx.sleep(300);
  const a = await played();
  check('Play renders the edit on B and the original on A', b.key === col && (await same(b.recipe, t1.sound)) && (await same(a.recipe, t0.sound)) && !(await same(a.recipe, b.recipe)));

  // 3. Revert: one store edit, undone by undo
  await page.click(`${head} .dsp-revert`);
  await ctx.sleep(200);
  const t2 = await track();
  check('Revert restores the original in one edit', JSON.stringify(t2.sound) === JSON.stringify(t0.sound) && t2.past === t1.past + 1 && (await count(`${head} .dsp-revert`)) === 0, `past ${t1.past} → ${t2.past}`);
  await page.evaluate(() => window.__dawStore.getState().undo());
  await ctx.sleep(200);
  const t3 = await track();
  check('Undo brings the edit back', JSON.stringify(t3.sound) === JSON.stringify(t1.sound) && (await count(`${head} .dsp-revert`)) === 1);

  // 4. Save: a my- sound in My Sounds, the track plays the saved copy
  await page.click(`${head} .dsp-save`);
  await ctx.sleep(500);
  const saved = await page.evaluate(async () => {
    const st = window.__dawStore.getState();
    const now = st.tracks.find((t) => t.id === st.selectedTrackId).instrument.parameters.Library.sound;
    const { getUserSounds } = await import('/src/audio/userSounds.ts');
    const db = await new Promise((resolve) => {
      const req = indexedDB.open('noprod-sounds', 1);
      req.onsuccess = () => { const g = req.result.transaction('sounds').objectStore('sounds').getAll(); g.onsuccess = () => resolve(g.result.map((x) => x.id)); };
    });
    return { id: now.id, mine: getUserSounds().map((x) => x.id), db, group: [...document.querySelectorAll('.browser-folder')].some((e) => e.textContent.trim().startsWith('My Sounds')), hint: document.querySelector('.dsp-map-toolbar .designer-hint').textContent };
  });
  check('Save puts a my- sound in My Sounds (Browser and IndexedDB), and the track plays it',
    saved.id.startsWith('my-') && saved.mine.includes(saved.id) && saved.db.includes(saved.id) && saved.group && /Saved/.test(saved.hint), JSON.stringify(saved));

  // 5. A scratch column holds the saved copy
  await page.evaluate(() => {
    const el = document.querySelector('.dsp-map-picker');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'sound:flute-modeled');
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await ctx.sleep(200);
  const scol = await page.evaluate(() => [...document.querySelectorAll('.dsp-map-head')].at(-1).dataset.col);
  await page.click(`.dsp-map-head[data-col="${scol}"] .dsp-save`);
  await ctx.sleep(500);
  const scratch = await page.evaluate(async (c) => {
    const { savedColumns } = await import('/src/components/dspMapState.ts');
    return savedColumns().find((x) => x.key === c)?.recipe.id;
  }, scol);
  check('A scratch column now holds the saved copy', /^my-/.test(scratch ?? ''), String(scratch));

  // 6. A track edited while the map is closed still shows its change when the map opens
  const tabs = () => page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent !== 'DSP Map').click());
  await tabs();
  await ctx.sleep(200);
  await page.evaluate(async () => {
    const { findSound } = await import(window.__fs + '/packages/sound/src/index.ts');
    const { createLibraryInstrument } = await import('/src/audio/library.ts');
    window.__dawStore.getState().addMidiTrackWithInstrument(createLibraryInstrument(findSound('trumpet-modeled')), 'Trumpet');
  });
  await ctx.sleep(300);
  const t4 = await track();
  await page.evaluate(async () => {
    const { setBlockOn, chainOf } = await import(window.__fs + '/packages/sound/src/index.ts');
    const st = window.__dawStore.getState();
    const t = st.tracks.find((x) => x.id === st.selectedTrackId);
    const lib = t.instrument.parameters.Library;
    const id = chainOf(lib.sound).layers[0].blocks.find((b) => b.switchable && b.on).id;
    st.updateInstrumentParameter(t.id, 'Library', { ...lib, sound: setBlockOn(lib.sound, 0, id, false) });
  });
  await ctx.sleep(200);
  const t5 = await track();
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'DSP Map').click());
  await ctx.sleep(400);
  const head2 = `.dsp-map-head[data-col="track:${t4.id}"]`;
  const edited = !(await same(t4.sound, t5.sound));
  await page.click(`${head2} [data-ab="A"]`);
  await page.click(`${head2} .designer-play`);
  await ctx.sleep(300);
  const a2 = await played();
  check('Edited on another tab: opening the map shows Revert, and A plays the pre-edit recipe',
    edited && (await count(`${head2} .dsp-revert`)) === 1 && (await same(a2.recipe, t4.sound)), `edited ${edited}`);

  // 7. A kit's pads each have their own original: switching pads isn't a change
  await page.evaluate(async () => {
    const { KITS } = await import(window.__fs + '/packages/sound/src/index.ts');
    const { createLibraryKit } = await import('/src/audio/library.ts');
    window.__dawStore.getState().addMidiTrackWithInstrument(createLibraryKit(KITS[0]), 'Kit');
  });
  await ctx.sleep(400);
  const kcol = await page.evaluate(() => window.__dawStore.getState().selectedTrackId);
  const khead = `.dsp-map-head[data-col="track:${kcol}"]`;
  const pads = await page.evaluate((h) => [...document.querySelector(h + ' .designer-pad').options].map((o) => o.value), khead);
  const noRevert = [];
  for (const pad of pads.slice(0, 3)) {
    await page.evaluate((h, pad) => {
      const el = document.querySelector(h + ' .designer-pad');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, pad);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, khead, pad);
    await ctx.sleep(150);
    noRevert.push((await count(`${khead} .dsp-revert`)) === 0);
  }
  check('Switching pads on a kit column shows no Revert', pads.length >= 2 && noRevert.every(Boolean), JSON.stringify(noRevert));

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
