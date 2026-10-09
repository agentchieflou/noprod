// MIDI effects: note transforms that sit before a MIDI track's instrument
// (track.midiEffects, in order). They apply to clip playback and to live
// MIDI input; recording keeps what was actually played.

import type { ParamSpec } from './devices';

export interface MidiNote { pitch: number; velocity: number; start: number; end: number; id?: string }

interface MidiEffectDef {
  kind: string;
  name: string;
  description: string;
  params: ParamSpec[];
  apply(notes: MidiNote[], p: Record<string, any>): MidiNote[];
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SCALES: Record<string, number[]> = {
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  'Major Pentatonic': [0, 2, 4, 7, 9],
  'Minor Pentatonic': [0, 3, 5, 7, 10],
  Blues: [0, 3, 5, 6, 7, 10]
};

// Seeded so a clip's randomized velocities don't change on every loop pass
const hash = (n: MidiNote) => {
  let h = Math.imul(Math.round(n.start * 1000) ^ (n.pitch * 2654435761), 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) % 10000) / 10000;
};

export const MIDI_EFFECT_DEFS: Record<string, MidiEffectDef> = {
  chord: {
    kind: 'chord',
    name: 'Chord',
    description: 'Adds up to three transposed copies of every note',
    params: [1, 2, 3].map((i) => ({ name: `Shift ${i}`, min: -24, max: 24, step: 1, unit: 'st', default: i === 1 ? 4 : i === 2 ? 7 : 0 })),
    apply(notes, p) {
      const shifts = [p['Shift 1'], p['Shift 2'], p['Shift 3']].map(Number).filter((s) => s);
      return notes.flatMap((n) => [n, ...shifts.map((s) => ({ ...n, pitch: n.pitch + s, id: `${n.id}+${s}` }))]);
    }
  },
  scale: {
    kind: 'scale',
    name: 'Scale',
    description: 'Moves every note onto the nearest note of a key and scale',
    params: [
      { name: 'Root', kind: 'enum', options: NOTE_NAMES, default: 'C' },
      { name: 'Scale', kind: 'enum', options: Object.keys(SCALES), default: 'Major' }
    ],
    apply(notes, p) {
      const root = Math.max(0, NOTE_NAMES.indexOf(String(p.Root)));
      const degrees = SCALES[String(p.Scale)] || SCALES.Major;
      const snap = (pitch: number) => {
        for (let d = 0; d < 12; d++) {
          // prefer the note below on ties, like Live's Scale device
          if (degrees.includes(((pitch - d - root) % 12 + 12) % 12)) return pitch - d;
          if (degrees.includes(((pitch + d - root) % 12 + 12) % 12)) return pitch + d;
        }
        return pitch;
      };
      return notes.map((n) => ({ ...n, pitch: snap(n.pitch) }));
    }
  },
  velocity: {
    kind: 'velocity',
    name: 'Velocity',
    description: 'Scales, randomizes and limits note velocities',
    params: [
      { name: 'Drive', min: 0, max: 200, step: 1, unit: '%', default: 100 },
      { name: 'Random', min: 0, max: 100, step: 1, unit: '%', default: 0 },
      { name: 'Out Lo', min: 1, max: 127, step: 1, default: 1 },
      { name: 'Out Hi', min: 1, max: 127, step: 1, default: 127 }
    ],
    apply(notes, p) {
      const lo = Number(p['Out Lo']) / 127, hi = Math.max(lo, Number(p['Out Hi']) / 127);
      return notes.map((n) => {
        const r = (hash(n) * 2 - 1) * (Number(p.Random) / 100) * 0.5;
        const v = n.velocity * (Number(p.Drive) / 100) + r;
        return { ...n, velocity: Math.max(lo, Math.min(hi, v)) };
      });
    }
  }
};

export const createMidiEffect = (kind: string) => {
  const def = MIDI_EFFECT_DEFS[kind];
  const parameters: Record<string, any> = {};
  def.params.forEach((p) => { parameters[p.name] = p.default; });
  return { name: def.name, type: 'midi-fx', kind, parameters };
};

// Run notes through a track's MIDI effect chain
export function applyMidiEffects(notes: MidiNote[], effects: any[] | undefined): MidiNote[] {
  if (!effects?.length) return notes;
  return effects.reduce((acc, fx) => {
    const def = MIDI_EFFECT_DEFS[fx.kind];
    if (!def || fx.enabled === false) return acc;
    return def.apply(acc, { ...Object.fromEntries(def.params.map((p) => [p.name, p.default])), ...fx.parameters })
      .filter((n) => n.pitch >= 0 && n.pitch <= 127);
  }, notes);
}
