// The Keyboard Coach: follows what's played (held notes, the melody, the
// chords, the key) and says which keys to play next, as highlights on the
// keyboard and a short readout. Same notes in, same suggestions out.

import { chordFamily, recognizeChord, romanNumeral, type Chord, type ChordQuality } from './chords.ts';
import { complements } from './complement.ts';
import { nextChords } from './harmony.ts';
import { findKey, KeyTracker } from './keys.ts';
import { findLesson, LessonRunner } from './lessons.ts';
import { nextNotes } from './melody.ts';
import { fitRange, pc, pitchClasses } from './notes.ts';
import { keyName, spellInKey, type Key } from './scales.ts';
import { voiceLead } from './voicing.ts';

export type CoachMode = 'off' | 'chords' | 'melody' | 'complement' | 'lesson';

export interface Highlight {
  pitch: number;
  role: 'next' | 'complement' | 'target' | 'wrong' | 'held';
  weight: number;    // 0..1
  label?: string;
  group?: number;    // which suggestion (chords mode: one group per chord)
}

export interface CoachReadout {
  key: Key;
  keyName: string;
  chord: Chord | null;
  roman: string | null;
  message: string;
  suggestions: { label: string; pitches: number[]; weight: number }[];
  lesson: { id: string; name: string; step: number; total: number; label: string; done: boolean } | null;
}

export interface CoachOptions {
  mode?: CoachMode;
  key?: Key | 'auto';
  range?: [number, number];
}

const C_MAJOR: Key = { tonic: 0, mode: 'major' };
const RECENT_NOTES = 16;
const RECENT_CHORDS = 8;
// The auto key stays C major until there's something to go on
const AUTO_KEY_NOTES = 8;
const AUTO_KEY_PITCH_CLASSES = 4;
// Keys that fit within this of the best are a toss-up
const KEY_TIE = 0.06;

interface Played {
  root: number;
  quality: ChordQuality;
  pitches: number[];
}

interface Advice {
  highlights: Highlight[];
  message: string;
  suggestions: CoachReadout['suggestions'];
}

export class Coach {
  private mode: CoachMode;
  private keySetting: Key | 'auto';
  private range: [number, number];
  private readonly tracker = new KeyTracker();
  private readonly down = new Map<number, number>();   // held pitch → time pressed
  private readonly wrong = new Set<number>();          // lesson notes pressed wrongly, still held
  private recent: number[] = [];
  private chords: Played[] = [];
  private notesSeen = 0;
  private readonly pitchClassesSeen = new Set<number>();
  private chordHeld = false;   // the last chord recorded is still held
  private runner: LessonRunner | null = null;

  constructor(options: CoachOptions = {}) {
    this.mode = options.mode ?? 'off';
    this.keySetting = options.key ?? 'auto';
    this.range = options.range ?? [48, 84];
  }

  setMode(mode: CoachMode) {
    this.mode = mode;
    this.wrong.clear();
  }

  setKey(key: Key | 'auto') {
    this.keySetting = key;
  }

  setRange(range: [number, number]) {
    this.range = [range[0], range[1]];
  }

  setLesson(id: string | null) {
    const lesson = id ? findLesson(id) : null;
    this.runner = lesson ? new LessonRunner(lesson) : null;
    this.wrong.clear();
  }

  // The key suggestions are in: the lesson's, the fixed one, or the one
  // the notes played point to
  key(): Key {
    if (this.mode === 'lesson' && this.runner) return this.runner.lesson.key;
    if (this.keySetting !== 'auto') return this.keySetting;
    if (this.notesSeen < AUTO_KEY_NOTES || this.pitchClassesSeen.size < AUTO_KEY_PITCH_CLASSES) return C_MAJOR;
    return this.homeKey() ?? this.tracker.key();
  }

  // Several keys can fit the notes about as well: C, G/B and Am fit C major,
  // E minor and G major. A progression usually starts at home, so of those,
  // the one whose home chord was played first.
  private homeKey(): Key | null {
    const { ranked } = findKey(this.tracker.histogram());
    const close = ranked.filter(r => r.score >= ranked[0].score - KEY_TIE);
    for (const c of this.chords) {
      const family = chordFamily(c.root, c.quality);
      const home = close.find(r => r.key.tonic === c.root && family === (r.key.mode === 'major' ? 'maj' : 'min'));
      if (home) return home.key;
    }
    return null;
  }

  held(): number[] {
    return [...this.down.keys()].sort((a, b) => a - b);
  }

