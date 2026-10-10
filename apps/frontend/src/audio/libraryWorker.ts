// Renders library notes off the main thread for library.ts's prewarm. Same
// renderer, same samples: a note rendered here or on demand sounds the same.

import { render, type RenderOptions, type SoundRecipe } from '@noprod/sound';

// Recipes arrive as copies; keep one object per recipe so its loudness is
// measured once (render caches it per object)
const recipes = new Map<string, SoundRecipe>();

self.onmessage = (e: MessageEvent<{ id: number; recipe: SoundRecipe; options: RenderOptions }>) => {
  const { id, recipe, options } = e.data;
  const json = JSON.stringify(recipe);
  let same = recipes.get(json);
  if (!same) recipes.set(json, (same = recipe));
  const { left, right } = render(same, options);
  (self as unknown as Worker).postMessage({ id, left, right }, [left.buffer, right.buffer]);
};
