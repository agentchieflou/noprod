// Every error the engine raises on purpose: bad input, a limit hit. Anything
// else escaping is a bug.
export class PatternError extends Error {
  // Where in the source the problem is, when a parser found it
  readonly position?: { offset: number; line: number; column: number };
  constructor(message: string, position?: { offset: number; line: number; column: number }) {
    super(message);
    this.name = 'PatternError';
    this.position = position;
  }
}