  // The chords played lately, oldest first
  recentChords(): { root: number; quality: ChordQuality }[] {
    return this.chords.map(({ root, quality }) => ({ root, quality }));
  }

  noteOn(pitch: number, time: number, velocity = 1) {
    this.down.set(pitch, time);
    this.recent = [...this.recent, pitch].slice(-RECENT_NOTES);
    // Velocity as 0..1 or MIDI 1..127; louder notes count a little more
    const loudness = Math.min(1, Math.max(0, velocity > 1 ? velocity / 127 : velocity));
    this.tracker.observe(pitch, time, 0.5 + 0.5 * loudness);
    this.notesSeen++;
    this.pitchClassesSeen.add(pc(pitch));
    this.recordChord();

    if (this.mode === 'lesson' && this.runner && !this.runner.done()) {
      const step = this.runner.current()!;
      // A melody is judged note by note (legato is fine), a chord as a whole
      const melody = this.runner.lesson.kind === 'melody';
      const result = this.runner.press(melody ? [pitch] : this.held());
      if (result === 'wrong') {
        const same = (p: number) => ((step.anyOctave ?? true) ? step.pitches.some(t => pc(t) === pc(p)) : step.pitches.includes(p));
        for (const p of melody ? [pitch] : this.held()) if (!same(p)) this.wrong.add(p);
      } else if (result !== 'partial') {
        this.wrong.clear();
      }
    }
  }

  noteOff(pitch: number, time: number) {
    const start = this.down.get(pitch);
    if (start === undefined) return;
    this.down.delete(pitch);
    this.wrong.delete(pitch);
    if (pitchClasses(this.held()).length < 3) this.chordHeld = false;
    // Held notes count toward the key for as long as they sound (up to 2 s)
    this.tracker.observe(pitch, time, Math.min(2, Math.max(0, time - start)) * 0.5);
  }

  // A chord is three or more pitch classes held together, recorded when it
  // differs from the last one. A note added while the chord is still held
  // (C, then C with B) refines it rather than starting a new one.
  private recordChord() {
    const held = this.held();
    if (pitchClasses(held).length < 3) return;
    const chord = recognizeChord(held, this.key());
    if (!chord) return;
    const played = { root: chord.root, quality: chord.quality, pitches: held };
    const same = (c?: Played) => c !== undefined && c.root === chord.root && c.quality === chord.quality;
    const last = this.chords[this.chords.length - 1];
    if (same(last) || (this.chordHeld && last?.root === chord.root)) this.chords = this.chords.slice(0, -1);
    // Built up again note by note, it may land back on the chord before
    if (same(this.chords[this.chords.length - 1])) this.chords[this.chords.length - 1] = played;
    else this.chords = [...this.chords, played].slice(-RECENT_CHORDS);
    this.chordHeld = true;
  }

  suggest(): { highlights: Highlight[]; readout: CoachReadout } {
    const key = this.key();
    const held = this.held();
    // The chord held, else the last one played. In chords mode two notes
    // are only a guess: the last whole chord says more.
    const last = this.chords[this.chords.length - 1];
    const lastChord = last ? recognizeChord(last.pitches, key) : null;
    const chord = this.mode === 'chords' && pitchClasses(held).length < 3
      ? lastChord
      : recognizeChord(held, key) ?? lastChord;

    const advice = this.mode === 'chords' ? this.chordAdvice(key, chord)
      : this.mode === 'melody' ? this.melodyAdvice(key, chord)
      : this.mode === 'complement' ? this.complementAdvice(key, chord)
      : this.mode === 'lesson' ? this.lessonAdvice()
      : { highlights: [], message: '', suggestions: [] };

    const inRange = (p: number) => p >= this.range[0] && p <= this.range[1];
    const highlights = [
      ...advice.highlights.filter(h => inRange(h.pitch)),
      ...held.filter(inRange).map((pitch): Highlight =>
        ({ pitch, role: this.wrong.has(pitch) ? 'wrong' : 'held', weight: 1, label: spellInKey(pitch, key) }))
    ];

    const runner = this.mode === 'lesson' ? this.runner : null;
    const lesson = runner && {
      id: runner.lesson.id,
      name: runner.lesson.name,
      step: runner.step(),
      total: runner.lesson.steps.length,
      label: runner.current()?.label ?? 'Done!',
      done: runner.done()
    };
    return {
      highlights,
      readout: {
        key,
        keyName: keyName(key),
        chord,
        roman: chord ? romanNumeral(chord.root, chord.quality, key) : null,
        message: advice.message,
        suggestions: advice.suggestions,
        lesson
      }
    };
  }

