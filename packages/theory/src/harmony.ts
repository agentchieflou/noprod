// Which chord comes next. Two models vote: functional harmony (what each
// chord of a key tends to move to: V goes home to I, ii goes to V...) and
// the progressions songs actually use, matched against the end of what was
// played (the longer the match, the louder its vote).

import {
  SEVENTHS, chordFamily, chordNameInKey, fitsKey, parseNumeral, romanNumeral,
  type ChordFamily, type ChordQuality
} from './chords.ts';
import { pc } from './notes.ts';
import type { Key } from './scales.ts';

export interface Progression {
  name: string;
  mode: 'major' | 'minor';
  numerals: string[];
}

// Played as loops: the chord after the last is the first again
export const PROGRESSIONS: Progression[] = [
  { name: 'I–V–vi–IV', mode: 'major', numerals: ['I', 'V', 'vi', 'IV'] },
  { name: 'vi–IV–I–V', mode: 'major', numerals: ['vi', 'IV', 'I', 'V'] },
  { name: 'I–vi–IV–V', mode: 'major', numerals: ['I', 'vi', 'IV', 'V'] },
  { name: 'I–IV–V–I', mode: 'major', numerals: ['I', 'IV', 'V', 'I'] },
  { name: 'I–V–IV–I', mode: 'major', numerals: ['I', 'V', 'IV', 'I'] },
  { name: 'ii–V–I', mode: 'major', numerals: ['ii7', 'V7', 'Imaj7'] },
  { name: '12-bar blues', mode: 'major', numerals: ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'] },
  { name: 'Pachelbel', mode: 'major', numerals: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'] },
  { name: 'i–VI–III–VII', mode: 'minor', numerals: ['i', 'VI', 'III', 'VII'] },
  { name: 'i–VII–VI–VII', mode: 'minor', numerals: ['i', 'VII', 'VI', 'VII'] },
  { name: 'i–iv–v–i', mode: 'minor', numerals: ['i', 'iv', 'v', 'i'] },
  { name: 'i–iv–VII–III', mode: 'minor', numerals: ['i', 'iv', 'VII', 'III'] },
  { name: 'Andalusian cadence', mode: 'minor', numerals: ['i', 'VII', 'VI', 'V'] },
  { name: 'ii–V–i', mode: 'minor', numerals: ['iiø7', 'V7', 'i7'] }
];

// Functional harmony: where each chord of the key tends to go, by triad
// (G7 moves like G). Borrowed and secondary chords (bVII, iv in major, II
// as V of V) have their own rows.
type Moves = Record<string, Record<string, number>>;

const MAJOR_MOVES: Moves = {
  I: { IV: 0.3, V: 0.3, vi: 0.2, ii: 0.1, iii: 0.05, 'vii°': 0.05 },
  ii: { V: 0.6, 'vii°': 0.1, IV: 0.1, I: 0.1, vi: 0.1 },
  iii: { vi: 0.5, IV: 0.3, ii: 0.1, I: 0.1 },
  IV: { V: 0.35, I: 0.3, ii: 0.2, vi: 0.1, 'vii°': 0.05 },
  V: { I: 0.5, vi: 0.25, IV: 0.2, iii: 0.05 },
  vi: { IV: 0.35, ii: 0.3, V: 0.15, iii: 0.1, I: 0.1 },
  'vii°': { I: 0.7, vi: 0.1, iii: 0.1, V: 0.1 },
  bVII: { I: 0.5, IV: 0.3, bVI: 0.2 },
  bVI: { bVII: 0.5, V: 0.2, I: 0.2, iv: 0.1 },
  iv: { I: 0.6, V: 0.3, bVII: 0.1 },
  II: { V: 0.8, IV: 0.2 },
  III: { vi: 0.8, IV: 0.2 },
  VI: { ii: 0.8, IV: 0.2 }
};

const MINOR_MOVES: Moves = {
  i: { iv: 0.25, VI: 0.2, VII: 0.2, V: 0.15, III: 0.1, 'ii°': 0.05, v: 0.05 },
  'ii°': { V: 0.6, i: 0.15, iv: 0.1, 'vii°': 0.15 },
  III: { VI: 0.35, iv: 0.25, VII: 0.2, i: 0.1, 'ii°': 0.1 },
  iv: { V: 0.3, i: 0.25, VII: 0.25, 'ii°': 0.1, v: 0.1 },
  v: { i: 0.5, VI: 0.25, iv: 0.25 },
  V: { i: 0.7, VI: 0.3 },
  VI: { VII: 0.3, iv: 0.25, III: 0.2, i: 0.1, 'ii°': 0.1, V: 0.05 },
  VII: { III: 0.35, i: 0.35, VI: 0.2, v: 0.1 },
  'vii°': { i: 0.8, III: 0.1, V: 0.1 },
  IV: { i: 0.4, VII: 0.3, V: 0.3 },
  bII: { V: 0.7, i: 0.3 }
};

// A chord the tables don't know heads for the main chords
const FALLBACK_MOVES: Record<Key['mode'], Record<string, number>> = {
  major: { I: 0.4, V: 0.3, IV: 0.2, vi: 0.1 },
  minor: { i: 0.4, V: 0.25, iv: 0.2, VI: 0.15 }
};

// How common each chord of the key is, whatever came before
const PRIOR: Record<Key['mode'], Record<string, number>> = {
  major: { I: 0.25, IV: 0.2, V: 0.2, vi: 0.15, ii: 0.1, iii: 0.05, 'vii°': 0.05 },
  minor: { i: 0.25, iv: 0.15, V: 0.15, VI: 0.15, VII: 0.15, III: 0.1, 'ii°': 0.05 }
};

const FUNCTION_SHARE = 0.45;
const PROGRESSION_SHARE = 0.45;
const PRIOR_SHARE = 0.1;
const BACKTRACK = 0.5;   // going straight back to the chord before: a coach nudges forward

export interface ChordRef {
  root: number;
  quality: ChordQuality;
}

export interface ChordSuggestion extends ChordRef {
  name: string;
  roman: string;
  weight: number;
  reason: string;
}

interface Candidate {
  root: number;
  family: ChordFamily;
  functional: number;
  progression: number;
  prior: number;
  qualities: Map<ChordQuality, number>;   // votes for the chord's exact type
  match: { name: string; length: number; fromStart: boolean } | null;
}

// The 7th chord a key builds on a root: maj7 where the key has the major
// 7th (I and IV), a dominant 7th elsewhere and everywhere in the blues
function seventhOn(root: number, family: ChordFamily, key: Key, bluesy: boolean): ChordQuality {
  if (family === 'min') return 'm7';
  if (family === 'aug') return 'aug';
  if (family === 'dim') return key.mode === 'minor' && pc(root - key.tonic) === 11 ? 'dim7' : 'm7b5';
  return !bluesy && fitsKey(root, 'maj7', key) ? 'maj7' : '7';
}

export function nextChords(history: ChordRef[], key: Key, count = 3): ChordSuggestion[] {
  const familyOf = (c: ChordRef) => chordFamily(c.root, c.quality, key);
  const same = (a: ChordRef, b: ChordRef) => pc(a.root) === pc(b.root) && familyOf(a) === familyOf(b);
  const numeralOf = (c: ChordRef) => romanNumeral(c.root, familyOf(c), key);
  const last = history.at(-1);
  const before = history.at(-2);
  const sevenths = last !== undefined && SEVENTHS.includes(last.quality);
  const bluesy = key.mode === 'major' && history.some(c =>
    (c.quality === '7' || c.quality === '9') && [0, 5].includes(pc(c.root - key.tonic)));

  const candidates = new Map<string, Candidate>();
  // `ownSeventh`: the chord's own 7th counts (a progression matched over
  // two chords or more: the blues' IV7, not the key's IVmaj7)
  const vote = (chord: ChordRef, source: 'functional' | 'progression' | 'prior', weight: number, ownSeventh = false) => {
    if (last && same(chord, last)) return;   // never "play it again"
    const family = familyOf(chord);
    const id = `${pc(chord.root)}${family}`;
    let c = candidates.get(id);
    if (!c) {
      c = { root: pc(chord.root), family, functional: 0, progression: 0, prior: 0, qualities: new Map(), match: null };
      candidates.set(id, c);
    }
    c[source] += weight;
    // Keep 7ths when the last chord had one: a progression's own 7th, else
    // the key's 7th chord on that root
    const quality = !sevenths ? family
      : ownSeventh && SEVENTHS.includes(chord.quality) ? chord.quality
      : seventhOn(c.root, family, key, bluesy);
    c.qualities.set(quality, (c.qualities.get(quality) ?? 0) + weight * (source === 'progression' ? 2 : 1));
  };

  if (last) {
    const moves = (key.mode === 'major' ? MAJOR_MOVES : MINOR_MOVES)[numeralOf(last)] ?? FALLBACK_MOVES[key.mode];
    for (const [numeral, p] of Object.entries(moves)) vote(parseNumeral(numeral, key), 'functional', p);
  }

  // Progressions: find every place one ends the way the history ends
  // (as loops); the chord after it gets length² votes
  for (const progression of PROGRESSIONS) {
    if (progression.mode !== key.mode) continue;
    const chords = progression.numerals.map(n => parseNumeral(n, key));
    const n = chords.length;
    for (let end = 0; end < n; end++) {
      let length = 0;
      while (length < Math.min(history.length, n) &&
        same(history[history.length - 1 - length], chords[(end - length + n) % n])) length++;
      if (!length) continue;
      const next = chords[(end + 1) % n];
      vote(next, 'progression', length * length, length >= 2);
      // The reason names the longest match; between equals, one played
      // from its start (vi–IV–I is the start of vi–IV–I–V)
      const fromStart = end - length + 1 === 0;
      const c = candidates.get(`${pc(next.root)}${familyOf(next)}`);
      if (c && (!c.match || length > c.match.length || (length === c.match.length && fromStart && !c.match.fromStart))) {
        c.match = { name: progression.name, length, fromStart };
      }
    }
  }

  for (const [numeral, p] of Object.entries(PRIOR[key.mode])) vote(parseNumeral(numeral, key), 'prior', p);

  const all = [...candidates.values()];
  const total = (source: 'functional' | 'progression' | 'prior') => all.reduce((sum, c) => sum + c[source], 0);
  const functional = total('functional'), progression = total('progression'), prior = total('prior');
  const shares = {
    functional: functional ? FUNCTION_SHARE + (progression ? 0 : PROGRESSION_SHARE) : 0,
    progression: progression ? PROGRESSION_SHARE + (functional ? 0 : FUNCTION_SHARE) : 0
  };
  const scored = all.map(c => {
    let weight = (functional ? shares.functional * c.functional / functional : 0) +
      (progression ? shares.progression * c.progression / progression : 0) +
      (prior ? PRIOR_SHARE * c.prior / prior : 0);
    if (before && same({ root: c.root, quality: c.family }, before)) weight *= BACKTRACK;
    return { c, weight };
  });
  scored.sort((a, b) => b.weight - a.weight || b.c.prior - a.c.prior || a.c.root - b.c.root);

  const top = scored.slice(0, count);
  const sum = top.reduce((s, x) => s + x.weight, 0) || 1;
  return top.map(({ c, weight }) => {
    const quality = [...c.qualities.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return {
      root: c.root,
      quality,
      name: chordNameInKey(c.root, quality, key),
      roman: romanNumeral(c.root, quality, key),
      weight: weight / sum,
      reason: reasonFor(c, last ? numeralOf(last) : null, key)
    };
  });
}

function reasonFor(c: Candidate, from: string | null, key: Key) {
  if (c.match && c.match.length >= 2) return `continues ${c.match.name}`;
  const to = romanNumeral(c.root, c.family, key);
  if (!from) return 'a main chord of the key';
  if (to === 'I' || to === 'i') return ['V', 'vii°', 'v', 'bVII', 'iv', 'IV'].includes(from) ? 'resolves home' : 'back home';
  if (to === 'V') return 'builds tension toward home';
  return `${from} often moves to ${to}`;
}
