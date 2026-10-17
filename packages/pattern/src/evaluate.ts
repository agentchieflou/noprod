// The interpreter: walks a parsed program and builds a pattern from the
// functions in its table. An unknown name is an error. Nothing here runs
// code from the program; the program only ever chooses among these functions.

import { Fraction } from './fraction.ts';
import { PatternError } from './errors.ts';
import { Pattern, pure, silence, stack, slowcat, fastcat, timecat, rand, sine, cosine, saw, isaw, tri, square, type Limits, type Transform } from './pattern.ts';
import { mini, type MiniValue } from './mini.ts';
import { parseProgram, positionOf, PROGRAM_LIMITS, type Expr, type Program } from './program.ts';
import { type Controls, isControls, addControls, noteToMidi, parseScale, scaleDegree, soundControls } from './controls.ts';
import type { Hap } from './hap.ts';

export const DEFAULT_CPS = 0.5; // one cycle every two seconds: a 120 BPM bar
export const MIN_BPM = 20;
export const MAX_BPM = 400;

type Value = number | string | Pattern<unknown> | Func | Value[] | undefined;
interface Func { kind: 'function'; name: string; call: (args: Value[], where: number) => Value }
const isFunc = (v: Value): v is Func => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Pattern) && (v as Func).kind === 'function';
const func = (name: string, call: Func['call']): Func => ({ kind: 'function', name, call });

export interface Evaluation {
  pattern: Pattern<Controls>;
  cps: number;             // cycles per second the program set (or the default)
  setsTempo: boolean;      // whether it did
  statements: number;
}

// The controls a program may set. Those the DAW plays are first; the rest are
// accepted so that code written for the published engine still parses, and
// ride along in the event's value.
export const CONTROL_NAMES = [
  'note', 'n', 's', 'gain', 'velocity', 'pan', 'bank', 'orbit',
  'speed', 'legato', 'clip', 'attack', 'decay', 'sustain', 'release', 'room', 'size', 'roomsize', 'delay', 'delaytime', 'delayfeedback',
  'lpf', 'cutoff', 'hpf', 'resonance', 'lpq', 'hpq', 'vowel', 'crush', 'coarse', 'shape', 'distort', 'detune', 'unison', 'spread',
  'phaser', 'phaserdepth', 'tremolo', 'vib', 'vibmod', 'fm', 'fmh', 'cps', 'channel', 'begin', 'end', 'cut', 'accelerate', 'duration'
];
const CONTROL_ALIASES: Record<string, string> = { sound: 's', velo: 'velocity', amp: 'gain', lp: 'lpf', hp: 'hpf', ctf: 'cutoff', number: 'n', sz: 'size', dt: 'delaytime', dfb: 'delayfeedback', det: 'detune' };

// Visual methods of the published engine that mean nothing here
const NO_OPS = ['pianoroll', '_pianoroll', 'punchcard', '_punchcard', 'color', 'scope', '_scope', 'spectrum', '_spectrum', 'spiral', '_spiral'];

// Whatever a program makes the engine do, the caller sees one error type:
// a stack overflow from a shape the limits didn't catch is a PatternError too
function failingClosed<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof RangeError) throw new PatternError(`the program is too deeply nested to run (${e.message})`);
    throw e;
  }
}

export function evaluate(code: string, limits?: Limits): Evaluation {
  return failingClosed(() => {
    const program = parseProgram(code);
    return new Interpreter(code, limits).run(program);
  });
}

// One cycle of a program, as plain data: what the DAW turns into tracks
export interface CycleEvent { time: number; duration: number; value: Controls }
export function evaluateCycle(code: string, limits?: Limits): { cps: number; setsTempo: boolean; events: CycleEvent[] } {
  const { pattern, cps, setsTempo } = evaluate(code, limits);
  const events = failingClosed(() => pattern.firstCycle(limits)).map((h: Hap<Controls>) => ({ time: Number(h.whole!.begin), duration: Number(h.whole!.duration), value: h.value }));
  return { cps, setsTempo, events };
}

