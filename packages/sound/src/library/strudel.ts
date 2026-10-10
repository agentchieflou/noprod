// Strudel's sound names, as library sounds (#68): what AI dictation's
// patterns (s("bd sd"), note("c3 e3").s("sawtooth")) play in the DAW.

import { GM_DRUM_NAMES } from './kits.ts';

// Drum names (Strudel's, plus plain words) on General MIDI drum notes
export const STRUDEL_DRUMS: Record<string, number> = {
  bd: 36, kick: 36, sd: 38, snare: 38, rim: 37, rs: 37, cp: 39, clap: 39,
  hh: 42, ch: 42, hihat: 42, oh: 46, lt: 45, mt: 47, ht: 50, tom: 47,
  cr: 49, crash: 49, rd: 51, ride: 51, cb: 56, cowbell: 56, sh: 70, shaker: 70,
  tb: 54, tambourine: 54, perc: 75, misc: 76
};

// Melodic names: the first pattern found in a name picks its sound (so
// "gm_epiano1" is an electric piano and "piano" a grand)
const SOUNDS: [RegExp, string][] = [
  [/supersaw/, 'lead-supersaw'],
  [/saw/, 'lead-saw'],
  [/square|pulse/, 'lead-square'],
  [/^tri(angle)?$/, 'lead-triangle'],
  [/^sine$/, 'lead-sine'],
  [/epiano|e_piano|rhodes|electric_piano/, 'piano-electric'],
  [/wurli/, 'piano-wurli'],
  [/clav/, 'clav'],
  [/harpsichord/, 'harpsichord'],
  [/piano/, 'piano-grand'],
  [/church_organ|pipe_organ|reed_organ/, 'organ-church'],
  [/organ/, 'organ-drawbar'],
  [/acid|303/, 'bass-acid'],
  [/reese/, 'bass-reese'],
  [/sub/, 'bass-sub'],
  [/fm_?bass/, 'bass-fm'],
  [/contrabass|double_?bass/, 'double-bass'],
  [/finger|electric_bass|fretless|acoustic_bass|upright/, 'bass-finger'],
  [/bass/, 'bass-pluck'],
  [/pizz/, 'pizzicato'],
  [/violin|fiddle/, 'violin'],
  [/viola/, 'viola'],
  [/cello/, 'cello'],
  [/string/, 'strings-ensemble'],
  [/trumpet/, 'brass-trumpet'],
  [/trombone/, 'trombone'],
  [/french_?horn|^horn$/, 'french-horn'],
  [/brass|horn|tuba/, 'brass-section'],
  [/pan_?flute/, 'pan-flute'],
  [/recorder/, 'recorder'],
  [/flute|piccolo/, 'flute'],
  [/clarinet|oboe|bassoon|sax/, 'clarinet'],
  [/choir|voice|aah|ooh/, 'pad-choir'],
  [/pad/, 'pad-warm'],
  [/marimba|xylophone/, 'marimba'],
  [/vibraphone|vibes/, 'vibraphone'],
  [/glock/, 'glockenspiel'],
  [/celesta|music_?box/, 'music-box'],
  [/kalimba|mbira/, 'kalimba'],
  [/guitar_steel|steel_guitar|steel_string/, 'guitar-steel'],
  [/steel/, 'steel-drum'],
  [/tubular|chime|bell/, 'bell-tubular'],
  [/harp/, 'harp'],
  [/banjo/, 'banjo'],
  [/dulcimer/, 'dulcimer'],
  [/koto/, 'koto'],
  [/guitar/, 'guitar-nylon'],
  [/pluck/, 'pluck-synth'],
  [/chip|8bit/, 'lead-chip'],
  [/lead|synth/, 'lead-saw']
];

// The names AI dictation is told about (apps/orchestrator's prompt lists these)
export const STRUDEL_SYNTHS = [
  'sawtooth', 'square', 'triangle', 'sine', 'supersaw', 'piano', 'epiano', 'organ', 'clav', 'harpsichord',
  'bass', 'sub', 'acid', 'reese', 'strings', 'violin', 'viola', 'cello', 'contrabass', 'pizzicato', 'brass', 'trumpet',
  'trombone', 'horn', 'flute', 'recorder', 'clarinet', 'choir',
  'pad', 'marimba', 'vibraphone', 'glockenspiel', 'kalimba', 'steeldrum', 'musicbox', 'bell', 'harp', 'koto',
  'guitar', 'banjo', 'dulcimer', 'pluck', 'chip'
];
export const STRUDEL_DRUM_NAMES = ['bd', 'sd', 'rim', 'cp', 'hh', 'oh', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'sh', 'tb', 'perc'];

// Strudel plays a note with no sound name on its triangle synth
const DEFAULT_SYNTH = 'lead-triangle';

