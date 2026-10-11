// Fingerprints of every library sound as rendered (#108): an engine change
// that should leave the existing sounds alone is checked against them, to
// the bit. After changing a sound on purpose, write them again:
//
//   node test/renders.ts --write

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { render } from '../src/index.ts';
import { LIBRARY } from '../src/library/index.ts';
import type { SoundRecipe } from '../src/index.ts';

export const FILE = new URL('./renders.json', import.meta.url);

// Its root at full velocity, and (pitched) an octave down, softer
export function fingerprint(recipe: SoundRecipe) {
  const hash = createHash('sha256');
  const takes = [render(recipe, { sampleRate: 44100 })];
  if (recipe.pitched) takes.push(render(recipe, { sampleRate: 44100, note: (recipe.root ?? 60) - 12, velocity: 0.5, gate: 0.5 }));
  for (const { left, right } of takes) {
    hash.update(new Uint8Array(left.buffer, left.byteOffset, left.byteLength));
    hash.update(new Uint8Array(right.buffer, right.byteOffset, right.byteLength));
  }
  return hash.digest('hex').slice(0, 16);
}

if (process.argv.includes('--write')) {
  const prints = Object.fromEntries(LIBRARY.map((r) => [r.id, fingerprint(r)]));
  writeFileSync(FILE, JSON.stringify(prints, null, 2) + '\n');
  console.log(`${Object.keys(prints).length} sounds`);
}
