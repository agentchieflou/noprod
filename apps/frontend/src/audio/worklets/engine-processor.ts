// The engine worklet (#159, step 2): every source on a track plays here,
// sample-accurately, from events the main thread posts ahead of time.
// Notes (rendered library notes, the Synth, the Drums), audio clips and
// live physical models each render into their strip's output, one stereo
// output per strip, which feeds that strip's devices and mixer on the
// native graph.
//
// Time: an event names a span (a stretch of the timeline played from a
// context time) and a position in it, or an absolute context time; both
// become a frame here, so the main thread may post seconds ahead and take
// events back (an edit, a jump) before they sound. An event that arrives
// after its frame starts at once if it is within the budget, else it is
// dropped and reported, never played off the beat.

import { makeVoice, BufferVoice, type Voice, type Buf } from '../dsp/voices.ts';
import { ClipPlayer } from '../dsp/clipPlayer.ts';
import { LiveVoices, warmUpLiveModels } from '../dsp/liveVoices.ts';
import { BLOCK, LATE_SECONDS, type ClipEvent, type DropReason, type EngineMessage, type EngineReply, type NoteEvent, type SpanSpec, type VoiceSpec } from '../dsp/events.ts';

// The AudioWorkletGlobalScope's (not in the DOM types)
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(options?: unknown); }

interface Span { id: number; startFrame: number; posStart: number; endFrame: number }

interface Pending {
  key: string;
  strip: number;
  frame: number;
  span: number | null;
  buf: number | null;      // the buffer it plays, pinned while it is queued or sounding
  note?: NoteEvent;
  clip?: ClipEvent;
  live?: VoiceSpec;        // a held voice (liveOn)
  stopAt?: number;         // taken back before it starts: stop it this soon after
  releaseAt?: number;      // let go before it started
}

// A voice or clip playing: its own record, on its strip's list for as long as
// it plays, and in `sounding` by key while it is the latest with that key (a
// clip restarted under its key while its last player fades leaves two)
interface Sounding { key: string; strip: number; span: number | null; buf: number | null; voice?: Voice; clip?: ClipPlayer }

// The buffer an event plays, if any
const bufferOf = (spec: VoiceSpec | undefined, clip: ClipEvent | undefined) =>
  clip ? clip.buf : spec?.kind === 'buffer' ? spec.buf : null;

interface Strip {
  playing: Sounding[];
  live: LiveVoices | null;
  chokes: Map<number, BufferVoice[]>;
}

