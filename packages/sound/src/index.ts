// @noprod/sound: noprod's sound library, built from scratch. Every sound is a
// recipe (an arrangement of frequencies over time) rendered by `render`.

export * from './types.ts';
export { render, loudnessGain, withId } from './render.ts';
export { midiToHz } from './dsp.ts';
export { encodeWav, decodeWav } from './wav.ts';
export type { WavBits, DecodedWav } from './wav.ts';
export { zip, crc32 } from './zip.ts';
export { resynthesize, spectralDistance } from './resynth.ts';
export type { ResynthOptions } from './resynth.ts';
export type { ZipEntry } from './zip.ts';
export * as analysis from './analysis.ts';
export {
  LIBRARY, KITS, GM_DRUM_NAMES, CATEGORY_NAMES, findSound, findKit,
  STRUDEL_DRUMS, STRUDEL_SYNTHS, STRUDEL_DRUM_NAMES, strudelSound, strudelKit, strudelNoteToMidi, strudelParts
} from './library/index.ts';
export type { DrumKit, KitPad, StrudelHap, StrudelPart } from './library/index.ts';
