// What the library's workers do (see libraryWorker.ts): render notes (prewarm,
// playback, the Sound Designer), measure what a live physical model needs,
// and resynthesize recordings. Where workers can't run, the main thread
// loads this and does the same, so the renderer only loads there then.

import { liveTunings, loudnessGain, render, resynthesize, type RenderOptions, type SoundRecipe } from '@noprod/sound';

export type LibraryJob =
  | { kind?: 'render'; recipe: SoundRecipe; options: RenderOptions }
  | { kind: 'live'; recipe: SoundRecipe; sampleRate: number; notes: { note: number; velocity: number; transpose: number }[] }
  | { kind: 'resynth'; samples: Float32Array; sampleRate: number; name: string; recipeId: string };

// Recipes arrive as copies; keep one object per recipe so its loudness is
// measured once (render caches it per object), for the last few recipes
// (the Sound Designer sends a new one with every edit)
const RECIPES = 64;
const recipes = new Map<string, SoundRecipe>();

function same(recipe: SoundRecipe) {
  const json = JSON.stringify(recipe);
  let kept = recipes.get(json);
  if (kept) recipes.delete(json);
  else kept = recipe;
  recipes.set(json, kept);
  for (const key of recipes.keys()) {
    if (recipes.size <= RECIPES) break;
    recipes.delete(key);
  }
  return kept;
}

// The reply, and the buffers it can hand over rather than copy
export function runJob(m: LibraryJob): { data: Record<string, unknown>; transfer: Transferable[] } {
  if (m.kind === 'resynth') {
    return { data: { recipe: resynthesize(m.samples, m.sampleRate, { name: m.name, id: m.recipeId }) }, transfer: [] };
  }
  const recipe = same(m.recipe);
  if (m.kind === 'live') {
    // the sound's level, as `render` normalizes it, and each note's loop tunings
    const gain = loudnessGain(recipe, m.sampleRate) * Math.pow(10, (recipe.gain ?? 0) / 20);
    const tunings = m.notes.map((n) => liveTunings(recipe, n.note, n.velocity, m.sampleRate, n.transpose));
    return { data: { gain, tunings }, transfer: [] };
  }
  const { left, right } = render(recipe, m.options);
  return { data: { left, right }, transfer: [left.buffer, right.buffer] };
}
