// Library work off the main thread: rendering notes (prewarm, the Sound
// Designer) and resynthesizing recordings. Same code, same results, as on
// the main thread.

import { render, resynthesize, type RenderOptions, type SoundRecipe } from '@noprod/sound';

// Recipes arrive as copies; keep one object per recipe so its loudness is
// measured once (render caches it per object)
const recipes = new Map<string, SoundRecipe>();

type Message =
  | { id: number; kind?: 'render'; recipe: SoundRecipe; options: RenderOptions }
  | { id: number; kind: 'resynth'; samples: Float32Array; sampleRate: number; name: string; recipeId: string };

self.onmessage = (e: MessageEvent<Message>) => {
  const post = (data: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(data, transfer);
  const m = e.data;
  if (m.kind === 'resynth') {
    post({ id: m.id, recipe: resynthesize(m.samples, m.sampleRate, { name: m.name, id: m.recipeId }) });
    return;
  }
  const json = JSON.stringify(m.recipe);
  let same = recipes.get(json);
  if (!same) recipes.set(json, (same = m.recipe));
  const { left, right } = render(same, m.options);
  post({ id: m.id, left, right }, [left.buffer, right.buffer]);
};
