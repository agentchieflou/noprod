// Realistic dictation programs, in the style of dictation's prompt:
// what Gemini writes for "a techno beat", "a sad piano melody", ... Each one
// says what it should make: the tempo, the sounds, and how many notes each
// plays in the first cycle. Also the seed of the program fuzz test.

export interface CorpusEntry {
  ask: string;              // what the user asked for
  code: string;
  bpm?: number;             // the tempo it sets
  sounds: Record<string, number>; // sound name → events in the first cycle (drums by name, melodic by their s)
}

export const CORPUS: CorpusEntry[] = [
  { ask: 'a techno beat', code: 'setcpm(128/4)\ns("bd*4, ~ cp ~ cp, hh*8").bank("RolandTR909")', bpm: 128, sounds: { bd: 4, cp: 2, hh: 8 } },
  { ask: 'a melody over a beat', code: 'setcpm(100/4)\nstack(\n  s("bd ~ sd ~, hh*8").bank("RolandTR808"),\n  note("c3 eb3 g3 bb3").s("epiano"),\n  note("c2 ~ ~ g1").s("bass")\n)', bpm: 100, sounds: { bd: 1, sd: 1, hh: 8, epiano: 4, bass: 2 } },
  { ask: 'a house groove with an acid line', code: 'setcpm(124/4)\nstack(\n  s("bd*4, ~ cp ~ cp, [~ hh]*4, oh ~ ~ ~").bank("RolandTR909"),\n  note("c2 [c2 c3] eb2 [g1 bb1]").s("acid").gain(0.8)\n)', bpm: 124, sounds: { bd: 4, cp: 2, hh: 4, oh: 1, acid: 6 } },
  { ask: 'a slow sad piano', code: 'setcpm(70/4)\nnote("<[a3,c4,e4] [f3,a3,c4] [c3,e3,g3] [g3,b3,d4]>").s("piano").gain(0.7)', bpm: 70, sounds: { piano: 3 } },
  { ask: 'a hip hop beat with a bass', code: 'setcpm(90/4)\nstack(\n  s("bd ~ [~ bd] ~, ~ sd ~ sd, hh*4").bank("RolandTR808"),\n  note("f1 ~ ~ [~ ab1] ~ ~ c2 ~").s("sub")\n)', bpm: 90, sounds: { bd: 2, sd: 2, hh: 4, sub: 3 } },
  { ask: 'a drum and bass break', code: 'setcpm(174/4)\nstack(\n  s("bd ~ ~ ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, hh*16").bank("RolandTR909"),\n  note("e1 ~ ~ ~ ~ ~ ~ ~ e1 ~ g1 ~ ~ ~ ~ ~").s("reese")\n)', bpm: 174, sounds: { bd: 3, sd: 2, hh: 16, reese: 3 } },
  { ask: 'an ambient pad', code: 'setcpm(60/4)\nstack(\n  note("<[c3,g3,e4] [a2,e3,c4]>").s("pad").gain(0.5),\n  note("<e5 g5 d5 c5>/2").s("bell").gain(0.3)\n)', bpm: 60, sounds: { pad: 3, bell: 1 } },
  { ask: 'a funky bass line', code: 'setcpm(105/4)\nstack(\n  s("bd ~ bd ~, ~ sd ~ sd, hh ~ hh hh ~ hh hh ~").bank("RolandTR808"),\n  note("e2 ~ e2 g2 ~ a2 ~ [b2 e3]").s("bass").gain(0.9)\n)', bpm: 105, sounds: { bd: 2, sd: 2, hh: 5, bass: 6 } },
  { ask: 'a minimal beat with a euclidean hat', code: 'setcpm(126/4)\ns("bd*4, hh(5,8), ~ cp").bank("RolandTR909")', bpm: 126, sounds: { bd: 4, hh: 5, cp: 1 } },
  { ask: 'strings in a minor key', code: 'setcpm(80/4)\nn("0 2 4 2 ~ 4 7 4").scale("A2:minor").s("strings").gain(0.6)', bpm: 80, sounds: { strings: 7 } },
  { ask: 'a lo-fi beat', code: 'setcpm(85/4)\nstack(\n  s("bd ~ ~ bd ~ ~ bd ~, ~ ~ sd ~ ~ ~ sd ~, hh*8?").bank("RolandTR808"),\n  note("<[d3,f3,a3] [c3,e3,g3]>").s("epiano").gain(0.5),\n  note("d2 ~ ~ ~ c2 ~ ~ ~").s("bass")\n)', bpm: 85, sounds: { bd: 3, sd: 2, hh: 5, epiano: 3, bass: 2 } },
  { ask: 'a reggaeton rhythm', code: 'setcpm(95/4)\nstack(\n  s("bd ~ ~ bd ~ ~ bd ~, ~ ~ ~ sd ~ ~ sd ~, hh*8").bank("RolandTR808"),\n  note("g2 ~ ~ g2 ~ ~ d2 ~").s("bass")\n)', bpm: 95, sounds: { bd: 3, sd: 2, hh: 8, bass: 3 } },
  { ask: 'a marimba pattern', code: 'setcpm(110/4)\nn("0 2 4 7 4 2 0 -3").scale("C:major:pentatonic").s("marimba").gain(0.7)', bpm: 110, sounds: { marimba: 8 } },
  { ask: 'a four on the floor with an off-beat bass', code: 'setcpm(122/4)\nstack(\n  s("bd*4, [~ hh]*4").bank("RolandTR909"),\n  note("[~ a1]*4").s("sub")\n)', bpm: 122, sounds: { bd: 4, hh: 4, sub: 4 } },
  { ask: 'a jazzy chord progression', code: 'setcpm(120/4)\nnote("<[d3,f3,a3,c4] [g2,b2,d3,f3] [c3,e3,g3,b3] [a2,c3,e3,g3]>").s("epiano").gain(0.6)', bpm: 120, sounds: { epiano: 4 } },
  { ask: 'a breakbeat that changes every four bars', code: 'setcpm(130/4)\ns("bd ~ sd bd ~ bd sd ~, hh*8").bank("RolandTR909").every(4, x => x.fast(2))', bpm: 130, sounds: { bd: 6, sd: 4, hh: 16 } },
  { ask: 'a flute melody with a bass', code: 'setcpm(96/4)\nstack(\n  note("g4 a4 b4 d5 ~ b4 a4 g4").s("flute").gain(0.6),\n  note("g2 ~ d2 ~").s("cello").gain(0.7)\n)', bpm: 96, sounds: { flute: 7, cello: 2 } },
  { ask: 'a trap beat', code: 'setcpm(140/4)\nstack(\n  s("bd ~ ~ ~ ~ ~ bd ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ cp ~ ~ ~ ~ ~ ~ ~ cp ~ ~ ~, hh*16, ~ ~ ~ oh").bank("RolandTR808"),\n  note("c1 ~ ~ ~ ~ ~ ~ ~ eb1 ~ ~ ~ ~ ~ ~ ~").s("sub")\n)', bpm: 140, sounds: { bd: 3, cp: 2, hh: 16, oh: 1, sub: 2 } },
  { ask: 'a bossa nova', code: 'setcpm(130/4)\nstack(\n  s("bd ~ ~ bd ~ ~ bd ~, rim ~ ~ rim ~ rim ~ ~, hh*8").bank("RolandTR808"),\n  note("<[c3,e3,g3,b3] [d3,f3,a3,c4]>").s("guitar").gain(0.6),\n  note("c2 ~ g2 ~ c2 ~ g2 ~").s("contrabass")\n)', bpm: 130, sounds: { bd: 3, rim: 3, hh: 8, guitar: 4, contrabass: 4 } },
  { ask: 'a rising arpeggio', code: 'setcpm(118/4)\nn("0 2 4 7 9 7 4 2").scale("E2:minor").s("pluck").gain(0.8).every(2, rev)', bpm: 118, sounds: { pluck: 8 } },
  { ask: 'a dub beat with a sometimes-dropped hat', code: 'setcpm(75/4)\nstack(\n  s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").bank("RolandTR808"),\n  s("hh*8").sometimes(x => x.gain(0.3)).bank("RolandTR808"),\n  note("a1 ~ ~ ~ ~ ~ a1 ~ ~ ~ c2 ~ ~ ~ ~ ~").s("sub")\n)', bpm: 75, sounds: { bd: 2, sd: 2, hh: 8, sub: 3 } },
  { ask: 'a glockenspiel over organ chords', code: 'setcpm(72/4)\nstack(\n  note("<[c4,e4,g4] [f4,a4,c5]>").s("organ").gain(0.4),\n  note("e6 ~ g6 ~ c6 ~ e6 ~").s("glockenspiel").gain(0.5)\n)', bpm: 72, sounds: { organ: 3, glockenspiel: 4 } },
  { ask: 'a stacked drum layer with ply', code: 'setcpm(128/4)\ns("bd ~ [sd cp] ~").bank("RolandTR909").ply(2)', bpm: 128, sounds: { bd: 2, sd: 2, cp: 2 } },
  { ask: 'labeled parts', code: 'setcpm(100/4)\n$: s("bd*2 sd").bank("RolandTR808")\n$: note("c3 e3 g3").s("harp")\n_$: s("hh*16")', bpm: 100, sounds: { bd: 2, sd: 1, harp: 3 } },
  { ask: 'a melody without a tempo', code: 'note("c3 e3 g3 c4")', sounds: { triangle: 4 } },
  { ask: 'an off-beat echo', code: 'setcpm(110/4)\nnote("c4 ~ e4 ~").s("kalimba").off(1/8, x => x.add(12).gain(0.5))', bpm: 110, sounds: { kalimba: 4 } }
];
