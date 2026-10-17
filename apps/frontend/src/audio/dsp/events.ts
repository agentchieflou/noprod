// What the main thread sends the engine worklet (engineNode.ts ->
// worklets/engine-processor.ts), and what it reports back. Times come in
// two forms: a song position within a span (the transport's timeline,
// seconds for now, beats from step 4 of #159), or an absolute context time
// (a live key, an audition, the band). Positions become frames here, so a
// tempo map can later replace the linear mapping in one place.

import type { LiveTarget, SoundRecipe } from '@noprod/sound';

export const BLOCK = 128;

// An event that arrives later than this after its time is dropped and
// counted, not played off the beat (library.ts's LATE_BUDGET, as frames)
export const LATE_SECONDS = 0.03;

export type VoiceSpec =
  // a rendered note (or a sample) played at a rate; `release` makes it a
  // held voice that fades when let go, else it plays out
  | { kind: 'buffer'; buf: number; rate: number; level: number; release?: number; choke?: { group: number; pad: number } }
  // the NoProd Synth's oscillator and ADSR
  | { kind: 'synth'; wave: string; hz: number; attack: number; decay: number; sustain: number; release: number; peak: number }
  // a NoProd Drums hit
  | { kind: 'drum'; note: number; tune: number; decay: number; level: number }
  // a physical model played live (liveVoices.ts)
  | { kind: 'model'; recipe: SoundRecipe; note: number; velocity: number; transpose: number; gain: number; tunings: number[] };

// A span: a stretch of the timeline [posStart, posEnd) played from context
// time ctxStart (transport.ts's Segment)
export interface SpanSpec { id: number; ctxStart: number; posStart: number; posEnd: number }

export interface NoteEvent {
  key: string;
  strip: number;          // the engine output it plays on
  span?: number;          // with `pos`: a timeline position in that span
  pos?: number;
  at?: number;            // else an absolute context time (seconds)
  voice: VoiceSpec;
  duration: number;       // seconds; the synth holds for it, a buffer plays out
}

export interface ClipEvent {
  key: string;
  strip: number;
  span: number;
  pos: number;            // where in the span it starts
  endPos: number;         // and stops
  buf: number;
  offset: number;         // source seconds at `pos`
  rate: number;           // source seconds per played second
  loop: [number, number] | null;   // source seconds
  gain: number;
  // granular time-stretch until a warped clip's render is ready: grains of
  // `grain` seconds every `hop`, each read at `pitch`, with `jitter` on
  // Texture; null plays the buffer straight
  grains: { grain: number; hop: number; jitter: number; pitch: number } | null;
}

export type EngineMessage =
  | { type: 'buffer'; id: number; l: Float32Array; r: Float32Array }
  | { type: 'forget'; ids: number[] }
  | { type: 'span'; span: SpanSpec }
  | { type: 'closeSpan'; id: number; at: number }
  | { type: 'notes'; notes: NoteEvent[] }
  | { type: 'clips'; clips: ClipEvent[] }
  | { type: 'retract'; keys: string[]; at?: number }
  | { type: 'liveOn'; key: string; strip: number; at: number; voice: VoiceSpec }
  | { type: 'liveOff'; key: string; at: number }
  | { type: 'control'; strip: number; to: LiveTarget; value: number; smoothing: number; at: number }
  | { type: 'silence'; strip: number; at: number }
  | { type: 'stop'; at: number }
  | { type: 'sync' }
  | { type: 'stats' };

// How the engine is doing: events started, started late (within the
// budget) and dropped (past it), what's queued and sounding, and the
// render thread's pace as live-models.ts measured it: blocks that took
// longer to make than they last, and dropouts (falling further behind than
// the device had queued)
export interface EngineStats {
  started: number;
  late: number;
  dropped: number;
  retracted: number;
  pending: number;
  sounding: number;
  voices: number;        // physical models sounding
  blocks: number;
  blocksLate: number;
  dropouts: number;
  busy: number;          // ms
  worst: number;         // ms
  seconds: number;
}

export type EngineReply =
  | { type: 'synced' }
  | ({ type: 'stats' } & EngineStats)
  | { type: 'dropped'; key: string; lateBy: number };
