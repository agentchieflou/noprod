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

  // 12. Branches (#108): the sitar's sympathetic strings beside its string,
  // joined by the bridge, and its two gourds side by side
  await setSel('.dsp-map-picker', 'sound:sitar');
  await ctx.sleep(300);
  const scol = (await heads()).find((h) => h.name === 'Sitar').col;
  const scratch = () => page.evaluate(async (c) => (await import('/src/components/dspMapState.ts')).savedColumns().find((x) => x.key === c)?.recipe, scol);
  const paths = (stage) => page.evaluate((c, stage) => {
    const row = document.querySelector(`.dsp-map-cell[data-col="${c}"][data-stage="${stage}"] .dsp-branches`);
    const boxes = [...(row?.querySelectorAll('.dsp-branch') ?? [])];
    const rects = boxes.map((b) => b.getBoundingClientRect());
    return {
      bridged: !!row?.classList.contains('bridged'), bridge: row?.querySelector('.dsp-bridge')?.textContent ?? null,
      branches: boxes.map((b) => [...b.querySelectorAll('.dsp-block')].map((x) => x.dataset.kind).join('+')),
      sideBySide: rects.every((r, i) => i === 0 || (r.left >= rects[i - 1].right - 1 && Math.abs(r.top - rects[0].top) < 4))
    };
  }, scol, stage);
  const strings = await paths('resonator'), gourds = await paths('radiator');
  check('The sitar\'s sympathetic strings are drawn beside its string, joined by the bridge',
    strings.bridged && strings.bridge === 'bridge' && JSON.stringify(strings.branches) === '["string","sympathetic"]' && strings.sideBySide, JSON.stringify(strings));
  check('…and its second gourd beside the first, in parallel (no bridge there)',
    !gourds.bridged && JSON.stringify(gourds.branches) === '["body","helmholtz"]' && gourds.sideBySide, JSON.stringify(gourds));
  // the inspector: the strings and the bridge they share
  await page.click(`.dsp-map-cell[data-col="${scol}"] .dsp-block[data-id="strings:0"]`);
  await ctx.sleep(150);
  const inspected = await page.evaluate(() => ({ title: document.querySelector('.dsp-inspector-title')?.firstChild?.textContent,
    params: [...document.querySelectorAll('.dsp-inspector .param-name')].map((n) => n.textContent) }));
  check('Its strings open in the inspector, with the bridge they share', inspected.title === 'Sympathetic strings'
    && ['Kind', 'Tuned', 'Notes', 'Rings', 'Level', 'Bridge'].every((p) => inspected.params.includes(p)), JSON.stringify(inspected));
  // a branch switches off as a whole, and the sound changes
  const s0 = await scratch();
  await page.click(`.dsp-map-cell[data-col="${scol}"] .dsp-block[data-id="strings:0"] .dsp-power`);
  await ctx.sleep(200);
  const s1 = await scratch();
  const symOff = await page.evaluate((c) => document.querySelector(`.dsp-map-cell[data-col="${c}"] .dsp-block[data-id="strings:0"]`).classList.contains('off'), scol);
  const symDiff = await renderPeakDiff(s0, s1);
  check('The sympathetic strings switch off as a branch, and the sound changes', JSON.stringify(s1.layers[0].bypass) === '["strings:0"]' && symOff && symDiff > 0.001,
    `bypass ${JSON.stringify(s1.layers[0].bypass)}, diff ${symDiff.toFixed(4)}`);
  // "+": a bell in parallel, a third path
  const rOptions = await page.evaluate((c) => [...document.querySelector(`.dsp-map-cell[data-col="${c}"][data-stage="radiator"] .dsp-add`).options].map((o) => o.textContent), scol);
  await setSel(`.dsp-map-cell[data-col="${scol}"][data-stage="radiator"] .dsp-add`, '0|bell|parallel');
  await ctx.sleep(200);
  const s2 = await scratch();
  const three = await paths('radiator');
  const opened = await page.evaluate(() => document.querySelector('.dsp-inspector-title')?.firstChild?.textContent);
  check('"+" puts a bell in parallel: a third path, opened in the inspector', rOptions.includes('Bell (in parallel)')
    && JSON.stringify(s2.layers[0].parallel.map((r) => r.kind)) === '["helmholtz","bell"]' && JSON.stringify(three.branches) === '["body","helmholtz","bell"]' && opened === 'Bell',
    JSON.stringify({ parallel: s2.layers[0].parallel.map((r) => r.kind), branches: three.branches, opened }));
  await page.evaluate(() => document.querySelector('.dsp-map-grid').scrollIntoView());
  await ctx.shot('dspmap_branches');

  // 13. The links to the Sound Designer (#98): its DSP Map button, and a track column's pencil
  const violin = await page.evaluate(() => window.__dawStore.getState().tracks.find((t) => t.name === 'Violin').id);
  const select = (id) => page.evaluate((id) => window.__dawStore.getState().setSelectedTrackId(id), id);
  const activeTab = () => page.evaluate(() => document.querySelector('.detail-tab.active')?.textContent);
  await select(violin);
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'Sound Designer').click());
  await ctx.sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.designer-button')].find((b) => b.textContent === 'DSP Map').click());
  await ctx.sleep(300);
  check('The Sound Designer\'s DSP Map button switches to the DSP Map tab', (await activeTab()) === 'DSP Map' && (await page.$('.dsp-map')) !== null, `tab ${await activeTab()}`);

  // The pencil is on a track's column only. The violin comes back from the picker, since it's no longer the selected track
  const other = await page.evaluate((v) => window.__dawStore.getState().tracks.find((t) => t.type === 'midi' && t.id !== v && t.instrument?.parameters?.Library).id, violin);
  await select(other);
  await setSel('.dsp-map-picker', `track:${violin}`);
  await ctx.sleep(200);
  const pencils = await page.evaluate((v, s) => ({
    track: !!document.querySelector(`.dsp-map-head[data-col="track:${v}"] button[title="Edit in the Sound Designer"]`),
    scratch: !!document.querySelector(`.dsp-map-head[data-col="${s}"] button[title="Edit in the Sound Designer"]`)
  }), violin, scol);
  check('A track column has the pencil, a library scratch column does not', pencils.track && !pencils.scratch, JSON.stringify(pencils));
  await page.click(`.dsp-map-head[data-col="track:${violin}"] button[title="Edit in the Sound Designer"]`);
  await ctx.sleep(300);
  const pencilled = await page.evaluate(() => ({ tab: document.querySelector('.detail-tab.active')?.textContent, name: document.querySelector('.designer-name')?.value, selected: window.__dawStore.getState().selectedTrackId }));
  check('The pencil selects that track and opens the Sound Designer on its sound', pencilled.tab === 'Sound Designer' && pencilled.name === 'Violin' && pencilled.selected === violin, JSON.stringify(pencilled));
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'DSP Map').click());
  await ctx.sleep(300);

  await ctx.sleep(500);
  const el = await page.$('.bottom-detail-panel');
  await el.screenshot({ path: require('path').join(ctx.shotDir, 'dspmap_end.png') });

  // 13. Stop (#97): Play all reads Stop while it runs; Stop ends the sequence
  const clickToolbar = (label) => page.evaluate((label) => [...document.querySelectorAll('.dsp-map-toolbar button')].find((b) => b.textContent.trim() === label).click(), label);
  const inspectorTitle = () => page.evaluate(() => document.querySelector('.dsp-inspector-title')?.firstChild?.textContent);
  await clickToolbar('Play all');
  await ctx.sleep(200);
  const running = await page.evaluate(() => [...document.querySelectorAll('.dsp-map-toolbar button')].map((b) => b.textContent.trim()).find((t) => /^(Play all|Stop)$/.test(t)));
  const firstPlaying = await page.evaluate(() => document.querySelector('.dsp-map-head.playing')?.dataset.col ?? null);
  await clickToolbar('Stop');
  const stopped = await page.evaluate(async () => {
    const label = () => [...document.querySelectorAll('.dsp-map-toolbar button')].map((b) => b.textContent.trim()).find((t) => /^(Play all|Stop)$/.test(t));
    const seen = new Set();
    let back = null;
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      for (const h of document.querySelectorAll('.dsp-map-head.playing')) seen.add(h.dataset.col);
      if (back === null && label() === 'Play all') back = performance.now() - t0;
      await new Promise((r) => setTimeout(r, 20));
    }
    return { back, seen: [...seen] };
  });
  check('Play all reads Stop while it runs', running === 'Stop', running);
  check('Stop turns it back to Play all within 2 s, and no other column starts',
    firstPlaying !== null && stopped.back !== null && stopped.back < 2000 && stopped.seen.every((c) => c === firstPlaying), JSON.stringify({ firstPlaying, ...stopped }));

  // 13b. Leaving the tab (#165): Play all ends with the map. Count the sounds that start
  // (each column is one source) while the map is off the panel: only the first column plays
  await page.evaluate(() => {
    window.__starts = 0;
    window.__startOrig = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) { window.__starts++; return window.__startOrig.apply(this, a); };
  });
  await clickToolbar('Play all');
  await page.waitForFunction(() => window.__starts >= 1, { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'Device Chain').click());
  await ctx.sleep(6000); // longer than the remaining columns take at 1.5 s each
  const leftTab = await page.evaluate(() => window.__starts);
  await page.evaluate(() => {
    AudioBufferSourceNode.prototype.start = window.__startOrig;
    [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'DSP Map').click();
  });
  await ctx.sleep(300);
  const idle = await page.evaluate(() => [...document.querySelectorAll('.dsp-map-toolbar button')].map((b) => b.textContent.trim()).find((t) => /^(Play all|Stop)$/.test(t)));
  check('Leaving the tab ends Play all: no column after the first starts', leftTab === 1 && idle === 'Play all', `${leftTab} sound(s) started; button ${idle}`);

  // 14. Reset map (#97): the four classic instruments again, no track touched.
  // The selected track still leads the map, as it always does.
  const trumpet = (await heads()).find((h) => h.name.startsWith('Trumpet')).col;
  await page.click(`.dsp-map-head[data-col="${trumpet}"] button[title="Take off the map"]`);
  await ctx.sleep(150);
  const beforeReset = await T();
  await clickToolbar('Reset map');
  await ctx.sleep(200);
  const afterReset = await T();
  const classic = (await heads()).filter((h) => !h.source.includes('(selected)')).map((h) => h.name);
  check('Reset map shows Violin, Trumpet (Modeled), Flute (Modeled) and Nylon Guitar (Modeled), and changes no track',
    JSON.stringify(classic) === JSON.stringify(['Violin', 'Trumpet (Modeled)', 'Flute (Modeled)', 'Nylon Guitar (Modeled)'])
    && afterReset.tracks === beforeReset.tracks && JSON.stringify(afterReset.sound) === JSON.stringify(beforeReset.sound), JSON.stringify(classic));

  // 15. Esc (#97): clears the inspector, but not while a field has focus
  await page.click('.dsp-map-cell[data-col^="trumpet-modeled-"] .dsp-block');
  await ctx.sleep(100);
  const titleOpen = await inspectorTitle();
  await page.keyboard.press('Escape');
  await ctx.sleep(100);
  const titleClosed = await inspectorTitle();
  check('Escape brings back the Inspector help', titleOpen !== 'Inspector' && titleClosed === 'Inspector', `${titleOpen} → ${titleClosed}`);
  await page.click('.dsp-map-cell[data-col^="trumpet-modeled-"] .dsp-block');
  await ctx.sleep(100);
  await page.focus('.dsp-map-toolbar select');
  await page.keyboard.press('Escape');
  await ctx.sleep(100);
  const inField = await inspectorTitle();
  check('Escape in a field leaves the inspector open', inField !== 'Inspector', inField);

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808\d/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
