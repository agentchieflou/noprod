import { useEffect, useState } from 'react';
import { useDAWStore } from '../store/useDAWStore';
import { resolveTarget, type MidiMapping } from '../audio/midiTargets';
import { resetPickup } from '../audio/midiLearn';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const sourceText = (m: MidiMapping) => {
  const s = m.source;
  const what = s.type === 'cc' ? `CC ${s.number}` : `Note ${NOTE_NAMES[s.number % 12]}${Math.floor(s.number / 12) - 1}`;
  return `${what} · ch ${s.channel} · ${s.input}`;
};

// The toolbar's MIDI Learn toggle and the list of every mapping
export default function MidiLearnControls() {
  const { midiLearn, setMidiLearn, midiMappings, updateMidiMapping, removeMidiMapping } = useDAWStore();
  const [listOpen, setListOpen] = useState(false);

  // Esc leaves learn mode
  useEffect(() => {
    if (!midiLearn.active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMidiLearn({ active: false, pending: null }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [midiLearn.active, setMidiLearn]);

  const edit = (m: MidiMapping, patch: Partial<MidiMapping>) => { resetPickup(m.id); updateMidiMapping(m.id, patch); };
  const state = useDAWStore.getState();

  return (
    <>
      <button
        className={`btn-metronome midi-learn-btn ${midiLearn.active ? 'active' : ''}`}
        onClick={() => setMidiLearn({ active: !midiLearn.active, pending: null })}
        title="MIDI Learn: click a control, then move a knob on your controller (Esc to leave)"
      >
        MIDI LEARN
      </button>
      <button className="btn-metronome midi-map-btn" onClick={() => setListOpen(!listOpen)} title="Every MIDI mapping">
        Mappings ({midiMappings.length})
      </button>
      {midiLearn.dropped > 0 && (
        <button className="row-main midi-dropped" title="Click to dismiss" onClick={() => setMidiLearn({ dropped: 0 })}>
          {midiLearn.dropped} MIDI mapping{midiLearn.dropped > 1 ? 's' : ''} dropped: missing track or device
        </button>
      )}
      {listOpen && (
        <div className="midi-map-dialog" role="dialog" aria-label="MIDI mappings">
          <div className="midi-map-head">
            <b>MIDI mappings</b>
            <button className="btn-icon" onClick={() => setListOpen(false)} title="Close">×</button>
          </div>
          {midiMappings.length === 0 && <div className="midi-map-empty">None yet. Turn on MIDI Learn, click a control, move a knob.</div>}
          {midiMappings.map((m: MidiMapping) => (
            <div key={m.id} className="midi-map-row">
              <span className="midi-map-target">{resolveTarget(state, m.target)?.label ?? 'Missing control'}</span>
              <span className="midi-map-source">{sourceText(m)}</span>
              <label>Min <input aria-label="Minimum" type="number" min={0} max={100} step={1} value={Math.round(m.min * 100)}
                onChange={(e) => edit(m, { min: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })} /></label>
              <label>Max <input aria-label="Maximum" type="number" min={0} max={100} step={1} value={Math.round(m.max * 100)}
                onChange={(e) => edit(m, { max: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })} /></label>
              <select aria-label="Takeover mode" className="rack-map-select" value={m.mode} onChange={(e) => edit(m, { mode: e.target.value as MidiMapping['mode'] })} title="Takeover: pickup waits for the controller to reach the control's value">
                <option value="jump">Jump</option>
                <option value="pickup">Pickup</option>
              </select>
              <label><input type="checkbox" checked={m.invert} onChange={(e) => edit(m, { invert: e.target.checked })} /> Invert</label>
              <button className="btn-icon" title="Remove mapping" onClick={() => removeMidiMapping(m.id)}>🗑</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
