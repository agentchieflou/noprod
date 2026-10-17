import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Accompanist, ACCOMPANY_STYLES, LATE_GRACE, findStyle, movement, noteName, pc,
  type AccompanyEvent, type AccompanyNote
} from '../src/index.ts';

type Input = [beat: number, kind: 'on' | 'off', pitches: number[]];

const C = [60, 64, 67], F = [65, 69, 72], G = [67, 71, 74], Am = [69, 72, 76];

// Plays `inputs` into an Accompanist on a mocked clock: every `tick` beats
// it commits `lookahead` beats ahead, as the app's scheduler does. Returns
// its events, and the notes they leave sounding.
function run(styleId: string, inputs: Input[], until: number,
  { tick = 0.05, lookahead = 0.3, stopAt = Infinity, setup = (_: Accompanist) => {} } = {}) {
  const acc = new Accompanist(findStyle(styleId)!);
  setup(acc);
  const events: AccompanyEvent[] = [];
  const queue = [...inputs].sort((a, b) => a[0] - b[0]);
  for (let k = 0; k * tick <= until; k++) {
    const now = k * tick;
    while (queue.length && queue[0][0] <= now) {
      const [at, kind, pitches] = queue.shift()!;
      for (const p of pitches) {
        if (kind === 'on') events.push(...acc.noteOn(p, at));
        else acc.noteOff(p);
      }
    }
    if (now >= stopAt) {
      events.push(...acc.stop(stopAt));
      break;
    }
    events.push(...acc.advance(now, now + lookahead));
  }
  const notes = new Map<number, AccompanyNote>();
  for (const e of events) {
    if (e.type === 'start') {
      assert.ok(!notes.has(e.note.id), `note ${e.note.id} started twice`);
      notes.set(e.note.id, { ...e.note });
    } else {
      const note = notes.get(e.id);
      assert.ok(note, `stop for unknown note ${e.id}`);
      note.end = Math.min(note.end, e.at);
      if (note.end <= note.start) notes.delete(e.id);
    }
  }
  return { acc, events, notes: [...notes.values()].sort((a, b) => a.start - b.start || a.pitch - b.pitch) };
}

// 'start:pitch+pitch' for each start of one part, before `until`
function sketch(notes: AccompanyNote[], part: 'bass' | 'keys', until = Infinity) {
  const starts = new Map<number, string[]>();
  for (const n of notes) {
    if (n.part !== part || n.start >= until) continue;
    starts.set(n.start, [...(starts.get(n.start) ?? []), noteName(n.pitch)]);
  }
  return [...starts].map(([start, pitches]) => `${+start.toFixed(2)}:${pitches.join('+')}`).join(' ');
}

const sounding = (notes: AccompanyNote[], part: 'bass' | 'keys', at: number) =>
  notes.filter((n) => n.part === part && n.start <= at + 1e-9 && n.end > at + 1e-9).map((n) => n.pitch).sort((a, b) => a - b);

// C held through the first bar, F put down just before the second
const C_THEN_F: Input[] = [[0, 'on', C], [1, 'off', C], [3.9, 'on', F], [5, 'off', F]];

test('styles are data: hits within a bar, steps that divide it', () => {
  assert.ok(ACCOMPANY_STYLES.length >= 3);
  for (const style of ACCOMPANY_STYLES) {
    assert.equal(findStyle(style.id), style);
    assert.ok(Number.isInteger(4 / style.step), style.id);
    for (const hit of [...style.bass, ...style.keys]) {
      assert.ok(hit.at >= 0 && hit.at < 4 && hit.length > 0 && hit.at + hit.length <= 4 + 1e-9, `${style.id} ${JSON.stringify(hit)}`);
      assert.ok(hit.velocity > 0 && hit.velocity <= 1);
    }
    assert.ok(style.keys.every((h) => h.tone === 'chord') && style.bass.every((h) => h.tone !== 'chord'), style.id);
  }
});

