import { GM_DRUM_NAMES, findSound, type DrumKit, type SoundRecipe } from '@noprod/sound';
import { kitSounds } from '../audio/library';

// The DSP Map's columns (#80): the selected track always, then any tracks
// and library sounds added. A library sound is edited as a scratch copy. A
// kit's column shows one pad's sound at a time (#102): `pad` is its sound id.
export type MapColumn =
  | { kind: 'track'; trackId: string; pad?: string }
  | { kind: 'scratch'; key: string; recipe: SoundRecipe }
  | { kind: 'kit'; key: string; kit: DrumKit; sounds: Record<string, SoundRecipe>; pad?: string };

export const kitColumn = (kit: DrumKit): MapColumn =>
  ({ kind: 'kit', key: `${kit.id}-${Math.random().toString(36).slice(2, 7)}`, kit, sounds: structuredClone(kitSounds(kit)) });

// A kit's pads as the Sound Designer lists them: each sound once, by its GM drum names
export const padOptions = (kit: DrumKit, sounds: Record<string, SoundRecipe> | undefined) =>
  [...new Set(Object.keys(kit.pads).map(Number).sort((a, b) => a - b).map((n) => kit.pads[n].sound))]
    .filter((id) => sounds?.[id])
    .map((id) => {
      const notes = Object.keys(kit.pads).map(Number).filter((n) => kit.pads[n].sound === id);
      return { id, label: `${sounds![id].name} · ${notes.map((n) => GM_DRUM_NAMES[n] || n).slice(0, 2).join(', ')}` };
    });

// Which pad's sound a kit column shows: the chosen one, else the first
export const padOf = (kit: DrumKit, sounds: Record<string, SoundRecipe> | undefined, pad?: string) => {
  const options = padOptions(kit, sounds);
  return (options.find((o) => o.id === pad) ?? options[0])?.id;
};

// With nothing chosen: the four instruments of the classic DSP map
const DEFAULTS = ['violin', 'trumpet-modeled', 'flute-modeled', 'guitar-nylon-modeled'];

export const scratchColumn = (recipe: SoundRecipe): MapColumn =>
  ({ kind: 'scratch', key: `${recipe.id}-${Math.random().toString(36).slice(2, 7)}`, recipe: structuredClone(recipe) });

// Kept while the panel is closed (the bottom panel unmounts its tabs)
let saved: MapColumn[] | null = null;
let savedNoteValue = 67; // G4: in range for all four
let savedPads: Record<string, string> = {}; // the selected track's pad, by track

export const savedColumns = (): MapColumn[] =>
  saved ?? DEFAULTS.map((id) => findSound(id)).filter((r): r is SoundRecipe => !!r).map(scratchColumn);

export const saveColumns = (columns: MapColumn[]) => { saved = columns; };

export const savedNote = () => savedNoteValue;
export const saveNote = (note: number) => { savedNoteValue = note; };

export const selectedPads = () => savedPads;
export const saveSelectedPads = (pads: Record<string, string>) => { savedPads = pads; };
