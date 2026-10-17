// The streaming scheduler (#159, step 2): what the store says plays on the
// timeline becomes engine events, posted a window ahead and taken back
// when an edit undoes them. Nothing is rebuilt on an edit: the posted
// window is diffed against the store, and only what changed is posted or
// retracted.
//
// A span is a stretch of the timeline [posStart, posEnd) played from a
// context time (transport.ts's segment). Within it, `advance` posts the
// notes that start up to a position, audio clips and frozen tracks are
// posted once for their whole overlap, and `resync` re-reads the store.
// The transport drives the live engine; renderArrangement drives one on
// an OfflineAudioContext, a window at a time with the context suspended,
// which is how an offline render stays sample-exact (the worklet gets no
// messages while it renders).

import { Engine, loadEngine } from './engineNode';
import { clipTimelineLength, clipLoop, clipPitchRate, clipRate, expandMidiNotes, isWarped, sourcePosAt } from './clipPlayback';
import { applyMidiEffects } from './midiEffects';
import { dbToGain } from './devices';
import { cachedNoteBuffer, noteBuffer, resolveLibraryNote, whenRendered } from './library';
import { stretchedBuffer } from './warp';
import { drumSpec, synthSpec } from './engineVoices';
import { BLOCK, type ClipEvent, type EngineStats, type NoteEvent } from './dsp/events';

// Grain sizes per warp mode: short for punchy material, long for pads
const WARP_GRAINS: Record<string, { grain: number; jitter: number }> = {
  beats: { grain: 0.05, jitter: 0 },
  tones: { grain: 0.09, jitter: 0 },
  texture: { grain: 0.16, jitter: 0.012 }
};

interface PostedNote { pos: number; cancel: (at?: number) => void; posted: boolean }
interface PostedClip { pos: number; signature: string; key: string } // key: the engine's, fresh on each restart

export interface Span {
  id: number;
  ctxStart: number;
  posStart: number;
  posEnd: number;            // Infinity when not looping
  cursor: number;            // notes posted up to this position
  notes: Map<string, PostedNote>;
  clips: Map<string, PostedClip>;
  clickCursor: number;       // the transport's metronome cursor
  engine: boolean;           // posted to the engine (a count-in span isn't)
}

interface Note { key: string; trackId: string; pos: number; duration: number; params: any; pitch: number; velocity: number }

// A region's notes, expanded (clip loops, transpose) and through the
// track's MIDI effects, sorted by start: an hour-long clip is read a window
// at a time, not whole on every tick. The store replaces a region or a
// track's effects on edit, so the cache follows their identity.
type Expanded = { start: number; end: number; pitch: number; velocity: number; id?: string };
const expanded = new WeakMap<object, { effects: unknown; notes: Expanded[] }>();
function expandedNotes(region: any, effects: unknown): Expanded[] {
  const hit = expanded.get(region);
  if (hit && hit.effects === effects) return hit.notes;
  const notes = [...applyMidiEffects(expandMidiNotes(region), effects as any)].sort((a, b) => a.start - b.start);
  expanded.set(region, { effects, notes });
  return notes;
}
// The first note starting at or after `start`
function firstFrom(notes: Expanded[], start: number) {
  let lo = 0, hi = notes.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (notes[mid].start < start) lo = mid + 1; else hi = mid; }
  return lo;
}

let nextSpanId = 1;

export class Scheduler {
  spans: Span[] = [];
  // the tracks whose arrangement clips are silent (a session clip holds them)
  owned = new Set<string>();
  private generation = 0; // restarts of a clip get a key of their own

  // for the tests: notes asked for, those that reached the engine (a
  // render can arrive too late, or be taken back first), clips posted,
  // and events taken back
  counts = { notes: 0, posted: 0, clips: 0, retracted: 0 };

  readonly engine: Engine;
  readonly ctx: BaseAudioContext;
  private getState: () => any;
  private only?: Set<string>;

  constructor(engine: Engine, ctx: BaseAudioContext, getState: () => any, only?: Set<string>) {
    this.engine = engine;
    this.ctx = ctx;
    this.getState = getState;
    this.only = only;
  }

  private tracks(st: any): any[] {
    return (st.tracks || []).filter((t: any) => !this.only || this.only.has(t.id));
  }

