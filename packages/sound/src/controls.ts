// What decides how a sound plays live (#106), apart from the live note
// itself (live.ts): whether it plays live at all, whether it slurs, and the
// player's controls. Light enough for the main thread to use without the
// renderer.

import type { SoundRecipe } from './types.ts';

// A pitched sound whose layers are all physical models plays live
export const playsLive = (recipe: SoundRecipe) =>
  recipe.pitched && recipe.layers.some((l) => !l.mute) && recipe.layers.every((l) => l.mute || l.type === 'model');

// Slurred from note to note (one voice) rather than a voice a note
export const legato = (recipe: SoundRecipe) => recipe.legato ?? recipe.layers.every((l) =>
  l.mute || (l.type === 'model' && (l.exciter.kind === 'lips' || l.exciter.kind === 'jet' || l.exciter.kind === 'reed')));

// What a player's controls move in a live note (#106), as data, so the DSP
// Map and the Sound Designer can show it. `to`: the player's input to a bow
// or breath (0..1, as the envelope is), vibrato added (cents, full scale
// `range`), or a bend (semitones, full scale `range`, either way). Each is
// followed smoothly, reaching a move in `smoothing` seconds.
export type LiveTarget = 'input' | 'vibrato' | 'bend';

export interface LiveControl {
  label: string;
  from: { type: 'cc'; controller: number } | { type: 'pressure' } | { type: 'bend' };
  to: LiveTarget;
  range: number;
  smoothing: number;
}

export const LIVE_CONTROLS: LiveControl[] = [
  { label: 'Breath', from: { type: 'cc', controller: 2 }, to: 'input', range: 1, smoothing: 0.03 },
  { label: 'Expression', from: { type: 'cc', controller: 11 }, to: 'input', range: 1, smoothing: 0.03 },
  { label: 'Aftertouch', from: { type: 'pressure' }, to: 'input', range: 1, smoothing: 0.03 },
  { label: 'Mod wheel', from: { type: 'cc', controller: 1 }, to: 'vibrato', range: 40, smoothing: 0.15 },
  { label: 'Pitch bend', from: { type: 'bend' }, to: 'bend', range: 2, smoothing: 0.01 }
];

// What a MIDI control event moves, and to what (`value`: 0..1, a bend -1..1)
export function liveControl(event: { type: string; controller?: number; value?: number }): { to: LiveTarget; value: number; smoothing: number } | null {
  const control = LIVE_CONTROLS.find((c) => c.from.type === event.type && (c.from.type !== 'cc' || c.from.controller === event.controller));
  if (!control || event.value === undefined) return null;
  return { to: control.to, value: event.value * control.range, smoothing: control.smoothing };
}
