// AI dictation, played with library sounds (#68). The provider returns the
// code it wrote (dictation/); our own pattern engine (@noprod/pattern, #133)
// parses it here, no eval, and plays one cycle. Each of its parts (the
// drums, each melodic sound) becomes a MIDI track playing a library kit or
// sound, with a clip that loops that bar.

import { evaluateCycle, DICTATION_LIMITS } from '@noprod/pattern';
import { findKit, findSound, strudelParts, type StrudelHap } from '@noprod/sound';
import { v4 as uuidv4 } from 'uuid';
import { createLibraryInstrument, createLibraryKit } from './library';
import { getPosition } from './transport';

export interface DictationResult {
  tracks: string[];     // the tracks made
  unmapped: string[];   // sound names the library has nothing for
  bpm?: number;         // the tempo the pattern set, if it set one
}

const BARS = 4; // each clip plays its bar this many times

interface Store { getState: () => any }

// One cycle of the code as the parts mapper reads it. Throws a PatternError
// (with a message for the user) when the code doesn't parse or run.
export function dictationHaps(code: string): { haps: StrudelHap[]; cps: number; setsTempo: boolean } {
  const { cps, setsTempo, events } = evaluateCycle(code, DICTATION_LIMITS);
  const haps = events.map(({ time, duration, value }) => ({
    time, duration,
    s: value.s === undefined ? undefined : String(value.s),
    pitch: value.note as string | number | undefined,
    bank: value.bank === undefined ? undefined : String(value.bank),
    gain: typeof value.gain === 'number' ? value.gain : undefined,
    velocity: typeof value.velocity === 'number' ? value.velocity : undefined
  }));
  return { haps, cps, setsTempo };
}

export function applyDictation(store: Store, code: string): DictationResult {
  const { haps, cps, setsTempo } = dictationHaps(code);
  const { parts, unmapped } = strudelParts(haps);

  // One cycle is a bar of four beats; follow the pattern's tempo if it set one
  let bpm: number | undefined;
  if (setsTempo) {
    bpm = Math.round(cps * 240 * 100) / 100;
    if (bpm >= 20 && bpm <= 400) store.getState().setBpm(bpm);
    else bpm = undefined;
  }
  const bar = 240 / (store.getState().bpm || 120);
  const start = getPosition();

  const tracks: string[] = [];
  for (const part of parts) {
    const kit = part.kind === 'kit' ? findKit(part.id) : undefined;
    const sound = part.kind === 'sound' ? findSound(part.id) : undefined;
    const instrument = kit ? createLibraryKit(kit) : sound ? createLibraryInstrument(sound) : null;
    if (!instrument) continue;
    const name = kit ? kit.name : sound!.name;
    store.getState().addMidiTrackWithInstrument(instrument, name);
    const trackId = store.getState().selectedTrackId;
    const notes = part.notes.map((n) => ({
      id: uuidv4(), pitch: n.pitch, start: n.start * bar, duration: Math.min(n.duration, 1 - n.start) * bar, velocity: n.velocity
    }));
    store.getState().addMidiRegion(trackId, start, bar * BARS, notes);
    store.getState().updateClip(store.getState().selectedRegionId, { file: `Dictation: ${part.label}`, loopEnabled: true, loopStart: 0, loopEnd: bar });
    tracks.push(name);
  }
  return { tracks, unmapped, bpm };
}
