import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useDAWStore } from '../store/useDAWStore';
import { audioContext } from '../audio/engine';
import { isPlaying } from '../audio/transport';
import { clipTimelineLength } from '../audio/clipPlayback';
import { exportProject, exportRange, download, type ExportWhat, type ExportRange } from '../audio/export';
import { projectTail } from '../audio/render';
import { stemIds } from '../audio/render';
import { setExportDialogOpen } from './exportDialog';
import { notify, errorMessage } from '../notify';
import type { WavBits } from '@noprod/sound';

const RATES = [44100, 48000, 96000];
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// Export: the mix or the stems, the whole project or the loop, as WAV at a
// bit depth and sample rate, with the devices' tails; a progress bar and
// Cancel while it renders, then the file downloads.
export default function ExportDialog() {
  const state = useDAWStore();
  const [what, setWhat] = useState<ExportWhat>('mix');
  const [range, setRange] = useState<ExportRange>('project');
  const [bits, setBits] = useState<WavBits>(24);
  const [rate, setRate] = useState<number>(audioContext.sampleRate);
  const [tailMode, setTailMode] = useState<'auto' | 'none' | 'fixed'>('auto');
  const [tailSeconds, setTailSeconds] = useState(2);
  const [progress, setProgress] = useState<number | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const [from, to] = exportRange(state, range, clipTimelineLength);
  const stems = stemIds(state).length;
  const autoTail = projectTail(state);
  const tail = tailMode === 'auto' ? autoTail : tailMode === 'none' ? 0 : tailSeconds;
  const loopable = state.loopEnd > state.loopStart;
  const empty = to <= from;

  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    if (isPlaying()) state.togglePlayback();
    const controller = new AbortController();
    abort.current = controller;
    setProgress(0);
    setDone(null);
    try {
      const r = await exportProject({ state: useDAWStore.getState(), what, range, bits, sampleRate: rate, tail, onProgress: setProgress, signal: controller.signal }, clipTimelineLength);
      download(r.blob, r.name);
      const size = r.blob.size < 1 << 20 ? `${(r.blob.size / 1024).toFixed(0)} KB` : `${(r.blob.size / (1 << 20)).toFixed(1)} MB`;
      setDone(`Exported ${r.name} (${size}): ${r.files === 1 ? 'the mix' : `${r.files} stems`}, ${fmt(r.seconds)} of music${r.tail > 0 ? ` and ${r.tail.toFixed(1)} s of tail` : ''}.`
        + (r.nativeSkipped ? ` ${r.nativeSkipped} native plug-in${r.nativeSkipped === 1 ? '' : 's'} passed audio through: they are not rendered yet.` : ''));
    } catch (err: any) {
      if (err?.name === 'AbortError') setDone('Export cancelled.');
      else notify(`Export failed: ${errorMessage(err)}`, 'error');
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };

  const rendering = progress !== null;
  return (
    <div className="midi-map-dialog export-dialog" role="dialog" aria-label="Export">
      <div className="midi-map-head">
        <b>Export</b>
        <button className="btn-icon" title="Close" onClick={() => { abort.current?.abort(); setExportDialogOpen(false); }}><X size={12} /></button>
      </div>
      <div className="export-rows">
        <label>What
          <select value={what} disabled={rendering} onChange={(e) => setWhat(e.target.value as ExportWhat)}>
            <option value="mix">The mix (master out)</option>
            <option value="stems">Stems: {stems} file{stems === 1 ? '' : 's'}, zipped</option>
          </select>
        </label>
        <label>Range
          <select value={range} disabled={rendering} onChange={(e) => setRange(e.target.value as ExportRange)}>
            <option value="project">The project ({fmt(Math.max(0, exportRange(state, 'project', clipTimelineLength)[1]))})</option>
            <option value="loop" disabled={!loopable}>The loop ({fmt(state.loopStart)} to {fmt(state.loopEnd)})</option>
          </select>
        </label>
        <label>Format
          <select value={bits} disabled={rendering} onChange={(e) => setBits(Number(e.target.value) as WavBits)}>
            <option value={16}>WAV 16-bit, dithered</option>
            <option value={24}>WAV 24-bit, dithered</option>
            <option value={32}>WAV 32-bit float</option>
          </select>
          <select value={rate} disabled={rendering} onChange={(e) => setRate(Number(e.target.value))}>
            {[...new Set([audioContext.sampleRate, ...RATES])].sort((a, b) => a - b).map((r) => <option key={r} value={r}>{r / 1000} kHz</option>)}
          </select>
        </label>
        <label>Tail
          <select value={tailMode} disabled={rendering} onChange={(e) => setTailMode(e.target.value as any)}>
            <option value="auto">The devices' ({autoTail.toFixed(1)} s)</option>
            <option value="none">None</option>
            <option value="fixed">Seconds:</option>
          </select>
          {tailMode === 'fixed' && <input type="number" min={0} max={30} step={0.5} value={tailSeconds} disabled={rendering} onChange={(e) => setTailSeconds(Math.max(0, Math.min(30, Number(e.target.value) || 0)))} />}
        </label>
      </div>
      {rendering && (
        <div className="export-progress">
          <progress value={progress} max={1} />
          <span>{Math.round(progress * 100)}%</span>
          <button className="btn-metronome" onClick={() => abort.current?.abort()}>Cancel</button>
        </div>
      )}
      {done && <p className="native-hint export-done">{done}</p>}
      {!rendering && (
        <div className="export-actions">
          <button className="btn-metronome export-start" disabled={empty} onClick={start} title={empty ? 'Nothing to export: the range is empty' : undefined}>Export…</button>
        </div>
      )}
    </div>
  );
}
