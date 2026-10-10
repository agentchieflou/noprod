// #80: the DSP Map
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  const T = () => page.evaluate(() => {
    const st = window.__dawStore.getState();
    const t = st.tracks.find((x) => x.id === st.selectedTrackId);
    return { id: t?.id, name: t?.name, sound: t?.instrument?.parameters?.Library?.sound, past: st.past.length, tracks: st.tracks.length };
  });
  const setSel = (sel, value) => page.evaluate((sel, value) => {
    const el = document.querySelector(sel);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, sel, value);
  const heads = () => page.evaluate(() => [...document.querySelectorAll('.dsp-map-head')].map((h) => ({
    col: h.dataset.col, name: h.querySelector('.dsp-head-name').textContent, source: h.querySelector('.dsp-head-source span').textContent })));
  await page.mouse.click(5, 5);

  // 1. Opens on the four classic instruments, their shared blocks listed by stage
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'DSP Map').click());
  await ctx.sleep(400);
  const first = await page.evaluate(() => ({
    heads: [...document.querySelectorAll('.dsp-head-name')].map((e) => e.textContent),
    shared: Object.fromEntries([...document.querySelectorAll('.dsp-shared')].map((e) => [e.dataset.kind, e.querySelector('.dsp-shared-count').textContent]))
  }));
  check('Opens with violin, trumpet, flute and guitar', JSON.stringify(first.heads) === JSON.stringify(['Violin', 'Trumpet (Modeled)', 'Flute (Modeled)', 'Nylon Guitar (Modeled)']), first.heads.join(', '));
  check('Shared blocks: string and body (violin, guitar), bore, vibrato ×3, envelope ×4',
    first.shared.string === '×2' && first.shared.body === '×2' && first.shared.bore === '×2' && first.shared.vibrato === '×3' && first.shared.env === '×4' && !first.shared.bow, JSON.stringify(first.shared));
  const loops = await page.evaluate(() => [...document.querySelectorAll('.dsp-map-cell.loop')].map((c) => c.dataset.col.split('-')[0]));
  check('Closed loops are marked (bowed and blown, not plucked)', loops.length === 3 && !loops.includes('guitar'), loops.join(', '));

  // 2. Hovering a shared block lights it in every column
  await page.hover('.dsp-shared[data-kind="string"]');
  await ctx.sleep(100);
  const lit = await page.evaluate(() => [...document.querySelectorAll('.dsp-block.hover')].map((b) => b.closest('.dsp-map-cell').dataset.col.split('-')[0] + ':' + b.dataset.kind));
  check('Hovering String lights the violin\'s and the guitar\'s strings', lit.length === 2 && lit.every((x) => x.endsWith(':string')), lit.join(', '));
  await page.mouse.move(5, 5);

  // 3. A violin on a track: the selected track joins the map first
  await page.evaluate(() => [...document.querySelectorAll('.browser-folder')].find((e) => e.textContent.trim().startsWith('Strings')).click());
  await ctx.sleep(150);
  await page.evaluate(() => [...document.querySelectorAll('.browser-item')].find((e) => e.querySelector('.browser-item-label')?.textContent === 'Violin').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await ctx.sleep(500);
  const track = await T();
  const h1 = await heads();
  const tcol = `track:${track.id}`;
  check('The selected track is the first column', h1[0].col === tcol && /Track · Violin \(selected\)/.test(h1[0].source) && h1.length === 5, JSON.stringify(h1[0]));

  // 4. A block's power switch: the body off on the track, and the sound changes
  const renderPeakDiff = async (a, b) => page.evaluate(async (a, b) => {
    const { render } = await import(window.__fs + '/packages/sound/src/index.ts');
    const x = render(a, { sampleRate: 22050, gate: 0.5, normalize: false }).left, y = render(b, { sampleRate: 22050, gate: 0.5, normalize: false }).left;
    let d = 0; for (let i = 0; i < Math.min(x.length, y.length); i++) d = Math.max(d, Math.abs(x[i] - y[i]));
    return d;
  }, a, b);
  const before = track.sound;
  await page.click(`.dsp-map-cell[data-col="${tcol}"] .dsp-block[data-id="radiator:0"] .dsp-power`);
  await ctx.sleep(150);
  const bodyOff = (await T()).sound;
  const offDiff = await renderPeakDiff(before, bodyOff);
  const offClass = await page.evaluate((c) => document.querySelector(`.dsp-map-cell[data-col="${c}"] .dsp-block[data-id="radiator:0"]`).classList.contains('off'), tcol);
  check('A block switches off on the track (settings kept) and the sound changes',
    JSON.stringify(bodyOff.layers[0].bypass) === '["radiator:0"]' && bodyOff.layers[0].radiators[0].preset === 'violin' && offDiff > 0.01 && offClass, `diff ${offDiff.toFixed(3)}`);
  await page.click(`.dsp-map-cell[data-col="${tcol}"] .dsp-block[data-id="radiator:0"] .dsp-power`);
  await ctx.sleep(150);
  check('…and back on, as it was', JSON.stringify((await T()).sound) === JSON.stringify(before));

  // 5. The common chain toggle: vibrato off in every instrument that has it
  await page.click('.dsp-shared[data-kind="vibrato"] .dsp-power');
  await ctx.sleep(200);
  const vib = await page.evaluate(() => ({
    off: [...document.querySelectorAll('.dsp-block[data-kind="vibrato"]')].map((b) => b.classList.contains('off')),
    chip: document.querySelector('.dsp-shared[data-kind="vibrato"]').className
  }));
  const vibTrack = (await T()).sound.layers[0].bypass;
  check('The shared Vibrato switch turns it off in all four that have it', vib.off.length === 4 && vib.off.every(Boolean) && /\boff\b/.test(vib.chip) && vibTrack?.includes('vibrato'), JSON.stringify({ ...vib, vibTrack }));
  await page.click('.dsp-shared[data-kind="vibrato"] .dsp-power');
  await ctx.sleep(200);
  const vibOn = await page.evaluate(() => [...document.querySelectorAll('.dsp-block[data-kind="vibrato"]')].every((b) => b.classList.contains('on')));
  check('…and on again in all of them', vibOn && !(await T()).sound.layers[0].bypass);

  // 6. A branch: a bell on the violin track, opened in the inspector
  await setSel(`.dsp-map-cell[data-col="${tcol}"][data-stage="radiator"] .dsp-add`, '0|bell');
  await ctx.sleep(200);
  const belled = (await T()).sound;
  const inspector = await page.evaluate(() => document.querySelector('.dsp-inspector-title')?.firstChild?.textContent);
  check('"+" adds a bell radiator to the violin, and opens it', JSON.stringify(belled.layers[0].radiators.map((r) => r.kind)) === '["body","bell"]' && inspector === 'Bell'
    && (await renderPeakDiff(before, belled)) > 0.01, `${inspector}; ${belled.layers[0].radiators.map((r) => r.kind)}`);
  // a bow on the guitar: the pluck is swapped
  const gcol = (await heads()).find((h) => h.name.startsWith('Nylon')).col;
  const gOptions = await page.evaluate((c) => [...document.querySelector(`.dsp-map-cell[data-col="${c}"][data-stage="excitation"] .dsp-add`).options].map((o) => o.textContent), gcol);
  await setSel(`.dsp-map-cell[data-col="${gcol}"][data-stage="excitation"] .dsp-add`, '0|bow');
  await ctx.sleep(200);
  const gNow = await page.evaluate((c) => ({ kinds: [...document.querySelectorAll(`.dsp-map-cell[data-col="${c}"] .dsp-block`)].map((b) => b.dataset.kind), loop: !!document.querySelector(`.dsp-map-cell.loop[data-col="${c}"]`) }), gcol);
  check('A bow on the guitar\'s string replaces the pluck and closes the loop', gOptions.includes('Bow (replaces Pluck)') && gNow.kinds.includes('bow') && !gNow.kinds.includes('pluck') && gNow.loop, JSON.stringify(gNow));

  // 7. The inspector edits the track: the bow's pressure
  await page.click(`.dsp-map-cell[data-col="${tcol}"] .dsp-block[data-id="exciter"]`);
  await ctx.sleep(150);
  const p0 = (await T()).sound.layers[0].exciter.pressure;
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.dsp-inspector .param-slider-row')].find((r) => r.querySelector('.param-name')?.textContent === 'Pressure');
    const input = row.querySelector('input[type=range]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '900');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await ctx.sleep(150);
  const p1 = (await T()).sound.layers[0].exciter.pressure;
  check('The inspector\'s Pressure slider edits the violin track\'s bow', p0 === 0.5 && p1 === 0.9, `${p0} → ${p1}`);

  // 8. Undo walks it back
  await page.evaluate(() => window.__dawStore.getState().undo());
  await ctx.sleep(150);
  const undone = (await T()).sound;
  check('Undo takes the edit back', undone.layers[0].exciter.pressure === 0.5, `pressure ${undone.layers[0].exciter.pressure}, radiators ${undone.layers[0].radiators.map((r) => r.kind)}`);

  // 9. Audition: the track's column plays through its strip, at the shared note
  await setSel('.dsp-map-toolbar select', '69');
  const peak = await page.evaluate(async (c) => {
    document.querySelector(`.dsp-map-head[data-col="${c}"] .designer-play`).click();
    const an = window.__transport.masterAnalyser;
    const buf = new Float32Array(an.fftSize);
    let p = 0;
    const end = performance.now() + 2500;
    while (performance.now() < end) { an.getFloatTimeDomainData(buf); for (const x of buf) p = Math.max(p, Math.abs(x)); await new Promise((r) => setTimeout(r, 10)); }
    return p;
  }, tcol);
  check('A column plays its sound (the track\'s through its strip)', peak > 0.02, `peak ${peak.toFixed(3)}`);

  // 10. Add a library sound, move it onto a new track, take a column off
  await setSel('.dsp-map-picker', 'sound:clarinet-modeled');
  await ctx.sleep(200);
  const h2 = await heads();
  const ccol = h2.find((h) => h.name === 'Clarinet (Modeled)');
  check('The picker adds a library sound as a scratch copy', !!ccol && ccol.source === 'Library · scratch copy', JSON.stringify(h2.map((h) => h.name)));
  const nTracks = (await T()).tracks;
  await page.evaluate((c) => [...document.querySelector(`.dsp-map-head[data-col="${c}"]`).querySelectorAll('.designer-link')].find((b) => b.textContent === 'Use on a new track').click(), ccol.col);
  await ctx.sleep(300);
  const moved = await T();
  const h3 = await heads();
  check('"Use on a new track" makes a track playing it, and the column follows the track',
    moved.tracks === nTracks + 1 && moved.sound.id === 'clarinet-modeled' && h3.some((h) => h.col === `track:${moved.id}` && h.name === 'Clarinet (Modeled)') && !h3.some((h) => h.source === 'Library · scratch copy' && h.name.startsWith('Clarinet')),
    JSON.stringify(h3.map((h) => h.source)));
  const fcol = h3.find((h) => h.name.startsWith('Flute')).col;
  await page.click(`.dsp-map-head[data-col="${fcol}"] button[title="Take off the map"]`);
  await ctx.sleep(150);
  check('× takes a column off the map', !(await heads()).some((h) => h.name.startsWith('Flute')));

  // 11. The map is kept while the panel shows something else
  const kept = (await heads()).map((h) => h.name).join();
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'Device Chain').click());
  await ctx.sleep(150);
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'DSP Map').click());
  await ctx.sleep(300);
  check('The columns are kept across tabs', (await heads()).map((h) => h.name).join() === kept, kept);

  await ctx.sleep(500);
  const el = await page.$('.bottom-detail-panel');
  await el.screenshot({ path: require('path').join(ctx.shotDir, 'dspmap_end.png') });
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
