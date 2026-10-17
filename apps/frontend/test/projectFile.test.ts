// The .noprod format: round trips (including an hour of audio), v1 files,
// and damaged or hostile files refused with a clear message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeProjectFile, readProjectFile, MAGIC, PCM_CHUNK_FRAMES, type Pcm } from '../src/project/format.ts';
import { SCHEMA_VERSION, SCHEMA_KEYS, ProjectFileError } from '../src/project/schema.ts';

// A project as the store's createDefaultProject makes it
const defaults = () => ({
  bpm: 120, timeSignatures: [{ bar: 0, numerator: 4, denominator: 4 }], countInBars: 1,
  masterVolume: 0.8, masterPan: 0,
  returns: [{ id: 'return-a', name: 'Reverb', volume: 0.5, pan: 0, isMuted: false, plugins: [{ id: 'd1', name: 'Reverb', type: 'audio-fx', kind: 'reverb', parameters: { 'Dry/Wet': 100 } }] }],
  masterPlugins: [], isLimiterEnabled: true, isLoopEnabled: false, loopStart: 0, loopEnd: 8, locators: [],
  punchInTime: 4, punchOutTime: 8, isPunchEnabled: false, vstScanPaths: ['C:/VST3'],
  tracks: [
    { id: 't1', name: '1 Audio', type: 'audio', volume: 0.8, pan: 0, sends: { 'return-a': 0.2 }, plugins: [] },
    { id: 't2', name: '2 MIDI', type: 'midi', volume: 0.8, pan: 0, sends: {}, plugins: [], instrument: { id: 'i1', name: 'NoProd Synth', type: 'instrument', parameters: { Gain: 0.7 } } }
  ],
  regions: [] as any[], sessionClips: {} as any, scenes: [{ id: 's1', name: '', tempo: null }], launchQuantization: '1 bar', savedRacks: []
});

const tone = (frames: number, hz: number, sr = 48000) => Float32Array.from({ length: frames }, (_, i) => Math.sin((2 * Math.PI * hz * i) / sr) * 0.5);

// A v2 project.json for `project`, with `pcm` described in order
const docJson = (project: any, pcm: Pcm[], extra: any = {}) => JSON.stringify({
  format: 'noprod-project', version: SCHEMA_VERSION, savedAt: '2026-10-17T00:00:00Z',
  buffers: pcm.map((b, i) => ({ id: `b${i}`, sampleRate: b.sampleRate, length: b.channels[0].length, channels: b.channels.length })),
  project, ...extra
});

const refuses = async (blob: Blob, pattern: RegExp) => {
  await assert.rejects(readProjectFile(blob, defaults()), (err: any) => {
    assert.ok(err instanceof ProjectFileError, `a ProjectFileError, not ${err?.name}: ${err?.message}`);
    assert.match(err.message, pattern);
    return true;
  });
};