// What a hap plays: a drum (a GM note on a kit) or a library sound, or
// nothing if the name means nothing to the library
export function strudelSound(name: string | undefined, pitched: boolean): { drum?: number; sound?: string } {
  const s = (name ?? '').toLowerCase().replace(/[:\s].*$/, '');
  if (!s) return pitched ? { sound: DEFAULT_SYNTH } : {};
  if (!pitched && STRUDEL_DRUMS[s] !== undefined) return { drum: STRUDEL_DRUMS[s] };
  for (const [pattern, sound] of SOUNDS) if (pattern.test(s)) return { sound };
  if (pitched) return { sound: DEFAULT_SYNTH };
  // a sample name that sounds like a drum
  const drum = /kick|bd/.test(s) ? 36 : /snare|sd/.test(s) ? 38 : /clap/.test(s) ? 39 : /hat|hh/.test(s) ? 42
    : /tom/.test(s) ? 47 : /crash|cymbal/.test(s) ? 49 : /ride/.test(s) ? 51 : /perc/.test(s) ? 75 : undefined;
  return drum !== undefined ? { drum } : {};
}

// Strudel's drum machine banks (.bank("RolandTR909")) as library kits
export function strudelKit(bank: string | undefined): string {
  const b = (bank ?? '').toLowerCase();
  if (/909|707|606|electronic/.test(b)) return 'kit-electronic';
  if (/linn|acoustic|oberheim|dmx/.test(b)) return 'kit-acoustic';
  if (/sp12|mpc|lofi|lo-fi|casio/.test(b)) return 'kit-lofi';
  return 'kit-808';
}

// Note names as Strudel reads them ("c3" is MIDI 48, "eb4" 63; s or # sharpens,
// b flattens; the octave defaults to 3), or a number as a MIDI note
export function strudelNoteToMidi(note: string | number | undefined): number | undefined {
  if (typeof note === 'number') return Number.isFinite(note) ? note : undefined;
  if (typeof note !== 'string') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(note.trim())) return Number(note);
  const m = /^([a-gA-G])([#sb]*)(-?\d+)?$/.exec(note.trim());
  if (!m) return undefined;
  const chroma = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
  const accidentals = [...m[2]].reduce((n, c) => n + (c === 'b' ? -1 : 1), 0);
  return (Number(m[3] ?? 3) + 1) * 12 + chroma + accidentals;
}

// One evaluated cycle of a pattern, as the Sequencer sends it
export interface StrudelHap {
  time: number;          // cycles
  duration: number;      // cycles
  s?: string;            // sound name
  pitch?: string | number; // the hap's note value
  bank?: string;
  gain?: number;
  velocity?: number;
  note?: string;         // older Sequencers: note ?? s
}

// The parts a cycle makes: a kit for its drums (per bank), and a sound per
// melodic name, each with its notes (times in cycles)
export interface StrudelPart {
  kind: 'kit' | 'sound';
  id: string;            // kit or sound id
  label: string;         // what the pattern called it
  notes: { pitch: number; start: number; duration: number; velocity: number }[];
}

export function strudelParts(haps: StrudelHap[]): { parts: StrudelPart[]; unmapped: string[] } {
  const parts = new Map<string, StrudelPart>();
  const unmapped = new Set<string>();
  for (const hap of haps) {
    // Older Sequencers sent `note` as the note, or else the sound name
    let name = hap.s;
    let pitch = strudelNoteToMidi(hap.pitch);
    if (name === undefined && hap.pitch === undefined && hap.note !== undefined) {
      pitch = strudelNoteToMidi(hap.note);
      if (pitch === undefined) name = hap.note;
    }
    const target = strudelSound(name, pitch !== undefined);
    const velocity = Math.min(1, Math.max(0.05, (hap.gain ?? 1) * (hap.velocity ?? 0.8)));
    const note = { start: hap.time, duration: Math.max(0.01, hap.duration), velocity };
    if (target.drum !== undefined) {
      const kit = strudelKit(hap.bank);
      const part = parts.get(`kit:${kit}`) ?? { kind: 'kit' as const, id: kit, label: hap.bank || 'Drums', notes: [] };
      part.notes.push({ ...note, pitch: target.drum });
      parts.set(`kit:${kit}`, part);
    } else if (target.sound && pitch !== undefined) {
      const part = parts.get(`sound:${target.sound}`) ?? { kind: 'sound' as const, id: target.sound, label: name || 'triangle', notes: [] };
      part.notes.push({ ...note, pitch });
      parts.set(`sound:${target.sound}`, part);
    } else if (name) {
      unmapped.add(name);
    }
  }
  return { parts: [...parts.values()], unmapped: [...unmapped] };
}

export const strudelDrumLabel = (note: number) => GM_DRUM_NAMES[note] ?? `${note}`;
