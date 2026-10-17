// #163: Delete and Backspace remove the selected arrangement clip (Ctrl+Z
// restores it), a note selected in the Clip View's piano roll takes the key
// first, typing in a field removes nothing, and the Clip View's button deletes
// the clip.
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  const regionIds = () => page.evaluate(() => window.__dawStore.getState().regions.map((r) => r.id));
  const selectedRegionId = () => page.evaluate(() => window.__dawStore.getState().selectedRegionId);
  const noteIds = (id) => page.evaluate((id) => window.__dawStore.getState().regions.find((r) => r.id === id).notes.map((n) => n.id), id);
  const openClipView = async () => {
    await page.evaluate(() => [...document.querySelectorAll('.detail-tab')].find((b) => b.textContent === 'Clip View').click());
    await ctx.sleep(300);
  };

  // Two MIDI arrangement clips, each with notes
  await page.evaluate(() => {
    const st = window.__dawStore.getState();
    const trackId = st.tracks.find((t) => t.type === 'midi').id;
    const note = (id, pitch, start) => ({ id, pitch, start, duration: 0.5, velocity: 0.9 });
    st.addMidiRegion(trackId, 0, 4, [note('a0', 60, 0)]);
    st.addMidiRegion(trackId, 8, 4, [note('b0', 62, 0), note('b1', 64, 1)]);
    const midi = window.__dawStore.getState().regions.filter((r) => r.type === 'midi');
    window.__clips = { a: midi[midi.length - 2].id, b: midi[midi.length - 1].id };
  });
  const { a, b } = await page.evaluate(() => window.__clips);

  // 1. Delete removes the selected arrangement clip
  await page.evaluate((id) => window.__dawStore.getState().setSelectedRegionId(id), a);
  await page.keyboard.press('Delete');
  await ctx.sleep(200);
  const gone = !(await regionIds()).includes(a);
  check('Delete removes the selected arrangement clip', gone);

  // 2. Ctrl+Z brings it back with the same id (undo only if the delete ran,
  // or it would undo the clip's creation instead)
  if (gone) {
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await ctx.sleep(200);
    check('Ctrl+Z restores the clip with the same id', (await regionIds()).includes(a));
  } else {
    check('Ctrl+Z restores the clip with the same id', false, 'nothing deleted, so nothing to undo');
  }

  // 3. With a note selected in the Clip View, Delete removes the note and the clip stays
  await page.evaluate((id) => window.__dawStore.getState().setSelectedRegionId(id), b);
  await openClipView();
  await page.click('.pr-note');
  await ctx.sleep(100);
  await page.keyboard.press('Delete');
  await ctx.sleep(200);
  check('Delete with a note selected removes the note', (await noteIds(b)).join() === 'b1', (await noteIds(b)).join(', '));
  check('Delete with a note selected keeps the clip', (await regionIds()).includes(b));

  // 4. Delete while typing in a field removes nothing
  await page.focus('.clip-name-input');
  await page.keyboard.press('Delete');
  await ctx.sleep(200);
  check('Delete in a text field removes no clip', (await regionIds()).includes(b));
  await page.evaluate(() => document.activeElement.blur());

  // 5. The Clip View's button deletes the clip, clears the selection and shows the empty message
  await page.click('button[title="Delete clip"]');
  await ctx.sleep(200);
  check('The Delete clip button removes the clip', !(await regionIds()).includes(b));
  check('Deleting clears the selection', (await selectedRegionId()) === null);
  const empty = await page.evaluate(() => document.querySelector('.detail-empty-message')?.textContent || '');
  check('The Clip View shows its empty message after a delete', empty.includes('No clip selected'), empty);

  await ctx.shot('clips_deleted');
  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/ws:\/\/localhost:808[235]/.test(l));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