  // Every track's output, claimed before anything is posted: the engine
  // grows its outputs by remaking its node, which loses what was queued
  claim() {
    for (const t of this.tracks(this.getState())) this.engine.output(t.id);
  }

  // Sends the buffers the window [from, to) plays before the clock is read
  // for it, so that posting the window takes nothing off its lead
  prepare(from: number, to: number) {
    const st = this.getState();
    for (const n of this.notesIn(st, from, to)) {
      if (n.params.Kit !== 'library') continue;
      const r = resolveLibraryNote(n.params, n.pitch, n.velocity, n.duration);
      const buffer = r && cachedNoteBuffer(r, this.ctx.sampleRate);
      if (buffer) this.engine.bufferId(buffer);
    }
    this.clipEvents(st, { posEnd: to } as Span, from); // sends their buffers
  }

  // ----------------------------------------------------------------- spans

  open(ctxStart: number, posStart: number, posEnd: number, engine = true): Span {
    const span: Span = { id: nextSpanId++, ctxStart, posStart, posEnd, cursor: posStart, notes: new Map(), clips: new Map(), clickCursor: posStart, engine };
    this.spans.push(span);
    if (engine) {
      this.engine.span({ id: span.id, ctxStart, posStart, posEnd });
      this.postClips(span, posStart);
    }
    return span;
  }

  // The span ends at `atCtx`: nothing of it starts after that
  close(span: Span, atCtx: number) {
    if (span.engine) this.engine.closeSpan(span.id, atCtx);
    for (const n of span.notes.values()) if (!n.posted) n.cancel(atCtx);
    const i = this.spans.indexOf(span);
    if (i >= 0) this.spans.splice(i, 1);
  }

  // Everything stops at `atCtx`
  clear(atCtx: number) {
    for (const span of this.spans) for (const n of span.notes.values()) if (!n.posted) n.cancel(atCtx);
    this.spans = [];
    this.engine.stopAll(atCtx);
  }

  // Forget spans that ended long enough ago that nothing of theirs sounds
  prune(nowCtx: number) {
    this.spans = this.spans.filter((s, i) => i === this.spans.length - 1 || s.ctxStart + (s.posEnd - s.posStart) > nowCtx - 5);
  }

  // The context time of a position in a span
  ctxAt = (span: Span, pos: number) => span.ctxStart + (pos - span.posStart);

  // ----------------------------------------------------------------- notes

  // Every note a track's MIDI clips play in [from, to) of the timeline
  private notesIn(st: any, from: number, to: number): Note[] {
    const out: Note[] = [];
    const bpm = st.bpm || 120;
    const trackById = new Map(this.tracks(st).map((t: any) => [t.id, t]));
    for (const region of st.regions || []) {
      if (region.type !== 'midi' || !region.notes) continue;
      const track = trackById.get(region.trackId);
      if (!track?.instrument || track.isFrozen || this.owned.has(region.trackId)) continue;
      const start = region.startTime;
      const end = start + clipTimelineLength(region, bpm);
      if (end <= from || start >= to) continue;
      const notes = expandedNotes(region, track.midiEffects);
      for (let i = firstFrom(notes, from - start); i < notes.length; i++) {
        const o = notes[i];
        const pos = start + o.start;
        if (pos >= to || pos >= end) break;
        out.push({ key: `${region.id}:${o.id}`, trackId: region.trackId, pos, duration: Math.min(o.end, end - start) - o.start, params: track.instrument.parameters, pitch: o.pitch, velocity: o.velocity });
      }
    }
    return out;
  }

