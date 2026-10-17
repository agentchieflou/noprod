// The main thread's side of the engine worklet (worklets/engine-processor.ts):
// one node per context, a stereo output per strip (tracks, returns, the
// master), the buffers it holds, and the messages that play and take back
// sources. The live engine is the one on the app's context; freezing and
// the engine's tests make another on an OfflineAudioContext.
//
// Buffers: a rendered note or a clip's audio is copied into the worklet the
// first time something plays it and kept there, least recently used out
// first within a budget (memory.ts), so a project's audio lives twice, on
// the main thread for drawing and saving and here for playing. The budget
// is for what isn't playing: the worklet keeps a buffer while an event
// queued or sounding plays it, however much that comes to, and forgets it
// when the last of them ends. Step 5 of #159 moves ownership here.

import type { LiveTarget } from '@noprod/sound';
import engineUrl from './worklets/engine-processor.ts?worker&url';
import { LruBytes, budgets, bufferBytes } from './memory';
import type { ClipEvent, DropReason, EngineMessage, EngineReply, EngineStats, NoteEvent, SpanSpec, VoiceSpec } from './dsp/events';

const loaded = new WeakSet<BaseAudioContext>();

// Registers the worklet on a context, once
export async function loadEngine(ctx: BaseAudioContext) {
  if (loaded.has(ctx)) return;
  await ctx.audioWorklet.addModule(engineUrl);
  loaded.add(ctx);
}

export const engineLoaded = (ctx: BaseAudioContext) => loaded.has(ctx);

const FIRST_OUTPUTS = 16;

export interface EngineOptions {
  // Where an output goes once a strip claims it (the live engine: the strip's input node)
  connect: (node: AudioWorkletNode, output: number, stripId: string) => void;
  // Called when the node had to be remade (more outputs): what was queued is gone
  onReset?: () => void;
  onDropped?: (key: string, lateBy: number, reason: DropReason) => void;
  // The processor threw: it is remade (onReset follows) and this is told
  onError?: (e: Event) => void;
  budget?: number; // bytes of buffers kept beyond those playing (the tests set a small one)
}

const bufferIds = new WeakMap<AudioBuffer, number>();
let nextBufferId = 1;

export class Engine {
  node: AudioWorkletNode;
  private outputs: number;
  private stripOutputs = new Map<string, number>();
  private resident: LruBytes<number, AudioBuffer>;
  private waiting: ((r: EngineReply) => boolean)[] = [];
  // Evicted ids, forgotten after the events being built with them are posted
  private forgets: number[] = [];

  readonly ctx: BaseAudioContext;
  private opts: EngineOptions;

  constructor(ctx: BaseAudioContext, opts: EngineOptions, outputs = FIRST_OUTPUTS) {
    this.ctx = ctx;
    this.opts = opts;
    const b = budgets();
    this.resident = new LruBytes<number, AudioBuffer>(opts.budget ?? b.renders + b.stretch, bufferBytes, (id) => this.evicted(id));
    this.outputs = outputs;
    this.node = this.make(outputs);
  }

  private make(outputs: number): AudioWorkletNode {
    const margin = 1000 * Math.max(this.ctx instanceof AudioContext ? this.ctx.outputLatency || this.ctx.baseLatency : 0, 0.01);
    const node = new AudioWorkletNode(this.ctx, 'noprod-engine', {
      numberOfInputs: 0, numberOfOutputs: outputs, outputChannelCount: Array(outputs).fill(2),
      processorOptions: { margin, outputs }
    });
    node.port.onmessage = (e: MessageEvent<EngineReply>) => {
      const r = e.data;
      if (r.type === 'dropped') { this.opts.onDropped?.(r.key, r.lateBy, r.reason); return; }
      this.waiting = this.waiting.filter((fn) => !fn(r));
    };
    // A throw on the audio thread stops the processor for good: start a
    // fresh one, as growing does, and let the transport start over
    node.onprocessorerror = (e) => { if (this.node === node) { this.opts.onError?.(e); this.remake(this.outputs); } };
    return node;
  }

  // The output a strip plays on, claimed on first use; more outputs when
  // the pool runs out (the node is remade, so the transport starts over)
  output(stripId: string): number {
    const have = this.stripOutputs.get(stripId);
    if (have !== undefined) return have;
    const index = this.stripOutputs.size;
    if (index >= this.outputs) this.grow(this.outputs * 2);
    this.stripOutputs.set(stripId, index);
    this.opts.connect(this.node, index, stripId);
    return index;
  }

  private grow(outputs: number) { this.remake(outputs); }

  private remake(outputs: number) {
    this.node.port.onmessage = null;
    this.node.onprocessorerror = null;
    this.node.disconnect();
    this.waiting = [];
    this.outputs = outputs;
    this.node = this.make(outputs);
    this.forgets = [];
    this.resident = new LruBytes<number, AudioBuffer>(this.resident.budget, bufferBytes, (id) => this.evicted(id));
    for (const [id, index] of this.stripOutputs) this.opts.connect(this.node, index, id);
    this.opts.onReset?.();
  }

