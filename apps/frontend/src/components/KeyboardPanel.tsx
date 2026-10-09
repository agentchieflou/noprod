import { useSyncExternalStore } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { useDAWStore } from '../store/useDAWStore';
import {
  subscribeKeyboard, getKeyboardState, effectiveMode, pitchesForCode, press, release, keyLabel,
  setKeyboardEnabled, setOctave, setVelocity, setKeyboardMode, setScale,
  PIANO_LOWER, PIANO_UPPER, SCALE_LOWER, SCALE_UPPER, DRUM_PADS, SCALES, NOTE_NAMES, usesFlats, spellNote, type KeyboardMode
} from '../audio/computerKeyboard';

const isBlack = (pitch: number) => [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
const noteName = (pitch: number, flats = false) => `${spellNote(pitch, flats)}${Math.floor(pitch / 12) - 1}`;

// Name a stacked triad (scale mode chords): C, Cm, C°, C+
const chordName = (pitches: number[], flats: boolean) => {
  if (pitches.length < 3) return noteName(pitches[0], flats);
  const [, third, fifth] = pitches.map((p) => p - pitches[0]);
  const quality = third === 3 && fifth === 7 ? 'm' : third === 3 && fifth === 6 ? '°' : third === 4 && fifth === 8 ? '+' : '';
  return `${spellNote(pitches[0], flats)}${quality}`;
};

// Pointer-played keys/pads use their own ids so mouse and keyboard don't clash
const pointerHandlers = (id: string, pitches: number[] | null) => ({
  onPointerDown: (e: React.PointerEvent) => { if (!pitches) return; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); press(id, pitches); },
  onPointerUp: () => release(id),
  onPointerCancel: () => release(id),
  onLostPointerCapture: () => release(id)
});

function PianoKeys({ base, sounding }: { base: number; sounding: number[] }) {
  // 32 semitones: the Z row covers 0-16, the Q row 12-31
  const labelsFor = (offset: number) => [
    ...PIANO_LOWER.filter(([, o]) => o === offset).map(([c]) => keyLabel(c)),
    ...PIANO_UPPER.filter(([, o]) => o === offset).map(([c]) => keyLabel(c))
  ];
  const offsets = Array.from({ length: 32 }, (_, i) => i);
  const whites = offsets.filter((o) => !isBlack(base + o));
  const whiteW = 100 / whites.length;
  return (
    <div className="kb-piano">
      {whites.map((o, i) => {
        const pitch = base + o;
        return (
          <div key={o} className={`kb-white ${sounding.includes(pitch) ? 'lit' : ''}`} style={{ left: `${i * whiteW}%`, width: `${whiteW}%` }}
            {...pointerHandlers(`pointer:${pitch}`, [pitch])} title={noteName(pitch)}>
            <span className="kb-key-label">{labelsFor(o).join(' ')}</span>
            {pitch % 12 === 0 && <span className="kb-note-label">{noteName(pitch)}</span>}
          </div>
        );
      })}
      {offsets.filter((o) => isBlack(base + o)).map((o) => {
        const pitch = base + o;
        const whitesBefore = whites.filter((w) => w < o).length;
        return (
          <div key={o} className={`kb-black ${sounding.includes(pitch) ? 'lit' : ''}`}
            style={{ left: `${whitesBefore * whiteW - whiteW * 0.3}%`, width: `${whiteW * 0.6}%` }}
            {...pointerHandlers(`pointer:${pitch}`, [pitch])} title={noteName(pitch)}>
            <span className="kb-key-label">{labelsFor(o).join(' ')}</span>
          </div>
        );
      })}
    </div>
  );
}

function PadRow({ codes, mode, sounding, extraLabel, flats = false }: {
  codes: string[]; mode: 'scale' | 'drums'; sounding: number[]; extraLabel?: (i: number) => string; flats?: boolean;
}) {
  return (
    <div className="kb-pad-row">
      {codes.map((code, i) => {
        const pitches = pitchesForCode(code, mode);
        if (!pitches) return null;
        const lit = pitches.every((p) => sounding.includes(p));
        const name = mode === 'drums' ? (extraLabel?.(i) ?? '') : pitches.length > 1 ? chordName(pitches, flats) : noteName(pitches[0], flats);
        return (
          <div key={code} className={`kb-pad ${lit ? 'lit' : ''} ${mode}`} {...pointerHandlers(`pointer:${code}`, pitches)}>
            <span className="kb-pad-name">{name}</span>
            <span className="kb-key-label">{keyLabel(code)}</span>
          </div>
        );
      })}
    </div>
  );
}