  // Posts a note, or adds it to `batch` (one message for a window's notes)
  // when its buffer is to hand; a render still to come posts on its own
  private postNote(span: Span, n: Note, batch?: NoteEvent[]) {
    const key = `${span.id}:${n.key}`;
    const strip = this.engine.output(n.trackId);
    const when = this.ctxAt(span, n.pos);
    const entry: PostedNote = { pos: n.pos, cancel: () => {}, posted: false };
    span.notes.set(key, entry);
    this.counts.notes++;
    const params = n.params;
    let sync = true; // still inside this call: the batch is open
    const post = (event: NoteEvent) => {
      entry.posted = true;
      this.counts.posted++;
      if (batch && sync) batch.push(event); else this.engine.notes([event]);
    };
    if (params.Kit === 'library') {
      const r = resolveLibraryNote(params, n.pitch, n.velocity, n.duration);
      if (!r) return;
      entry.cancel = noteBuffer(this.ctx, r, when, (buffer, at) => {
        const voice: NoteEvent['voice'] = {
          kind: 'buffer', buf: this.engine.bufferId(buffer), rate: 1, level: r.level,
          ...(r.chokeGroup !== undefined && r.pad !== undefined ? { choke: { group: r.chokeGroup, pad: r.pad } } : {})
        };
        // on time: at its position in the span (so a loop seam or a jump still takes it back);
        // late: now, as an absolute time
        if (at <= when) post({ key, strip, span: span.id, pos: n.pos, voice, duration: n.duration });
        else post({ key, strip, at, voice, duration: n.duration });
      }).cancel;
      sync = false;
      return;
    }
    const voice = params.Kit === 'drums' ? drumSpec(params, n.pitch, n.velocity) : synthSpec(params, n.pitch, n.velocity);
    post({ key, strip, span: span.id, pos: n.pos, voice, duration: n.duration });
    sync = false;
  }

  // Post the notes that start in [cursor, to)
  advance(span: Span, to: number) {
    if (!span.engine) return;
    const limit = Math.min(to, span.posEnd);
    if (limit <= span.cursor) return;
    const batch: NoteEvent[] = [];
    for (const n of this.notesIn(this.getState(), span.cursor, limit)) this.postNote(span, n, batch);
    this.engine.notes(batch);
    span.cursor = limit;
  }

  // ----------------------------------------------------------------- clips

  private clipEvents(st: any, span: Span, from: number): { key: string; signature: string; event: Omit<ClipEvent, 'key' | 'span'> }[] {
    const out: { key: string; signature: string; event: Omit<ClipEvent, 'key' | 'span'> }[] = [];
    const bpm = st.bpm || 120;
    const tracks = this.tracks(st);
    const trackById = new Map(tracks.map((t: any) => [t.id, t]));
    // Frozen tracks play their rendered buffer instead of live clips
    for (const t of tracks) {
      if (!t.isFrozen || !t.frozenBuffer) continue;
      const a = Math.max(from, 0), b = Math.min(span.posEnd, t.frozenDuration);
      if (b <= a) continue;
      out.push({
        key: `frozen:${t.id}`, signature: `${t.frozenDuration}`,
        event: { strip: this.engine.output(t.id), pos: a, endPos: b, buf: this.engine.bufferId(t.frozenBuffer), offset: a, rate: 1, loop: null, gain: 1, grains: null }
      });
    }
    for (const region of st.regions || []) {
      if (region.type === 'midi' || !region.audioBuffer) continue;
      const track = trackById.get(region.trackId);
      if (!track || track.isFrozen || this.owned.has(region.trackId)) continue;
      const start = region.startTime;
      const end = start + clipTimelineLength(region, bpm);
      const a = Math.max(from, start), b = Math.min(span.posEnd, end);
      if (b <= a) continue;
      const buffer: AudioBuffer = region.audioBuffer;
      const rate = clipRate(region, bpm);
      const loop = clipLoop(region);
      const gain = dbToGain(region.gain || 0, -96);
      const stretching = isWarped(region) && region.warpMode !== 'repitch';
      const stretched = stretching ? stretchedBuffer(region, bpm) : null;
      const strip = this.engine.output(region.trackId);
      const x = a - start; // played seconds into the clip
      let event: Omit<ClipEvent, 'key' | 'span'>;
      if (stretching && !stretched) {
        // grains until the render is ready: each read at the tempo ratio and pitched on its own
        const { grain, jitter } = WARP_GRAINS[region.warpMode] || WARP_GRAINS.beats;
        event = {
          strip, pos: a, endPos: b, buf: this.engine.bufferId(buffer), offset: sourcePosAt(region, bpm, x), rate, loop, gain,
          grains: { grain, hop: grain / 2, jitter, pitch: clipPitchRate(region) }
        };
      } else {
        // plain playback, Re-Pitch, or the stretched render: one player, looped at the source
        const played = stretched ?? buffer;
        const scale = stretched ? region.originalBpm / bpm : 1;
        event = {
          strip, pos: a, endPos: b, buf: this.engine.bufferId(played), offset: sourcePosAt(region, bpm, x) * scale, rate: stretched ? 1 : rate,
          loop: loop ? [loop[0] * scale, loop[1] * scale] : null, gain, grains: null
        };
      }
      out.push({ key: `clip:${region.id}`, signature: JSON.stringify([start, end, event.buf, event.rate, event.loop, gain, event.grains, region.startOffset]), event });
    }
    return out;
  }