  // Moved by octaves onto the keyboard (null when the range can't hold it)
  private fit(pitch: number) {
    return fitRange(pitch, this.range);
  }

  private chordAdvice(key: Key, chord: Chord | null): Advice {
    const next = nextChords(this.recentChords(), key, 3);
    const held = this.held();
    // Voice-lead from the hands: what's held, or the last chord played
    const from = pitchClasses(held).length >= 2 ? held : this.chords[this.chords.length - 1]?.pitches ?? [];
    const highlights: Highlight[] = [];
    const suggestions = next.map((s, group) => {
      const pitches = voiceLead(from, s.root, s.quality, this.range);
      for (const pitch of pitches) {
        highlights.push({ pitch, role: 'next', weight: s.weight, group, ...(pc(pitch) === s.root ? { label: s.name } : {}) });
      }
      return { label: `${s.name} (${s.roman})`, pitches, weight: s.weight };
    });
    const options = next.slice(0, 2).map(s => `${s.name} (${s.roman})`).join(' or ');
    const message = chord
      ? `${chord.name} (${romanNumeral(chord.root, chord.quality, key)}) → try ${options}`
      : `Play a chord, or try ${options}`;
    return { highlights, message, suggestions };
  }

  private melodyAdvice(key: Key, chord: Chord | null): Advice {
    const notes = nextNotes(this.recent, key, chord, 4);
    const highlights: Highlight[] = [];
    const suggestions: Advice['suggestions'] = [];
    notes.forEach((n, group) => {
      const pitch = this.fit(n.pitch);
      if (pitch === null) return;
      const label = spellInKey(pitch, key);
      highlights.push({ pitch, role: 'next', weight: n.weight, label, group });
      suggestions.push({ label: `${label} (${n.reason})`, pitches: [pitch], weight: n.weight });
    });
    // 'Next: E or C (steps), G (chord tone)': names grouped by reason
    const byReason = new Map<string, string[]>();
    for (const n of notes) {
      const names = byReason.get(n.reason) ?? [];
      const name = spellInKey(n.pitch, key);
      if (!names.includes(name)) names.push(name);
      byReason.set(n.reason, names);
    }
    const plural = (reason: string, count: number) =>
      count > 1 && ['step', 'leap', 'chord tone', 'repeat'].includes(reason) ? `${reason}s` : reason;
    const parts = [...byReason].map(([reason, names]) => `${names.join(' or ')} (${plural(reason, names.length)})`);
    return { highlights, message: `Next: ${parts.join(', ')}`, suggestions };
  }

  private complementAdvice(key: Key, chord: Chord | null): Advice {
    const held = this.held();
    if (!held.length) return { highlights: [], message: 'Hold a note or two to see what goes with them', suggestions: [] };
    const found = complements(held, key);
    const highlights: Highlight[] = [];
    const suggestions: Advice['suggestions'] = [];
    found.forEach((c, group) => {
      const pitch = this.fit(c.pitch);
      if (pitch === null) return;
      const label = spellInKey(pitch, key);
      highlights.push({ pitch, role: 'complement', weight: c.weight, label, group });
      suggestions.push({ label: `${label} (${c.reason})`, pitches: [pitch], weight: c.weight });
    });
    const message = suggestions.length
      ? `Add ${suggestions.slice(0, 3).map(s => s.label).join(', ')}`
      : `${chord ? chord.name : 'That'} is complete as it is`;
    return { highlights, message, suggestions };
  }

  private lessonAdvice(): Advice {
    const runner = this.runner;
    if (!runner) return { highlights: [], message: 'Pick a lesson', suggestions: [] };
    const step = runner.current();
    if (!step) return { highlights: [], message: 'Done!', suggestions: [] };
    const key = runner.lesson.key;
    const pitches = step.pitches.map(p => this.fit(p)).filter(p => p !== null);
    const highlights = pitches.map((pitch, i): Highlight =>
      ({ pitch, role: 'target', weight: 1, ...(i === 0 ? { label: step.label } : {}) }));
    const names = step.pitches.map(p => spellInKey(p, key)).join(' ');
    const message = runner.lesson.kind === 'chords' ? `Play ${step.label}: ${names}` : `Play ${step.label}`;
    return { highlights, message, suggestions: [{ label: step.label, pitches, weight: 1 }] };
  }
}