test('pop eighths: root eighths in the bass, the chord on every eighth', () => {
  const { notes } = run('pop-eighths', C_THEN_F, 8);
  const eighths = (pitches: string, from: number) => Array.from({ length: 8 }, (_, i) => `${from + i / 2}:${pitches}`).join(' ');
  assert.equal(sketch(notes, 'bass', 8), `${eighths('C2', 0)} ${eighths('F2', 4)}`);
  assert.equal(sketch(notes, 'keys', 8), `${eighths('C4+E4+G4', 0)} ${eighths('C4+F4+A4', 4)}`);
  assert.ok(notes.every((n) => Math.abs(n.end - n.start - (n.part === 'bass' ? 0.45 : 0.4)) < 1e-9));
});

test('ballad: a chord a bar over root and fifth', () => {
  const { notes } = run('ballad', C_THEN_F, 8);
  assert.equal(sketch(notes, 'bass', 8), '0:C2 2:G2 4:F2 6:C3');
  assert.equal(sketch(notes, 'keys', 8), '0:C4+E4+G4 4:C4+F4+A4');
  assert.ok(notes.filter((n) => n.part === 'keys').every((n) => n.end - n.start === 4));
});

test('12-bar shuffle: a swung boogie bass and 7th chords into 2 and 4', () => {
  const { notes } = run('shuffle', C_THEN_F, 8);
  assert.equal(sketch(notes, 'bass', 8),
    '0:C2 0.67:E2 1:G2 1.67:A2 2:A#2 2.67:A2 3:G2 3.67:E2 4:F2 4.67:A2 5:C3 5.67:D3 6:D#3 6.67:D3 7:C3 7.67:A2');
  assert.equal(sketch(notes, 'keys', 8),
    '0.67:C4+E4+G4+A#4 1:C4+E4+G4+A#4 2.67:C4+E4+G4+A#4 3:C4+E4+G4+A#4 4.67:C4+D#4+F4+A4 5:C4+D#4+F4+A4 6.67:C4+D#4+F4+A4 7:C4+D#4+F4+A4');
});

test('a chord put down just before a downbeat catches it, though its notes were committed', () => {
  for (const style of ACCOMPANY_STYLES) {
    // A 16th before bar 2, with the downbeat's notes already committed
    const { events, notes } = run(style.id, [[0, 'on', C], [1, 'off', C], [4 - 0.2, 'on', F]], 6, { lookahead: 0.3 });
    const taken = events.filter((e) => e.type === 'stop');
    assert.ok(taken.length > 0, `${style.id}: nothing committed to take back`);
    assert.equal(sounding(notes, 'bass', 4).map(pc).join(), '5', style.id);
    // F, or F7 in the shuffle
    assert.ok(notes.filter((n) => n.part === 'keys' && n.start >= 4).every((n) => [5, 9, 0, 3].includes(pc(n.pitch))), style.id);
  }
});

test('a chord a moment late is played from when it came; later than that, from the next step', () => {
  const ballad = (at: number) => run('ballad', [[0, 'on', C], [0.5, 'off', C], [at, 'on', F]], 4).notes;
  const late = ballad(2 + LATE_GRACE * 0.4);
  const at = 2 + LATE_GRACE * 0.4;
  assert.deepEqual(sounding(late, 'bass', 2), [43]);              // the fifth of C, from the step
  assert.deepEqual(sounding(late, 'bass', at), [48]);             // then F's, as soon as F came
  assert.deepEqual(sounding(late, 'keys', at).map(pc), [0, 5, 9]); // C holds on, F and A come in
  const tooLate = ballad(2.5);
  assert.deepEqual(sounding(tooLate, 'bass', 3), [43]);
  assert.deepEqual(sounding(tooLate, 'keys', 3).map(pc), [0, 4, 7]);
});

test('a change taken back before its step leaves the chord sounding', () => {
  // F, then C again, both after the step's notes were committed
  const { notes } = run('ballad', [[0, 'on', C], [0.5, 'off', C], [1.8, 'on', F], [1.85, 'off', F], [1.9, 'on', C]], 4);
  assert.deepEqual(sounding(notes, 'keys', 1.99), [60, 64, 67]);
  assert.deepEqual(sounding(notes, 'keys', 2.01), [60, 64, 67]);
  assert.deepEqual(sounding(notes, 'bass', 2.01), [43]);
});

