// The .noprod file format (see README.md): a chunked binary container that
// holds project.json (gzip) and each AudioBuffer as raw Float32 PCM chunks,
// so no audio ever goes through a string. Also reads v1 files (one gzipped
// JSON string with base64 audio). Pure: no DOM or Web Audio, so it runs in
// the project worker and in Node's tests.

import { migrate, validateDoc, knownKeys, ProjectFileError, BUFFER_LIMITS, type ProjectDoc, type BufferInfo } from './schema.ts';

export { ProjectFileError };

// "\x89NPRJ\r\n\x1a": a non-ASCII first byte, and line endings that a
// text-mode transfer would mangle (the same trick as PNG's signature)
export const MAGIC = [0x89, 0x4e, 0x50, 0x52, 0x4a, 0x0d, 0x0a, 0x1a];
export const CONTAINER_VERSION = 1;
const HEADER = 16;       // magic, u32 container version, u32 reserved
const CHUNK_HEADER = 16; // tag, u32 flags, u64 payload length
const PCM_HEADER = 16;   // u32 buffer index, u32 channel, u64 first frame
export const PCM_CHUNK_FRAMES = 1 << 20; // 4 MB of samples per chunk

// What a file may declare before we believe it (buffers: BUFFER_LIMITS)
export const LIMITS = {
  jsonBytes: 256 << 20, // project.json, decompressed
  v1Bytes: 512 << 20,   // a whole v1 file, decompressed
  chunkFrames: 1 << 22
};
const fail = (msg: string): never => { throw new ProjectFileError(msg); };

// One AudioBuffer's samples, as the worker and the tests hold them
export interface Pcm {
  sampleRate: number;
  channels: Float32Array[];
}

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const tagBytes = (tag: string) => Uint8Array.from(tag, (c) => c.charCodeAt(0));

const chunkHeader = (tag: string, length: number) => {
  const b = new Uint8Array(CHUNK_HEADER);
  const v = new DataView(b.buffer);
  b.set(tagBytes(tag), 0);
  v.setUint32(4, 0, true);
  v.setUint32(8, length % 2 ** 32, true);
  v.setUint32(12, Math.floor(length / 2 ** 32), true);
  return b;
};

const gzip = async (text: string) =>
  new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());

// Decompresses, refusing to inflate past `limit` bytes (a gzip bomb)
async function gunzipText(data: Blob, limit: number) {
  const reader = data.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { reader.cancel().catch(() => {}); fail('The project data is larger than NoProd accepts'); }
      parts.push(value);
    }
  } catch (err) {
    if (err instanceof ProjectFileError) throw err;
    fail('The project data is damaged (it does not decompress)');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(await new Blob(parts as BlobPart[]).arrayBuffer()); }
  catch { return fail('The project data is not valid UTF-8 text'); }
}

const parseJson = (text: string) => {
  try { return JSON.parse(text); } catch { return fail('The project data is not valid JSON'); }
};

// project.json (with `buffers` describing each entry of `pcm`, in order)
// -> a .noprod v2 file
export async function writeProjectFile(json: string, pcm: Pcm[]): Promise<Blob> {
  if (!littleEndian) fail('Saving needs a little-endian machine');
  const head = new Uint8Array(HEADER);
  head.set(MAGIC, 0);
  new DataView(head.buffer).setUint32(8, CONTAINER_VERSION, true);
  const doc = await gzip(json);
  const parts: BlobPart[] = [head, chunkHeader('JSON', doc.length), doc];
  pcm.forEach((buf, index) => {
    buf.channels.forEach((data, channel) => {
      for (let at = 0; at < data.length; at += PCM_CHUNK_FRAMES) {
        const frames = Math.min(PCM_CHUNK_FRAMES, data.length - at);
        const h = new Uint8Array(PCM_HEADER);
        const v = new DataView(h.buffer);
        v.setUint32(0, index, true);
        v.setUint32(4, channel, true);
        v.setUint32(8, at % 2 ** 32, true);
        v.setUint32(12, Math.floor(at / 2 ** 32), true);
        parts.push(chunkHeader('PCM ', PCM_HEADER + frames * 4), h,
          new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset + at * 4, frames * 4));
      }
    });
  });
  parts.push(chunkHeader('END ', 0));
  return new Blob(parts, { type: 'application/x-noprod' });
}

const bytesAt = async (blob: Blob, at: number, length: number) => {
  if (at + length > blob.size) fail('The file is truncated');
  return new Uint8Array(await blob.slice(at, at + length).arrayBuffer());
};

const u64 = (v: DataView, at: number) => {
  const hi = v.getUint32(at + 4, true);
  if (hi >= 2 ** 21) fail('The file declares an impossible size');
  return hi * 2 ** 32 + v.getUint32(at, true);
};

