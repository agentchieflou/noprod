import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, zip } from '../src/index.ts';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('a zip lists every file and stores them intact', () => {
  const files = [
    { name: 'Drums/808 Kick.wav', data: Uint8Array.from({ length: 1000 }, (_, i) => i % 251) },
    { name: 'Keys/Grand Piano.wav', data: new TextEncoder().encode('hello') }
  ];
  const archive = zip(files);
  const view = new DataView(archive.buffer);
  const end = archive.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  assert.equal(view.getUint32(0, true), 0x04034b50);

  // Any unzip agrees, when one is installed
  let unzip = '';
  try { unzip = execFileSync('which', ['unzip']).toString().trim(); } catch { /* none */ }
  if (!unzip) return;
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  writeFileSync(join(dir, 'a.zip'), archive);
  execFileSync(unzip, ['-q', join(dir, 'a.zip'), '-d', join(dir, 'out')]);
  files.forEach((f) => assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'out', f.name))), f.data));
});
