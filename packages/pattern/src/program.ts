// The program language: the JavaScript-shaped code dictation writes, parsed
// by our own parser into a tree. Nothing is evaluated as JavaScript; the
// interpreter (evaluate.ts) walks this tree and only ever calls the
// functions in its own table.
//
//   setcpm(120/4)
//   stack(
//     s("bd*4, ~ cp").bank("RolandTR909"),
//     note("c2 ~ eb2 g1").s("bass").gain(0.8),
//     n("0 2 4").scale("C:minor").s("epiano").every(4, x => x.rev())
//   )
//
// Covered: number and string literals, arithmetic on numbers, identifiers,
// calls, method chains (across lines), arrays, one-parameter arrow functions,
// `$:` labels (one pattern per line, all played together; `_$:` mutes one),
// statements separated by newlines or semicolons, and comments.

import { PatternError } from './errors.ts';

export const PROGRAM_LIMITS = { maxLength: 10000, maxDepth: 64, maxArguments: 256 };

export interface Position { offset: number; line: number; column: number }

export type Expr =
  | { type: 'number'; value: number; pos: number }
  | { type: 'string'; value: string; pos: number }
  | { type: 'identifier'; name: string; pos: number }
  | { type: 'call'; callee: Expr; args: Expr[]; pos: number }
  | { type: 'member'; object: Expr; name: string; pos: number }
  | { type: 'array'; items: Expr[]; pos: number }
  | { type: 'arrow'; param: string; body: Expr; pos: number }
  | { type: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr; pos: number }
  | { type: 'negate'; operand: Expr; pos: number };

export interface Statement { expr: Expr; label?: string; muted?: boolean; pos: number }

export interface Program { statements: Statement[] }

// ---- tokens

type TokenType = 'number' | 'string' | 'identifier' | 'punct' | 'newline' | 'end';
interface Token { type: TokenType; text: string; value?: string | number; offset: number }

const PUNCT = ['=>', '(', ')', '[', ']', ',', '.', '+', '-', '*', '/', ';', ':'];

export function positionOf(source: string, offset: number): Position {
  const before = source.slice(0, offset);
  const line = before.split('\n').length;
  return { offset, line, column: offset - before.lastIndexOf('\n') };
}

function fail(source: string, offset: number, message: string): PatternError {
  const p = positionOf(source, offset);
  return new PatternError(`${message} at ${p.line}:${p.column}`, p);
}

export function tokenizeProgram(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0; // inside ( ) or [ ], newlines mean nothing
  while (i < source.length) {
    const c = source[i];
    if (c === '\n') { if (depth === 0) tokens.push({ type: 'newline', text: '\n', offset: i }); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw fail(source, i, 'a comment that never ends');
      i = end + 2;
      continue;
    }
    const rest = source.slice(i);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) { tokens.push({ type: 'number', text: number[0], value: Number(number[0]), offset: i }); i += number[0].length; continue; }
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (identifier) { tokens.push({ type: 'identifier', text: identifier[0], offset: i }); i += identifier[0].length; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') {
          const next = source[j + 1];
          const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", '`': '`' };
          if (!(next in escapes)) throw fail(source, j, `unknown escape "\\${next ?? ''}"`);
          value += escapes[next];
          j += 2;
          continue;
        }
        if (c === '`' && source[j] === '$' && source[j + 1] === '{') throw fail(source, j, 'template literals can\'t interpolate');
        if (source[j] === '\n' && c !== '`') throw fail(source, i, 'a string that never ends');
        value += source[j++];
      }
      if (j >= source.length) throw fail(source, i, 'a string that never ends');
      tokens.push({ type: 'string', text: source.slice(i, j + 1), value, offset: i });
      i = j + 1;
      continue;
    }
    const punct = PUNCT.find((p) => rest.startsWith(p));
    if (punct) {
      if (punct === '(' || punct === '[') depth++;
      if (punct === ')' || punct === ']') depth = Math.max(0, depth - 1);
      tokens.push({ type: 'punct', text: punct, offset: i });
      i += punct.length;
      continue;
    }
    throw fail(source, i, `unexpected character "${c}"`);
  }
  tokens.push({ type: 'end', text: '', offset: source.length });
  return tokens;
}

// ---- parser