test('holding nothing repeats the last chord', () => {
  const { notes } = run('pop-eighths', [[0, 'on', Am], [0.5, 'off', Am]], 12);
  for (let beat = 0; beat < 12; beat += 0.5) {
    assert.deepEqual(sounding(notes, 'bass', beat).map(pc), [9], `bass at ${beat}`);
    assert.deepEqual(sounding(notes, 'keys', beat).map(pc).sort((a, b) => a - b), [0, 4, 9], `keys at ${beat}`);
  }
});

test('nothing plays before the first chord, and the band comes in at the next step', () => {
  const { notes } = run('ballad', [[1, 'on', G]], 4);
  assert.equal(sketch(notes, 'bass', 4), '2:D2');
  assert.equal(sketch(notes, 'keys', 4), '2:G3+B3+D4');
});

// A chord a bar on every root, in several qualities
const PROGRESSION: Input[] = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5, 0, 5, 7, 0].flatMap((root, bar): Input[] => {
  const shapes = [[0, 4, 7], [0, 3, 7], [0, 4, 7, 10], [0, 3, 7, 10], [0, 4, 7, 11]];
  const pitches = shapes[bar % shapes.length].map((i) => 60 + root + i);
  return [[bar * 4 - 0.3, 'on', pitches], [bar * 4 + 1, 'off', pitches]];
});

test('the bass stays in its range and moves to the nearest root', () => {
  for (const style of ACCOMPANY_STYLES) {
    const { notes } = run(style.id, PROGRESSION, 64, { tick: 0.1 });
    const bass = notes.filter((n) => n.part === 'bass');
    assert.ok(bass.length > 16);
    assert.ok(bass.every((n) => n.pitch >= 28 && n.pitch <= 55), `${style.id}: ${bass.map((n) => n.pitch)}`);
    const roots = Array.from({ length: 16 }, (_, bar) => sounding(notes, 'bass', bar * 4)[0]);
    for (let i = 1; i < roots.length; i++) assert.ok(Math.abs(roots[i] - roots[i - 1]) <= 8, `${style.id}: ${roots}`);
  }
});

test('the keys are voice-led: each chord moves little from the last', () => {
  const { notes } = run('ballad', [C, Am, F, G, C, F, G, C].map((pitches, bar): Input => [bar * 4 - 0.3, 'on', pitches])
    .flatMap((input) => [[input[0] - 0.01, 'off', [...C, ...Am, ...F, ...G]] as Input, input]), 32);
  const voicings = Array.from({ length: 8 }, (_, bar) => sounding(notes, 'keys', bar * 4));
  for (let i = 1; i < voicings.length; i++) {
    assert.ok(movement(voicings[i - 1], voicings[i]) <= 6, `${voicings[i - 1]} → ${voicings[i]}`);
    assert.ok(voicings[i].every((p) => p >= 52 && p <= 76));
  }
  const bigger = run('pop-eighths', PROGRESSION, 64, { tick: 0.1 }).notes;
  const chords = Array.from({ length: 16 }, (_, bar) => sounding(bigger, 'keys', bar * 4));
  for (let i = 1; i < chords.length; i++) {
    assert.ok(movement(chords[i - 1], chords[i]) <= 3 * Math.max(chords[i].length, chords[i - 1].length), `${chords[i - 1]} → ${chords[i]}`);
  }
});

