import { useDAWStore, createDefaultInstrument, createDrumKit } from '../store/useDAWStore';
import { midiNoteName, DRUM_NAMES } from '../audio/synth';
import { libraryOf } from '../audio/library';
import { CATEGORY_NAMES, GM_DRUM_NAMES } from '@noprod/sound';

const INSTRUMENTS = [
  { label: 'NoProd Synth', create: createDefaultInstrument },
  { label: 'NoProd Drums', create: createDrumKit }
];

// A MIDI track's instrument: swap between the synth and the drum kit, edit
// its parameters, and audition notes (keyboard for the synth, pads for drums).
// Library sounds and kits (from the Browser) show here too.
export default function InstrumentCard({ track, onAudition, onEditSound }: { track: any; onAudition: (pitch: number) => void; onEditSound?: () => void }) {
  const { updateInstrumentParameter, setTrackInstrument } = useDAWStore();
  const inst = track.instrument;
  const p = inst.parameters;
  const library = libraryOf(p);
  const isDrums = p.Kit === 'drums' || !!library?.kit;

  // Pads to audition: the classic kit's, or the library kit's first 16 notes,
  // named by sound (or by their General MIDI role where a sound repeats)
  const pads: [number, string][] = library?.kit
    ? (() => {
      const notes = Object.keys(library.kit.pads).map(Number).sort((a, b) => a - b).slice(0, 16);
      const sound = (note: number) => library.sounds?.[library.kit!.pads[note].sound]?.name || GM_DRUM_NAMES[note] || `${note}`;
      return notes.map((note): [number, string] => [note,
        notes.filter((n) => sound(n) === sound(note)).length > 1 ? GM_DRUM_NAMES[note] || sound(note) : sound(note)]);
    })()
    : Object.entries(DRUM_NAMES).map(([note, name]) => [Number(note), name]);

  const slider = (name: string, min: number, max: number, step: number, fmt = (v: number) => v.toFixed(2)) => (
    <div key={name} className="param-slider-row">
      <span className="param-name">{name}</span>
      <input
        type="range" min={min} max={max} step={step}
        value={p[name]}
        onChange={(e) => updateInstrumentParameter(track.id, name, parseFloat(e.target.value))}
        className="param-slider"
      />
      <span className="param-value">{fmt(Number(p[name]))}</span>
    </div>
  );

  return (
    <div className="device-card instrument-card">
      <div className="device-card-header">
        <select
          className="rack-map-select instrument-select"
          value={inst.name}
          onChange={(e) => {
            const choice = INSTRUMENTS.find((i) => i.label === e.target.value);
            if (choice) setTrackInstrument(track.id, choice.create());
          }}
          title="Instrument"
        >
          {library && <option value={inst.name}>{inst.name}</option>}
          {INSTRUMENTS.map((i) => <option key={i.label} value={i.label}>{i.label}</option>)}
        </select>
        <span style={{ fontSize: '9px', color: 'var(--accent-green)' }}>
          {library ? `LIBRARY · ${library.kit ? 'KIT' : CATEGORY_NAMES[library.sound!.category].toUpperCase()}` : 'INSTRUMENT'}
        </span>
      </div>
      <div className="device-card-params">
        {library ? (
          <>
            {slider('Tune', -24, 24, 1, (v) => `${v > 0 ? '+' : ''}${v} st`)}
            {slider('Gain', 0, 1, 0.01)}
            {onEditSound && <button className="designer-link" onClick={onEditSound}>Edit in Sound Designer</button>}
          </>
        ) : isDrums ? (
          <>
            {slider('Tune', -12, 12, 0.1, (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st`)}
            {slider('Decay', 0.2, 2.5, 0.01, (v) => `×${v.toFixed(2)}`)}
            {slider('Gain', 0, 1, 0.01)}
          </>
        ) : (
          <>
            <div className="param-slider-row">
              <span className="param-name">Waveform</span>
              <select className="rack-map-select" value={p.Waveform}
                onChange={(e) => updateInstrumentParameter(track.id, 'Waveform', e.target.value)}>
                <option value="sawtooth">Sawtooth</option>
                <option value="square">Square</option>
                <option value="sine">Sine</option>
                <option value="triangle">Triangle</option>
              </select>
            </div>
            {['Attack', 'Decay', 'Sustain', 'Release', 'Gain'].map((n) => slider(n, 0, 1, 0.01))}
          </>
        )}
      </div>
      {isDrums ? (
        <div className="drum-pads">
          {pads.map(([note, name]) => (
            <button key={note} className="drum-pad" onMouseDown={() => onAudition(note)} title={`${name} (MIDI ${note})`}>
              {name}
            </button>
          ))}
        </div>
      ) : (
        // Audition keyboard: one octave from C4
        <div className="audition-keys">
          {[60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71].map((pitch) => (
            <button
              key={pitch}
              className={`audition-key ${midiNoteName(pitch).includes('#') ? 'black-key' : ''}`}
              onMouseDown={() => onAudition(pitch)}
              title={midiNoteName(pitch)}
            >
              {midiNoteName(pitch).includes('#') ? '' : midiNoteName(pitch)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