const sameSamples = (a: Float32Array, b: Float32Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

test('the schema covers every project key', () => {
  assert.deepEqual([...SCHEMA_KEYS].sort(), Object.keys(defaults()).sort());
});

test('a project round-trips bit for bit, buffers shared where they were', async () => {
  const stereo: Pcm = { sampleRate: 44100, channels: [tone(30000, 440, 44100), tone(30000, 660, 44100)] };
  const mono: Pcm = { sampleRate: 48000, channels: [tone(5, 100)] };
  const project = defaults();
  project.regions = [
    { id: 'r1', trackId: 't1', file: 'a.wav', audioBuffer: { $audioBuffer: 'b0' }, startTime: 0, duration: 0.68 },
    { id: 'r2', trackId: 't1', file: 'a.wav', audioBuffer: { $audioBuffer: 'b0' }, startTime: 2, duration: 0.68 },
    { id: 'r3', trackId: 't2', type: 'midi', audioBuffer: null, startTime: 0, duration: 2, notes: [{ id: 'n', pitch: 60, start: 0, duration: 1, velocity: 0.8 }] }
  ];
  project.tracks[0] = { ...project.tracks[0], isFrozen: true, frozenBuffer: { $audioBuffer: 'b1' } } as any;
  const blob = await writeProjectFile(docJson(project, [stereo, mono]), [stereo, mono]);
  const { doc, pcm } = await readProjectFile(blob, defaults());
  assert.equal(doc.version, SCHEMA_VERSION);
  assert.deepEqual(doc.project, project);
  assert.equal(pcm.length, 2);
  assert.equal(pcm[0].sampleRate, 44100);
  assert.ok(sameSamples(pcm[0].channels[0], stereo.channels[0]) && sameSamples(pcm[0].channels[1], stereo.channels[1]));
  assert.ok(sameSamples(pcm[1].channels[0], mono.channels[0]));
});

test('an hour of audio saves and loads (v1 would need a string past Chrome\'s limit)', async () => {
  const frames = 3600 * 48000;
  const hour = new Float32Array(frames);
  for (let i = 0; i < frames; i += 997) hour[i] = ((i % 2001) - 1000) / 1000;
  hour[frames - 1] = 0.25;
  // v1 held each sample's bytes as base64 inside one JSON string
  assert.ok((frames * 4 * 4) / 3 > 2 ** 29, 'base64 of this hour is longer than Chrome allows a string');
  const pcm: Pcm[] = [{ sampleRate: 48000, channels: [hour] }];
  const project = defaults();
  project.regions = [{ id: 'r', trackId: 't1', file: 'Take', audioBuffer: { $audioBuffer: 'b0' }, startTime: 0, duration: 3600 }];
  const blob = await writeProjectFile(docJson(project, pcm), pcm);
  assert.ok(blob.size > frames * 4 && blob.size < frames * 4 * 1.001, `raw PCM, not text (${blob.size} bytes)`);
  const back = await readProjectFile(blob, defaults());
  assert.equal(back.pcm[0].channels[0].length, frames);
  assert.ok(sameSamples(back.pcm[0].channels[0], hour));
  assert.equal(Math.ceil(frames / PCM_CHUNK_FRAMES) > 100, true);
});

// The v1 writer, as it shipped (gzip of one JSON string, base64 channels)
async function v1File(project: any, buffers: Record<string, { sampleRate: number; channels: Float32Array[] }>) {
  const enc: any = {};
  Object.entries(buffers).forEach(([id, b]) => {
    enc[id] = { sampleRate: b.sampleRate, length: b.channels[0].length, channels: b.channels.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString('base64')) };
  });
  const json = JSON.stringify({ format: 'noprod-project', version: 1, savedAt: '2026-10-10T00:00:00Z', project, buffers: enc });
  return new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

test('v1 files load into v2, keys they predate filled in', async () => {
  const take = tone(4800, 220);
  const { scenes: _s, launchQuantization: _q, ...project } = defaults();
  project.regions = [{ id: 'r1', trackId: 't1', file: 'Take', audioBuffer: { $audioBuffer: 'buf0' }, startTime: 1, duration: 0.1 }];
  const blob = await v1File(project, { buf0: { sampleRate: 48000, channels: [take, take] } });
  const { doc, pcm } = await readProjectFile(blob, defaults());
  assert.equal(doc.version, SCHEMA_VERSION);
  assert.deepEqual(doc.buffers, [{ id: 'buf0', sampleRate: 48000, length: 4800, channels: 2 }]);
  assert.deepEqual(doc.project.scenes, defaults().scenes);
  assert.equal(doc.project.launchQuantization, '1 bar');
  assert.deepEqual(doc.project.regions, project.regions);
  assert.ok(sameSamples(pcm[0].channels[1], take));
});

test('v1 files that are damaged are refused', async () => {
  const { tracks: _t, ...noTracks } = defaults();
  await refuses(await v1File(noTracks, {}), /project\.tracks: missing/);
  await refuses(await v1File({ ...defaults(), tracks: null }, {}), /project\.tracks: expected a list/);
  const bad = await v1File(defaults(), { b: { sampleRate: 48000, channels: [tone(10, 1)] } });
  const text = await new Response(bad.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const doc = JSON.parse(text);
  doc.buffers.b.length = 11;
  const gz = (o: any) => new Response(new Blob([JSON.stringify(o)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  await refuses(await gz(doc), /length does not match/);
  await refuses(await gz({ ...doc, version: 3 }), /must be v1/);
  await refuses(new Blob([new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4, 5])]), /damaged/);
});

// ---- hand-built v2 files
const chunk = (tag: string, payload: Uint8Array, length = payload.length) => {
  const h = new Uint8Array(16);
  const v = new DataView(h.buffer);
  h.set([...tag].map((c) => c.charCodeAt(0)));
  v.setUint32(8, length % 2 ** 32, true);
  v.setUint32(12, Math.floor(length / 2 ** 32), true);
  return [h, payload];
};
const header = (version = 1) => {
  const h = new Uint8Array(16);
  h.set(MAGIC);
  new DataView(h.buffer).setUint32(8, version, true);
  return h;
};
const gzipBytes = async (text: string) => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
const pcmChunk = (index: number, channel: number, first: number, samples: Float32Array) => {
  const h = new Uint8Array(16);
  const v = new DataView(h.buffer);
  v.setUint32(0, index, true);
  v.setUint32(4, channel, true);
  v.setUint32(8, first, true);
  const out = new Uint8Array(16 + samples.byteLength);
  out.set(h);
  out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 16);
  return chunk('PCM ', out);
};
const file = async (doc: any, ...rest: Uint8Array[][]) =>
  new Blob([header(), ...chunk('JSON', await gzipBytes(typeof doc === 'string' ? doc : JSON.stringify(doc))), ...rest.flat(), ...chunk('END ', new Uint8Array(0))] as BlobPart[]);
const v2 = (project: any = defaults(), buffers: any[] = []) => ({ format: 'noprod-project', version: 2, buffers, project });

test('files with wrong types are refused, naming the field', async () => {
  await refuses(await file(v2({ ...defaults(), bpm: 'fast' })), /project\.bpm: expected a number/);
  await refuses(await file(v2({ ...defaults(), tracks: null })), /project\.tracks: expected a list/);
  await refuses(await file(v2({ ...defaults(), tracks: [{ ...defaults().tracks[0], type: 'video' }] })), /project\.tracks\[0\]\.type/);
  await refuses(await file(v2({ ...defaults(), sessionClips: { t1: { 0: { duration: '1' } } } })), /sessionClips\.t1\.0\.duration/);
  await refuses(await file(v2({ ...defaults(), timeSignatures: [] })), /timeSignatures: expected at least 1/);
  await refuses(await file(v2({ ...defaults(), bpm: 1e9 })), /bpm: 1000000000 is out of range/);
  await refuses(await file({ ...v2(), format: 'something-else' }), /Not a NoProd project/);
  await refuses(await file('{"format": "noprod-project", '), /not valid JSON/);
  await refuses(await file('[1, 2]'), /Not a NoProd project/);
});

test('files with missing fields are refused, never half-loaded', async () => {
  const { regions: _r, ...noRegions } = defaults();
  await refuses(await file(v2(noRegions)), /project\.regions: missing/);
  await refuses(await file(v2({ ...defaults(), regions: [{ id: 'r', startTime: 0, duration: 1 }] })), /regions\[0\]\.trackId: missing/);
  await refuses(await file({ format: 'noprod-project', version: 2, project: defaults() }), /buffers: expected a list/);
  await refuses(await file({ format: 'noprod-project', buffers: [], project: defaults() }), /no valid version/);
  await refuses(await file(v2({ ...defaults(), regions: [{ id: 'r', trackId: 't1', startTime: 0, duration: 1, audioBuffer: { $audioBuffer: 'nope' } }] })), /audio the file does not hold/);
  // the file must end, and hold every sample it declares
  const one = [{ id: 'b0', sampleRate: 48000, length: 4, channels: 1 }];
  await refuses(await file(v2(defaults(), one)), /missing some of its audio/);
  const whole = await file(v2(defaults(), one), pcmChunk(0, 0, 0, tone(4, 1)));
  assert.ok(await readProjectFile(whole, defaults()));
  await refuses(whole.slice(0, whole.size - 16), /truncated/);
  await refuses(whole.slice(0, whole.size - 30), /truncated/);
});

test('huge declared sizes are refused before anything is allocated', async () => {
  const huge = [{ id: 'b0', sampleRate: 48000, length: 2 ** 31 - 1, channels: 32 }];
  await refuses(await file(v2(defaults(), huge)), /declares more audio than it holds/);
  await refuses(await file(v2(defaults(), [{ id: 'b0', sampleRate: 48000, length: 2 ** 40, channels: 1 }])), /buffers\[0\]\.length/);
  await refuses(await file(v2(defaults(), [{ id: 'b0', sampleRate: 1, length: 1, channels: 1 }])), /sampleRate/);
  await refuses(await file(v2(defaults(), [{ id: 'b0', sampleRate: 48000, length: 1, channels: 1000 }])), /channels/);
  // a chunk claiming more bytes than the file has, or more than 2^53
  await refuses(new Blob([header(), ...chunk('JSON', new Uint8Array(8), 2 ** 40)] as BlobPart[]), /truncated/);
  await refuses(new Blob([header(), ...chunk('JSON', new Uint8Array(8), 2 ** 60)] as BlobPart[]), /impossible size/);
  // a gzip bomb: 300 MB of JSON in a few hundred KB
  const bomb = `{"format":"noprod-project","pad":"${' '.repeat(300 << 20)}"}`;
  await refuses(await file(bomb), /larger than NoProd accepts/);
});

test('audio chunks must belong where they say', async () => {
  const one = [{ id: 'b0', sampleRate: 48000, length: 4, channels: 1 }];
  await refuses(await file(v2(defaults(), one), pcmChunk(1, 0, 0, tone(4, 1))), /does not declare/);
  await refuses(await file(v2(defaults(), one), pcmChunk(0, 1, 0, tone(4, 1))), /does not declare/);
  await refuses(await file(v2(defaults(), one), pcmChunk(0, 0, 2, tone(4, 1))), /misplaced/);
  await refuses(await file(v2(defaults(), one), pcmChunk(0, 0, 0, tone(2, 1)), pcmChunk(0, 0, 0, tone(2, 1))), /misplaced/);
  await refuses(await file(v2(defaults(), one), pcmChunk(0, 0, 0, tone(5, 1))), /misplaced/);
  await refuses(new Blob([header(), ...pcmChunk(0, 0, 0, tone(4, 1))] as BlobPart[]), /audio before its project/);
});

test('newer files are refused with a reason; optional chunks are skipped', async () => {
  await refuses(new Blob([header(2), ...chunk('END ', new Uint8Array(0))] as BlobPart[]), /newer NoProd \(container v2\)/);
  await refuses(await file({ ...v2(), version: SCHEMA_VERSION + 1 }), /newer NoProd \(project v3\)/);
  await refuses(await file(v2(), chunk('WAVE', new Uint8Array(4))), /needs a newer NoProd/);
  const skipped = await file(v2(), chunk('note', new Uint8Array(4)));
  assert.deepEqual((await readProjectFile(skipped, defaults())).doc.project, defaults());
  await refuses(new Blob([new TextEncoder().encode('hello, not a project')]), /Not a NoProd project/);
});

test('only known project keys reach the store, and deep nesting is refused', async () => {
  const { doc } = await readProjectFile(await file(v2({ ...defaults(), undo: 'boom', isPlaying: true })), defaults());
  assert.deepEqual(Object.keys(doc.project).sort(), [...SCHEMA_KEYS].sort());
  const depth = 100000;
  const racks = `${'{"id":"r","name":"Rack","devices":['.repeat(depth)}${']}'.repeat(depth)}`;
  const deep = JSON.stringify(v2({ ...defaults(), savedRacks: ['RACKS'] })).replace('"RACKS"', racks);
  await refuses(await file(deep), /nested too deeply|not valid JSON/);
  await refuses(await file(v2({ ...defaults(), savedRacks: [{ id: 'x', devices: [] }] })), /savedRacks\[0\]\.name: missing/);
  const dup = [{ id: 'b0', sampleRate: 48000, length: 1, channels: 1 }, { id: 'b0', sampleRate: 48000, length: 1, channels: 1 }];
  await refuses(await file(v2(defaults(), dup)), /share an id/);
});
