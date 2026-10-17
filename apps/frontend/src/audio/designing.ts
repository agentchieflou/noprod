// Library work for the Sound Designer, the DSP Map and the Browser, on the
// Sound Designer's own worker (library.ts): rendering a sound, resynthesizing
// a recording, and exporting sounds as files. Loaded with what uses it.

import type { RenderOptions, RenderedSound, SoundRecipe } from '@noprod/sound';
import { v4 as uuidv4 } from 'uuid';
import { audioContext } from './engine';
import { designPool, previewGain } from './library';

// Render off the main thread (on the Sound Designer's worker)
export function renderSound(recipe: SoundRecipe, options: RenderOptions): Promise<RenderedSound> {
  const sampleRate = options.sampleRate ?? audioContext.sampleRate;
  return designPool().run({ recipe, options: { ...options, sampleRate } }, { timeout: 60000 })
    .then((data: any) => ({ left: data.left, right: data.right, sampleRate }));
}

// A recording as a recipe: partials and noise bands (the first 12 s, mixed to mono)
export function resynthesizeBuffer(buffer: AudioBuffer, name: string): Promise<SoundRecipe> {
  const length = Math.min(buffer.length, Math.round(12 * buffer.sampleRate));
  const samples = new Float32Array(length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) samples[i] += data[i] / buffer.numberOfChannels;
  }
  const recipeId = `resynth-${uuidv4().slice(0, 8)}`;
  return designPool().run({ kind: 'resynth', samples, sampleRate: buffer.sampleRate, name, recipeId }, { transfer: [samples.buffer], timeout: 120000 })
    .then((data: any) => data.recipe);
}

export function toAudioBuffer({ left, right, sampleRate }: RenderedSound) {
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: left.length, sampleRate });
  buffer.copyToChannel(left, 0);
  buffer.copyToChannel(right, 1);
  return buffer;
}

// Plays a rendered sound into `destination` (a track's strip, or the speakers)
export function playRendered(buffer: AudioBuffer, destination: AudioNode = previewGain) {
  if (audioContext.state === 'suspended') audioContext.resume();
  const src = audioContext.createBufferSource();
  src.buffer = buffer;
  src.connect(destination);
  src.start();
  return src;
}

const download = (data: Uint8Array<ArrayBuffer>, name: string, type: string) => {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const fileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Sound';

// A sound as a 24-bit WAV file, at a note (pitched sounds held for a second)
export async function exportWav(recipe: SoundRecipe, note = recipe.root ?? 60, velocity = 1) {
  const [sound, { encodeWav }] = await Promise.all([renderSound(recipe, { note, velocity, gate: recipe.pitched ? 1 : undefined }), import('./fileFormats')]);
  download(encodeWav([sound.left, sound.right], sound.sampleRate, 24) as Uint8Array<ArrayBuffer>, `${fileName(recipe.name)}.wav`, 'audio/wav');
}

// Several sounds as a zip of WAVs
export async function exportZip(name: string, recipes: SoundRecipe[]) {
  const { encodeWav, zip } = await import('./fileFormats');
  const files = [];
  for (const r of recipes) {
    const sound = await renderSound(r, { note: r.root ?? 60, velocity: 1, gate: r.pitched ? 1 : undefined });
    files.push({ name: `${fileName(name)}/${fileName(r.name)}.wav`, data: encodeWav([sound.left, sound.right], sound.sampleRate, 24) });
  }
  download(zip(files) as Uint8Array<ArrayBuffer>, `${fileName(name)}.zip`, 'application/zip');
}
