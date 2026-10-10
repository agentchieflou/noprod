// The library: every built-in sound and kit.

import type { Category, SoundRecipe } from '../types.ts';
import { DRUMS } from './drums.ts';
import { PERCUSSION } from './percussion.ts';
import { KITS } from './kits.ts';
import { TONAL } from './tonal.ts';

export { KITS, GM_DRUM_NAMES } from './kits.ts';
export type { DrumKit, KitPad } from './kits.ts';
export {
  STRUDEL_DRUMS, STRUDEL_SYNTHS, STRUDEL_DRUM_NAMES, strudelSound, strudelKit, strudelNoteToMidi, strudelParts
} from './strudel.ts';
export type { StrudelHap, StrudelPart } from './strudel.ts';

export const LIBRARY: SoundRecipe[] = [...DRUMS, ...PERCUSSION, ...TONAL];

export const CATEGORY_NAMES: Record<Category, string> = {
  drums: 'Drums', percussion: 'Percussion', bass: 'Bass', keys: 'Keys', mallets: 'Mallets',
  plucks: 'Plucks', leads: 'Leads', pads: 'Pads', strings: 'Strings', brass: 'Brass', winds: 'Winds', fx: 'FX'
};

const byId = new Map(LIBRARY.map((r) => [r.id, r]));

export const findSound = (id: string): SoundRecipe | undefined => byId.get(id);
export const findKit = (id: string) => KITS.find((k) => k.id === id);