class Interpreter {
  cps = DEFAULT_CPS;
  private setsTempo = false;
  private steps = 0; // expressions evaluated: a program's whole work is bounded
  private depth = 0; // calls in progress
  private readonly source: string;
  private readonly globals: Map<string, Value>;

  constructor(source: string, _limits?: Limits) {
    this.source = source;
    this.globals = this.makeGlobals();
  }

  run(program: Program): Evaluation {
    const labeled: Pattern<Controls>[] = [];
    let last: Value;
    let lastPos = 0;
    for (const statement of program.statements) {
      const value = this.eval(statement.expr, new Map());
      if (statement.label) {
        if (statement.muted) continue;
        labeled.push(this.asControls(value, statement.pos, 'a "$:" line'));
      } else {
        last = value;
        lastPos = statement.pos;
      }
    }
    let pattern: Pattern<Controls>;
    if (labeled.length) pattern = stack(...labeled);
    else if (last === undefined && program.statements.length === 0) throw new PatternError('an empty program');
    else if (last === undefined) throw this.error(lastPos, 'the program ends with a statement that makes no pattern (setcpm?); end with the pattern to play');
    else pattern = this.asControls(last, lastPos, 'the program\'s last expression');
    return { pattern, cps: this.cps, setsTempo: this.setsTempo, statements: program.statements.length };
  }

  error(pos: number, message: string): PatternError {
    const p = positionOf(this.source, pos);
    return new PatternError(`${message} at ${p.line}:${p.column}`, p);
  }

  // ---- expressions

  private eval(expr: Expr, scope: Map<string, Value>): Value {
    if (++this.steps > PROGRAM_LIMITS.maxSteps) throw this.error(expr.pos, `the program does more than ${PROGRAM_LIMITS.maxSteps} steps`);
    switch (expr.type) {
      case 'number': return expr.value;
      case 'string': return expr.value;
      case 'array': return expr.items.map((e) => this.eval(e, scope));
      case 'identifier': {
        if (scope.has(expr.name)) return scope.get(expr.name);
        if (this.globals.has(expr.name)) return this.globals.get(expr.name);
        throw this.error(expr.pos, `unknown name "${expr.name}"`);
      }
      case 'negate': {
        const v = this.eval(expr.operand, scope);
        if (typeof v !== 'number') throw this.error(expr.pos, `"-" wants a number, not ${describe(v)}`);
        return -v;
      }
      case 'binary': {
        const l = this.eval(expr.left, scope);
        const r = this.eval(expr.right, scope);
        if (typeof l !== 'number' || typeof r !== 'number') throw this.error(expr.pos, `"${expr.op}" wants numbers, not ${describe(l)} and ${describe(r)}`);
        const out = expr.op === '+' ? l + r : expr.op === '-' ? l - r : expr.op === '*' ? l * r : l / r;
        if (!Number.isFinite(out)) throw this.error(expr.pos, `"${expr.op}" gives ${out}`);
        return out;
      }
      case 'arrow': {
        const name = `${expr.param} => …`;
        return func(name, (args) => {
          if (args.length !== 1) throw this.error(expr.pos, `an arrow function takes one argument, not ${args.length}`);
          if (++this.depth > PROGRAM_LIMITS.maxCallDepth) throw this.error(expr.pos, `calls nested more than ${PROGRAM_LIMITS.maxCallDepth} deep`);
          try {
            const inner = new Map(scope);
            inner.set(expr.param, args[0]);
            return this.eval(expr.body, inner);
          } finally {
            this.depth--;
          }
        });
      }
      case 'member': {
        // a method used without calling it: pat.rev
        const object = this.eval(expr.object, scope);
        throw this.error(expr.pos, `".${expr.name}" needs parentheses: ${object instanceof Pattern || typeof object === 'string' ? `.${expr.name}()` : 'it is a method'}`);
      }
      case 'call': {
        if (expr.callee.type === 'member') {
          const object = this.eval(expr.callee.object, scope);
          const args = expr.args.map((a) => this.eval(a, scope));
          return this.callMethod(object, expr.callee.name, args, expr.callee.pos);
        }
        const callee = this.eval(expr.callee, scope);
        if (!isFunc(callee)) throw this.error(expr.pos, `${describe(callee)} is not a function`);
        const args = expr.args.map((a) => this.eval(a, scope));
        return callee.call(args, expr.pos);
      }
    }
  }

