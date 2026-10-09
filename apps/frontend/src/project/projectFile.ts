// .noprod project files: the project slice of the store as JSON, with every
// AudioBuffer (clips, session clips, frozen tracks, takes) moved into a
// de-duplicated table of base64 Float32 PCM, gzip-compressed as a whole.

import { PROJECT_KEYS } from '../store/useDAWStore';

const FORMAT = 'noprod-project';
const VERSION = 1;

interface EncodedBuffer {
  sampleRate: number;
  length: number;
  channels: string[]; // base64 of each channel's Float32Array bytes
}

const toBase64 = (bytes: Uint8Array) => {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

const fromBase64 = (b64: string) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const isAudioBuffer = (v: unknown): v is AudioBuffer =>
  typeof AudioBuffer !== 'undefined' && v instanceof AudioBuffer;

// Project state (plain data + AudioBuffers) -> gzip'd JSON blob
export async function serializeProject(state: any): Promise<Blob> {
  const buffers: Record<string, EncodedBuffer> = {};
  const ids = new Map<AudioBuffer, string>();

  const encode = (buf: AudioBuffer) => {
    let id = ids.get(buf);
    if (id) return id;
    id = `buf${ids.size}`;
    ids.set(buf, id);
    const channels: string[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c);
      channels.push(toBase64(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))));
    }
    buffers[id] = { sampleRate: buf.sampleRate, length: buf.length, channels };
    return id;
  };

  const project: Record<string, unknown> = {};
  PROJECT_KEYS.forEach((k) => { project[k] = state[k]; });
  // `buffers` comes after `project`, so it is already filled by the time
  // JSON.stringify reaches it
  const json = JSON.stringify(
    { format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), project, buffers },
    (_key, value) => (isAudioBuffer(value) ? { $audioBuffer: encode(value) } : value)
  );
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

// gzip'd JSON blob -> project state with AudioBuffers rebuilt in `ctx`
export async function deserializeProject(blob: Blob, ctx: BaseAudioContext): Promise<any> {
  const text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const doc = JSON.parse(text);
  if (doc.format !== FORMAT) throw new Error('Not a NoProd project file');
  if (doc.version > VERSION) throw new Error(`Project was saved by a newer NoProd (format v${doc.version})`);

  const decoded = new Map<string, AudioBuffer>();
  const decode = (id: string) => {
    let buf = decoded.get(id);
    if (buf) return buf;
    const enc: EncodedBuffer = doc.buffers[id];
    buf = ctx.createBuffer(enc.channels.length, enc.length, enc.sampleRate);
    enc.channels.forEach((b64, c) => {
      const bytes = fromBase64(b64);
      buf!.copyToChannel(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), c);
    });
    decoded.set(id, buf);
    return buf;
  };

  const revive = (value: any): any => {
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === 'object') {
      if (typeof value.$audioBuffer === 'string') return decode(value.$audioBuffer);
      const out: any = {};
      Object.keys(value).forEach((k) => { out[k] = revive(value[k]); });
      return out;
    }
    return value;
  };
  return revive(doc.project);
}
