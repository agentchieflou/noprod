// Every refusal of a file's bytes: what was wrong, and where
export class MidiFileError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (at byte ${offset})`);
    this.name = 'MidiFileError';
    this.offset = offset;
  }
}