  // ---- values

  // Anything that stands for a pattern: a pattern, a mini-notation string,
  // a number, or an array (a sequence of them)
  toPattern(v: Value, pos: number, what: string): Pattern<unknown> {
    if (v instanceof Pattern) return v;
    if (typeof v === 'string') {
      try { return mini(v); } catch (e) { throw this.error(pos, (e as Error).message); }
    }
    if (typeof v === 'number') return pure(v);
    if (Array.isArray(v)) return fastcat(...v.map((x) => this.toPattern(x, pos, what)));
    throw this.error(pos, `${what} wants a pattern, not ${describe(v)}`);
  }

  // The pattern to play. Plain values are played too, as the old pipeline
  // did: a number or a note name is a note, any other string a sound.
  private asControls(v: Value, pos: number, what: string): Pattern<Controls> {
    const pat = this.toPattern(v, pos, what);
    return pat.fmap((value) => {
      if (isControls(value)) return value as Controls;
      if (typeof value === 'number' || (typeof value === 'string' && /^([a-gA-G][#sb]*(-?\d+)?|-?\d+(\.\d+)?)$/.test(value.trim()))) return { note: value };
      if (typeof value === 'string') return { s: value };
      throw this.error(pos, `${what} is a pattern of ${JSON.stringify(value)}, which can't be played`);
    });
  }

  toTransform(v: Value, pos: number, what: string): Transform<unknown> {
    if (!isFunc(v)) throw this.error(pos, `${what} wants a function (x => x.fast(2), or fast(2)), not ${describe(v)}`);
    return (pat) => this.toPattern(v.call([pat], pos), pos, `${what}'s function`);
  }

  toNumber(v: Value, pos: number, what: string): number | Pattern<number> {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' || v instanceof Pattern || Array.isArray(v)) {
      return this.toPattern(v, pos, what).fmap((x) => {
        if (typeof x === 'number') return x;
        if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
        throw this.error(pos, `${what} wants a number, not ${JSON.stringify(x)}`);
      });
    }
    throw this.error(pos, `${what} wants a number, not ${describe(v)}`);
  }

  plainNumber(v: Value, pos: number, what: string): number {
    if (typeof v !== 'number') throw this.error(pos, `${what} wants a number, not ${describe(v)}`);
    return v;
  }

  // ---- the table

  private makeGlobals(): Map<string, Value> {
    const g = new Map<string, Value>();
    const define = (name: string, call: Func['call']) => g.set(name, func(name, call));

    // constructors
    for (const [name, make] of [
      ['stack', stack], ['cat', slowcat], ['slowcat', slowcat], ['seq', fastcat], ['sequence', fastcat], ['fastcat', fastcat]
    ] as [string, (...pats: Pattern<unknown>[]) => Pattern<unknown>][]) {
      define(name, (args, pos) => make(...args.map((a) => this.toPattern(a, pos, name))));
    }
    define('timecat', (args, pos) => timecat(...args.map((a, i) => {
      if (!Array.isArray(a) || a.length !== 2 || typeof a[0] !== 'number') throw this.error(pos, `timecat wants [weight, pattern] pairs (argument ${i + 1})`);
      return [a[0], this.toPattern(a[1], pos, 'timecat')] as [number, Pattern<unknown>];
    })));
    g.set('silence', silence);
    g.set('rand', rand());
    g.set('sine', sine); g.set('cosine', cosine); g.set('saw', saw); g.set('isaw', isaw); g.set('tri', tri); g.set('square', square);
    define('irand', (args, pos) => {
      const n = this.plainNumber(args[0], pos, 'irand');
      return rand().fmap((x) => Math.floor(x * n));
    });

    // controls as functions: note("c3 e3"), s("bd sd"), gain(0.5)
    for (const name of CONTROL_NAMES) define(name, (args, pos) => this.control(this.toPattern(args.length === 1 ? args[0] : args, pos, name), name, pos));
    for (const [alias, name] of Object.entries(CONTROL_ALIASES)) define(alias, (args, pos) => this.control(this.toPattern(args.length === 1 ? args[0] : args, pos, alias), name, pos));

    // tempo
    define('setcps', (args, pos) => { this.setTempo(this.plainNumber(args[0], pos, 'setcps'), pos); return undefined; });
    define('setcpm', (args, pos) => { this.setTempo(this.plainNumber(args[0], pos, 'setcpm') / 60, pos); return undefined; });
    define('setbpm', (args, pos) => { this.setTempo(this.plainNumber(args[0], pos, 'setbpm') / 240, pos); return undefined; });
    define('hush', () => silence);

    // every method is also a function: fast(2, pat), or fast(2) as a
    // transform waiting for its pattern (every(4, fast(2)))
    for (const [name, method] of Object.entries(METHODS)) {
      define(name, (args, pos) => {
        if (args.length === method.arity + 1) return method.apply(this, this.toPattern(args[args.length - 1], pos, name), args.slice(0, -1), pos);
        if (args.length === method.arity) return func(`${name}(…)`, (more) => method.apply(this, this.toPattern(more[0], pos, name), args, pos));
        throw this.error(pos, `${name} wants ${method.arity} argument${method.arity === 1 ? '' : 's'} (and a pattern), not ${args.length}`);
      });
    }
    return g;
  }

  // The transport takes 20 to 400 BPM; a cycle is a bar of four beats
  private setTempo(cps: number, pos: number): void {
    if (!(cps > 0) || !Number.isFinite(cps)) throw this.error(pos, `a tempo must be a positive number, not ${cps}`);
    const bpm = cps * 240;
    if (bpm < MIN_BPM || bpm > MAX_BPM) throw this.error(pos, `a tempo of ${Math.round(bpm * 100) / 100} BPM is outside ${MIN_BPM} to ${MAX_BPM}`);
    this.cps = cps;
    this.setsTempo = true;
  }

  private callMethod(object: Value, name: string, args: Value[], pos: number): Value {
    if (object === undefined) throw this.error(pos, `".${name}" on nothing (setcpm makes no pattern)`);
    if (isFunc(object)) throw this.error(pos, `".${name}" on a function; call it first`);
    const pat = this.toPattern(object, pos, `.${name}`);
    // own properties only: "toString" and "__proto__" are not methods
    const method = Object.hasOwn(METHODS, name) ? METHODS[name] : undefined;
    if (method) {
      if (args.length < method.arity || (!method.rest && args.length > method.arity)) {
        throw this.error(pos, `.${name} wants ${method.arity} argument${method.arity === 1 ? '' : 's'}, not ${args.length}`);
      }
      return method.apply(this, pat, args, pos);
    }
    const control = Object.hasOwn(CONTROL_ALIASES, name) ? CONTROL_ALIASES[name] : CONTROL_NAMES.includes(name) ? name : undefined;
    if (control) return this.setControl(pat, control, this.toPattern(args.length === 1 ? args[0] : args, pos, `.${name}`), pos);
    if (NO_OPS.includes(name)) return pat;
    throw this.error(pos, `unknown method ".${name}"`);
  }

  // note("c3 e3") → a pattern of { note: ... }
  private control(pat: Pattern<unknown>, name: string, pos: number): Pattern<Controls> {
    return pat.fmap((v) => {
      if (isControls(v)) throw this.error(pos, `${name}() wants plain values, not a pattern that already has controls; use .${name}() to set one`);
      if (name === 's') return soundControls(v as MiniValue);
      return { [name]: v as MiniValue };
    });
  }

  // pat.s("piano"): the structure stays pat's; each event takes the value
  // from the argument pattern
  private setControl(pat: Pattern<unknown>, name: string, values: Pattern<unknown>, pos: number): Pattern<Controls> {
    return pat.appLeft(values, (c, v) => {
      if (!isControls(c)) throw this.error(pos, `.${name} wants a pattern with controls (from note(), n() or s()), not plain values like ${JSON.stringify(c)}`);
      if (isControls(v)) return { ...c, ...v };
      if (name === 's') return { ...c, ...soundControls(v as MiniValue) };
      return { ...c, [name]: v as MiniValue };
    });
  }
}

const describe = (v: Value): string => {
  if (v === undefined) return 'nothing';
  if (v instanceof Pattern) return 'a pattern';
  if (isFunc(v)) return `the function ${v.name}`;
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'string' ? `the string ${JSON.stringify(v)}` : `the number ${v}`;
};

// ---- the methods: name → how many arguments before the pattern, and what it does

interface Method { arity: number; rest?: boolean; apply: (it: Interpreter, pat: Pattern<unknown>, args: Value[], pos: number) => Value }


const numeric = (name: string, f: (pat: Pattern<unknown>, n: number | Pattern<number>) => Pattern<unknown>): Method =>
  ({ arity: 1, apply: (it, pat, [n], pos) => f(pat, it.toNumber(n, pos, name)) });
const transform = (name: string, f: (pat: Pattern<unknown>, t: Transform<unknown>) => Pattern<unknown>): Method =>
  ({ arity: 1, apply: (it, pat, [t], pos) => f(pat, it.toTransform(t, pos, name)) });
const numericTransform = (name: string, f: (pat: Pattern<unknown>, n: number | Pattern<number>, t: Transform<unknown>) => Pattern<unknown>): Method =>
  ({ arity: 2, apply: (it, pat, [n, t], pos) => f(pat, it.toNumber(n, pos, name), it.toTransform(t, pos, name)) });
const plain = (f: (pat: Pattern<unknown>) => Pattern<unknown>): Method => ({ arity: 0, apply: (_it, pat) => f(pat) });

// Arithmetic on the values: numbers, note names, or controls (then the note or n)
function arithmetic(name: string, op: (value: MiniValue | Controls, amount: MiniValue | Controls) => MiniValue | Controls): Method {
  return {
    arity: 1,
    apply: (it, pat, [amount], pos) => {
      const amounts = it.toPattern(amount, pos, name);
      return pat.appLeft(amounts, (v, a) => {
        try { return op(v as MiniValue | Controls, a as MiniValue | Controls); } catch (e) { throw it.error(pos, (e as Error).message); }
      });
    }
  };
}
const addValues = (v: MiniValue | Controls, a: MiniValue | Controls): MiniValue | Controls => {
  if (isControls(v)) return addControls(v, a);
  if (isControls(a)) throw new PatternError('add wants a number when the pattern has plain values');
  if (typeof a !== 'number') throw new PatternError(`add wants a number, not ${JSON.stringify(a)}`);
  const sum = noteToMidi(v, 'add') + a;
  if (!Number.isFinite(sum)) throw new PatternError(`add gives ${sum}`);
  return sum;
};
const negate = (a: MiniValue | Controls): MiniValue | Controls => {
  if (isControls(a)) return Object.fromEntries(Object.entries(a).map(([k, x]) => [k, typeof x === 'number' ? -x : x]));
  if (typeof a !== 'number') throw new PatternError(`sub wants a number, not ${JSON.stringify(a)}`);
  return -a;
};

export const METHODS: Record<string, Method> = {
  // time
  fast: numeric('fast', (p, n) => p.fast(n)),
  slow: numeric('slow', (p, n) => p.slow(n)),
  hurry: numeric('hurry', (p, n) => p.fast(n)),
  early: numeric('early', (p, n) => p.early(n)),
  late: numeric('late', (p, n) => p.late(n)),
  rev: plain((p) => p.rev()),
  palindrome: plain((p) => p.palindrome()),
  iter: { arity: 1, apply: (it, p, [n], pos) => p.iter(it.plainNumber(n, pos, 'iter')) },
  iterBack: { arity: 1, apply: (it, p, [n], pos) => p.iter(it.plainNumber(n, pos, 'iterBack'), true) },
  ply: numeric('ply', (p, n) => p.ply(n)),
  // the pattern's own tempo, relative to the program's
  cpm: { arity: 1, apply: (it, p, [n], pos) => p.fast(new Fraction(it.plainNumber(n, pos, 'cpm')).div(60).div(Fraction.from(it.cps))) },
  // structure
  every: numericTransform('every', (p, n, t) => p.every(n, t)),
  firstOf: numericTransform('firstOf', (p, n, t) => p.every(n, t)),
  lastOf: numericTransform('lastOf', (p, n, t) => p.lastOf(n, t)),
  struct: { arity: 1, apply: (it, p, [b], pos) => p.struct(it.toPattern(b, pos, 'struct')) },
  mask: { arity: 1, apply: (it, p, [b], pos) => p.mask(it.toPattern(b, pos, 'mask')) },
  euclid: { arity: 2, rest: true, apply: (it, p, [k, n, r], pos) => p.euclid(it.toNumber(k, pos, 'euclid'), it.toNumber(n, pos, 'euclid'), r === undefined ? 0 : it.toNumber(r, pos, 'euclid')) },
  euclidRot: { arity: 3, apply: (it, p, [k, n, r], pos) => p.euclid(it.toNumber(k, pos, 'euclidRot'), it.toNumber(n, pos, 'euclidRot'), it.toNumber(r, pos, 'euclidRot')) },
  off: numericTransform('off', (p, n, t) => p.off(n, t)),
  superimpose: transform('superimpose', (p, t) => p.superimpose(t)),
  layer: { arity: 1, rest: true, apply: (it, p, ts, pos) => p.layer(...ts.map((t) => it.toTransform(t, pos, 'layer'))) },
  // randomness
  degradeBy: numeric('degradeBy', (p, n) => p.degradeBy(n)),
  degrade: plain((p) => p.degrade()),
  sometimesBy: numericTransform('sometimesBy', (p, n, t) => p.sometimesBy(n, t)),
  sometimes: transform('sometimes', (p, t) => p.sometimes(t)),
  often: transform('often', (p, t) => p.often(t)),
  rarely: transform('rarely', (p, t) => p.rarely(t)),
  almostAlways: transform('almostAlways', (p, t) => p.almostAlways(t)),
  almostNever: transform('almostNever', (p, t) => p.almostNever(t)),
  always: transform('always', (p, t) => p.always(t)),
  never: transform('never', (p) => p),
  someCyclesBy: numericTransform('someCyclesBy', (p, n, t) => p.someCyclesBy(n, t)),
  someCycles: transform('someCycles', (p, t) => p.someCycles(t)),
  // values
  add: arithmetic('add', addValues),
  sub: arithmetic('sub', (v, a) => addValues(v, negate(a))),
  transpose: arithmetic('transpose', addValues),
  range: { arity: 2, apply: (it, p, [lo, hi], pos) => {
    const a = it.plainNumber(lo, pos, 'range'), b = it.plainNumber(hi, pos, 'range');
    return p.fmap((v) => { if (typeof v !== 'number') throw it.error(pos, `range wants a pattern of numbers, not ${JSON.stringify(v)}`); return a + v * (b - a); });
  } },
  // n("0 2 4").scale("C:major") → notes
  scale: { arity: 1, apply: (it, p, [name], pos) => {
    const names = it.toPattern(name, pos, 'scale');
    return p.appLeft(names, (v, spec) => {
      try {
        const scale = parseScale(spec as MiniValue);
        if (isControls(v)) {
          const degree = v.n ?? v.note;
          const { n: _n, ...rest } = v;
          return { ...rest, note: scaleDegree(scale, degree) };
        }
        return { note: scaleDegree(scale, v as MiniValue) };
      } catch (e) { throw it.error(pos, (e as Error).message); }
    });
  } }
};