// On-screen computer keyboard: shows what every key plays, lights up as you
// play (keys or mouse), and holds the mode, scale, octave and velocity.
export default function KeyboardPanel() {
  const kb = useSyncExternalStore(subscribeKeyboard, getKeyboardState);
  const st = useDAWStore();
  const mode = effectiveMode(st);
  const base = (kb.octave + 1) * 12;

  const modes: [KeyboardMode, string][] = [['auto', 'Auto'], ['piano', 'Piano'], ['scale', 'Scale'], ['drums', 'Drums']];

  return (
    <div className="kb-panel">
      <div className="kb-controls">
        <div className="kb-title">
          Computer keyboard →{' '}
          {kb.targetName ? <b>{kb.targetName}</b> : <span className="kb-warn">select or arm a MIDI track</span>}
          <button className="btn-icon kb-close" title="Turn the computer keyboard off" onClick={() => setKeyboardEnabled(false)}><X size={13} /></button>
        </div>
        <div className="kb-row">
          <div className="kb-segment" title="Auto = Drums on a drum kit, Piano otherwise">
            {modes.map(([m, label]) => (
              <button key={m} className={kb.mode === m ? 'active' : ''} onClick={() => setKeyboardMode(m)}>
                {label}{m === 'auto' && kb.mode === 'auto' ? ` (${mode === 'drums' ? 'Drums' : 'Piano'})` : ''}
              </button>
            ))}
          </div>
        </div>
        {mode === 'scale' && (
          <div className="kb-row">
            <select className="rack-map-select" value={kb.root} onChange={(e) => setScale({ root: parseInt(e.target.value) })} title="Key">
              {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n === spellNote(i, true) ? n : `${n} / ${spellNote(i, true)}`}</option>)}
            </select>
            <select className="rack-map-select" value={kb.scale} onChange={(e) => setScale({ scale: e.target.value })} title="Scale">
              {Object.keys(SCALES).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="kb-check" title="Each key plays a chord built from the scale">
              <input type="checkbox" checked={kb.chords} onChange={(e) => setScale({ chords: e.target.checked })} /> Chords
            </label>
          </div>
        )}
        {mode !== 'drums' && (
          <div className="kb-row">
            <span className="kb-label">Octave</span>
            <button className="btn-icon" title="Octave down (←)" onClick={() => setOctave(kb.octave - 1)}><ChevronLeft size={13} /></button>
            <span className="kb-value">C{kb.octave}</span>
            <button className="btn-icon" title="Octave up (→)" onClick={() => setOctave(kb.octave + 1)}><ChevronRight size={13} /></button>
          </div>
        )}
        <div className="kb-row">
          <span className="kb-label">Velocity</span>
          <input type="range" min="0.05" max="1" step="0.05" value={kb.velocity} className="param-slider kb-velocity"
            onChange={(e) => setVelocity(parseFloat(e.target.value))} title="Velocity (↑/↓); hold Shift for accents" />
          <span className="kb-value">{Math.round(kb.velocity * 127)}</span>
        </div>
        <div className="kb-help">Shift = accent · ←/→ octave · ↑/↓ velocity · Esc = stop all</div>
      </div>

      <div className="kb-keys">
        {mode === 'piano' && <PianoKeys base={base} sounding={kb.sounding} />}
        {mode === 'scale' && (
          <div className="kb-pads">
            <PadRow codes={SCALE_UPPER} mode="scale" sounding={kb.sounding} flats={usesFlats(kb.root, kb.scale)} />
            <PadRow codes={SCALE_LOWER} mode="scale" sounding={kb.sounding} flats={usesFlats(kb.root, kb.scale)} />
          </div>
        )}
        {mode === 'drums' && (
          <div className="kb-pads">
            <PadRow codes={SCALE_LOWER.slice(0, DRUM_PADS.length)} mode="drums" sounding={kb.sounding} extraLabel={(i) => DRUM_PADS[i].name} />
            <div className="kb-help" style={{ textAlign: 'center' }}>The Q row plays the same pads ({SCALE_UPPER.slice(0, DRUM_PADS.length).map(keyLabel).join(' ')})</div>
          </div>
        )}
      </div>
    </div>
  );
}