// FNV-1a over a key: the seed of whatever randomness a voice needs, so a
// render is the same every time. A span's events are keyed by the span
// first (scheduler.ts), which differs from one playback to the next, so
// the seed takes what follows it.
const seedOf = (key: string, inSpan: boolean) => {
  let h = 0x811c9dc5;
  for (let i = inSpan ? key.indexOf(':') + 1 : 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};

class EngineProcessor extends AudioWorkletProcessor {
  private bufs = new Map<number, Buf>();
  // Buffers stay while an event pending or sounding plays them: the main
  // thread's forget is a request, kept until the last such event ends
  private refs = new Map<number, number>();
  private forgotten = new Set<number>();
  private spans = new Map<number, Span>();
  private pending: Pending[] = [];          // sorted by frame
  private strips: Strip[] = [];
  private sounding = new Map<string, Sounding>();
  private readonly lateFrames = Math.round(LATE_SECONDS * sampleRate);
  private readonly margin: number;
  // the stats
  private started = 0; private late = 0; private dropped = 0; private retracted = 0;
  private blocks = 0; private blocksLate = 0; private dropouts = 0; private busy = 0; private worst = 0; private behind = 0;

  constructor(options: { processorOptions?: { margin?: number; outputs?: number } }) {
    super(options);
    this.margin = options.processorOptions?.margin ?? 10;
    const outputs = options.processorOptions?.outputs ?? 1;
    for (let i = 0; i < outputs; i++) this.strips.push({ playing: [], live: null, chokes: new Map() });
    this.port.onmessage = (e: MessageEvent<EngineMessage>) => this.receive(e.data);
  }

  private reply(m: EngineReply) { this.port.postMessage(m); }

  private strip(i: number): Strip {
    while (this.strips.length <= i) this.strips.push({ playing: [], live: null, chokes: new Map() });
    return this.strips[i];
  }

  private frameOf(span: number | undefined, pos: number | undefined, at: number | undefined): number | null {
    if (span !== undefined) {
      const s = this.spans.get(span);
      if (!s || pos === undefined) return null;
      return s.startFrame + Math.round((pos - s.posStart) * sampleRate);
    }
    return at === undefined ? null : Math.round(at * sampleRate);
  }

  private drop(key: string, reason: DropReason, lateBy = 0) {
    this.dropped++;
    this.reply({ type: 'dropped', key, lateBy, reason });
  }

  private pin(buf: number | null) {
    if (buf !== null) this.refs.set(buf, (this.refs.get(buf) ?? 0) + 1);
  }

  private unpin(buf: number | null) {
    if (buf === null) return;
    const n = (this.refs.get(buf) ?? 1) - 1;
    if (n > 0) { this.refs.set(buf, n); return; }
    this.refs.delete(buf);
    if (this.forgotten.delete(buf)) this.bufs.delete(buf);
  }

  private forget(ids: number[], force: boolean) {
    for (const id of ids) {
      if (!force && this.refs.has(id)) this.forgotten.add(id);
      else { this.bufs.delete(id); this.forgotten.delete(id); }
    }
  }

  // Queue an event at its frame, or now if it's a little late; drop it if very late
  private enqueue(p: Pending) {
    const now = currentFrame;
    if (p.frame < now) {
      if (now - p.frame > this.lateFrames) { this.drop(p.key, 'late', (now - p.frame) / sampleRate); return; }
      this.late++;
      p.frame = now;
    }
    this.pin(p.buf);
    let at = this.pending.length;
    while (at > 0 && this.pending[at - 1].frame > p.frame) at--;
    this.pending.splice(at, 0, p);
  }

  // A queued event that never starts
  private discard(p: Pending) {
    this.retracted++;
    this.unpin(p.buf);
  }

  private receive(m: EngineMessage) {
    switch (m.type) {
      case 'buffer': this.bufs.set(m.id, { l: m.l, r: m.r }); this.forgotten.delete(m.id); return;
      case 'forget': this.forget(m.ids, !!m.force); return;
      case 'span': this.addSpan(m.span); return;
      case 'closeSpan': this.closeSpan(m.id, Math.round(m.at * sampleRate)); return;
      case 'notes': for (const n of m.notes) this.addNote(n); return;
      case 'clips': for (const c of m.clips) this.addClip(c); return;
      case 'retract': this.retract(m.keys, m.at === undefined ? currentFrame : Math.round(m.at * sampleRate)); return;
      case 'liveOn': {
        const frame = Math.round(m.at * sampleRate);
        if (m.voice.kind === 'model') {
          const s = this.strip(m.strip);
          if (!s.live) s.live = new LiveVoices(sampleRate);
          s.live.on(m.key, m.voice, frame, currentFrame);
        } else {
          this.enqueue({ key: m.key, strip: m.strip, frame, span: null, buf: bufferOf(m.voice, undefined), live: m.voice });
        }
        return;
      }
      case 'liveOff': this.liveOff(m.key, Math.round(m.at * sampleRate)); return;
      case 'control': this.strip(m.strip).live?.control(m.to, m.value, m.smoothing, Math.round(m.at * sampleRate), currentFrame); return;
      case 'silence': this.silence(m.strip, Math.round(m.at * sampleRate)); return;
      case 'stop': this.stopAll(Math.round(m.at * sampleRate)); return;
      case 'sync': this.reply({ type: 'synced' }); return;
      case 'stats': this.reply({
        type: 'stats', started: this.started, late: this.late, dropped: this.dropped, retracted: this.retracted,
        pending: this.pending.length, sounding: this.sounding.size,
        voices: this.strips.reduce((n, s) => n + (s.live?.sounding ?? 0), 0),
        blocks: this.blocks, blocksLate: this.blocksLate, dropouts: this.dropouts, busy: this.busy, worst: this.worst,
        seconds: (this.blocks * BLOCK) / sampleRate
      });
    }
  }

  private addSpan(s: SpanSpec) {
    const startFrame = Math.round(s.ctxStart * sampleRate);
    const endFrame = Number.isFinite(s.posEnd) ? startFrame + Math.round((s.posEnd - s.posStart) * sampleRate) : Infinity;
    this.spans.set(s.id, { id: s.id, startFrame, posStart: s.posStart, endFrame });
  }

  // The span ends at `at`: what hasn't started by then never does; what is
  // sounding plays on (a loop seam lets notes ring; a stop fades them, below)
  private closeSpan(id: number, at: number) {
    const span = this.spans.get(id);
    if (!span) return;
    span.endFrame = Math.min(span.endFrame, at);
    this.pending = this.pending.filter((p) => {
      if (p.span !== id || p.frame < at) return true;
      this.discard(p);
      return false;
    });
    for (const s of this.playing()) if (s.span === id) s.clip?.stop(at);
  }

  private *playing() {
    for (const strip of this.strips) yield* strip.playing;
  }

  // A voice or clip has ended: what it played may go
  private ended(s: Sounding) {
    if (this.sounding.get(s.key) === s) this.sounding.delete(s.key);
    this.unpin(s.buf);
  }

  private addNote(n: NoteEvent) {
    const frame = this.frameOf(n.span, n.pos, n.at);
    if (frame === null) { this.drop(n.key, 'span'); return; } // its span is gone
    this.enqueue({ key: n.key, strip: n.strip, frame, span: n.span ?? null, buf: bufferOf(n.voice, undefined), note: n });
  }

  private addClip(c: ClipEvent) {
    const frame = this.frameOf(c.span, c.pos, undefined);
    if (frame === null) { this.drop(c.key, 'span'); return; }
    this.enqueue({ key: c.key, strip: c.strip, frame, span: c.span, buf: c.buf, clip: c });
  }

  // Take events back: pending ones never start; sounding ones fade from `at`
  private retract(keys: string[], at: number) {
    const set = new Set(keys);
    this.pending = this.pending.filter((p) => {
      if (!set.has(p.key)) return true;
      if (p.frame < at) { p.stopAt = at; return true; } // it starts before the cut: cut it then
      this.discard(p);
      return false;
    });
    for (const key of set) {
      const s = this.sounding.get(key);
      if (!s) continue;
      s.voice?.stop(at);
      s.clip?.stop(at);
    }
  }

  private liveOff(key: string, at: number) {
    const s = this.sounding.get(key);
    if (s?.voice) { s.voice.release(at); return; }
    for (const strip of this.strips) if (strip.live?.has(key)) { strip.live.off(key, at, currentFrame); return; }
    const p = this.pending.find((q) => q.key === key);
    if (p) p.releaseAt = at;
  }

  // A session clip takes this strip over: its spanned sources stop at `at`
  private silence(strip: number, at: number) {
    this.pending = this.pending.filter((p) => {
      if (!(p.strip === strip && p.span !== null && p.frame >= at)) return true;
      this.discard(p);
      return false;
    });
    for (const s of this.strips[strip]?.playing ?? []) {
      if (s.span === null) continue;
      s.voice?.stop(at);
      s.clip?.stop(at);
    }
  }

  private stopAll(at: number) {
    for (const p of this.pending) this.discard(p);
    this.pending = [];
    for (const s of this.playing()) { s.voice?.stop(at); s.clip?.stop(at); }
    for (const strip of this.strips) strip.live?.stop();
  }

  // Start a pending event whose frame falls in this block
  private begin(p: Pending) {
    const strip = this.strip(p.strip);
    const seed = seedOf(p.key, p.span !== null);
    if (p.clip) {
      const buf = this.bufs.get(p.clip.buf);
      const span = this.spans.get(p.clip.span);
      if (!buf || !span) { this.drop(p.key, buf ? 'span' : 'buffer'); this.unpin(p.buf); return; }
      const end = Math.min(span.endFrame, span.startFrame + Math.round((p.clip.endPos - span.posStart) * sampleRate));
      const player = new ClipPlayer(p.key, p.frame, p.clip, buf, end, sampleRate, seed);
      if (p.stopAt !== undefined) player.stop(p.stopAt);
      this.play(strip, { key: p.key, strip: p.strip, span: p.span, buf: p.buf, clip: player });
      return;
    }
    const spec = p.note ? p.note.voice : p.live!;
    const voice = makeVoice(p.key, p.frame, spec, p.note ? p.note.duration : null, this.bufs, sampleRate, seed);
    if (!voice) { this.drop(p.key, 'buffer'); this.unpin(p.buf); return; }
    if (voice instanceof BufferVoice && voice.chokeGroup >= 0) {
      // a closed hat cuts an open one off: the group's earlier hits fade
      const group = strip.chokes.get(voice.chokeGroup) ?? [];
      const kept = group.filter((v) => !v.done);
      for (const v of kept) if (v.start < voice.start) v.choke(voice.start);
      kept.push(voice);
      strip.chokes.set(voice.chokeGroup, kept);
    }
    if (p.stopAt !== undefined) voice.stop(p.stopAt);
    if (p.releaseAt !== undefined) voice.release(Math.max(p.releaseAt, p.frame));
    this.play(strip, { key: p.key, strip: p.strip, span: p.span, buf: p.buf, voice });
  }

  private play(strip: Strip, s: Sounding) {
    strip.playing.push(s);
    this.sounding.set(s.key, s);
    this.started++;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const began = Date.now();
    const frame = currentFrame;
    const end = frame + BLOCK;
    while (this.pending.length && this.pending[0].frame < end) this.begin(this.pending.shift()!);
    for (let i = 0; i < this.strips.length && i < outputs.length; i++) {
      const strip = this.strips[i];
      if (!strip.playing.length && !strip.live) continue;
      const out = outputs[i];
      const l = out[0], r = out[1] ?? out[0];
      l.fill(0); if (r !== l) r.fill(0);
      let kept = 0;
      for (let k = 0; k < strip.playing.length; k++) {
        const s = strip.playing[k];
        const src = (s.voice ?? s.clip)!;
        src.render(l, r, Math.max(0, src.start - frame), BLOCK, frame);
        if (src.done) this.ended(s); else strip.playing[kept++] = s;
      }
      strip.playing.length = kept;
      strip.live?.render(l, r, frame);
    }
    // the render thread's pace, as live-models.ts kept it
    const took = Date.now() - began;
    const lasts = (BLOCK / sampleRate) * 1000;
    this.blocks++;
    this.busy += took;
    if (took > this.worst) this.worst = took;
    if (took > lasts) this.blocksLate++;
    this.behind = Math.max(0, this.behind + took - lasts);
    if (this.behind > this.margin) { this.dropouts++; this.behind = 0; }
    return true;
  }
}

warmUpLiveModels(sampleRate);
registerProcessor('noprod-engine', EngineProcessor);
