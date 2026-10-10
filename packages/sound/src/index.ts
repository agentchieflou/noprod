// @noprod/sound: noprod's sound library, built from scratch. Every sound is a
// recipe (an arrangement of frequencies over time) rendered by `render`.

export * from './types.ts';
export { render, loudnessGain } from './render.ts';
export { midiToHz } from './dsp.ts';
export { encodeWav, decodeWav } from './wav.ts';
export type { WavBits, DecodedWav } from './wav.ts';
export * as analysis from './analysis.ts';
export { LIBRARY, KITS, GM_DRUM_NAMES, CATEGORY_NAMES, findSound, findKit } from './library/index.ts';
export type { DrumKit, KitPad } from './library/index.ts';
