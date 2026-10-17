import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictationSystemPrompt, stripFences, checkDictation, generateDictation, evaluateCycle, type DictationTurn } from '../src/index.ts';

const names = { drums: ['bd', 'sd', 'hh'], synths: ['piano', 'bass'] };

test('the prompt names the sounds, and its own examples parse', () => {
  const prompt = dictationSystemPrompt(names);
  assert.ok(prompt.includes('bd, sd, hh') && prompt.includes('piano, bass'));
  const examples = prompt.split('you might output:').slice(1).map((s) => s.split('\n\n')[0].trim());
  assert.equal(examples.length, 3);
  for (const code of examples) assert.equal(checkDictation(code), null, code);
  assert.equal(evaluateCycle(examples[0]).cps * 240, 128);
});

test('fences are stripped', () => {
  assert.equal(stripFences('```javascript\ns("bd")\n```'), 's("bd")');
  assert.equal(stripFences('```\ns("bd")```'), 's("bd")');
  assert.equal(stripFences('  s("bd")\n'), 's("bd")');
  assert.equal(stripFences('s("bd")'), 's("bd")');
});

test('checkDictation says what is wrong, or nothing', () => {
  assert.equal(checkDictation('s("bd sd")'), null);
  assert.match(checkDictation('s("bd").foo()')!, /unknown method "\.foo"/);
  assert.match(checkDictation('s("bd*1000000")')!, /too many events/);
  assert.match(checkDictation('s("bd*100")', { maxEvents: 10 })!, /too many events/);
  assert.match(checkDictation(undefined as unknown as string)!, /a program is a string/);
});

test('generateDictation accepts good code first time', async () => {
  const asked: DictationTurn[][] = [];
  const result = await generateDictation('a beat', async (turns) => { asked.push(turns); return '```js\ns("bd*4")\n```'; });
  assert.deepEqual(result, { code: 's("bd*4")', error: null, attempts: 1 });
  assert.deepEqual(asked, [[{ role: 'user', text: 'a beat' }]]);
});

test('generateDictation asks once more with the error, then gives up', async () => {
  const asked: DictationTurn[][] = [];
  const fixed = await generateDictation('a beat', async (turns) => { asked.push(turns); return turns.length === 1 ? 's("bd").foo()' : 's("bd")'; });
  assert.deepEqual(fixed, { code: 's("bd")', error: null, attempts: 2 });
  assert.equal(asked[1].length, 3);
  assert.deepEqual(asked[1].map((t) => t.role), ['user', 'model', 'user']);
  assert.equal(asked[1][1].text, 's("bd").foo()');
  assert.match(asked[1][2].text, /failed to parse: unknown method "\.foo" at 1:8/);

  const stillBad = await generateDictation('a beat', async () => 'nope(1)');
  assert.equal(stillBad.attempts, 2);
  assert.equal(stillBad.code, 'nope(1)');
  assert.match(stillBad.error!, /unknown name "nope"/);
});
