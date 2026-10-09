import {
  formatParam, valueToSlider, sliderToValue, SLIDER_STEPS, type ParamSpec, type ParamValue
} from '../audio/devices';

// One parameter control driven by its spec: slider (lin/log), toggle, or select.
export default function ParamControl({ spec, value, onChange, label, disabled }: {
  spec: ParamSpec; value: ParamValue; onChange: (v: ParamValue) => void; label?: string; disabled?: boolean;
}) {
  const name = label ?? spec.name;
  if (spec.kind === 'bool') {
    return (
      <div className="param-slider-row">
        <span className="param-name">{name}</span>
        <button className={`btn-view param-toggle ${value ? 'active' : ''}`} disabled={disabled} onClick={() => onChange(!value)}>
          {value ? 'ON' : 'OFF'}
        </button>
      </div>
    );
  }
  if (spec.kind === 'enum') {
    return (
      <div className="param-slider-row">
        <span className="param-name">{name}</span>
        <select className="rack-map-select" value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {(spec.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  const v = typeof value === 'number' ? value : Number(value) || 0;
  return (
    <div className="param-slider-row">
      <span className="param-name">{name}</span>
      <input
        type="range" min="0" max={SLIDER_STEPS} step="1"
        value={valueToSlider(spec, v)}
        disabled={disabled}
        onChange={(e) => onChange(sliderToValue(spec, parseFloat(e.target.value)))}
        onDoubleClick={() => onChange(spec.default)}
        className="param-slider"
        title="Double-click to reset"
      />
      <span className="param-value">{formatParam(spec, v)}{spec.unit && !(spec.minLabel && v <= (spec.min ?? 0)) ? ` ${spec.unit}` : ''}</span>
    </div>
  );
}

