// What readMidiFile returns and writeMidiFile takes: plain data, with
// positions in beats (float64 quarter notes, as @noprod/time).

export interface MidiNote {
  pitch: number;                 // 0..127
  start: number;                 // beats
  length: number;                // beats
  velocity: number;              // 0..1 (the file's 1..127 over 127)
  channel: number;               // 0..15
  releaseVelocity?: number;      // 0..1, only when the file has a note-off (8n) event
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
  controllers: { beat: number; channel: number; controller: number; value: number }[];   // value 0..127
  pitchBend: { beat: number; channel: number; value: number }[];                         // −1..1
  programs: { beat: number; channel: number; program: number }[];
  channelPressure: { beat: number; channel: number; value: number }[];                   // 0..127
}

export interface MidiFile {
  format: 0 | 1 | 2;
  ticksPerBeat: number;
  tempo: { beat: number; bpm: number }[];
  meter: { bar: number; numerator: number; denominator: number }[];
  key?: { beat: number; sharps: number; minor: boolean }[];
  markers: { beat: number; text: string }[];
  tracks: MidiTrack[];
  warnings: string[];
}

// What the writer needs of a file: the rest (format, division) is its options
export type MidiFileData = Pick<MidiFile, 'tracks'> & Partial<Pick<MidiFile, 'tempo' | 'meter' | 'key' | 'markers'>>;

export interface WriteOptions {
  format?: 0 | 1;
  ticksPerBeat?: number;         // default 960
}
