import { useEffect, useRef } from 'react';
import { useDAWStore } from '../store/useDAWStore';
import { PIXELS_PER_SECOND } from '../audio/timeline';
import { clipRate, clipTimelineLength, clipLoop, sourcePosAt, expandMidiNotes } from '../audio/clipPlayback';
import { dbToGain } from '../audio/devices';

interface ClipNodeProps {
  region: any;
  trackColor: string;
  isSelected: boolean;
  onClick: () => void;
  onOpenClip?: () => void;
}

// Timeline offsets (seconds into the clip) where a looped clip wraps around
const loopWraps = (region: any, bpm: number, length: number) => {
  const loop = clipLoop(region);
  if (!loop) return [];
  const rate = clipRate(region, bpm);
  const startPos = region.type === 'midi' ? 0 : region.startOffset || 0;
  const out: number[] = [];
  let x = (loop[1] - startPos) / rate;
  while (x > 0 && x < length - 1e-6 && out.length < 500) {
    out.push(x);
    x += (loop[1] - loop[0]) / rate;
  }
  return out;
};

// Drag the clip (move) or its edges (trim). Edge drags are converted from
// timeline seconds to the clip's source time; a looped clip can be stretched
// past its content, an unlooped one stops at the end of its audio.
function useClipDrag(region: any) {
  const { updateRegionPosition, updateRegionTrim, bpm } = useDAWStore();
  return (e: React.MouseEvent, type: 'move' | 'trim-left' | 'trim-right', onClick: () => void) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    onClick();
    const startX = e.clientX;
    const start = region.startTime;
    const dur = region.duration;
    const offset = region.startOffset || 0;
    const rate = clipRate(region, bpm);
    const isMidi = region.type === 'midi';
    const maxSource = !isMidi && region.audioBuffer && !clipLoop(region) ? region.audioBuffer.duration - offset : Infinity;

    const onMove = (me: MouseEvent) => {
      const dt = (me.clientX - startX) / PIXELS_PER_SECOND;
      if (type === 'move') {
        updateRegionPosition(region.id, Math.max(0, start + dt));
      } else if (type === 'trim-left') {
        // never before the start of the source, never shorter than 0.1s
        const minDt = isMidi ? 0 : -offset / rate;
        const d = Math.max(Math.max(-start, minDt), Math.min(dt, dur / rate - 0.1));
        updateRegionTrim(region.id, start + d, dur - d * rate, isMidi ? 0 : offset + d * rate);
      } else {
        const newDur = Math.min(maxSource, Math.max(0.1 * rate, dur + dt * rate));
        updateRegionTrim(region.id, start, newDur, offset);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
}

export function AudioRegionNode({ region, trackColor, isSelected, onClick, onOpenClip }: ClipNodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bpm = useDAWStore((s: any) => s.bpm);
  const drag = useClipDrag(region);
  const length = clipTimelineLength(region, bpm);
  const width = Math.max(4, length * PIXELS_PER_SECOND);

  // Waveform as it will play: each pixel reads the loop-wrapped source
  // position for its timeline time, scaled by the clip gain.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const buf: AudioBuffer | undefined = region.audioBuffer;
    if (!canvas || !ctx || !buf) return;
    const data = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const amp = canvas.height / 2;
    const gain = Math.min(4, dbToGain(region.gain || 0, -96));
    const perPx = Math.max(1, Math.floor((clipRate(region, bpm) / PIXELS_PER_SECOND) * sr));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = trackColor || '#3b82f6';
    for (let x = 0; x < canvas.width; x++) {
      const i0 = Math.floor(sourcePosAt(region, bpm, x / PIXELS_PER_SECOND) * sr);
      if (i0 >= data.length) break;
      let min = 1, max = -1;
      for (let j = i0; j < Math.min(data.length, i0 + perPx); j += Math.max(1, Math.floor(perPx / 64))) {
        const v = data[j] * gain;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      min = Math.max(-1, min); max = Math.min(1, max);
      ctx.fillRect(x, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
    }
  }, [region, trackColor, bpm, width]);

  const stretched = region.warpEnabled && region.originalBpm;
  const badges = [
    stretched ? '⇌' : '',
    region.loopEnabled ? '⟳' : '',
    region.transpose ? `${region.transpose > 0 ? '+' : ''}${region.transpose}st` : '',
    region.gain ? `${region.gain > 0 ? '+' : ''}${Number(region.gain).toFixed(1)}dB` : ''
  ].filter(Boolean).join(' ');

  return (
    <div
      className={`audio-region ${isSelected ? 'selected' : ''}`}
      onMouseDown={(e) => drag(e, 'move', onClick)}
      onDoubleClick={(e) => { e.stopPropagation(); onOpenClip?.(); }}
      style={{ width, left: region.startTime * PIXELS_PER_SECOND, borderColor: isSelected ? '#fff' : trackColor }}
    >
      <div className="trim-handle left-handle" onMouseDown={(e) => drag(e, 'trim-left', onClick)} />
      <canvas ref={canvasRef} width={Math.ceil(width)} height={80} style={{ display: 'block', opacity: 0.8 }} />
      {stretched && (region.transients || []).map((t: number, i: number) => {
        const x = (t - (region.startOffset || 0)) / clipRate(region, bpm);
        if (x < 0 || x > length) return null;
        return <div key={i} className="warp-marker" style={{ left: x * PIXELS_PER_SECOND }} />;
      })}
      {loopWraps(region, bpm, length).map((x) => <div key={x} className="loop-wrap-marker" style={{ left: x * PIXELS_PER_SECOND }} />)}
      <div className="clip-label">{badges && <span className="clip-badges">{badges}</span>}{region.file}</div>
      <div className="trim-handle right-handle" onMouseDown={(e) => drag(e, 'trim-right', onClick)} />
    </div>
  );
}

export function MidiRegionNode({ region, trackColor, isSelected, onClick, onOpenClip }: ClipNodeProps) {
  const drag = useClipDrag(region);
  const bpm = useDAWStore((s: any) => s.bpm);
  const length = region.duration;

  // Map the clip's pitch span onto its height so the pattern silhouette reads at a glance
  const notes = expandMidiNotes(region);
  const pitches = notes.map((n) => n.pitch);
  const minPitch = pitches.length ? Math.min(...pitches) - 2 : 48;
  const maxPitch = pitches.length ? Math.max(...pitches) + 2 : 72;
  const pitchSpan = Math.max(1, maxPitch - minPitch);

  return (
    <div
      className={`audio-region midi-region ${isSelected ? 'selected' : ''}`}
      onMouseDown={(e) => drag(e, 'move', onClick)}
      onDoubleClick={(e) => { e.stopPropagation(); onOpenClip?.(); }}
      style={{
        width: length * PIXELS_PER_SECOND,
        left: region.startTime * PIXELS_PER_SECOND,
        borderColor: isSelected ? '#fff' : trackColor,
        backgroundColor: `${trackColor}30`
      }}
    >
      {notes.map((note) => (
        <div
          key={note.id}
          className="midi-note-bar"
          style={{
            left: `${(note.start / length) * 100}%`,
            width: `${Math.max(0.5, ((note.end - note.start) / length) * 100)}%`,
            top: `${(1 - (note.pitch - minPitch) / pitchSpan) * 90}%`,
            backgroundColor: trackColor,
            opacity: 0.4 + 0.6 * note.velocity
          }}
        />
      ))}
      {loopWraps(region, bpm, length).map((x) => <div key={x} className="loop-wrap-marker" style={{ left: x * PIXELS_PER_SECOND }} />)}
      <div className="clip-label">
        {region.loopEnabled && <span className="clip-badges">⟳</span>}
        {region.transpose ? <span className="clip-badges">{region.transpose > 0 ? '+' : ''}{region.transpose}st</span> : null}
        {region.file} {(region.notes || []).length === 0 ? '(empty)' : ''}
      </div>
      <div className="trim-handle right-handle" onMouseDown={(e) => drag(e, 'trim-right', onClick)} />
    </div>
  );
}
