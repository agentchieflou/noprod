import { GM_DRUM_NAMES, findSound, type DrumKit, type SoundRecipe } from '@noprod/sound';
import { useDAWStore } from '../store/useDAWStore';
import { kitSounds, libraryOf } from '../audio/library';

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

export const defaultColumns = (): MapColumn[] =>
  DEFAULTS.map((id) => findSound(id)).filter((r): r is SoundRecipe => !!r).map(scratchColumn);

export const savedColumns = (): MapColumn[] => saved ?? defaultColumns();

export const saveColumns = (columns: MapColumn[]) => { saved = columns; };

export const savedNote = () => savedNoteValue;
export const saveNote = (note: number) => { savedNoteValue = note; };

// Each column's recipe as it was when it joined the map (a track's, when it
// became the selected one), for A/B and Revert. Keyed by the column's key,
// and by the pad too for a kit.
const originals = new Map<string, SoundRecipe>();
const originalKey = (key: string, pad: string | null) => (pad ? `${key}#${pad}` : key);

export const originalOf = (key: string, pad: string | null, recipe: SoundRecipe): SoundRecipe => {
  const k = originalKey(key, pad);
  if (!originals.has(k)) originals.set(k, structuredClone(recipe));
  return originals.get(k)!;
};
const dropOriginals = (key: string) => {
  for (const k of [...originals.keys()]) if (k.split('#')[0] === key) originals.delete(k);
};

// The selected track's original is its recipe when it became selected, so an
// edit made elsewhere before the map opens still shows as a change.
const isColumn = (trackId: string) => !!saved?.some((c) => c.kind === 'track' && c.trackId === trackId);
useDAWStore.subscribe((state: any, prev: any) => {
  if (state.selectedTrackId === prev.selectedTrackId) return;
  if (prev.selectedTrackId && !isColumn(prev.selectedTrackId)) dropOriginals(`track:${prev.selectedTrackId}`);
  const id = state.selectedTrackId;
  const lib = libraryOf(state.tracks.find((t: any) => t.id === id)?.instrument?.parameters);
  if (!lib || isColumn(id)) return;
  if (lib.kit) for (const [pad, sound] of Object.entries(lib.sounds ?? {})) originals.set(originalKey(`track:${id}`, pad), structuredClone(sound as SoundRecipe));
  else if (lib.sound) originals.set(`track:${id}`, structuredClone(lib.sound));
});

// Columns that left the map take their original with them
export const keepOriginals = (keys: string[]) => {
  for (const k of [...originals.keys()]) if (!keys.includes(k.split('#')[0])) originals.delete(k);
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
export const selectedPads = () => savedPads;
export const saveSelectedPads = (pads: Record<string, string>) => { savedPads = pads; };
