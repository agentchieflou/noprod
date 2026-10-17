// Export: the project, or a range of it, rendered (render.ts) and written
// as WAV files: 16 or 24 bit with TPDF dither, or 32-bit float; the mix as
// one file, the stems as one file each in a zip. The Export dialog
// (components/ExportDialog.tsx) drives this and shows its progress.

import { encodeWav, zip, type WavBits } from '@noprod/sound';
import { MASTER_ID } from './mixer';
import { renderProject, stemIds, type RenderRequest } from './render';

export type ExportWhat = 'mix' | 'stems';
export type ExportRange = 'project' | 'loop';

export interface ExportOptions {
  state: any;
  what: ExportWhat;
  range: ExportRange;
  bits: WavBits;
  sampleRate: number;
  tail: number | 'auto';
  onProgress?: (done: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  name: string;
  files: number;
  seconds: number;        // of music, the tail apart
  tail: number;           // seconds of tail rendered
  nativeSkipped: number;  // native inserts that passed through
}

// A name as a file name (no path separators or reserved characters)
const safe = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\p{Cc}+/gu, '').trim() || 'Untitled';

// The project's end: the last clip's end, in timeline seconds
export function projectEnd(state: any, clipLength: (clip: any, bpm: number) => number): number {
  const bpm = state.bpm || 120;
  return Math.max(0, ...(state.regions || []).map((r: any) => r.startTime + clipLength(r, bpm)));
}

export function exportRange(state: any, range: ExportRange, clipLength: (clip: any, bpm: number) => number): [number, number] {
  if (range === 'loop' && state.loopEnd > state.loopStart) return [state.loopStart, state.loopEnd];
  return [0, projectEnd(state, clipLength)];
}

const stemName = (state: any, id: string) =>
  id === MASTER_ID ? 'Master' : (state.tracks || []).find((t: any) => t.id === id)?.name || (state.returns || []).find((r: any) => r.id === id)?.name || id;

export async function exportProject(o: ExportOptions, clipLength: (clip: any, bpm: number) => number): Promise<ExportResult> {
  const [from, to] = exportRange(o.state, o.range, clipLength);
  if (to <= from) throw new Error('There is nothing to export: the range is empty.');
  const stems = o.what === 'stems' ? stemIds(o.state) : null;
  const request: RenderRequest = { state: o.state, from, to, sampleRate: o.sampleRate, stems, tail: o.tail, onProgress: o.onProgress, signal: o.signal };
  const r = await renderProject(request);
  const dither = o.bits !== 32;
  const encode = (b: AudioBuffer) => encodeWav(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)), b.sampleRate, o.bits, dither);
  const project = safe(o.state.projectName || 'Untitled');
  const seconds = to - from;
  if (!stems) {
    const wav = encode(r.buffers[0]);
    return { blob: new Blob([wav as BlobPart], { type: 'audio/wav' }), name: `${project}.wav`, files: 1, seconds, tail: r.tail, nativeSkipped: r.nativeSkipped };
  }
  const used = new Set<string>();
  const entries = r.buffers.map((b, i) => {
    let name = safe(stemName(o.state, stems[i]));
    for (let n = 2; used.has(name); n++) name = `${safe(stemName(o.state, stems[i]))} ${n}`;
    used.add(name);
    return { name: `${project}/${String(i + 1).padStart(2, '0')} ${name}.wav`, data: encode(b) };
  });
  const archive = zip(entries);
  return { blob: new Blob([archive as BlobPart], { type: 'application/zip' }), name: `${project} stems.zip`, files: entries.length, seconds, tail: r.tail, nativeSkipped: r.nativeSkipped };
}

// Hands the file to the browser as a download
export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
