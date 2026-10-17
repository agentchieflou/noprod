// @noprod/midi: Standard MIDI File 1.0 reader and writer. Pure data in beats;
// importing into tracks and clips is the store's job.

export { readMidiFile, MAX_FILE_BYTES, MAX_TRACKS, MAX_EVENTS, MAX_BEATS } from './reader.ts';
export { writeMidiFile } from './writer.ts';
export { MidiFileError } from './errors.ts';
export type { MidiFile, MidiTrack, MidiNote, MidiFileData, WriteOptions } from './types.ts';