test('no dropped or doubled notes when chords change mid-bar', () => {
  // Changes anywhere in the bar, some just before a step, some just after
  const times = [0, 1.3, 2.95, 4.05, 5.5, 6.2, 7.99, 9.1, 10.04, 11.7];
  const chords = [C, F, G, Am, F, C, G, Am, F, C];
  const inputs = times.flatMap((t, i): Input[] => [[t, 'on', chords[i]], [t + 0.2, 'off', chords[i]]]);
  for (const style of ACCOMPANY_STYLES) {
    const { notes } = run(style.id, inputs, 16);
    for (const part of ['bass', 'keys'] as const) {
      const mine = notes.filter((n) => n.part === part);
      // Doubled: one pitch sounding twice at once
      for (const a of mine) {
        for (const b of mine) {
          if (a !== b && a.pitch === b.pitch) assert.ok(a.end <= b.start + 1e-9 || b.end <= a.start + 1e-9, `${style.id} ${part}: ${JSON.stringify([a, b])}`);
        }
      }
      // Dropped: every hit sounds a chord's worth of notes (one in the bass)
      for (let bar = 0; bar < 4; bar++) {
        for (const hit of style[part]) {
          const at = bar * 4 + hit.at + 1e-6;
          const heard = sounding(notes, part, at);
          assert.ok(part === 'bass' ? heard.length === 1 : heard.length >= 3, `${style.id} ${part} at ${at}: ${heard}`);
        }
      }
    }
  }
});

test('stopping ends every note then and there', () => {
  const { notes, acc } = run('ballad', C_THEN_F, 8, { stopAt: 5 });
  assert.ok(notes.length > 0 && notes.every((n) => n.end <= 5), JSON.stringify(notes));
  // A stopped band starts again where it's told to
  assert.deepEqual(acc.advance(5.9, 6.2).map((e) => e.type === 'start' && noteName(e.note.pitch)), ['C3']);
});

test('the same input gives the same notes', () => {
  const a = run('shuffle', PROGRESSION, 32), b = run('shuffle', PROGRESSION, 32);
  assert.deepEqual(a.events, b.events);
});

test('a long session keeps a bounded history, and plays exactly as it would with all of it', () => {
  const bars = 200;
  const inputs = Array.from({ length: bars }, (_, bar): Input[] => {
    const pitches = [C, Am, F, G][bar % 4];
    return [[bar * 4 - 0.3, 'on', pitches], [bar * 4 + 0.5, 'off', pitches]];
  }).flat();
  for (const style of ACCOMPANY_STYLES) {
    const pruned = run(style.id, inputs, bars * 4, { tick: 0.25 });
    // The same session with nothing forgotten
    const whole = run(style.id, inputs, bars * 4, { tick: 0.25, setup: (acc) => { (acc as any).forget = () => {}; } });
    assert.deepEqual(pruned.events, whole.events, style.id);
    const kept = pruned.acc as any;
    assert.ok(kept.changes.length <= 3 && kept.voicings.size <= 8, `${style.id}: ${kept.changes.length} changes, ${kept.voicings.size} voicings`);
    assert.equal((whole.acc as any).changes.length, bars);
  }
});

test('after a stop and chords played meanwhile, it starts again voice-led as if nothing was forgotten', () => {
  const session = (forget: boolean) => {
    const acc = new Accompanist(findStyle('ballad')!);
    if (!forget) (acc as any).forget = () => {};
    const events: AccompanyEvent[] = [];
    const chord = (pitches: number[], at: number) => {
      for (const p of pitches) events.push(...acc.noteOn(p, at));
      for (const p of pitches) acc.noteOff(p);
    };
    const progression = [C, Am, F, G, Am, F, C, G];
    for (let beat = 0; beat < 32; beat += 0.25) {
      if (beat % 4 === 3.5) chord(progression[(beat + 0.5) / 4 % 8], beat);
      events.push(...acc.advance(beat, beat + 0.3));
    }
    events.push(...acc.stop(32));
    // Chords put down while the band is stopped, ending C then F (voice-led
    // from C, F is an inversion; voiced afresh it would be root position)
    for (let bar = 9; bar < 20; bar++) chord(bar % 2 ? F : C, bar * 4 - 0.5);
    for (let beat = 80; beat < 96; beat += 0.25) events.push(...acc.advance(beat, beat + 0.3));
    return events;
  };
  assert.deepEqual(session(true), session(false));
});
