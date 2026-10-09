import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { DeviceExtra } from './DeviceVisuals';
import {
  getDeviceDef, resolvedParameters, formatParam, valueToSlider, sliderToValue, SLIDER_STEPS,
  type ParamSpec, type ParamValue
} from '../audio/devices';

interface DeviceCardProps {
  device: any;
  onChange: (paramName: string, value: ParamValue) => void;
  onRemove: () => void;
  className?: string;
  extra?: ReactNode; // device-specific visuals (meters, curves) above the params
}

// One parameter control driven by its spec: slider (lin/log), toggle, or select.
export function ParamControl({ spec, value, onChange }: { spec: ParamSpec; value: ParamValue; onChange: (v: ParamValue) => void }) {
  if (spec.kind === 'bool') {
    return (
      <div className="param-slider-row">
        <span className="param-name">{spec.name}</span>
        <button className={`btn-view param-toggle ${value ? 'active' : ''}`} onClick={() => onChange(!value)}>
          {value ? 'ON' : 'OFF'}
        </button>
      </div>
    );
  }
  if (spec.kind === 'enum') {
    return (
      <div className="param-slider-row">
        <span className="param-name">{spec.name}</span>
        <select className="rack-map-select" value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {(spec.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  const v = typeof value === 'number' ? value : Number(value) || 0;
  return (
    <div className="param-slider-row">
      <span className="param-name">{spec.name}</span>
      <input
        type="range" min="0" max={SLIDER_STEPS} step="1"
        value={valueToSlider(spec, v)}
        onChange={(e) => onChange(sliderToValue(spec, parseFloat(e.target.value)))}
        onDoubleClick={() => onChange(spec.default)}
        className="param-slider"
        title="Double-click to reset"
      />
      <span className="param-value">{formatParam(spec, v)}{spec.unit && !(spec.minLabel && v <= (spec.min ?? 0)) ? ` ${spec.unit}` : ''}</span>
    </div>
  );
}

export default function DeviceCard({ device, onChange, onRemove, className = '', extra }: DeviceCardProps) {
  const def = getDeviceDef(device);
  const params = resolvedParameters(device);

  return (
    <div className={`device-card device-${def?.kind || 'generic'} ${className}`}>
      <div className="device-card-header">
        <span>{device.name}</span>
        <button className="btn-icon" title="Remove device" onClick={onRemove}><Trash2 size={12} /></button>
      </div>
      {extra ?? <DeviceExtra device={device} onChange={onChange} />}
      <div className="device-card-params">
        {def
          ? def.params.filter((spec) => !spec.hidden).map((spec) => (
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
      {!def && device.type === 'vst' && (
        <div className="device-note" title="Native plugin hosting runs in Audio Core (JUCE); the browser engine passes audio through unchanged">
          not hosted in browser — audio passes through
        </div>
      )}
    </div>
  );
}
