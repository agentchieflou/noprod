import { useEffect, useRef } from 'react';
import { useDAWStore } from '../store/useDAWStore';
import { useState } from 'react';
import { clipTimelineLength } from '../audio/clipPlayback';
import { convertClipToMidi, type ConvertMode } from '../audio/audioToMidi';
import { detectTransients, estimateBpm } from '../audio/warp';
import PianoRoll from './PianoRoll';

const SAMPLE_W = 620;
const SAMPLE_H = 132;

// Audio-to-MIDI: converts an arrangement clip onto a new MIDI track
function ConvertToMidi({ region }: { region: any }) {
  const [busy, setBusy] = useState<ConvertMode | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const run = async (mode: ConvertMode) => {
    const st = useDAWStore.getState();
    setBusy(mode);
    setResult(null);
    try {
      const notes = await convertClipToMidi(region, mode, st.bpm);
      if (!notes.length) { setResult('No notes found'); return; }
      const source = st.tracks.find((t: any) => t.id === region.trackId);
      st.addConvertedMidiTrack({
        sourceTrackId: region.trackId,
        name: `${region.file} (${mode})`,
        kit: mode === 'drums' ? 'drums' : 'synth',
        startTime: region.startTime,
        duration: clipTimelineLength(region, st.bpm),
        notes
      });
      setResult(`${notes.length} notes → new track after ${source?.name ?? 'source'}`);
    } catch (err: any) {
      setResult(`Failed: ${err.message || err}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="clip-prop-box">
      <span className="clip-control-label">Convert to MIDI</span>
      <div style={{ display: 'flex', gap: 3 }}>
        {(['melody', 'harmony', 'drums'] as ConvertMode[]).map((m) => (
          <button key={m} className="btn-view convert-btn" disabled={!!busy} onClick={() => run(m)}
            title={m === 'melody' ? 'Extract the lead line (monophonic)' : m === 'harmony' ? 'Extract chords / polyphony' : 'Extract kick, snare and hi-hats onto a drum kit'}>
            {busy === m ? '…' : m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>
      {result && <span className="clip-meta">{result}</span>}
    </div>
  );
}

interface Props {
  region: any;                       // an arrangement clip or a session clip
  onChange: (patch: any) => void;    // writes clip properties back to the store
  trackColor: string;
  onAudition: (pitch: number) => void;
}

const round = (v: number, step = 0.001) => Math.round(v / step) * step;

// Full-buffer sample display: the playing range highlighted, a draggable
// start marker and (when looping) a draggable/resizable loop brace.
function SampleDisplay({ region, color, onChange }: { region: any; color: string; onChange: (patch: any) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buf: AudioBuffer = region.audioBuffer;
  const total = buf.duration;
  const xOf = (t: number) => (t / total) * SAMPLE_W;
  const tOf = (x: number) => Math.max(0, Math.min(total, (x / SAMPLE_W) * total));
  const start = region.startOffset || 0;
  const looping = !!region.loopEnabled;
  const ls = region.loopStart ?? start, le = region.loopEnd ?? Math.min(total, start + region.duration);
  const contentEnd = looping ? le : Math.min(total, start + region.duration);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const data = buf.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / SAMPLE_W));
    ctx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
    for (let x = 0; x < SAMPLE_W; x++) {
      let min = 1, max = -1;
      for (let j = x * per; j < Math.min(data.length, (x + 1) * per); j += Math.max(1, Math.floor(per / 48))) {
        if (data[j] < min) min = data[j];
        if (data[j] > max) max = data[j];
      }
      const t = (x / SAMPLE_W) * total;
      const active = looping ? t >= Math.min(start, ls) && t < le : t >= start && t < contentEnd;
      ctx.fillStyle = active ? color : '#555';
      ctx.fillRect(x, (1 + min) * SAMPLE_H / 2, 1, Math.max(1, (max - min) * SAMPLE_H / 2));
    }
  }, [buf, start, ls, le, looping, contentEnd, total, color]);

  const drag = (e: React.MouseEvent, onMove: (t: number, dt: number) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).closest('.sample-display')!.getBoundingClientRect();
    const t0 = tOf(e.clientX - rect.left);
    const move = (me: MouseEvent) => {
      const t = tOf(me.clientX - rect.left);
      onMove(t, t - t0);
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const moveStart = (e: React.MouseEvent) => drag(e, (t) => {
    const s = round(Math.min(t, looping ? le - 0.01 : total - 0.05));
    // keep the clip's end in place when not looping
    const dur = looping ? region.duration : Math.max(0.05, contentEnd - s);
    onChange({ startOffset: s, duration: dur });
  });

  const moveLoop = (mode: 'move' | 'start' | 'end') => (e: React.MouseEvent) => {
    const s0 = ls, e0 = le;
    drag(e, (t, dt) => {
      if (mode === 'move') {
        const d = Math.max(-s0, Math.min(total - e0, dt));
        onChange({ loopStart: round(s0 + d), loopEnd: round(e0 + d) });
      } else if (mode === 'start') {
        onChange({ loopStart: round(Math.min(t, e0 - 0.01)) });
      } else {
        onChange({ loopEnd: round(Math.max(t, s0 + 0.01)) });
      }
    });
  };

  return (
    <div className="sample-display" style={{ width: SAMPLE_W }}>
      <div className="sample-loop-row">
        {looping && (
          <div className="sample-loop-brace" style={{ left: xOf(ls), width: Math.max(4, xOf(le) - xOf(ls)) }}
            onMouseDown={moveLoop('move')} title="Loop: drag to move, drag edges to resize">
            <div className="loop-brace-handle left" onMouseDown={moveLoop('start')} />
            <div className="loop-brace-handle right" onMouseDown={moveLoop('end')} />
          </div>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <canvas ref={canvasRef} width={SAMPLE_W} height={SAMPLE_H} className="sample-canvas" />
        <div className="sample-start-marker" style={{ left: xOf(start) }} onMouseDown={moveStart} title="Start marker: drag to change where the clip starts in the sample" />
        {!looping && <div className="sample-end-marker" style={{ left: xOf(contentEnd) }} title="End of the clip's content" />}
      </div>
    </div>
  );
}

// Clip View: per-clip properties (gain, transpose/detune, loop, warp) next to
// the sample display (audio) or the piano roll (MIDI). Every change updates
// the clip in the store, which playback and the arrangement visuals follow.
export default function ClipView({ region, onChange, trackColor, onAudition }: Props) {
  const bpm = useDAWStore((s: any) => s.bpm);
  const isMidi = region.type === 'midi';
  const buf: AudioBuffer | undefined = region.audioBuffer;
  const set = onChange;
  const length = clipTimelineLength(region, bpm);

  const toggleLoop = () => {
    if (region.loopEnabled) { set({ loopEnabled: false }); return; }
    // default loop = the clip's current content
    const start = isMidi ? 0 : region.startOffset || 0;
    const end = isMidi ? region.duration : Math.min(buf ? buf.duration : Infinity, start + region.duration);
    set({ loopEnabled: true, loopStart: region.loopStart ?? start, loopEnd: region.loopEnd ?? end });
  };

  const toggleWarp = () => {
    if (region.warpEnabled) { set({ warpEnabled: false }); return; }
    const transients = region.transients || detectTransients(buf!);
    set({ warpEnabled: true, warpMode: region.warpMode || 'beats', transients, originalBpm: region.originalBpm || estimateBpm(transients, bpm) });
  };

  const num = (label: string, value: number, onChange: (v: number) => void, opts: { min?: number; max?: number; step?: number; unit?: string } = {}) => (
    <label className="clip-num">
      <span>{label}</span>
      <input
        type="number" className="clip-input"
        min={opts.min} max={opts.max} step={opts.step ?? 1}
        value={Number.isFinite(value) ? round(value, opts.step ?? 1) : 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(opts.min ?? -Infinity, Math.min(opts.max ?? Infinity, v)));
        }}
      />
      {opts.unit && <em>{opts.unit}</em>}
    </label>
  );

  return (
    <div className="clip-view">
      <div className="clip-props">
        <div className="clip-prop-box">
          <span className="clip-control-label">Clip</span>
          <input className="clip-name-input" value={region.file} onChange={(e) => set({ file: e.target.value })} />
          <span className="clip-meta">{isMidi ? 'MIDI' : 'Audio'} · {length.toFixed(2)}s on timeline</span>
        </div>

        <div className="clip-prop-box">
          <span className="clip-control-label">Gain</span>
          <div className="clip-gain-row">
            <input
              type="range" min="-36" max="24" step="0.1"
              value={region.gain || 0}
              onChange={(e) => set({ gain: parseFloat(e.target.value) })}
              onDoubleClick={() => set({ gain: 0 })}
              className="param-slider"
              title="Double-click to reset"
            />
            <span className="param-value">{(region.gain || 0).toFixed(1)} dB</span>
          </div>
        </div>

        <div className="clip-prop-box">
          <span className="clip-control-label">{isMidi ? 'Transpose' : 'Pitch'}</span>
          {num('Transp.', region.transpose || 0, (v) => set({ transpose: Math.round(v) }), { min: -48, max: 48, unit: 'st' })}
          {!isMidi && num('Detune', region.detune || 0, (v) => set({ detune: Math.round(v) }), { min: -50, max: 50, unit: 'ct' })}
          {!isMidi && !region.warpEnabled && (region.transpose || region.detune) ? <span className="clip-meta">unwarped: speed changes too</span> : null}
        </div>

        <div className="clip-prop-box">
          <span className="clip-control-label">Loop</span>
          <button className={`btn-view ${region.loopEnabled ? 'active' : ''}`} onClick={toggleLoop}>{region.loopEnabled ? 'ON' : 'OFF'}</button>
          {region.loopEnabled && (
            <>
              {num('Start', region.loopStart, (v) => set({ loopStart: Math.min(v, region.loopEnd - 0.01) }), { min: 0, step: 0.01, unit: 's' })}
              {num('End', region.loopEnd, (v) => set({ loopEnd: Math.max(v, region.loopStart + 0.01) }), { min: 0, max: buf?.duration, step: 0.01, unit: 's' })}
              {num('Length', region.loopEnd - region.loopStart, (v) => set({ loopEnd: region.loopStart + Math.max(0.01, v) }), { min: 0.01, step: 0.01, unit: 's' })}
              <span className="clip-meta">drag the clip's right edge to repeat it</span>
            </>
          )}
        </div>

        {!isMidi && buf && region.trackId && <ConvertToMidi region={region} />}

        {!isMidi && buf && (
          <div className="clip-prop-box">
            <span className="clip-control-label">Warp</span>
            <button className={`btn-view ${region.warpEnabled ? 'active' : ''}`} onClick={toggleWarp}
              title="Warp: follow the project tempo">{region.warpEnabled ? 'ON' : 'OFF'}</button>
            {region.warpEnabled && (
              <>
                <select className="rack-map-select" value={region.warpMode || 'beats'} onChange={(e) => set({ warpMode: e.target.value })}>
                  <option value="beats">Beats</option>
                  <option value="tones">Tones</option>
                  <option value="texture">Texture</option>
                  <option value="repitch">Re-Pitch</option>
                </select>
                {num('Orig BPM', region.originalBpm, (v) => set({ originalBpm: v || 120 }), { min: 40, max: 240, step: 0.1 })}
                <span className="clip-meta">{(region.transients || []).length} transients · ×{(bpm / region.originalBpm).toFixed(2)}</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="clip-editor">
        {isMidi ? (
          <PianoRoll region={region} trackColor={trackColor} bpm={bpm} onAudition={onAudition}
            onNotesChange={(notes: any[]) => onChange({ notes })} />
        ) : buf ? (
          <SampleDisplay region={region} color={trackColor} onChange={onChange} />
        ) : null}
      </div>
    </div>
  );
}
