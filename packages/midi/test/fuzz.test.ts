import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMidiFile, writeMidiFile, MidiFileError } from '../src/index.ts';
import { smf, track, ev, tempoEv, meterEv, chunk, vlq } from './helpers.ts';

// Seeded, so a failing mutation reruns
function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// A valid file with a bit of everything: running status, metas, sysex, a second track
const valid = smf(1, 480, [
  track([tempoEv(0, 120), meterEv(0, 3, 2), ev(0, 0xff, 3, 1, 0x54), ev(0, 0xff, 6, 2, 0x4d, 0x31), ev(480, 0xf0, ...vlq(2), 1, 0xf7), tempoEv(480, 90)]),
  track([
    ev(0, 0xc0, 5), ev(0, 0x90, 60, 100), ev(0, 64, 90), ev(480, 60, 0), ev(0, 64, 0),
    ev(0, 0xb0, 7, 90), ev(10, 0xe0, 0, 64), ev(10, 0xd0, 50), ev(0, 0xa0, 60, 3), ev(240, 0x80, 60, 40),
  ]),
]);

test('2000 seeded mutations either read or throw a MidiFileError, each under 50 ms', () => {
  const rand = random(203);
  const pick = (n: number) => Math.floor(rand() * n);
  const seen = { read: 0, refused: 0 };
  for (let i = 0; i < 2000; i++) {
    let bytes = Array.from(valid);
    switch (i % 4) {
      case 0:   // flipped bytes
        for (let k = 1 + pick(4); k > 0; k--) bytes[pick(bytes.length)] = pick(256);
        break;
      case 1:   // truncation
        bytes = bytes.slice(0, pick(bytes.length));
        break;
      case 2: { // a spliced chunk: part of the file copied somewhere else, or random bytes inserted
        const from = pick(bytes.length), to = from + 1 + pick(40);
        const piece = rand() < 0.5 ? bytes.slice(from, to) : Array.from({ length: 1 + pick(12) }, () => pick(256));
        bytes.splice(pick(bytes.length), 0, ...piece);
        break;
      }
      default: { // a whole chunk dropped in, or a bit flipped in the header or a length
        if (rand() < 0.5) bytes.splice(14 + pick(bytes.length - 14), 0, ...chunk(rand() < 0.5 ? 'MTrk' : 'XXXX', Array.from({ length: pick(20) }, () => pick(256))));
        else bytes[pick(22)] ^= 1 << pick(8);
      }
    }
    const started = performance.now();
    try {
      readMidiFile(Uint8Array.from(bytes));
      seen.read++;
    } catch (e) {
      assert.ok(e instanceof MidiFileError, `mutation ${i} threw ${e}`);
      seen.refused++;
    }
    const took = performance.now() - started;
    assert.ok(took < 50, `mutation ${i} took ${took.toFixed(1)} ms`);
  }
  // The test means something only if both outcomes happen
  assert.ok(seen.read > 100 && seen.refused > 100, JSON.stringify(seen));
});

test('what the writer writes survives the same treatment', () => {
  const rand = random(7);
  const bytes = writeMidiFile({ tracks: [{ name: 'x', notes: [{ pitch: 60, start: 0, length: 1, velocity: 1, channel: 0 }], controllers: [], pitchBend: [], programs: [], channelPressure: [] }] });
  for (let i = 0; i < 300; i++) {
    const mutated = Uint8Array.from(bytes);
    mutated[Math.floor(rand() * mutated.length)] = Math.floor(rand() * 256);
    try { readMidiFile(mutated); } catch (e) { assert.ok(e instanceof MidiFileError, `${e}`); }
  }
});
