import { useState } from 'react';
import { Plus, Snowflake } from 'lucide-react';
import { useDAWStore, createDefaultInstrument } from '../store/useDAWStore';
import { DEVICE_DEFS, createDevice } from '../audio/devices';
import { MIDI_EFFECT_DEFS, createMidiEffect } from '../audio/midiEffects';
import InstrumentCard from './InstrumentCard';
import RackDevice from './RackDevice';
import DeviceCard from './DeviceCard';
import { readableOn } from './contrast';

// Add Device choices: the stock devices (plug-ins come from the Browser)
const BROWSER_PLUGINS = Object.keys(DEVICE_DEFS).map(createDevice);

// The Device Chain tab for the selected track: adding devices and racks,
// its MIDI effects, instrument and devices
export default function DeviceChain({ track: selectedTrack, onAudition, onEditSound }: { track: any; onAudition: (pitch: number) => void; onEditSound: () => void }) {
  const {
    addDeviceToTrack, removeDeviceFromTrack, updateDeviceParameter, setTrackInstrument,
    savedRacks, addRackToTrack, groupTrackDevicesIntoRack, addSavedRackToTrack,
    addMidiEffect, removeMidiEffect, updateMidiEffectParameter
  } = useDAWStore();
  const [newDeviceIdx, setNewDeviceIdx] = useState('audio:0');

  return (
    <>
    {selectedTrack.isFrozen && (
      <div className="frozen-banner" title="Unfreeze the track to edit devices">
        <Snowflake size={12} /> Frozen
      </div>
    )}
    <div style={{ marginRight: '1rem', borderRight: '1px solid var(--border-color)', paddingRight: '1rem', display: 'flex', flexDirection: 'column', gap: '5px' }}>
      <h5 style={{ color: readableOn(selectedTrack.color, '#202020') }}>{selectedTrack.name} Device Chain</h5>
      <div style={{ display: 'flex', gap: '3px' }}>
        <select aria-label="Device to add" className="rack-map-select" value={newDeviceIdx} onChange={(e) => setNewDeviceIdx(e.target.value)} title="Device to add">
          <optgroup label="Audio Effects">
            {BROWSER_PLUGINS.map((p: any, i: number) => <option key={p.name} value={`audio:${i}`}>{p.name}</option>)}
          </optgroup>
          {selectedTrack.type === 'midi' && (
            <optgroup label="MIDI Effects">
              {Object.values(MIDI_EFFECT_DEFS).map((d) => <option key={d.kind} value={`midi:${d.kind}`}>{d.name}</option>)}
            </optgroup>
          )}
        </select>
        <button className="btn-add-track" onClick={() => {
          const [group, key] = newDeviceIdx.split(':');
          if (group === 'midi') addMidiEffect(selectedTrack.id, createMidiEffect(key));
          else addDeviceToTrack(selectedTrack.id, BROWSER_PLUGINS[parseInt(key)] || BROWSER_PLUGINS[0]);
        }}>
          <Plus size={12} /> Add
        </button>
      </div>
      <button className="btn-add-track" style={{ backgroundColor: '#a855f7' }} onClick={() => addRackToTrack(selectedTrack.id)}>
        <Plus size={12} /> Add Rack
      </button>
      {selectedTrack.plugins.some((p: any) => p.type !== 'rack') && (
        <button className="btn-add-track" style={{ backgroundColor: '#6366f1' }}
          title="Wrap this track's devices into an Audio Effect Rack"
          onClick={() => groupTrackDevicesIntoRack(selectedTrack.id)}>
          Group into Rack
        </button>
      )}
      {savedRacks.length > 0 && (
        <select aria-label="Insert a saved rack preset"
          className="rack-map-select"
          title="Insert a saved rack preset"
          value=""
          onChange={(e) => {
            if (e.target.value !== '') addSavedRackToTrack(selectedTrack.id, parseInt(e.target.value));
          }}
        >
          <option value="">Saved racks…</option>
          {savedRacks.map((r: any, i: number) => <option key={i} value={i}>{r.name}</option>)}
        </select>
      )}
    </div>
    
    {/* MIDI effects run before the instrument */}
    {selectedTrack.type === 'midi' && (selectedTrack.midiEffects || []).map((fx: any) => (
      <DeviceCard
        key={fx.id}
        device={fx}
        onChange={(name, val) => updateMidiEffectParameter(selectedTrack.id, fx.id, name, val)}
        onRemove={() => removeMidiEffect(selectedTrack.id, fx.id)}
      />
    ))}

    {/* Instrument Card (MIDI tracks) */}
    {selectedTrack.type === 'midi' && (
      selectedTrack.instrument ? (
        <InstrumentCard track={selectedTrack} onAudition={onAudition} onEditSound={onEditSound} />
      ) : (
        <button className="btn-add-track" style={{ backgroundColor: '#10b981', alignSelf: 'flex-start' }}
          onClick={() => setTrackInstrument(selectedTrack.id, createDefaultInstrument())}>
          <Plus size={12} /> Add Instrument
        </button>
      )
    )}

    {/* Plugin Cards */}
    <div className="device-cards">
      {selectedTrack.plugins.map((plugin: any) => (
        plugin.type === 'rack' ? (
          <RackDevice
            key={plugin.id}
            trackId={selectedTrack.id}
            rack={plugin}
            browserPlugins={BROWSER_PLUGINS}
            onRemove={() => removeDeviceFromTrack(selectedTrack.id, plugin.id)}
          />
        ) : (
          <DeviceCard
            key={plugin.id}
            device={plugin}
            onChange={(paramName, val) => updateDeviceParameter(selectedTrack.id, plugin.id, paramName, val)}
            onRemove={() => removeDeviceFromTrack(selectedTrack.id, plugin.id)}
          />
        )
      ))}
    </div>
    </>
  );
}