  private postClips(span: Span, from: number) {
    const events: ClipEvent[] = [];
    for (const c of this.clipEvents(this.getState(), span, from)) {
      const key = `${span.id}:${c.key}`;
      span.clips.set(key, { pos: c.event.pos, signature: c.signature, key });
      events.push({ key, span: span.id, ...c.event });
    }
    this.counts.clips += events.length;
    this.engine.clips(events);
  }

  // ----------------------------------------------------------------- edits

  // The store changed: post what is new in the window already posted, take
  // back what is gone, and restart clips whose settings changed
  resync(span: Span, nowCtx: number) {
    if (!span.engine) return;
    const st = this.getState();
    const nowPos = Math.max(span.posStart, span.posStart + (nowCtx - span.ctxStart));
    const retract: string[] = [];
    // notes: everything in [now, cursor) should be posted, nothing else
    const want = new Map<string, Note>();
    for (const n of this.notesIn(st, nowPos, span.cursor)) want.set(`${span.id}:${n.key}`, n);
    for (const [key, posted] of span.notes) {
      if (posted.pos < nowPos || want.has(key)) continue;
      if (posted.posted) retract.push(key); else posted.cancel(nowCtx);
      span.notes.delete(key);
    }
    const batch: NoteEvent[] = [];
    for (const [key, n] of want) if (!span.notes.has(key)) this.postNote(span, n, batch);
    this.engine.notes(batch);
    // clips: by what they play; a changed one restarts from here
    const clips = this.clipEvents(st, span, nowPos);
    const wantClips = new Map(clips.map((c) => [`${span.id}:${c.key}`, c]));
    for (const [key, posted] of span.clips) {
      const c = wantClips.get(key);
      if (c && c.signature === posted.signature) { wantClips.delete(key); continue; }
      retract.push(posted.key);
      span.clips.delete(key);
    }
    const events: ClipEvent[] = [];
    for (const [key, c] of wantClips) {
      // a restart is a new player while the old one fades: keyed apart
      const engineKey = `${key}#${++this.generation}`;
      span.clips.set(key, { pos: c.event.pos, signature: c.signature, key: engineKey });
      events.push({ key: engineKey, span: span.id, ...c.event });
    }
    this.counts.retracted += retract.length;
    this.counts.clips += events.length;
    this.engine.retract(retract, nowCtx);
    this.engine.clips(events);
  }

