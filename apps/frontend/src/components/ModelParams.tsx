import type { Exciter, ModelLayer, Radiator, Resonator } from '@noprod/sound';
import { Param, Choice, Section } from './designerControls';
import { EXCITERS, RESONATORS, RADIATORS, radiatorName } from './designerUtils';

// A physical model's controls (#77): its exciter, resonator and radiators.
// Each block's editor is exported for the DSP Map's inspector.

interface Spec { key: string; label: string; def: number; min: number; max: number; log?: boolean; unit?: string }


const EXCITER_SPECS: Record<Exciter['kind'], Spec[]> = {
  pluck: [
    { key: 'position', label: 'Position', def: 0.2, min: 0.02, max: 0.5 },
    { key: 'hardness', label: 'Hardness', def: 0.6, min: 0, max: 1 }
  ],
  strike: [
    { key: 'position', label: 'Position', def: 0.12, min: 0.02, max: 0.5 },
    { key: 'hardness', label: 'Hardness', def: 0.5, min: 0, max: 1 }
  ],
  bow: [
    { key: 'pressure', label: 'Pressure', def: 0.5, min: 0, max: 1 },
    { key: 'position', label: 'Position', def: 0.13, min: 0.03, max: 0.5 },
    { key: 'noise', label: 'Hair noise', def: 0.1, min: 0, max: 1 }
  ],
  lips: [{ key: 'tension', label: 'Tension', def: 1, min: 0.7, max: 1.4 }],
  jet: [
    { key: 'ratio', label: 'Jet length', def: 0.32, min: 0.1, max: 0.6 },
    { key: 'noise', label: 'Breath', def: 0.15, min: 0, max: 1 }
  ],
  reed: [
    { key: 'stiffness', label: 'Stiffness', def: 0.5, min: 0, max: 1 },
    { key: 'noise', label: 'Breath', def: 0.05, min: 0, max: 1 }
  ]
};

const RESONATOR_SPECS: Record<Resonator['kind'], Spec[]> = {
  string: [
    { key: 'decay', label: 'Rings', def: 3, min: 0.1, max: 20, log: true, unit: 's' },
    { key: 'brightness', label: 'Brightness', def: 0.5, min: 0, max: 1 },
    { key: 'stiffness', label: 'Stiffness', def: 0, min: 0, max: 1 }
  ],
  bore: [{ key: 'loss', label: 'Loss', def: 0.5, min: 0, max: 1 }]
};

const RADIATOR_SPECS: Record<Radiator['kind'], Spec[]> = {
  body: [{ key: 'mix', label: 'Mix', def: 0.7, min: 0, max: 1 }],
  helmholtz: [
    { key: 'hz', label: 'Frequency', def: 110, min: 40, max: 600, log: true, unit: 'Hz' },
    { key: 'q', label: 'Q', def: 6, min: 0.5, max: 30, log: true },
    { key: 'mix', label: 'Mix', def: 0.4, min: 0, max: 1 }
  ],
  bell: [
    { key: 'cutoff', label: 'Cutoff', def: 700, min: 100, max: 8000, log: true, unit: 'Hz' },
    { key: 'mix', label: 'Mix', def: 0.8, min: 0, max: 1 }
  ],
  tonehole: [
    { key: 'cutoff', label: 'Cutoff', def: 0.7, min: 0.25, max: 4, log: true, unit: '×' },
    { key: 'brightness', label: 'Brightness', def: 0.6, min: 0, max: 1 }
  ],
  damping: [{ key: 'a', label: 'a', def: 0.5, min: 0, max: 0.99 }]
};

function Specs<T extends object>({ specs, value, onChange }: { specs: Spec[]; value: T; onChange: (next: T) => void }) {
  const v = value as Record<string, unknown>;
  return (
    <>
      {specs.map((s) => (
        <Param key={s.key} label={s.label} value={v[s.key] as number | undefined} def={s.def} min={s.min} max={s.max}
          log={s.log} unit={s.unit} onChange={(x) => onChange({ ...value, [s.key]: x })} />
      ))}
    </>
  );
}

export function ExciterParams({ exciter, onChange }: { exciter: Exciter; onChange: (e: Exciter) => void }) {
  return (
    <>
      <Choice label="Kind" value={exciter.kind} options={EXCITERS} onChange={(kind) => onChange({ kind } as Exciter)} />
      <Specs specs={EXCITER_SPECS[exciter.kind]} value={exciter} onChange={onChange} />
    </>
  );
}

export function ResonatorParams({ resonator, onChange }: { resonator: Resonator; onChange: (r: Resonator) => void }) {
  return (
    <>
      <Choice label="Kind" value={resonator.kind} options={RESONATORS} onChange={(kind) => onChange({ kind } as Resonator)} />
      {resonator.kind === 'bore' && (
        <Choice label="End" value={resonator.end ?? 'open'} options={[['open', 'Open (flute, clarinet)'], ['stopped', 'Stopped'], ['flared', 'Flared (brass)']]}
          onChange={(end) => onChange({ ...resonator, end })} />
      )}
      <Specs specs={RESONATOR_SPECS[resonator.kind]} value={resonator} onChange={onChange} />
    </>
  );
}

export function RadiatorParams({ radiator, onChange }: { radiator: Radiator; onChange: (r: Radiator) => void }) {
  return (
    <>
      {radiator.kind === 'body' && (
        <Choice label="Body" value={radiator.preset ?? 'box'}
          options={[['violin', 'Violin'], ['cello', 'Cello'], ['guitar', 'Guitar'], ['harp', 'Harp'], ['box', 'Box']]}
          onChange={(preset) => onChange({ ...radiator, preset, modes: undefined })} />
      )}
      <Specs specs={RADIATOR_SPECS[radiator.kind]} value={radiator} onChange={onChange} />
    </>
  );
}

export default function ModelParams({ layer, onChange }: { layer: ModelLayer; onChange: (layer: ModelLayer) => void }) {
  const radiators = layer.radiators ?? [];
  const setRadiators = (next: Radiator[]) => onChange({ ...layer, radiators: next.length ? next : undefined });
  return (
    <>
      <Section title="Exciter" open>
        <ExciterParams exciter={layer.exciter} onChange={(exciter) => onChange({ ...layer, exciter })} />
      </Section>
      <Section title="Resonator" open>
        <ResonatorParams resonator={layer.resonator} onChange={(resonator) => onChange({ ...layer, resonator })} />
      </Section>
      <Section title={`Radiators${radiators.length ? ` (${radiators.length})` : ''}`} open={radiators.length > 0}>
        {radiators.map((r, i) => (
          <div className="designer-filter" key={i}>
            <div className="designer-sub">{radiatorName(r.kind)}</div>
            <RadiatorParams radiator={r} onChange={(next) => setRadiators(radiators.map((x, k) => (k === i ? next : x)))} />
            <button className="designer-link" onClick={() => setRadiators(radiators.filter((_, k) => k !== i))}>Remove</button>
          </div>
        ))}
        <select className="rack-map-select designer-select" value="" aria-label="Add a radiator"
          onChange={(e) => e.target.value && setRadiators([...radiators, { kind: e.target.value } as Radiator])}>
          <option value="">+ Add radiator…</option>
          {RADIATORS.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
        </select>
      </Section>
    </>
  );
}
