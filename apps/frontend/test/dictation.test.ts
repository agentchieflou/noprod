// AI dictation with the user's own key (#157): the Gemini call, its errors in
// words, the limits, and where the key may go.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateDictation } from '@noprod/pattern';
import { gemini, DictationError, LIMITS } from '../src/dictation/provider.ts';

const KEY = 'AIza-test-key-123';
const HOST = 'generativelanguage.googleapis.com';

interface Call { url: string; init: RequestInit }
let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response> = () => new Response('{}');

beforeEach(() => {
  calls = [];
  respond = () => new Response('{}');
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
});

const reply = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
const fail = (status: number, message = '') => new Response(JSON.stringify({ error: { message } }), { status });
const provider = () => gemini(() => KEY);
const kindOf = async (p: Promise<unknown>) => p.then(() => 'none', (e) => (e as DictationError).kind);

test('a request carries the key in a header, goes to the provider host only, and uses the shared prompt', async () => {
  respond = () => reply('s("bd")');
  const text = await provider().generate([{ role: 'user', text: 'a kick' }]);
  assert.equal(text, 's("bd")');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(new URL(url).host, HOST);
  assert.equal((init.headers as Record<string, string>)['x-goog-api-key'], KEY);
  assert.ok(!url.includes(KEY), 'the key is not in the URL');
  const body = JSON.parse(init.body as string);
  assert.equal(body.contents[0].parts[0].text, 'a kick');
  assert.match(body.systemInstruction.parts[0].text, /dictation engine/);
  assert.ok(!JSON.stringify(body).includes(KEY), 'the key is not in the body');
});

test('a parse error leads to one retry, with the error and the first answer in the conversation', async () => {
  const answers = ['s("bd").foo()', 's("bd*4")'];
  respond = () => reply(answers.shift()!);
  const out = await generateDictation('four kicks', (turns) => provider().generate(turns));
  assert.equal(out.attempts, 2);
  assert.equal(out.error, null);
  assert.equal(out.code, 's("bd*4")');
  const retry = JSON.parse(calls[1].init.body as string).contents;
  assert.deepEqual(retry.map((c: any) => c.role), ['user', 'model', 'user']);
  assert.match(retry[2].parts[0].text, /foo/);
  assert.equal(calls.length, 2);
});

test('errors come in words a user understands', async () => {
  const p = provider();
  const turns = [{ role: 'user' as const, text: 'x' }];
  respond = () => fail(400, 'API key not valid. Please pass a valid API key.');
  assert.equal(await kindOf(p.generate(turns)), 'key');
  respond = () => fail(403, 'denied');
  assert.equal(await kindOf(p.generate(turns)), 'key');
  respond = () => fail(429, 'quota');
  assert.equal(await kindOf(p.generate(turns)), 'quota');
  respond = () => fail(503);
  assert.equal(await kindOf(p.generate(turns)), 'busy');
  respond = () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await kindOf(p.generate(turns)), 'network');
  respond = () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }));
  assert.equal(await kindOf(p.generate(turns)), 'refused');
  respond = () => reply('   ');
  assert.equal(await kindOf(p.generate(turns)), 'refused');
});

test('an error message never contains the key', async () => {
  respond = () => fail(418, `teapot ${KEY} refused`);
  const e = await provider().generate([{ role: 'user', text: 'x' }]).catch((err) => err as Error);
  assert.ok(!e.message.includes(KEY), e.message);
});

test('an answer past the size cap is refused', async () => {
  respond = () => reply('a'.repeat(LIMITS.codeChars + 1));
  assert.equal(await kindOf(provider().generate([{ role: 'user', text: 'x' }])), 'refused');
});

test('cancelling aborts the request and reads as cancelled', async () => {
  const controller = new AbortController();
  globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;
  const pending = provider().generate([{ role: 'user', text: 'x' }], controller.signal);
  controller.abort();
  assert.equal(await kindOf(pending), 'cancelled');
});

test('without a key nothing is requested', async () => {
  assert.equal(await kindOf(gemini(() => '').generate([{ role: 'user', text: 'x' }])), 'key');
  assert.equal(await kindOf(gemini(() => '').test()), 'key');
  assert.equal(calls.length, 0);
});

test('the key test is one cheap call that bills nothing: a GET of the model, not a generation', async () => {
  respond = () => new Response('{}');
  await provider().test();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.ok(!calls[0].url.includes('generateContent'));
  assert.equal(new URL(calls[0].url).host, HOST);
  respond = () => fail(400, 'API key not valid');
  assert.equal(await kindOf(provider().test()), 'key');
});
