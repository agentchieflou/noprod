// #146: a note selected in one clip is not selected in another, so Delete in
// the second clip leaves its notes alone
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  const notesOf = (id) => page.evaluate((id) => window.__dawStore.getState().regions.find((r) => r.id === id).notes.map((n) => n.id), id);
  const selectedCount = () => page.evaluate(() => document.querySelectorAll('.pr-note.selected').length);

  // Two MIDI clips whose notes share ids (n0 and n1 in both)
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    const trackId = st.tracks.find((t) => t.type === 'midi').id;
    const note = (id, pitch, start) => ({ id, pitch, start, duration: 0.5, velocity: 0.9 });
    st.addMidiRegion(trackId, 0, 4, [note('n0', 60, 0), note('n1', 62, 1), note('n2', 64, 2)]);
    st.addMidiRegion(trackId, 8, 4, [note('n0', 48, 0), note('n1', 50, 1), note('n2', 52, 2), note('n3', 53, 3)]);
    const midi = window.__dawStore.getState().regions.filter((r) => r.type === 'midi');
    window.__clips = { first: midi[midi.length - 2].id, second: midi[midi.length - 1].id };
    return 1;
  });
  const { first, second } = await page.evaluate(() => window.__clips);

  // 1. Open the first clip and select its first note
  await page.evaluate((id) => window.__dawStore.getState().setSelectedRegionId(id), first);
  await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'Clip View').click());
  await ctx.sleep(300);
  await page.click('.pr-note');
  await ctx.sleep(100);
  check('Selecting a note in the first clip selects it', (await selectedCount()) === 1);

  // 2. Open the second clip: nothing is selected there
  await page.evaluate((id) => window.__dawStore.getState().setSelectedRegionId(id), second);
  await ctx.sleep(300);
  check('Opening the second clip selects no note', (await selectedCount()) === 0, `${await selectedCount()} selected`);

  // 3. Delete in the second clip removes nothing (focus is in a field, so the
  // key doesn't delete the clip either)
  await page.focus('.clip-name-input');
  await page.keyboard.press('Delete');
  await ctx.sleep(200);
  const secondNotes = await notesOf(second);
  const firstNotes = await notesOf(first);
  check('Delete leaves the second clip\'s notes alone', secondNotes.join() === 'n0,n1,n2,n3', secondNotes.join(', '));
  check('Delete leaves the first clip\'s notes alone', firstNotes.join() === 'n0,n1,n2', firstNotes.join(', '));

  await ctx.shot('pianoroll_second_clip');
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808\d/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