  // A strip's input node was remade (engine.ts): its output follows
  reconnect(stripId: string) {
    const index = this.stripOutputs.get(stripId);
    if (index === undefined) return;
    try { this.node.disconnect(index); } catch { /* not connected */ }
    this.opts.connect(this.node, index, stripId);
  }

  disconnect(stripId: string) {
    const index = this.stripOutputs.get(stripId);
    if (index !== undefined) { try { this.node.disconnect(index); } catch { /* not connected */ } }
  }

  // The worklet's id for a buffer, sending it over if it isn't there
  bufferId(buffer: AudioBuffer): number {
    let id = bufferIds.get(buffer);
    if (id === undefined) { id = nextBufferId++; bufferIds.set(buffer, id); }
    if (this.resident.get(id)) return id;
    const l = buffer.getChannelData(0).slice();
    const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : l.slice();
    this.node.port.postMessage({ type: 'buffer', id, l, r } satisfies EngineMessage, [l.buffer, r.buffer]);
    this.resident.set(id, buffer);
    return id;
  }

  // A buffer left the budget while a window was being built: the forget
  // goes after that window's events, which pin what they play
  private evicted(id: number) {
    if (!this.forgets.length) queueMicrotask(() => this.flushForgets());
    this.forgets.push(id);
  }

  private flushForgets() {
    if (!this.forgets.length) return;
    const ids = this.forgets;
    this.forgets = [];
    this.post({ type: 'forget', ids });
  }

  // For the tests: the processor throws on its next block
  crash() { this.post({ type: 'throw' }); }

  // For the tests: forget now; `force` even what is playing
  forget(ids: number[], force = false) {
    for (const id of ids) this.resident.delete(id);
    this.post({ type: 'forget', ids, force });
  }

  post(m: EngineMessage) { this.node.port.postMessage(m); }

  span(span: SpanSpec) { this.post({ type: 'span', span }); }
  closeSpan(id: number, at: number, cut = false) { this.post({ type: 'closeSpan', id, at, cut }); }
  notes(notes: NoteEvent[]) { if (notes.length) this.post({ type: 'notes', notes }); }
  clips(clips: ClipEvent[]) { if (clips.length) this.post({ type: 'clips', clips }); }
  retract(keys: string[], at?: number) { if (keys.length) this.post({ type: 'retract', keys, at }); }
  liveOn(key: string, strip: number, at: number, voice: VoiceSpec) { this.post({ type: 'liveOn', key, strip, at, voice }); }
  liveOff(key: string, at: number) { this.post({ type: 'liveOff', key, at }); }
  control(strip: number, control: { to: LiveTarget; value: number; smoothing: number }, at: number) { this.post({ type: 'control', strip, ...control, at }); }
  silence(strip: number, at: number) { this.post({ type: 'silence', strip, at }); }
  stopAll(at: number) { this.post({ type: 'stop', at }); }

  private ask<T extends EngineReply>(m: EngineMessage, type: T['type']): Promise<T> {
    this.flushForgets(); // so a sync covers them
    return new Promise((resolve) => {
      this.waiting.push((r) => { if (r.type !== type) return false; resolve(r as T); return true; });
      this.post(m);
    });
  }

  // Resolves once every message posted before it has reached the worklet
  sync() { return this.ask({ type: 'sync' }, 'synced'); }
  stats(): Promise<EngineStats> { return this.ask<{ type: 'stats' } & EngineStats>({ type: 'stats' }, 'stats'); }

  dispose() {
    this.node.port.onmessage = null;
    this.node.disconnect();
  }
}

// ------------------------------------------------------------ the live engine

let live: Engine | null = null;
export const liveEngine = () => live;

export interface LiveEngineHooks {
  stripIdOf: (node: AudioNode) => string | null;
  getStripInput: (id: string) => AudioNode;
  onStripInputChange: (fn: (id: string, input: AudioNode | null) => void) => unknown;
  onReset?: () => void;
  onDropped?: (key: string, lateBy: number, reason: DropReason) => void;
  onError?: (e: Event) => void;
}

let hooks: LiveEngineHooks | null = null;

// Makes the engine on the app's context, its outputs following the strips
// (engine.ts). Until it resolves, notes play as nodes.
export async function initLiveEngine(ctx: AudioContext, h: LiveEngineHooks) {
  hooks = h;
  await loadEngine(ctx);
  live = new Engine(ctx, {
    connect: (node, output, stripId) => node.connect(h.getStripInput(stripId), output),
    onReset: h.onReset,
    onDropped: h.onDropped,
    onError: h.onError
  });
  h.onStripInputChange((id, input) => { if (input) live?.reconnect(id); else live?.disconnect(id); });
  return live;
}

// The live engine's output for a note's destination, when that is a strip's input
export function liveStrip(ctx: BaseAudioContext, destination: AudioNode): { engine: Engine; output: number } | null {
  if (!live || live.ctx !== ctx || !hooks) return null;
  const id = hooks.stripIdOf(destination);
  return id === null ? null : { engine: live, output: live.output(id) };
}