// Any version's file -> the current ProjectDoc, migrated and checked, with
// each buffer's samples. Throws ProjectFileError for anything else.
export async function readProjectFile(blob: Blob, defaults: Record<string, unknown>): Promise<{ doc: ProjectDoc; pcm: Pcm[] }> {
  if (blob.size < 2) fail('Not a NoProd project file');
  const sig = await bytesAt(blob, 0, Math.min(blob.size, HEADER));
  if (sig[0] === 0x1f && sig[1] === 0x8b) return readV1(blob, defaults);
  if (sig.length < HEADER || MAGIC.some((b, i) => sig[i] !== b)) fail('Not a NoProd project file');
  const version = new DataView(sig.buffer).getUint32(8, true);
  if (version > CONTAINER_VERSION) fail(`This project was saved by a newer NoProd (container v${version}); update NoProd to open it`);

  let at = HEADER;
  let doc: ProjectDoc | null = null;
  let pcm: Pcm[] = [];
  let infos: BufferInfo[] = [];
  let filled: number[][] = [];
  let ended = false;
  while (at < blob.size) {
    const h = await bytesAt(blob, at, CHUNK_HEADER);
    const v = new DataView(h.buffer);
    const tag = String.fromCharCode(...h.subarray(0, 4));
    const length = u64(v, 8);
    const start = at + CHUNK_HEADER;
    if (start + length > blob.size) fail('The file is truncated');
    at = start + length;
    if (tag === 'END ') { ended = true; break; }
    if (tag === 'JSON') {
      if (doc) fail('The file holds two projects');
      if (length > LIMITS.jsonBytes) fail('The project data is larger than NoProd accepts');
      const raw = parseJson(await gunzipText(blob.slice(start, start + length), LIMITS.jsonBytes));
      doc = checkDoc(raw, defaults);
      infos = doc.buffers;
      // Every sample must be in the file, so declared sizes are bounded by it
      const declared = infos.reduce((n, b) => n + b.length * b.channels * 4, 0);
      if (declared > blob.size) fail('The file declares more audio than it holds');
      pcm = infos.map((b) => ({ sampleRate: b.sampleRate, channels: Array.from({ length: b.channels }, () => new Float32Array(b.length)) }));
      filled = infos.map((b) => new Array(b.channels).fill(0));
    } else if (tag === 'PCM ') {
      if (!doc) fail('The file has audio before its project data');
      if (length < PCM_HEADER || (length - PCM_HEADER) % 4) fail('The file has a damaged audio chunk');
      const frames = (length - PCM_HEADER) / 4;
      if (frames > LIMITS.chunkFrames) fail('The file has an audio chunk larger than NoProd accepts');
      const bytes = await bytesAt(blob, start, length);
      const pv = new DataView(bytes.buffer);
      const index = pv.getUint32(0, true);
      const channel = pv.getUint32(4, true);
      const first = u64(pv, 8);
      const info = infos[index];
      if (!info || channel >= info.channels) fail('The file has audio for a buffer it does not declare');
      // Chunks of a channel come in order, each starting where the last ended
      if (first !== filled[index][channel] || first + frames > info.length) fail('The file has misplaced audio');
      pcm[index].channels[channel].set(new Float32Array(bytes.buffer, PCM_HEADER, frames), first);
      filled[index][channel] = first + frames;
    } else if (tag.charCodeAt(0) >= 0x61 && tag.charCodeAt(0) <= 0x7a) {
      // An optional chunk from a later version (lowercase first letter): skip it
    } else {
      fail(`This project needs a newer NoProd (it has a "${tag.trim()}" chunk)`);
    }
  }
  if (!ended) fail('The file is truncated');
  if (!doc) fail('The file holds no project');
  infos.forEach((b, i) => { if (filled[i].some((n) => n !== b.length)) fail('The file is missing some of its audio'); });
  return { doc: doc!, pcm };
}

// A decoded project.json (any version) -> the current, checked ProjectDoc
export function checkDoc(raw: unknown, defaults: Record<string, unknown>): ProjectDoc {
  const doc = migrate(raw, defaults);
  const problem = validateDoc(doc);
  if (problem) fail(`This project file is damaged: ${problem}`);
  return { ...doc, project: knownKeys(doc.project) };
}

// v1: gzip(JSON) with each buffer's channels as base64 Float32 bytes in
// doc.buffers = { [id]: { sampleRate, length, channels: string[] } }
async function readV1(blob: Blob, defaults: Record<string, unknown>) {
  const raw = parseJson(await gunzipText(blob, LIMITS.v1Bytes));
  if (!raw || typeof raw !== 'object' || raw.format !== 'noprod-project') fail('Not a NoProd project file');
  if (typeof raw.version !== 'number' || raw.version !== 1) fail(`A gzip project must be v1, not v${raw.version}`);
  const table = raw.buffers ?? {};
  if (typeof table !== 'object' || Array.isArray(table)) fail('This project file is damaged: buffers: expected an object');
  const ids = Object.keys(table);
  if (ids.length > BUFFER_LIMITS.count) fail('The file has more audio buffers than NoProd accepts');
  const pcm: Pcm[] = [];
  const buffers: BufferInfo[] = ids.map((id) => {
    const b = table[id];
    const where = `buffers.${id}`;
    if (!b || typeof b !== 'object' || !Array.isArray(b.channels) || !b.channels.length || b.channels.length > BUFFER_LIMITS.channels
      || b.channels.some((c: unknown) => typeof c !== 'string')) fail(`This project file is damaged: ${where}: bad channels`);
    const channels = b.channels.map((s: string) => {
      let bin: string;
      try { bin = atob(s); } catch { return fail(`This project file is damaged: ${where}: bad base64`); }
      if (bin.length % 4) fail(`This project file is damaged: ${where}: bad sample data`);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Float32Array(bytes.buffer);
    });
    if (channels.some((c: Float32Array) => c.length !== b.length)) fail(`This project file is damaged: ${where}: length does not match its samples`);
    pcm.push({ sampleRate: b.sampleRate, channels });
    return { id, sampleRate: b.sampleRate, length: b.length, channels: channels.length };
  });
  const doc = checkDoc({ ...raw, buffers }, defaults);
  return { doc, pcm };
}
