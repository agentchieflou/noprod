// WAV files: 16- or 24-bit PCM, or 32-bit float.

export type WavBits = 16 | 24 | 32;

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
}

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

export function encodeWav(channels: Float32Array[], sampleRate: number, bits: WavBits = 16): Uint8Array {
  const count = channels.length;
  const frames = count ? channels[0].length : 0;
  const bytes = bits / 8;
  const float = bits === 32;
  const fmtSize = float ? 18 : 16;
  const dataSize = frames * count * bytes;
  const headerSize = 12 + 8 + fmtSize + (float ? 12 : 0) + 8;
  const out = new Uint8Array(headerSize + dataSize + (dataSize % 2));
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => { for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i); };

  tag(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, float ? FLOAT : PCM, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * bytes, true);
  view.setUint16(32, count * bytes, true);
  view.setUint16(34, bits, true);
  let at = 36;
  if (float) {
    view.setUint16(at, 0, true); // no extra format bytes
    at += 2;
    tag(at, 'fact');
    view.setUint32(at + 4, 4, true);
    view.setUint32(at + 8, frames, true);
    at += 12;
  }
  tag(at, 'data');
  view.setUint32(at + 4, dataSize, true);
  at += 8;

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const x = channels[c][i];
      if (float) {
        view.setFloat32(at, x, true);
      } else {
        const clamped = Math.max(-1, Math.min(1, x));
        // Negative samples reach one step further, so ±1 both fit
        if (bits === 16) {
          view.setInt16(at, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
        } else {
          const v = Math.round(clamped * (clamped < 0 ? 8388608 : 8388607));
          out[at] = v & 0xff;
          out[at + 1] = (v >> 8) & 0xff;
          out[at + 2] = (v >> 16) & 0xff;
        }
      }
      at += bytes;
    }
  }
  return out;
}

const scale = (v: number, full: number) => (v < 0 ? v / full : v / (full - 1));

export function decodeWav(data: Uint8Array): DecodedWav {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const text = (at: number) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new Error('not a WAV file');

  let format = 0, count = 0, sampleRate = 0, bits = 0;
  let body: { at: number; size: number } | null = null;
  for (let at = 12; at + 8 <= data.length;) {
    const id = text(at);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(at + 8, true);
      count = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
      if (format === EXTENSIBLE && size >= 40) format = view.getUint16(at + 32, true);
    } else if (id === 'data') {
      body = { at: at + 8, size: Math.min(size, data.length - at - 8) };
    }
    at += 8 + size + (size % 2);
  }
  if (!body || !count) throw new Error('WAV file has no audio');
  if (!(format === PCM && (bits === 16 || bits === 24 || bits === 32)) && !(format === FLOAT && bits === 32)) {
    throw new Error(`unsupported WAV format ${format}/${bits}`);
  }

  const bytes = bits / 8;
  const frames = Math.floor(body.size / (bytes * count));
  const channels = Array.from({ length: count }, () => new Float32Array(frames));
  let at = body.at;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      let x: number;
      if (format === FLOAT) x = view.getFloat32(at, true);
      else if (bits === 16) x = scale(view.getInt16(at, true), 32768);
      else if (bits === 24) x = scale(((data[at + 2] << 24) | (data[at + 1] << 16) | (data[at] << 8)) >> 8, 8388608);
      else x = scale(view.getInt32(at, true), 2147483648);
      channels[c][i] = x;
      at += bytes;
    }
  }
  return { sampleRate, channels };
}
