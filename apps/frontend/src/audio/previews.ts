// The Browser's previews: a sound, or a bar of a kit, played straight to
// the speakers once its notes are rendered, through the engine on an input
// of its own (engine.ts registerInput), as a track's notes play.

import type { DrumKit, SoundRecipe } from '@noprod/sound';
import { audioContext, registerInput } from './engine';
import { renderAhead } from './library';
import { triggerNote } from './synth';

type Stoppable = { stop: (when?: number) => void };

export const previewGain = audioContext.createGain();
previewGain.gain.value = 0.8;
previewGain.connect(audioContext.destination);
registerInput('preview', previewGain);
let previewing: Stoppable[] = [];

// A preview starts when its notes are ready (unless another took its place)
let previewId = 0;

export function stopSoundPreview() {
  previewId++;
  previewing.forEach((s) => { try { s.stop(); } catch { /* not started */ } });
  previewing = [];
}

export async function previewSound(recipe: SoundRecipe, note = recipe.root ?? 60) {
  stopSoundPreview();
  const id = ++previewId;
  if (audioContext.state === 'suspended') audioContext.resume();
  const params = { Kit: 'library', Gain: 1, Library: { sound: recipe } };
  await renderAhead(params, [[note, 0.9, 0.8]]);
  if (id !== previewId) return;
  previewing.push(triggerNote(audioContext, previewGain, params, note, audioContext.currentTime + 0.01, 0.8, 0.9));
}

// A bar of kick, snare and hats
const KIT_PREVIEW = [[36, 42], [42], [38, 42], [42], [36, 42], [36, 42], [38, 42], [46]];
const velocityOf = (note: number) => (note === 42 ? 0.6 : 0.9);

export async function previewKit(kit: DrumKit, sounds: Record<string, SoundRecipe>) {
  stopSoundPreview();
  const id = ++previewId;
  if (audioContext.state === 'suspended') audioContext.resume();
  const params = { Kit: 'library', Gain: 1, Library: { kit, sounds } };
  await renderAhead(params, [...new Set(KIT_PREVIEW.flat())].map((note) => [note, velocityOf(note), 0.1]));
  if (id !== previewId) return;
  const start = audioContext.currentTime + 0.02;
  KIT_PREVIEW.forEach((notes, step) => notes.forEach((note) => {
    previewing.push(triggerNote(audioContext, previewGain, params, note, start + step * 0.2, 0.1, velocityOf(note)));
  }));
}
