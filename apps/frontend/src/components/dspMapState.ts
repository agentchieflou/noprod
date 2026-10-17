import { findSound, type SoundRecipe } from '@noprod/sound';
import { useDAWStore } from '../store/useDAWStore';
import { libraryOf } from '../audio/library';

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

// Each column's recipe as it was when it joined the map (a track's, when it
// became the selected one), for A/B and Revert. Keyed by the column's key.
const originals = new Map<string, SoundRecipe>();

export const originalOf = (key: string, recipe: SoundRecipe): SoundRecipe => {
  if (!originals.has(key)) originals.set(key, structuredClone(recipe));
  return originals.get(key)!;
};
// The selected track's original is its recipe when it became selected, so an
// edit made elsewhere before the map opens still shows as a change.
const isColumn = (trackId: string) => !!saved?.some((c) => c.kind === 'track' && c.trackId === trackId);
const soundOf = (state: any, id: string | null) => libraryOf(state.tracks.find((t: any) => t.id === id)?.instrument?.parameters)?.sound;
useDAWStore.subscribe((state: any, prev: any) => {
  if (state.selectedTrackId === prev.selectedTrackId) return;
  if (prev.selectedTrackId && !isColumn(prev.selectedTrackId)) originals.delete(`track:${prev.selectedTrackId}`);
  const sound = soundOf(state, state.selectedTrackId);
  if (sound && !isColumn(state.selectedTrackId)) originals.set(`track:${state.selectedTrackId}`, structuredClone(sound));
});

// Columns that left the map take their original with them
export const keepOriginals = (keys: string[]) => {
  for (const k of [...originals.keys()]) if (!keys.includes(k)) originals.delete(k);
};

// What the last play rendered, for the browser suite to check A against B
export let lastPlayed: { key: string; recipe: SoundRecipe } | null = null;
export const notePlayed = (key: string, recipe: SoundRecipe) => { lastPlayed = { key, recipe }; };

// Deep equality for plain recipe data (key order and undefined fields don't count)
export const sameRecipe = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if (!sameRecipe(x[k], y[k])) return false;
  return true;
};
