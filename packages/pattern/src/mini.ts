// The mini-notation: the string language inside note("c3 [e3 g3]*2 <a3 b3>").
// Our own tokenizer and parser build a tree, which `toPattern` interprets
// with the core combinators. Written from the published language's
// documentation and observed behavior; nothing here derives from any other
// implementation.
//
//   a b c        a sequence: the cycle shared equally
//   ~            a rest
//   [a b]        a sub-sequence in one step
//   <a b>        alternation: one per cycle
//   a*2  a/2     faster, slower (the factor may itself be a pattern: a*<2 3>)
//   a!3  a ! !   the step repeated
//   a@3  a _ _   the step lengthened
//   a, b         polyphony: both at once
//   a(3,8,2)     a Euclidean rhythm: 3 hits over 8 steps, turned 2 later
//   a:3          a sample index (kept in the value: "a:3")
//   a?  a?0.2    dropped at random, half the time or with the probability given
//   a | b        one of them per cycle, at random
//   a . b c      groups: "a" then "[b c]"
//   0 .. 3       a range of numbers: 0 1 2 3
//   {a b c, d e}%4   polymeter: every layer steps at the same rate
//
// Randomness (`?`, `|`) is seeded by the operator's position in the string,
// so the same string always gives the same events.

import { Fraction } from './fraction.ts';
import { PatternError } from './errors.ts';
import {
  Pattern, pure, silence, stack, timecat, randcat, polymeter, patternify, setStringParser, type Patternable
} from './pattern.ts';

export const MINI_LIMITS = { maxLength: 10000, maxDepth: 32 };

export type MiniValue = string | number;

export type MiniNode =
  | { type: 'word'; value: string }
  | { type: 'number'; value: number }
  | { type: 'rest' }
  | { type: 'seq'; steps: MiniStep[] }                 // [a b@2 c]
  | { type: 'alt'; steps: MiniStep[] }                 // <a b c>
  | { type: 'stack'; layers: MiniNode[] }              // a, b
  | { type: 'choice'; options: MiniNode[]; seed: number } // a | b
  | { type: 'poly'; layers: MiniNode[]; steps?: MiniNode } // {a b, c}%4
  | { type: 'fast'; node: MiniNode; factor: MiniNode }
  | { type: 'slow'; node: MiniNode; factor: MiniNode }
  | { type: 'degrade'; node: MiniNode; probability: number; seed: number }
  | { type: 'euclid'; node: MiniNode; hits: MiniNode; steps: MiniNode; rotation?: MiniNode };

export interface MiniStep { node: MiniNode; weight: Fraction }

// ---- tokens

type TokenType = 'word' | 'number' | 'punct' | 'end';
interface Token { type: TokenType; text: string; offset: number }

const PUNCT = ['..', '~', '[', ']', '<', '>', '{', '}', '(', ')', ',', '|', '*', '/', '!', '@', '?', '%', '.', '_'];
const WORD = /^[a-zA-Z][a-zA-Z0-9_#'~.-]*(?::[a-zA-Z0-9_#-]+)*/;
const NUMBER = /^-?\d+(?:\.\d+)?(?:e-?\d+)?|^-?\.\d+/;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    const rest = source.slice(i);
    const number = NUMBER.exec(rest);
    if (number) { tokens.push({ type: 'number', text: number[0], offset: i }); i += number[0].length; continue; }
    const word = WORD.exec(rest);
    if (word && !(word[0].includes('.') && /\.\./.test(word[0]))) {
      // a word may contain dots (a.b) but never the range operator
      tokens.push({ type: 'word', text: word[0], offset: i }); i += word[0].length; continue;
    }
    const punct = PUNCT.find((p) => rest.startsWith(p));
    if (punct) { tokens.push({ type: 'punct', text: punct, offset: i }); i += punct.length; continue; }
    throw positioned(source, i, `unexpected character "${c}"`);
  }
  tokens.push({ type: 'end', text: '', offset: source.length });
  return tokens;
}

function positioned(source: string, offset: number, message: string): PatternError {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return new PatternError(`mini-notation: ${message} at ${line}:${column} in "${source}"`, { offset, line, column });
}

// ---- parser

