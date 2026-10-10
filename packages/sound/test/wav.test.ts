import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav, encodeWav } from '../src/index.ts';

const ramp = (n: number, offset = 0) => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37 + offset) * 0.9);
const ascii = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.slice(at, at + 4));

test('a 16-bit file has a standard PCM header', () => {
  const wav = encodeWav([ramp(100), ramp(100, 1)], 48000, 16);
  const view = new DataView(wav.buffer);
  assert.equal(ascii(wav, 0), 'RIFF');
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(ascii(wav, 8), 'WAVE');
  assert.equal(ascii(wav, 12), 'fmt ');
  assert.equal(view.getUint16(20, true), 1);        // PCM
  assert.equal(view.getUint16(22, true), 2);        // channels
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(28, true), 48000 * 4); // byte rate
  assert.equal(view.getUint16(32, true), 4);        // block align
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(wav, 36), 'data');
  assert.equal(view.getUint32(40, true), 400);
  assert.equal(wav.length, 44 + 400);
});

test('samples survive a round trip at every bit depth', () => {
  const channels = [ramp(1001), ramp(1001, 2)];
  for (const [bits, tolerance] of [[16, 1 / 32767], [24, 1 / 8388607], [32, 0]] as const) {
    const { sampleRate, channels: decoded } = decodeWav(encodeWav(channels, 44100, bits));
    assert.equal(sampleRate, 44100);
    assert.equal(decoded.length, 2);
    decoded.forEach((c, ch) => {
      assert.equal(c.length, 1001);
      c.forEach((x, i) => assert.ok(Math.abs(x - channels[ch][i]) <= tolerance + 1e-9, `${bits}-bit sample ${i}`));
    });
  }
});

test('a float file says so and counts its frames', () => {
  const wav = encodeWav([ramp(10)], 44100, 32);
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint16(20, true), 3); // IEEE float
  assert.equal(ascii(wav, 38), 'fact');
  assert.equal(view.getUint32(46, true), 10);
});

test('out-of-range samples clip instead of wrapping, and odd data is padded', () => {
  const { channels } = decodeWav(encodeWav([Float32Array.from([1.5, -1.5, 0])], 8000, 16));
  assert.ok(channels[0][0] > 0.999 && channels[0][1] < -0.999);
  const odd = encodeWav([Float32Array.from([0.5])], 8000, 24);
  assert.equal(odd.length % 2, 0);
  assert.equal(decodeWav(odd).channels[0].length, 1);
});

test('decoding refuses what is not a WAV file', () => {
  assert.throws(() => decodeWav(new Uint8Array(64)), /not a WAV/);
});
