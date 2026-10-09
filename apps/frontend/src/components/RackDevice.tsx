import { useState } from 'react';
import { Trash2, Save, Plus } from 'lucide-react';
import { useDAWStore } from '../store/useDAWStore';
import { getDeviceDef } from '../audio/devices';
import DeviceCard from './DeviceCard';

// Macros can only sweep continuous parameters (not toggles or choice lists)
const mappableParams = (device: any): string[] => {
  const def = getDeviceDef(device);
  if (!def) return Object.keys(device.parameters || {});
  return def.params.filter(p => !p.kind || p.kind === 'number').map(p => p.name);
};

interface RackDeviceProps {
  trackId: string;
  rack: any;
  browserPlugins: any[];
  onRemove: () => void;
}

export default function RackDevice({ trackId, rack, browserPlugins, onRemove }: RackDeviceProps) {
  const {
    addDeviceToRack, removeDeviceFromRack, updateRackDeviceParameter,
    updateMacroValue, addMacroMapping, removeMacroMapping, saveRackPreset
  } = useDAWStore();

  const [newDeviceIdx, setNewDeviceIdx] = useState(0);
  // "deviceId::paramName" pending selection per macro id
  const [pendingMap, setPendingMap] = useState<{ [macroId: string]: string }>({});

  const deviceName = (id: string) => rack.devices.find((d: any) => d.id === id)?.name || '?';

  return (
    <div className="device-card rack-card">
      <div className="device-card-header">
        <span>{rack.name}</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button className="btn-icon" title="Save rack as preset (reusable on any track)" onClick={() => saveRackPreset(rack)}>
            <Save size={12} />
          </button>
          <button className="btn-icon" title="Delete rack" onClick={onRemove}><Trash2 size={12} /></button>
        </div>
      </div>

      <div className="rack-body">
        {/* Macro panel */}
        <div className="rack-macros">
          {rack.macros.map((macro: any) => (
            <div key={macro.id} className="rack-macro">
              <div className="rack-macro-head">
                <span>{macro.name}</span>
                <span style={{ fontFamily: 'monospace' }}>{Math.round(macro.value)}</span>
              </div>
              <input
                type="range" min="0" max="100" step="1"
                value={macro.value}
                onChange={(e) => updateMacroValue(trackId, rack.id, macro.id, parseFloat(e.target.value))}
                className="param-slider"
              />
              <div className="rack-macro-mappings">
                {macro.mappings.map((mp: any, i: number) => (
                  <span key={`${mp.deviceId}-${mp.paramName}`} className="rack-mapping-chip" title={`${deviceName(mp.deviceId)} — ${mp.paramName}`}>
                    {mp.paramName}
                    <button className="btn-icon" style={{ fontSize: '9px', lineHeight: 1 }} onClick={() => removeMacroMapping(trackId, rack.id, macro.id, i)}>×</button>
                  </span>
                ))}
              </div>
              {rack.devices.length > 0 && (
                <div style={{ display: 'flex', gap: '3px' }}>
                  <select
                    className="rack-map-select"
                    value={pendingMap[macro.id] || ''}
                    onChange={(e) => setPendingMap({ ...pendingMap, [macro.id]: e.target.value })}
                  >
                    <option value="">Map to…</option>
                    {rack.devices.flatMap((d: any) =>
                      mappableParams(d).map(paramName => (
                        <option key={`${d.id}::${paramName}`} value={`${d.id}::${paramName}`}>
                          {d.name}: {paramName}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    className="btn-icon"
                    title="Add mapping"
                    onClick={() => {
                      const sel = pendingMap[macro.id];
                      if (!sel) return;
                      const [deviceId, paramName] = sel.split('::');
                      // Map across the parameter's real range (e.g. 20Hz..20kHz), not a fixed 0..100
                      const spec = getDeviceDef(rack.devices.find((d: any) => d.id === deviceId))
                        ?.params.find(p => p.name === paramName);
                      addMacroMapping(trackId, rack.id, macro.id, deviceId, paramName, spec?.min ?? 0, spec?.max ?? 100);
                      setPendingMap({ ...pendingMap, [macro.id]: '' });
                    }}
                  >
                    <Plus size={11} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Chained devices */}
        <div className="rack-devices">
          {rack.devices.map((device: any) => (
            <DeviceCard
              key={device.id}
              device={device}
              className="rack-inner-device"
              onChange={(paramName, val) => updateRackDeviceParameter(trackId, rack.id, device.id, paramName, val)}
              onRemove={() => removeDeviceFromRack(trackId, rack.id, device.id)}
            />
          ))}

          <div className="rack-add-device">
            <select className="rack-map-select" value={newDeviceIdx} onChange={(e) => setNewDeviceIdx(parseInt(e.target.value))}>
              {browserPlugins.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
            </select>
            <button className="btn-icon" title="Add device to rack" onClick={() => addDeviceToRack(trackId, rack.id, browserPlugins[newDeviceIdx])}>
              <Plus size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
