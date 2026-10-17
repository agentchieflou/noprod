// AI dictation, the parts every host shares: the system prompt that teaches
// the model our language, and the check-and-retry around its answer. The
// orchestrator calls this today; a browser calling Gemini with the user's own
// key (#157) will call the same thing. Nothing here talks to a network: the
// caller brings the model as a function.

import { evaluateCycle } from './evaluate.ts';
import { PatternError } from './errors.ts';
import type { Limits } from './pattern.ts';

export interface DictationNames {
  drums: string[];  // sound names for s("...")
  synths: string[]; // sound names for .s(name)
}

export function dictationSystemPrompt({ drums, synths }: DictationNames): string {
  return `
You are the dictation engine for the NoProd DAW. Your job is to translate user natural language requests into pattern code.
You MUST output ONLY valid pattern code, nothing else: no markdown blocks, no explanations.

The language (a subset of Strudel's): one pattern per program, built from these functions and nothing else.
- Tempo: one cycle is one bar of four beats. Set the tempo with setcpm(BPM/4) on its own line first, e.g. setcpm(120/4) for 120 BPM.
- Drums: s("...") using only these names: ${drums.join(', ')}. Choose a drum machine with .bank("RolandTR808") or .bank("RolandTR909").
- Melodies, chords and bass lines: note("c3 e3 g3") with .s(name), name being one of: ${synths.join(', ')}.
  Notes are names like c3, eb4, f#2 (sharps with #, flats with b), or n("0 2 4 7").scale("C:minor") for scale degrees (scales: major, minor, dorian, mixolydian, lydian, phrygian, harmonic:minor, major:pentatonic, minor:pentatonic, blues).
- Mini-notation inside the strings: a space separates steps in one bar; ~ is a rest; [a b] fits two steps in one; <a b> alternates per bar; a*2 repeats; a!3 repeats a step; a@3 lengthens; [c3,e3,g3] is a chord; a(3,8) is a Euclidean rhythm; a? drops it at random.
- Put several parts together with stack(...), one part per line.
- Methods on a pattern: .gain(0 to 1), .velocity(0 to 1), .pan(0 to 1), .fast(2), .slow(2), .rev(), .every(4, x => x.fast(2)), .sometimes(x => x.gain(0.5)), .degradeBy(0.3), .off(0.125, x => x.add(12)), .ply(2), .struct("t ~ t t"), .euclid(3, 8), .add(12), .transpose(-12).
Use nothing else: no variables, no loops, no effects, no samples beyond the names above.

If the user asks for a techno beat, you might output:
setcpm(128/4)
s("bd*4, ~ cp ~ cp, hh*8").bank("RolandTR909")

If the user asks for a melody over a beat, you might output:
setcpm(100/4)
stack(
  s("bd ~ sd ~, hh*8").bank("RolandTR808"),
  note("c3 eb3 g3 bb3").s("epiano"),
  note("c2 ~ ~ g1").s("bass")
)

If the user asks for a sad piano, you might output:
setcpm(70/4)
n("<[0,2,4] [-2,0,2] [3,5,7] [1,3,5]>").scale("A2:minor").s("piano").gain(0.7)
`;
}

// The markdown fence a model sometimes wraps its code in
export function stripFences(text: string): string {
  return text.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
}

// Dictated code is untrusted: what one cycle may cost
export const DICTATION_LIMITS: Limits = { maxEvents: 5000, maxMillis: 1000 };

// Parses the code and plays one cycle; the error's message, or null when fine
export function checkDictation(code: string, limits: Limits = DICTATION_LIMITS): string | null {
  try {
    evaluateCycle(code, limits);
    return null;
  } catch (e) {
    if (e instanceof PatternError) return e.message;
    throw e;
  }
}

// A conversation turn for the model; the caller formats it for its API
export interface DictationTurn { role: 'user' | 'model'; text: string }

export interface Dictation {
  code: string;           // the (last) code the model wrote, fences stripped
  error: string | null;   // why it doesn't parse, when it doesn't
  attempts: number;       // 1, or 2 when the model was asked again
}

// Asks the model for code; when it doesn't parse, once more with the error.
// `ask` sends the turns (the system prompt is the caller's to add) and
// returns the model's text.
export async function generateDictation(text: string, ask: (turns: DictationTurn[]) => Promise<string>, limits: Limits = DICTATION_LIMITS): Promise<Dictation> {
  const first: DictationTurn[] = [{ role: 'user', text }];
  let code = stripFences(await ask(first));
  let error = checkDictation(code, limits);
  if (error === null) return { code, error, attempts: 1 };
  const retry: DictationTurn[] = [...first, { role: 'model', text: code }, { role: 'user', text: `That code failed to parse: ${error}. Reply with corrected code only, using only the language described.` }];
  code = stripFences(await ask(retry));
  error = checkDictation(code, limits);
  return { code, error, attempts: 2 };
}
