// .noprod project files (format.ts, README.md): the project slice of the
// store, with every AudioBuffer (clips, session clips, frozen tracks, takes)
// moved into a de-duplicated table of raw PCM. The worker does the writing
// and reading; this side turns state into project.json and back.

import { v4 as uuidv4 } from 'uuid';
import { PROJECT_KEYS, createDefaultProject } from '../store/useDAWStore';
import { FORMAT, SCHEMA_VERSION, type BufferInfo, type ProjectDoc } from './schema';
import type { Pcm } from './format';

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

// Calls an op in the project worker (projectWorker.ts); its errors keep
// their name (QuotaExceededError, ProjectFileError, …)
export function callWorker<T>(op: string, args: unknown = {}, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./projectWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(Object.assign(new Error(e.data.error.message), { name: e.data.error.name }));
    };
    worker.onerror = (e) => {
      pending.forEach((p) => p.reject(new Error(`The project worker failed: ${e.message}`)));
      pending.clear();
    };
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, op, args }, transfer);
  });
}

// Each AudioBuffer keeps one id for the session, so autosave writes it once
const bufferIds = new WeakMap<AudioBuffer, string>();
const idOf = (buf: AudioBuffer) => {
  let id = bufferIds.get(buf);
  if (!id) { id = uuidv4(); bufferIds.set(buf, id); }
  return id;
};

const isAudioBuffer = (v: unknown): v is AudioBuffer =>
  typeof AudioBuffer !== 'undefined' && v instanceof AudioBuffer;

// The store's project slice -> project.json, and the buffers it refers to
export function snapshotProject(state: any): { json: string; buffers: Map<string, AudioBuffer> } {
  const buffers = new Map<string, AudioBuffer>();
  const project: Record<string, unknown> = {};
  PROJECT_KEYS.forEach((k) => { project[k] = state[k]; });
  const projectJson = JSON.stringify(project, (_key, value) => {
    if (!isAudioBuffer(value)) return value;
    const id = idOf(value);
    buffers.set(id, value);
    return { $audioBuffer: id };
  });
  const table: BufferInfo[] = [...buffers].map(([id, b]) => ({ id, sampleRate: b.sampleRate, length: b.length, channels: b.numberOfChannels }));
  const head = JSON.stringify({ format: FORMAT, version: SCHEMA_VERSION, savedAt: new Date().toISOString(), buffers: table });
  return { json: `${head.slice(0, -1)},"project":${projectJson}}`, buffers };
}

// A copy of a buffer's samples, to transfer to the worker
export const toPcm = (buf: AudioBuffer): Pcm => ({
  sampleRate: buf.sampleRate,
  channels: Array.from({ length: buf.numberOfChannels }, (_, c) => {
    const data = new Float32Array(buf.length);
    buf.copyFromChannel(data, c);
    return data;
  })
});

export const pcmTransfer = (pcm: Pcm[]) => pcm.flatMap((p) => p.channels.map((c) => c.buffer as ArrayBuffer));

// Project state (plain data + AudioBuffers) -> a .noprod file
export async function serializeProject(state: any): Promise<Blob> {
  const { json, buffers } = snapshotProject(state);
  const pcm = [...buffers.values()].map(toPcm);
  return callWorker<Blob>('write', { json, pcm }, pcmTransfer(pcm));
}

// A checked doc and its samples -> project state with AudioBuffers in `ctx`
export function reviveProject(doc: ProjectDoc, pcm: Pcm[], ctx: BaseAudioContext): any {
  const decoded = new Map<string, AudioBuffer>();
  doc.buffers.forEach((info, i) => {
    const buf = ctx.createBuffer(info.channels, info.length, info.sampleRate);
    pcm[i].channels.forEach((data, c) => buf.copyToChannel(data as Float32Array<ArrayBuffer>, c));
    decoded.set(info.id, buf);
  });
  const revive = (value: any): any => {
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === 'object') {
      if (typeof value.$audioBuffer === 'string') return decoded.get(value.$audioBuffer);
      const out: any = {};
      Object.keys(value).forEach((k) => { out[k] = revive(value[k]); });
      return out;
    }
    return value;
  };
  return revive(doc.project);
}

// A .noprod file of any version -> project state, or a clear error
export async function deserializeProject(blob: Blob, ctx: BaseAudioContext): Promise<any> {
  const { doc, pcm } = await callWorker<{ doc: ProjectDoc; pcm: Pcm[] }>('read', { blob, defaults: createDefaultProject() });
  return reviveProject(doc, pcm, ctx);
}