class Parser {
  private pos = 0;
  private depth = 0;
  private seeds = 0; // one seed per ? and | in the string, in order
  private readonly tokens: Token[];
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenize(source);
  }

  parse(): MiniNode {
    const node = this.content(']', true);
    if (this.peek().type !== 'end') throw this.error(`unexpected "${this.peek().text}"`);
    return node;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }
  private is(text: string): boolean { const t = this.peek(); return t.type === 'punct' && t.text === text; }
  private error(message: string, token = this.peek()): PatternError { return positioned(this.source, token.offset, message); }
  private expect(text: string): void {
    if (!this.is(text)) throw this.error(`expected "${text}" but found ${this.describe(this.peek())}`);
    this.next();
  }
  private describe(t: Token): string { return t.type === 'end' ? 'the end' : `"${t.text}"`; }

  private enter(): void { if (++this.depth > MINI_LIMITS.maxDepth) throw this.error(`nested more than ${MINI_LIMITS.maxDepth} deep`); }
  private leave(): void { this.depth--; }

  // What goes between brackets: alternatives separated by |, each a stack of
  // layers separated by , (or polymeter layers in {}), each a sequence
  private content(closer: string, top = false, poly = false): MiniNode {
    const options: MiniNode[] = [];
    const seedAt = this.seeds;
    let hasChoice = false;
    for (;;) {
      const layers: MiniNode[] = [];
      for (;;) {
        layers.push(this.sequence(closer));
        if (this.is(',')) { this.next(); continue; }
        break;
      }
      options.push(poly ? { type: 'poly', layers } : layers.length === 1 ? layers[0] : { type: 'stack', layers });
      if (this.is('|')) { this.next(); hasChoice = true; this.seeds++; continue; }
      break;
    }
    if (!top && !this.is(closer)) throw this.error(`expected "${closer}" but found ${this.describe(this.peek())}`);
    if (!hasChoice) return options[0];
    return { type: 'choice', options, seed: seedAt };
  }

  // Steps up to the next , | or closer; "." groups them
  private sequence(closer: string): MiniNode {
    const groups: MiniStep[][] = [[]];
    let steps = groups[0];
    while (!this.is(',') && !this.is('|') && !this.is(closer) && this.peek().type !== 'end') {
      if (this.is('.')) { this.next(); steps = []; groups.push(steps); continue; }
      if (this.is('!')) {
        // a bare ! repeats the step before it
        this.next();
        const last = steps.at(-1);
        if (!last) throw this.error('"!" has no step to repeat');
        steps.push({ node: last.node, weight: new Fraction(1) });
        continue;
      }
      if (this.is('_')) {
        this.next();
        const last = steps.at(-1);
        if (!last) throw this.error('"_" has no step to lengthen');
        last.weight = last.weight.add(1);
        continue;
      }
      if (this.is('..')) {
        this.next();
        const from = steps.at(-1);
        const to = this.term();
        if (!from || from.node.type !== 'number' || to.type !== 'number' || !Number.isInteger(from.node.value) || !Number.isInteger(to.value)) {
          throw this.error('".." wants a whole number on each side');
        }
        const a = from.node.value, b = to.value;
        if (Math.abs(b - a) > 1024) throw this.error('a range of more than 1024 steps');
        const direction = Math.sign(b - a);
        for (let n = a + direction; direction !== 0 && (direction > 0 ? n <= b : n >= b); n += direction) steps.push({ node: { type: 'number', value: n }, weight: new Fraction(1) });
        continue;
      }
      steps.push(...this.step());
    }
    if (groups.length === 1) return this.seqOf(steps);
    return { type: 'seq', steps: groups.map((g) => ({ node: this.seqOf(g), weight: new Fraction(1) })) };
  }

  private seqOf(steps: MiniStep[]): MiniNode {
    if (steps.length === 0) throw this.error('an empty sequence');
    if (steps.length === 1 && steps[0].weight.eq(1)) return steps[0].node;
    return { type: 'seq', steps };
  }

  // A term with its modifiers; ! makes it several steps
  private step(): MiniStep[] {
    const start = this.peek();
    let node = this.term();
    let weight = new Fraction(1);
    let count = 1;
    for (;;) {
      if (this.is('*') || this.is('/')) {
        const op = this.next().text === '*' ? 'fast' : 'slow';
        node = { type: op, node, factor: this.factor() };
      } else if (this.is('!')) {
        // a!3 repeats; a bare ! after a modifier is read by the sequence
        if (this.tokens[this.pos + 1]?.type !== 'number') break;
        this.next();
        const n = Number(this.next().text);
        if (!Number.isInteger(n) || n < 0) throw this.error('"!" wants a whole number');
        if (n > 1024) throw this.error('"!" repeats more than 1024 times');
        count = n;
      } else if (this.is('@')) {
        this.next();
        const t = this.next();
        if (t.type !== 'number') throw this.error('"@" wants a number', t);
        const w = Fraction.from(t.text);
        weight = w.gt(0) ? w : new Fraction(1);
      } else if (this.is('?')) {
        this.next();
        let probability = 0.5;
        if (this.peek().type === 'number') {
          probability = Number(this.next().text);
          if (probability < 0 || probability > 1) throw this.error('"?" wants a probability from 0 to 1');
        }
        node = { type: 'degrade', node, probability, seed: this.seeds++ };
      } else if (this.is('(')) {
        this.next();
        this.enter();
        const hits = this.sequence(')');
        this.expect(',');
        const steps = this.sequence(')');
        let rotation: MiniNode | undefined;
        if (this.is(',')) { this.next(); rotation = this.sequence(')'); }
        this.expect(')');
        this.leave();
        node = { type: 'euclid', node, hits, steps, rotation };
      } else break;
    }
    if (count === 0) return [{ node: { type: 'rest' }, weight }];
    if (start.type === 'end') throw this.error('expected a step');
    return Array.from({ length: count }, () => ({ node, weight }));
  }

  // The number after * or /, or a bracketed pattern of numbers
  private factor(): MiniNode {
    const t = this.peek();
    if (t.type === 'number') { this.next(); return { type: 'number', value: Number(t.text) }; }
    if (this.is('[') || this.is('<') || this.is('{')) return this.term();
    throw this.error(`expected a number after "${this.tokens[this.pos - 1].text}" but found ${this.describe(t)}`);
  }

  private term(): MiniNode {
    const t = this.next();
    if (t.type === 'number') return { type: 'number', value: Number(t.text) };
    if (t.type === 'word') return { type: 'word', value: t.text };
    if (t.type === 'punct') {
      if (t.text === '~') return { type: 'rest' };
      if (t.text === '[') { this.enter(); const node = this.content(']'); this.expect(']'); this.leave(); return node; }
      if (t.text === '<') {
        this.enter();
        const node = this.content('>');
        this.expect('>');
        this.leave();
        return this.alternationOf(node);
      }
      if (t.text === '{') {
        this.enter();
        const node = this.content('}', false, true);
        this.expect('}');
        let steps: MiniNode | undefined;
        if (this.is('%')) { this.next(); steps = this.factor(); }
        this.leave();
        if (node.type === 'poly') return steps ? { ...node, steps } : node;
        // choices of polymeters: carry the step count into each
        return { ...node, options: (node as { options: MiniNode[] }).options.map((o) => (o.type === 'poly' && steps ? { ...o, steps } : o)) } as MiniNode;
      }
    }
    throw this.error(`unexpected ${this.describe(t)}`, t);
  }

  // <a b c> is the sequence's steps, one per cycle (a choice or stack inside
  // <> alternates each of its layers)
  private alternationOf(node: MiniNode): MiniNode {
    if (node.type === 'seq') return { type: 'alt', steps: node.steps };
    if (node.type === 'stack') return { ...node, layers: node.layers.map((l) => this.alternationOf(l)) };
    if (node.type === 'choice') return { ...node, options: node.options.map((o) => this.alternationOf(o)) };
    return { type: 'alt', steps: [{ node, weight: new Fraction(1) }] };
  }
}

