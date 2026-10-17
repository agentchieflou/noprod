// #100: the chord lane over the piano roll in the Clip View
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };

  // The helper alone (one import per call: several in one can hang)
  const unit = await page.evaluate(async () => {
    const { chordSegments, chordLabel } = await import('/src/audio/chordLane.ts');
    const key = { tonic: 0, mode: 'major' };
    const block = (chords) => chords.flatMap((pitches, i) => pitches.map((pitch) => ({ pitch, start: i * 2, duration: 2 })));
    const progression = chordSegments(block([[60, 64, 67], [59, 62, 67], [57, 60, 64], [53, 57, 60]]), key, 0.125);
    const arpeggio = chordSegments([60, 64, 67].map((pitch, i) => ({ pitch, start: i * 0.25, duration: 2 - i * 0.25 })), key, 0.125);
    const dyad = chordSegments([60, 67].map((pitch) => ({ pitch, start: 0, duration: 2 })), key, 0.125);
    const blip = chordSegments([...block([[60, 64, 67]]), { pitch: 62, start: 1, duration: 0.05 }], key, 0.125);
    return {
      labels: progression.map((s) => chordLabel(s, key)),
      arpeggio: arpeggio.map((s) => chordLabel(s, key)),
      dyad: dyad.length,
      blip: blip.map((s) => chordLabel(s, key))
    };
  });
  check('Block chords give C I, G/B V (labeled G V), Am vi, F IV', unit.labels.join(',') === 'C I,G V,Am vi,F IV', unit.labels.join(','));
  check('An arpeggiated C still gives C', unit.arpeggio.join(',') === 'C I', unit.arpeggio.join(','));
  check('Two notes alone give no chord', unit.dyad === 0, String(unit.dyad));
  check('A passing blip shorter than a 16th is dropped', unit.blip.join(',') === 'C I', unit.blip.join(','));

  // A MIDI clip with those four chords, one bar each, open in the Clip View
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    const track = st.tracks.find((t) => t.type === 'midi');
    const chords = [[60, 64, 67], [59, 62, 67], [57, 60, 64], [53, 57, 60]];
    const notes = chords.flatMap((pitches, i) => pitches.map((pitch, j) => ({ id: `n${i}-${j}`, pitch, start: i * 2, duration: 2, velocity: 0.9 })));
    st.addRegion({ trackId: track.id, type: 'midi', file: 'Chords', audioBuffer: null, startTime: 0, duration: 8, notes });
    window.__regionId = window.__dawStore.getState().selectedRegionId;
  });
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'Clip View').click());
  await page.waitForSelector('.pr-chord');
  await ctx.sleep(200);

  const lane = () => page.evaluate(() => {
    const grid = document.querySelector('.pr-grid').getBoundingClientRect();
    return {
      key: document.querySelector('.pr-chords-key').textContent,
      chords: [...document.querySelectorAll('.pr-chord')].map((el) => ({ text: el.textContent, title: el.title, x: el.getBoundingClientRect().left - grid.left }))
    };
  });
  const before = await lane();
  check('The lane names the key', before.key === 'C major', before.key);
  check('The lane shows four labels', before.chords.map((c) => c.text).join(',') === 'C I,G V,Am vi,F IV', before.chords.map((c) => c.text).join(','));
  check('Hovering gives the inversion', before.chords[1].title === 'G/B (V)', before.chords[1].title);
  const pxPerBeat = 48, beatsPerBar = 4;   // one bar each, 2 s at 120 BPM
  check('Labels sit at their notes\' starts', before.chords.every((c, i) => Math.abs(c.x - i * beatsPerBar * pxPerBeat) <= 3), before.chords.map((c) => Math.round(c.x)).join(','));
  await ctx.shot('chord-lane');

  // Am → A major: move the C up to C#
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    const region = st.regions.find((r) => r.id === window.__regionId);
    st.updateRegionNotes(region.id, region.notes.map((n) => (n.id === 'n2-1' ? { ...n, pitch: 61 } : n)));
  });
  await ctx.sleep(200);
  const after = await lane();
  check('Editing a note changes its label', after.chords.length === 4 && /^A /.test(after.chords[2].text), after.chords.map((c) => c.text).join(','));
  check('The other labels stay', after.chords.map((c, i) => i === 2 || c.text === before.chords[i].text).every(Boolean));

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080')); // no orchestrator here
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
