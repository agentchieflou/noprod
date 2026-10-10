import { findSound, type SoundRecipe } from '@noprod/sound';

// The DSP Map's columns (#80): the selected track always, then any tracks
// and library sounds added. A library sound is edited as a scratch copy.
export type MapColumn =
  | { kind: 'track'; trackId: string }
  | { kind: 'scratch'; key: string; recipe: SoundRecipe };

// With nothing chosen: the four instruments of the classic DSP map
const DEFAULTS = ['violin', 'trumpet-modeled', 'flute-modeled', 'guitar-nylon-modeled'];

export const scratchColumn = (recipe: SoundRecipe): MapColumn =>
  ({ kind: 'scratch', key: `${recipe.id}-${Math.random().toString(36).slice(2, 7)}`, recipe: structuredClone(recipe) });

// Kept while the panel is closed (the bottom panel unmounts its tabs)
let saved: MapColumn[] | null = null;
let savedNoteValue = 67; // G4: in range for all four

export const savedColumns = (): MapColumn[] =>
  saved ?? DEFAULTS.map((id) => findSound(id)).filter((r): r is SoundRecipe => !!r).map(scratchColumn);

export const saveColumns = (columns: MapColumn[]) => { saved = columns; };

export const savedNote = () => savedNoteValue;
export const saveNote = (note: number) => { savedNoteValue = note; };