export function parseMini(source: string): MiniNode {
  if (typeof source !== 'string') throw new PatternError(`mini-notation wants a string, not ${typeof source}`);
  if (source.length > MINI_LIMITS.maxLength) throw new PatternError(`mini-notation: longer than ${MINI_LIMITS.maxLength} characters`);
  return new Parser(source).parse();
}

// ---- interpretation

function numberOf(v: unknown, what: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  throw new PatternError(`${what} wants a number, not ${JSON.stringify(v)}`);
}

// A numeric argument: a plain number, or a pattern of them (then `f` is patternified)
function numeric(node: MiniNode): Patternable<number> {
  if (node.type === 'number') return node.value;
  return toPattern(node).fmap((v) => numberOf(v, 'a mini-notation factor'));
}

export function toPattern(node: MiniNode): Pattern<MiniValue> {
  switch (node.type) {
    case 'word': return pure(node.value);
    case 'number': return pure(node.value);
    case 'rest': return silence;
    case 'seq': return timecat(...node.steps.map((s) => [s.weight, toPattern(s.node)] as [Fraction, Pattern<MiniValue>]));
    case 'alt': {
      const total = node.steps.reduce((sum, s) => sum.add(s.weight), new Fraction(0));
      return timecat(...node.steps.map((s) => [s.weight, toPattern(s.node)] as [Fraction, Pattern<MiniValue>]))._slow(total);
    }
    case 'stack': return stack(...node.layers.map(toPattern));
    case 'choice': return randcat(node.options.map(toPattern), node.seed);
    case 'poly': {
      const layers = node.layers.map((l) => (l.type === 'seq' ? l.steps : [{ node: l, weight: new Fraction(1) }]));
      const sequences = layers.map((steps) => steps.map((s) => toPattern(s.node)));
      const build = (steps: number) => {
        if (!Number.isInteger(steps) || steps <= 0) throw new PatternError(`a polymeter wants a positive whole number of steps, not ${steps}`);
        return polymeter(sequences, steps);
      };
      if (!node.steps) return build(layers[0].length);
      return patternify((n: number, _p: Pattern<MiniValue>) => build(n))(numeric(node.steps), silence);
    }
    case 'fast': return toPattern(node.node).fast(numeric(node.factor));
    case 'slow': return toPattern(node.node).slow(numeric(node.factor));
    case 'degrade': return toPattern(node.node)._degradeBy(node.probability, node.seed);
    case 'euclid': return toPattern(node.node).euclid(numeric(node.hits), numeric(node.steps), node.rotation ? numeric(node.rotation) : 0);
  }
}

export function mini(source: string): Pattern<MiniValue> { return toPattern(parseMini(source)); }

// Strings given to the core where a pattern is wanted are mini-notation
setStringParser(mini);
