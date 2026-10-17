// #190: the tempo field. A BPM draft being typed isn't overwritten while the
// transport plays; a committed or external tempo does reach the field; tap tempo
module.exports = async (page, ctx) => {
  const results = [];
  const check = (name, ok, detail = '') => { const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`; results.push(line); console.log(line); };
  await page.mouse.click(5, 5);

  const bpmField = () => page.$eval('.bpm-input', (el) => el.value);
  const bpm = () => page.evaluate(() => window.__dawStore.getState().bpm);
  await page.evaluate(() => window.__dawStore.getState().setBpm(120));
  await ctx.sleep(100);
  check('The field shows the project tempo', (await bpmField()) === '120.00', await bpmField());

  // Typing while the transport plays: the playhead re-renders the controls every frame
  await page.evaluate(() => window.__dawStore.getState().togglePlayback());
  await ctx.sleep(300);
  await page.$eval('.bpm-input', (el) => { el.focus(); el.select(); });
  await page.keyboard.type('133');
  await ctx.sleep(600);
  check('A draft being typed survives the playhead moving', (await bpmField()) === '133' && (await bpm()) === 120, `${await bpmField()}, bpm ${await bpm()}`);
  await page.keyboard.press('Enter');
  await ctx.sleep(100);
  check('Enter commits the draft', (await bpm()) === 133 && (await bpmField()) === '133.00', `bpm ${await bpm()}, field ${await bpmField()}`);

  await page.evaluate(() => window.__dawStore.getState().setBpm(90));
  await ctx.sleep(100);
  check('A tempo set elsewhere reaches the field', (await bpmField()) === '90.00', await bpmField());

  await page.evaluate(() => window.__dawStore.getState().togglePlayback());
  await ctx.sleep(100);

  // Tap tempo: two taps 500 ms apart are 120 BPM, and the button flashes
  await page.click('.tap-btn');
  await ctx.sleep(500);
  // The flash lasts 90 ms, shorter than a round trip: watch the class instead
  await page.$eval('.tap-btn', (el) => {
    window.__flashed = false;
    new MutationObserver(() => { if (el.classList.contains('active')) window.__flashed = true; }).observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  await page.click('.tap-btn');
  await ctx.sleep(50);
  const flashing = await page.evaluate(() => window.__flashed);
  const tapped = await bpm();
  check('Two taps 500 ms apart set about 120 BPM', Math.abs(tapped - 120) < 8, `${tapped}`);
  check('The tap button flashes', flashing);
  await ctx.sleep(300);
  check('The flash clears', !(await page.$eval('.tap-btn', (el) => el.classList.contains('active'))));
  check('The field follows the tap tempo', (await bpmField()) === tapped.toFixed(2), await bpmField());

  const errors = ctx.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !l.includes('ws://localhost:8080'));
  check('No page errors', errors.length === 0, errors.join(' / '));
  console.log(`${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
};
