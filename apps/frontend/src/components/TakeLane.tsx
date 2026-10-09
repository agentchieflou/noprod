import { useEffect, useRef, useState } from 'react';
import { useDAWStore } from '../store/useDAWStore';
import { PIXELS_PER_SECOND, beatSeconds } from '../audio/timeline';
import { clipTimelineLength, expandMidiNotes } from '../audio/clipPlayback';

export const TAKE_LANE_HEIGHT = 48;

function TakeClip({ clip, bpm, color }: { clip: any; bpm: number; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = Math.max(2, clipTimelineLength(clip, bpm) * PIXELS_PER_SECOND);
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, TAKE_LANE_HEIGHT);
    ctx.fillStyle = color;
    if (clip.type === 'midi') {
      const notes = expandMidiNotes(clip);
      const ps = notes.map((n) => n.pitch);
      const lo = Math.min(...ps, 60) - 1, hi = Math.max(...ps, 60) + 1;
      notes.forEach((n) => ctx.fillRect(n.start * PIXELS_PER_SECOND, (1 - (n.pitch - lo) / (hi - lo)) * (TAKE_LANE_HEIGHT - 6), Math.max(1, (n.end - n.start) * PIXELS_PER_SECOND), 3));
      return;
    }
    const buf: AudioBuffer | undefined = clip.audioBuffer;
    if (!buf) return;
    const data = buf.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / width));
    const off = Math.floor((clip.startOffset || 0) * buf.sampleRate);
    const amp = TAKE_LANE_HEIGHT / 2;
    for (let x = 0; x < width; x++) {
      let mx = 0;
      for (let j = off + x * per; j < Math.min(data.length, off + (x + 1) * per); j += Math.max(1, Math.floor(per / 32))) mx = Math.max(mx, Math.abs(data[j]));
      ctx.fillRect(x, amp - mx * amp, 1, Math.max(1, mx * 2 * amp));
    }
  }, [clip, bpm, color, width]);
  return (
    <canvas
      ref={canvasRef}
      className="take-clip"
      width={Math.ceil(width)}
      height={TAKE_LANE_HEIGHT}
      style={{ left: clip.startTime * PIXELS_PER_SECOND, borderColor: color }}
    />
  );
}

// One take lane: its clips, the ranges currently used in the comp, and
// drag-to-comp (drag across a take to use that range; click a take to use
// all of it).
export default function TakeLane({ track, lane, width }: { track: any; lane: any; width: number }) {
  const { bpm, regions, compTakeRange } = useDAWStore();
  const [sel, setSel] = useState<[number, number] | null>(null);
  const grid = beatSeconds(bpm) / 4;
  const snap = (t: number) => Math.max(0, Math.round(t / grid) * grid);

  // Parts of the comp that come from this lane
  const used = regions.filter((r: any) => r.trackId === track.id && r.takeLaneId === lane.id)
    .map((r: any) => [r.startTime, r.startTime + clipTimelineLength(r, bpm)]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const tAt = (x: number) => Math.max(0, (x - rect.left) / PIXELS_PER_SECOND);
    const t0 = tAt(e.clientX);
    let dragged = false;
    const move = (me: MouseEvent) => {
      if (Math.abs(me.clientX - e.clientX) > 4) dragged = true;
      if (dragged) {
        const t1 = tAt(me.clientX);
        setSel([snap(Math.min(t0, t1)), snap(Math.max(t0, t1))]);
      }
    };
    const up = (me: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setSel(null);
      if (dragged) {
        const t1 = tAt(me.clientX);
        compTakeRange(track.id, lane.id, snap(Math.min(t0, t1)), snap(Math.max(t0, t1)));
      } else {
        const clip = lane.regions.find((c: any) => t0 >= c.startTime && t0 < c.startTime + clipTimelineLength(c, bpm));
        if (clip) compTakeRange(track.id, lane.id, clip.startTime, clip.startTime + clipTimelineLength(clip, bpm));
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="take-lane-row" style={{ width }} onMouseDown={onMouseDown} onClick={(e) => e.stopPropagation()}
      title="Drag across this take to use that range in the comp; click a take to use all of it">
      {lane.regions.map((c: any) => <TakeClip key={c.id} clip={c} bpm={bpm} color={track.color} />)}
      {used.map(([a, b]: number[], i: number) => (
        <div key={i} className="take-used" style={{ left: a * PIXELS_PER_SECOND, width: (b - a) * PIXELS_PER_SECOND }} />
      ))}
      {sel && <div className="take-selection" style={{ left: sel[0] * PIXELS_PER_SECOND, width: (sel[1] - sel[0]) * PIXELS_PER_SECOND }} />}
    </div>
  );
}
