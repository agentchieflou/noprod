import { type ReactNode } from 'react';
import type { Envelope, Filter, FilterType } from '@noprod/sound';
import { clean } from './designerUtils';

// The Sound Designer's controls, shared with the DSP Map's inspector

const show = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

// A slider for an optional number: double-click resets it to its default
export function Param({ label, value, def, min, max, log, unit = '', onChange }: {
  label: string; value: number | undefined; def: number; min: number; max: number; log?: boolean; unit?: string;
  onChange: (value: number | undefined) => void;
}) {
  const v = value ?? def;
  const toPos = (x: number) => (log ? Math.log(Math.max(x, min) / min) / Math.log(max / min) : (x - min) / (max - min));
  const fromPos = (p: number) => (log ? min * Math.pow(max / min, p) : min + p * (max - min));
  const text = value === undefined && def === 0 && log ? 'off'
    : unit === 's' && v > 0 && v < 1 ? `${show(v * 1000)}ms` : `${show(v)}${unit}`;
  return (
    <div className="param-slider-row" title={`${label} (double-click to reset)`} onDoubleClick={() => onChange(undefined)}>
      <span className="param-name">{label}</span>
      <input
        type="range" className="param-slider" min={0} max={1000}
        value={Math.round(Math.min(1, Math.max(0, toPos(v))) * 1000)}
        onChange={(e) => onChange(clean(fromPos(Number(e.target.value) / 1000)))}
      />
      <span className="param-value">{text}</span>
    </div>
  );
}

export function Choice<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: [T, string][]; onChange: (value: T) => void;
}) {
  return (
    <div className="param-slider-row">
      <span className="param-name">{label}</span>
      <select className="rack-map-select designer-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, name]) => <option key={v} value={v}>{name}</option>)}
      </select>
    </div>
  );
}

export const Section = ({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) => (
  <details className="designer-section" open={open}>
    <summary>{title}</summary>
    {children}
  </details>
);

// An optional part of a layer (pitch envelope, vibrato…): add it, or edit and remove it
export function Optional<T>({ value, make, onChange, children }: {
  value: T | undefined; make: () => T; onChange: (value: T | undefined) => void; children: (value: T) => ReactNode;
}) {
  if (value === undefined) return <button className="designer-link" onClick={() => onChange(make())}>+ Add</button>;
  return <>{children(value)}<button className="designer-link" onClick={() => onChange(undefined)}>Remove</button></>;
}

export function EnvelopeParams({ env, onChange, release = true }: { env: Envelope | undefined; onChange: (env: Envelope) => void; release?: boolean }) {
  const e = env ?? {};
  const set = (key: keyof Envelope) => (v: number | undefined) => onChange({ ...e, [key]: v });
  return (
    <>
      <Param label="Attack" value={e.attack} def={0.002} min={0.0005} max={8} log unit="s" onChange={set('attack')} />
      <Param label="Hold" value={e.hold} def={0} min={0} max={4} unit="s" onChange={set('hold')} />
      <Param label="Decay" value={e.decay} def={0} min={0.005} max={20} log unit="s" onChange={set('decay')} />
      <Param label="Sustain" value={e.sustain} def={1} min={0} max={1} onChange={set('sustain')} />
      {release && <Param label="Release" value={e.release} def={0.05} min={0.005} max={10} log unit="s" onChange={set('release')} />}
    </>
  );
}


export function FilterParams({ filter, onChange, onRemove }: { filter: Filter; onChange: (f: Filter) => void; onRemove: () => void }) {
  const set = (key: keyof Filter) => (v: unknown) => onChange({ ...filter, [key]: v });
  const env = filter.env;
  return (
    <div className="designer-filter">
      <Choice<FilterType> label="Type" value={filter.type} onChange={set('type')}
        options={[['lowpass', 'Lowpass'], ['highpass', 'Highpass'], ['bandpass', 'Bandpass'], ['notch', 'Notch']]} />
      <Param label="Cutoff" value={filter.cutoff} def={1000} min={20} max={20000} log unit="Hz" onChange={(v) => set('cutoff')(v ?? 1000)} />
      <Param label="Q" value={filter.q} def={0.707} min={0.3} max={20} log onChange={set('q')} />
      <Choice label="Slope" value={String(filter.slope ?? 12)} options={[['12', '12 dB/oct'], ['24', '24 dB/oct']]}
        onChange={(v) => set('slope')(v === '24' ? 24 : undefined)} />
      <Param label="Key track" value={filter.keyTrack} def={0} min={0} max={1} onChange={set('keyTrack')} />
      <Param label="Velocity" value={filter.velocity} def={0} min={0} max={4} unit="oct" onChange={set('velocity')} />
      <div className="designer-sub">Envelope</div>
      <Optional value={env} make={() => ({ amount: 2, attack: 0.002, decay: 0.3, sustain: 0 })} onChange={set('env')}>
        {(en) => (
          <>
            <Param label="Amount" value={en.amount} def={0} min={-6} max={6} unit="oct" onChange={(v) => set('env')({ ...en, amount: v ?? 0 })} />
            <EnvelopeParams env={en} onChange={(next) => set('env')({ ...next, amount: en.amount })} />
          </>
        )}
      </Optional>
      <button className="designer-link" onClick={onRemove}>Remove filter</button>
    </div>
  );
}

