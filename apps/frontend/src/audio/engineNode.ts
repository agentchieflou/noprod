// The main thread's side of the engine worklet (worklets/engine-processor.ts):
// one node per context, a stereo output per strip (tracks, returns, the
// master), the buffers it holds, and the messages that play and take back
// sources. The live engine is the one on the app's context; freezing and
// the engine's tests make another on an OfflineAudioContext.
//
// Buffers: a rendered note or a clip's audio is copied into the worklet the
// first time something plays it and kept there, least recently used out
// first within a budget (memory.ts), so a project's audio lives twice, on
// the main thread for drawing and saving and here for playing. Step 5 of
// #159 moves ownership here.

import type { LiveTarget } from '@noprod/sound';
import engineUrl from './worklets/engine-processor.ts?worker&url';
import { LruBytes, budgets, bufferBytes } from './memory';
import type { ClipEvent, EngineMessage, EngineReply, EngineStats, NoteEvent, SpanSpec, VoiceSpec } from './dsp/events';

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
  onDropped?: (key: string, lateBy: number) => void;
}

const bufferIds = new WeakMap<AudioBuffer, number>();
let nextBufferId = 1;

export class Engine {
  node: AudioWorkletNode;
  private outputs: number;
  private stripOutputs = new Map<string, number>();
  private resident: LruBytes<number, AudioBuffer>;
  private waiting: ((r: EngineReply) => boolean)[] = [];

  readonly ctx: BaseAudioContext;
  private opts: EngineOptions;

  constructor(ctx: BaseAudioContext, opts: EngineOptions, outputs = FIRST_OUTPUTS) {
    this.ctx = ctx;
    this.opts = opts;
    const b = budgets();
    this.resident = new LruBytes<number, AudioBuffer>(b.renders + b.stretch, bufferBytes, (id) => this.post({ type: 'forget', ids: [id] }));
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
      if (r.type === 'dropped') { this.opts.onDropped?.(r.key, r.lateBy); return; }
      this.waiting = this.waiting.filter((fn) => !fn(r));
    };
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

  private grow(outputs: number) {
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.outputs = outputs;
    this.node = this.make(outputs);
    this.resident = new LruBytes<number, AudioBuffer>(this.resident.budget, bufferBytes, (id) => this.post({ type: 'forget', ids: [id] }));
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

  post(m: EngineMessage) { this.node.port.postMessage(m); }

  span(span: SpanSpec) { this.post({ type: 'span', span }); }
  closeSpan(id: number, at: number) { this.post({ type: 'closeSpan', id, at }); }
  notes(notes: NoteEvent[]) { if (notes.length) this.post({ type: 'notes', notes }); }
  clips(clips: ClipEvent[]) { if (clips.length) this.post({ type: 'clips', clips }); }
  retract(keys: string[], at?: number) { if (keys.length) this.post({ type: 'retract', keys, at }); }
  liveOn(key: string, strip: number, at: number, voice: VoiceSpec) { this.post({ type: 'liveOn', key, strip, at, voice }); }
  liveOff(key: string, at: number) { this.post({ type: 'liveOff', key, at }); }
  control(strip: number, control: { to: LiveTarget; value: number; smoothing: number }, at: number) { this.post({ type: 'control', strip, ...control, at }); }
  silence(strip: number, at: number) { this.post({ type: 'silence', strip, at }); }
  stopAll(at: number) { this.post({ type: 'stop', at }); }

  private ask<T extends EngineReply>(m: EngineMessage, type: T['type']): Promise<T> {
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
  onDropped?: (key: string, lateBy: number) => void;
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
    onDropped: h.onDropped
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