class Parser {
  private pos = 0;
  private depth = 0;
  private readonly tokens: Token[];
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenizeProgram(source);
  }

  program(): Program {
    const statements: Statement[] = [];
    this.skipSeparators();
    while (this.peek().type !== 'end') {
      statements.push(this.statement());
      if (!this.is(';') && !this.isNewline() && this.peek().type !== 'end') {
        throw this.error(`unexpected ${this.describe(this.peek())}; expected the end of the line`);
      }
      this.skipSeparators();
    }
    return { statements };
  }

  private peek(ahead = 0): Token { return this.tokens[Math.min(this.pos + ahead, this.tokens.length - 1)]; }
  private next(): Token { return this.tokens[this.pos++]; }
  private is(text: string, ahead = 0): boolean { const t = this.peek(ahead); return t.type === 'punct' && t.text === text; }
  private isNewline(): boolean { return this.peek().type === 'newline'; }
  private skipNewlines(): void { while (this.isNewline()) this.pos++; }
  private skipSeparators(): void { while (this.isNewline() || this.is(';')) this.pos++; }
  private describe(t: Token): string {
    if (t.type === 'end') return 'the end of the program';
    if (t.type === 'newline') return 'the end of the line';
    return `"${t.text}"`;
  }
  private error(message: string, token = this.peek()): PatternError { return fail(this.source, token.offset, message); }
  private expect(text: string): Token {
    if (!this.is(text)) throw this.error(`expected "${text}" but found ${this.describe(this.peek())}`);
    return this.next();
  }
  private enter(): void { if (++this.depth > PROGRAM_LIMITS.maxDepth) throw this.error(`nested more than ${PROGRAM_LIMITS.maxDepth} deep`); }
  private leave(): void { this.depth--; }

  private statement(): Statement {
    const start = this.peek();
    // "$: pattern" and "_$: pattern" labels
    if (start.type === 'identifier' && /^_?\$$/.test(start.text) && this.is(':', 1)) {
      this.next(); this.next();
      this.skipNewlines();
      return { expr: this.expression(), label: '$', muted: start.text.startsWith('_'), pos: start.offset };
    }
    if (start.type === 'identifier' && this.is(':', 1)) throw this.error(`unknown label "${start.text}:"; only "$:" is supported`);
    return { expr: this.expression(), pos: start.offset };
  }

  // arrow functions, then arithmetic
  private expression(): Expr {
    this.enter();
    try {
      // x => body   or   (x) => body
      const t = this.peek();
      if (t.type === 'identifier' && this.is('=>', 1)) {
        this.next(); this.next();
        this.skipNewlines();
        return { type: 'arrow', param: t.text, body: this.expression(), pos: t.offset };
      }
      if (this.is('(') && this.peek(1).type === 'identifier' && this.is(')', 2) && this.is('=>', 3)) {
        this.next();
        const param = this.next();
        this.next(); this.next();
        this.skipNewlines();
        return { type: 'arrow', param: param.text, body: this.expression(), pos: t.offset };
      }
      if (this.is('(') && this.is(')', 1) && this.is('=>', 2)) throw this.error('an arrow function wants one parameter, the pattern');
      return this.additive();
    } finally {
      this.leave();
    }
  }

  private additive(): Expr {
    let left = this.multiplicative();
    while (this.is('+') || this.is('-')) {
      const op = this.next();
      const right = this.multiplicative();
      left = { type: 'binary', op: op.text as '+' | '-', left, right, pos: op.offset };
    }
    return left;
  }

  private multiplicative(): Expr {
    let left = this.unary();
    while (this.is('*') || this.is('/')) {
      const op = this.next();
      const right = this.unary();
      left = { type: 'binary', op: op.text as '*' | '/', left, right, pos: op.offset };
    }
    return left;
  }

  private unary(): Expr {
    if (this.is('-')) { const t = this.next(); return { type: 'negate', operand: this.unary(), pos: t.offset }; }
    if (this.is('+')) { this.next(); return this.unary(); }
    return this.postfix();
  }

  // calls and member chains; a chain may continue on the next line
  private postfix(): Expr {
    let expr = this.primary();
    for (;;) {
      if (this.is('(')) {
        const open = this.next();
        const args: Expr[] = [];
        this.skipNewlines();
        while (!this.is(')')) {
          if (args.length >= PROGRAM_LIMITS.maxArguments) throw this.error(`more than ${PROGRAM_LIMITS.maxArguments} arguments`);
          args.push(this.expression());
          this.skipNewlines();
          if (this.is(',')) { this.next(); this.skipNewlines(); continue; }
          if (!this.is(')')) throw this.error(`expected "," or ")" but found ${this.describe(this.peek())}`);
        }
        this.next();
        expr = { type: 'call', callee: expr, args, pos: open.offset };
      } else if (this.is('.') || (this.isNewline() && this.continuesWithDot())) {
        this.skipNewlines();
        const dot = this.next();
        const name = this.next();
        if (name.type !== 'identifier') throw this.error(`expected a method name after "." but found ${this.describe(name)}`, name);
        expr = { type: 'member', object: expr, name: name.text, pos: dot.offset };
      } else break;
    }
    return expr;
  }

  private continuesWithDot(): boolean {
    let i = 0;
    while (this.peek(i).type === 'newline') i++;
    return this.is('.', i);
  }

  private primary(): Expr {
    const t = this.next();
    if (t.type === 'number') return { type: 'number', value: t.value as number, pos: t.offset };
    if (t.type === 'string') return { type: 'string', value: t.value as string, pos: t.offset };
    if (t.type === 'identifier') return { type: 'identifier', name: t.text, pos: t.offset };
    if (t.type === 'punct' && t.text === '(') {
      this.skipNewlines();
      const inner = this.expression();
      this.skipNewlines();
      this.expect(')');
      return inner;
    }
    if (t.type === 'punct' && t.text === '[') {
      const items: Expr[] = [];
      this.skipNewlines();
      while (!this.is(']')) {
        if (items.length >= PROGRAM_LIMITS.maxArguments) throw this.error(`more than ${PROGRAM_LIMITS.maxArguments} items`);
        items.push(this.expression());
        this.skipNewlines();
        if (this.is(',')) { this.next(); this.skipNewlines(); continue; }
        if (!this.is(']')) throw this.error(`expected "," or "]" but found ${this.describe(this.peek())}`);
      }
      this.next();
      return { type: 'array', items, pos: t.offset };
    }
    throw this.error(`unexpected ${this.describe(t)}`, t);
  }
}

export function parseProgram(source: string): Program {
  if (typeof source !== 'string') throw new PatternError(`a program is a string, not ${typeof source}`);
  if (source.length > PROGRAM_LIMITS.maxLength) throw new PatternError(`the program is longer than ${PROGRAM_LIMITS.maxLength} characters`);
  return new Parser(source).program();
}
