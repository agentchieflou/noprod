import { useSyncExternalStore, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { DeviceExtra } from './DeviceVisuals';
import ParamControl from './ParamControl';
import { getParamSpecs, resolvedParameters, type ParamValue } from '../audio/devices';
import { audioContext } from '../audio/engine';
import { getNativeDeviceState, isNativeDevice, subscribeNativeDevices, type NativeDeviceState } from '../native/trackBridge';

interface DeviceCardProps {
  device: any;
  onChange: (paramName: string, value: ParamValue) => void;
  onRemove: () => void;
  className?: string;
  extra?: ReactNode; // device-specific visuals (meters, curves) above the params
}

export default function DeviceCard({ device, onChange, onRemove, className = '', extra }: DeviceCardProps) {
  const specs = getParamSpecs(device);
  const params = resolvedParameters(device);
  const native = useSyncExternalStore(subscribeNativeDevices, () => getNativeDeviceState(device.id));

  if (isNativeDevice(device)) {
    return (
      <div className={`device-card device-native ${className}`}>
        <div className="device-card-header">
          <span title={device.pluginPath}>{device.name}</span>
          <button className="btn-icon" title="Remove device" onClick={onRemove}><Trash2 size={12} /></button>
        </div>
        <NativeStatus device={device} state={native} />
        <div className="device-card-params">
          {native?.insert?.parameters.map((p) => {
            const value = typeof params[p.id] === 'number' ? (params[p.id] as number) : p.value;
            return (
              <div key={p.index} className="param-slider-row" title={p.id || p.name}>
                <span className="param-name">{p.name}</span>
                {p.boolean ? (
                  <input type="checkbox" checked={value >= (p.min + p.max) / 2} disabled={p.readOnly}
                    onChange={(e) => onChange(p.id, e.target.checked ? p.max : p.min)} />
                ) : (
                  <input type="range" className="param-slider" min={p.min} max={p.max} disabled={p.readOnly || !p.id}
                    step={p.stepped && p.max - p.min >= 1 ? 1 : (p.max - p.min) / 1000} value={value}
                    onChange={(e) => onChange(p.id, parseFloat(e.target.value))} />
                )}
                <span className="param-value">{p.text}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={`device-card device-${device.kind || 'generic'} ${device.type === 'midi-fx' ? 'midi-fx-card' : ''} ${className}`}>
      <div className="device-card-header">
        <span>{device.name}</span>
        <button className="btn-icon" title="Remove device" onClick={onRemove}><Trash2 size={12} /></button>
      </div>
      {extra ?? <DeviceExtra device={device} onChange={onChange} />}
      <div className="device-card-params">
        {specs
          ? specs.filter((spec) => !spec.hidden).map((spec) => (
            <ParamControl key={spec.name} spec={spec} value={params[spec.name]} onChange={(v) => onChange(spec.name, v)} />
          ))
          : Object.keys(params).map((paramName) => (
            // Unhosted third-party plugin: generic normalized controls
            <div key={paramName} className="param-slider-row">
              <span className="param-name">{paramName}</span>
              <input
                type="range" min="0" max="100"
                value={Number(params[paramName]) || 0}
                onChange={(e) => onChange(paramName, parseFloat(e.target.value))}
                className="param-slider"
              />
              <span className="param-value">{params[paramName]}</span>
            </div>
          ))}
      </div>
      {!specs && device.type === 'vst' && (
        <div className="device-note" title="Add the plug-in from the Browser's Plug-ins list (after scanning its folder in the Audio Core) to host it">
          not linked to a plug-in file — audio passes through
        </div>
      )}
    </div>
  );
}

// Where a hosted plug-in stands: connected and loaded, offline, or failed
function NativeStatus({ device, state }: { device: any; state: NativeDeviceState | null }) {
  const ms = state ? Math.round((state.latencyFrames / audioContext.sampleRate) * 1000) : 0;
  let text: string;
  let tone = '';
  if (state?.error) {
    text = state.error;
    tone = 'error';
  } else if (!state?.connected) {
    text = 'Audio Core offline — audio passes through';
    tone = 'warn';
  } else if (!state.insert) {
    text = 'loading in the Audio Core…';
  } else {
    text = `${state.insert.format} in the Audio Core · ${ms} ms`;
    if (state.stats?.late) {
      text += ` · ${state.stats.late} late block${state.stats.late === 1 ? '' : 's'}`;
      tone = 'warn';
    }
  }
  return <div className={`device-note native-device-status ${tone}`} title={device.pluginPath}>{text}</div>;
}