  // A session clip takes a track over at `atCtx`: its arrangement sources stop
  silenceTrack(trackId: string, atCtx: number) {
    this.owned.add(trackId);
    this.engine.silence(this.engine.output(trackId), atCtx);
    const st = this.getState();
    const regions = new Set((st.regions || []).filter((r: any) => r.trackId === trackId).map((r: any) => r.id));
    for (const span of this.spans) {
      for (const [key, n] of span.notes) {
        const regionId = key.split(':')[1];
        if (!regions.has(regionId)) continue;
        if (!n.posted) n.cancel(atCtx);
        span.notes.delete(key);
      }
      for (const key of [...span.clips.keys()]) {
        const id = key.split(':')[2];
        if (regions.has(id) || key.includes(`frozen:${trackId}`)) span.clips.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------- offline

const WINDOW = 1; // seconds of song per window, rounded to whole blocks
const PAIRS = 16;  // stereo pairs a context can hold

export interface RenderOptions {
  state: any;
  trackIds: string[];
  from: number;            // timeline seconds
  to: number;
  sampleRate: number;
  perTrack?: boolean;      // one stereo pair per track, in trackIds order, instead of their sum
  report?: (r: { engine: EngineStats; counts: Scheduler['counts'] }) => void; // for the tests
}

// The arrangement, or some of its tracks, rendered through the engine on an
// OfflineAudioContext: the same scheduler, a window at a time, each
// window's events posted and acknowledged while the context is suspended.
// Sources only, as freezing renders them: a track's devices are not applied.
export async function renderArrangement(o: RenderOptions): Promise<AudioBuffer> {
  if (o.perTrack && o.trackIds.length > PAIRS) throw new Error(`at most ${PAIRS} tracks render to their own pairs at once: see renderStems`);
  const channels = o.perTrack ? 2 * o.trackIds.length : 2;
  const length = Math.max(1, Math.ceil((o.to - o.from) * o.sampleRate));
  const ctx = new OfflineAudioContext(channels, length, o.sampleRate);
  await loadEngine(ctx);
  const merger = o.perTrack ? ctx.createChannelMerger(channels) : null;
  if (merger) merger.connect(ctx.destination);
  const engine = new Engine(ctx, {
    connect: (node, output, stripId) => {
      if (!merger) { node.connect(ctx.destination, output); return; }
      const k = o.trackIds.indexOf(stripId);
      if (k < 0) return;
      const split = ctx.createChannelSplitter(2);
      node.connect(split, output);
      split.connect(merger, 0, 2 * k);
      split.connect(merger, 1, 2 * k + 1);
    }
  }, Math.max(1, o.trackIds.length));
  const scheduler = new Scheduler(engine, ctx, () => o.state, new Set(o.trackIds));
  const span = scheduler.open(0, o.from, o.to);

  // Each window: post its notes, wait for their renders and for the worklet
  // to have every message, then let the context run on. Windows end on a
  // block boundary: the context suspends there exactly (a time between two
  // is rounded up to the next), so a note due at the boundary isn't late.
  const blockSeconds = BLOCK / o.sampleRate;
  const windowSeconds = Math.round((WINDOW * o.sampleRate) / BLOCK) * blockSeconds;
  const window = async (end: number) => {
    scheduler.advance(span, end);
    await whenRendered(ctx);
    await engine.sync();
  };
  let next = o.from + windowSeconds;
  await window(next);
  const pause = (): Promise<void> | null => {
    if (next >= o.to) return null;
    const at = next - o.from;
    // just short of the boundary, so rounding up lands on it, not past it
    const p = ctx.suspend(at - blockSeconds / 2).then(async () => {
      next += windowSeconds;
      await window(next);
      const again = pause();
      await ctx.resume();
      return again ?? undefined;
    });
    return p;
  };
  const chain = pause();
  const rendered = await ctx.startRendering();
  await chain;
  if (o.report) o.report({ engine: await engine.stats(), counts: scheduler.counts });
  engine.dispose();
  return rendered;
}

// Each track rendered on its own, in turns of what a context can hold
export async function renderStems(o: Omit<RenderOptions, 'perTrack'>): Promise<AudioBuffer[]> {
  const stems: AudioBuffer[] = [];
  const reports: Parameters<NonNullable<RenderOptions['report']>>[0][] = [];
  for (let i = 0; i < o.trackIds.length; i += PAIRS) {
    const ids = o.trackIds.slice(i, i + PAIRS);
    const all = await renderArrangement({ ...o, trackIds: ids, perTrack: true, report: (r) => reports.push(r) });
    for (let t = 0; t < ids.length; t++) {
      const stem = new AudioBuffer({ numberOfChannels: 2, length: all.length, sampleRate: all.sampleRate });
      stem.copyToChannel(all.getChannelData(2 * t), 0);
      stem.copyToChannel(all.getChannelData(2 * t + 1), 1);
      stems.push(stem);
    }
  }
  if (o.report) {
    // the turns' numbers, summed
    const sum = <T extends object>(xs: T[]): T => xs.reduce((a: any, x: any) => { for (const k in x) a[k] = (a[k] ?? 0) + x[k]; return a; }, {} as any);
    o.report({ engine: sum(reports.map((r) => r.engine)), counts: sum(reports.map((r) => r.counts)) });
  }
  return stems;
}
