import { useRef, useState, useEffect } from 'react';
import { useDAWStore } from '../store/useDAWStore';
import { midiNoteName } from '../audio/synth';

const PITCH_TOP = 84;    // C6
const PITCH_BOTTOM = 36; // C2
const ROW_H = 14;
const PX_PER_BEAT = 48;
const VEL_LANE_H = 52;

const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);

interface PianoRollProps {
  region: any;
  trackColor: string;
  bpm: number;
  onAudition: (pitch: number) => void;
  onNotesChange?: (notes: any[]) => void; // defaults to editing an arrangement clip
}

export default function PianoRoll({ region, trackColor, bpm, onAudition, onNotesChange }: PianoRollProps) {
  const { updateRegionNotes: updateArrangementNotes } = useDAWStore();
  const updateRegionNotes = (id: string, next: any[]) => (onNotesChange ? onNotesChange(next) : updateArrangementNotes(id, next));
  const gridRef = useRef<HTMLDivElement>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  const secPerBeat = 60 / bpm;
  const snapSec = secPerBeat / 4; // 16th-note grid
  const totalBeats = Math.max(1, Math.ceil(region.duration / secPerBeat));
  const gridW = totalBeats * PX_PER_BEAT;
  const notes = region.notes || [];

  const rows: number[] = [];
  for (let p = PITCH_TOP; p >= PITCH_BOTTOM; p--) rows.push(p);
  const gridH = rows.length * ROW_H;

  const timeToX = (t: number) => (t / secPerBeat) * PX_PER_BEAT;
  const xToTime = (x: number) => (x / PX_PER_BEAT) * secPerBeat;
  const pitchToY = (p: number) => (PITCH_TOP - p) * ROW_H;

  const snap = (t: number) => Math.round(t / snapSec) * snapSec;
  const snapFloor = (t: number) => Math.floor(t / snapSec) * snapSec;

  // Delete key removes the selected note
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNoteId && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault();
        updateRegionNotes(region.id, notes.filter((n: any) => n.id !== selectedNoteId));
        setSelectedNoteId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNoteId, notes, region.id, updateRegionNotes]);

  const handleGridMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const start = Math.max(0, Math.min(snapFloor(xToTime(x)), region.duration - snapSec));
    const pitch = PITCH_TOP - Math.floor(y / ROW_H);
    if (pitch < PITCH_BOTTOM || pitch > PITCH_TOP) return;

    const newNote = {
      id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      pitch,
      start,
      duration: Math.min(snapSec * 2, region.duration - start), // default: 8th note
      velocity: 0.9
    };
    updateRegionNotes(region.id, [...notes, newNote]);
    setSelectedNoteId(newNote.id);
    onAudition(pitch);
  };

  const handleNoteMouseDown = (e: React.MouseEvent, note: any) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    setSelectedNoteId(note.id);

    const target = e.currentTarget as HTMLElement;
    const noteRect = target.getBoundingClientRect();
    const mode: 'move' | 'resize' = e.clientX > noteRect.right - 8 ? 'resize' : 'move';

    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...note };
    let lastPitch = note.pitch;

    const onMove = (me: MouseEvent) => {
      const dTime = xToTime(me.clientX - startX);
      const dRows = Math.round((me.clientY - startY) / ROW_H);
      const current = useDAWStore.getState().regions.find((r: any) => r.id === region.id);
      if (!current) return;

      const newNotes = (current.notes || []).map((n: any) => {
        if (n.id !== note.id) return n;
        if (mode === 'resize') {
          const newDur = Math.max(snapSec, snap(orig.duration + dTime));
          return { ...n, duration: Math.min(newDur, region.duration - n.start) };
        }
        const newStart = Math.max(0, Math.min(snap(orig.start + dTime), region.duration - n.duration));
        const newPitch = Math.max(PITCH_BOTTOM, Math.min(PITCH_TOP, orig.pitch - dRows));
        if (newPitch !== lastPitch) {
          lastPitch = newPitch;
          onAudition(newPitch);
        }
        return { ...n, start: newStart, pitch: newPitch };
      });
      updateRegionNotes(region.id, newNotes);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleNoteDoubleClick = (e: React.MouseEvent, note: any) => {
    e.stopPropagation();
    updateRegionNotes(region.id, notes.filter((n: any) => n.id !== note.id));
    if (selectedNoteId === note.id) setSelectedNoteId(null);
  };

  const handleVelocityMouseDown = (e: React.MouseEvent, note: any) => {
    e.stopPropagation();
    setSelectedNoteId(note.id);
    const laneRect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();

    const setVel = (clientY: number) => {
      const vel = Math.max(0.05, Math.min(1, 1 - (clientY - laneRect.top) / VEL_LANE_H));
      const current = useDAWStore.getState().regions.find((r: any) => r.id === region.id);
      if (!current) return;
      updateRegionNotes(region.id, (current.notes || []).map((n: any) => n.id === note.id ? { ...n, velocity: vel } : n));
    };
    setVel(e.clientY);
    const onMove = (me: MouseEvent) => setVel(me.clientY);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="piano-roll">
      <div className="pr-toolbar">
        <span style={{ fontWeight: 'bold', fontSize: '12px' }}>{region.file}</span>
        <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
          {notes.length} notes · 1/16 grid · double-click grid to add, double-click note to delete, drag edge to resize
        </span>
      </div>
      <div className="pr-scroll">
        <div className="pr-body" style={{ width: gridW + 44 }}>
          {/* Key labels */}
          <div className="pr-keys" style={{ height: gridH }}>
            {rows.map(p => (
              <div
                key={p}
                className={`pr-key ${isBlackKey(p) ? 'black' : ''}`}
                style={{ height: ROW_H }}
                onMouseDown={() => onAudition(p)}
              >
                {p % 12 === 0 ? midiNoteName(p) : ''}
              </div>
            ))}
          </div>

          {/* Note grid */}
          <div
            className="pr-grid"
            ref={gridRef}
            style={{
              width: gridW,
              height: gridH,
              backgroundSize: `${PX_PER_BEAT / 4}px ${ROW_H}px, ${PX_PER_BEAT}px ${ROW_H}px, ${PX_PER_BEAT * 4}px ${ROW_H}px`
            }}
            onDoubleClick={handleGridMouseDown}
          >
            {rows.map(p => isBlackKey(p) && (
              <div key={p} className="pr-row-shade" style={{ top: pitchToY(p), height: ROW_H }} />
            ))}
            {notes.map((note: any) => (
              <div
                key={note.id}
                className={`pr-note ${selectedNoteId === note.id ? 'selected' : ''}`}
                style={{
                  left: timeToX(note.start),
                  top: pitchToY(note.pitch) + 1,
                  width: Math.max(6, timeToX(note.duration) - 1),
                  height: ROW_H - 2,
                  backgroundColor: trackColor,
                  opacity: 0.5 + 0.5 * (note.velocity ?? 1)
                }}
                onMouseDown={(e) => handleNoteMouseDown(e, note)}
                onDoubleClick={(e) => handleNoteDoubleClick(e, note)}
              />
            ))}
          </div>
        </div>

        {/* Velocity lane */}
        <div className="pr-vel-wrap" style={{ width: gridW + 44 }}>
          <div className="pr-vel-label">VEL</div>
          <div className="pr-vel-lane" style={{ width: gridW, height: VEL_LANE_H }}>
            {notes.map((note: any) => (
              <div
                key={note.id}
                className={`pr-vel-bar ${selectedNoteId === note.id ? 'selected' : ''}`}
                style={{
                  left: timeToX(note.start),
                  height: `${(note.velocity ?? 1) * 100}%`,
                  backgroundColor: trackColor
                }}
                onMouseDown={(e) => handleVelocityMouseDown(e, note)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
