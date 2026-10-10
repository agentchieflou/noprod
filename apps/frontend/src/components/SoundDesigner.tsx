import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Play, Copy, Trash2, Volume2, VolumeX, Save, Download, RotateCcw } from 'lucide-react';
import {
  CATEGORY_NAMES, GM_DRUM_NAMES, withId,
  type Category, type Envelope, type Filter, type FilterType, type Layer, type RenderedSound, type SoundRecipe, type Vibrato, type WaveShape
} from '@noprod/sound';
import { v4 as uuidv4 } from 'uuid';
import { useDAWStore } from '../store/useDAWStore';
import { libraryOf, renderSound, toAudioBuffer, playRendered, exportWav } from '../audio/library';
import { saveUserSound, findAnySound } from '../audio/userSounds';
import { getStripInput } from '../audio/engine';
import { midiNoteName } from '../audio/synth';
import Spectrogram from './Spectrogram';
import PartialEditor from './PartialEditor';

// The Sound Designer (#66): edits the library sound the selected MIDI track
// plays (or one of its kit's sounds), layer by layer, showing its frequencies
// over time. Edits go to the track's instrument, so they're undoable and
// saved with the project; Save keeps a copy in My Sounds for every project.

// ------------------------------------------------------------------ params

const clean = (x: number) => Number(x.toPrecision(3));
const show = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

// A slider for an optional number: double-click resets it to its default
function Param({ label, value, def, min, max, log, unit = '', onChange }: {
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

function Choice<T extends string>({ label, value, options, onChange }: {
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

const Section = ({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) => (
  <details className="designer-section" open={open}>
    <summary>{title}</summary>
    {children}
  </details>
);

// An optional part of a layer (pitch envelope, vibrato…): add it, or edit and remove it
function Optional<T>({ value, make, onChange, children }: {
  value: T | undefined; make: () => T; onChange: (value: T | undefined) => void; children: (value: T) => ReactNode;
}) {
  if (value === undefined) return <button className="designer-link" onClick={() => onChange(make())}>+ Add</button>;
  return <>{children(value)}<button className="designer-link" onClick={() => onChange(undefined)}>Remove</button></>;
}

function EnvelopeParams({ env, onChange, release = true }: { env: Envelope | undefined; onChange: (env: Envelope) => void; release?: boolean }) {
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

const filtersOf = (layer: Layer): Filter[] => (!layer.filter ? [] : Array.isArray(layer.filter) ? layer.filter : [layer.filter]);
const asFilter = (filters: Filter[]): Layer['filter'] => (filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : filters);

function FilterParams({ filter, onChange, onRemove }: { filter: Filter; onChange: (f: Filter) => void; onRemove: () => void }) {
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

// ------------------------------------------------------------------ layers

const LAYER_NAMES: Record<Layer['type'], string> = { partials: 'Partials', wave: 'Wave', fm: 'FM', noise: 'Noise' };

const NEW_LAYERS: Record<Layer['type'], () => Layer> = {
  partials: () => ({ type: 'partials', partials: [{ ratio: 1, level: 1 }, { ratio: 2, level: 0.5 }, { ratio: 3, level: 0.25 }], env: { attack: 0.005, decay: 2, sustain: 0.4, release: 0.3 } }),
  wave: () => ({ type: 'wave', shape: 'saw', env: { attack: 0.005, sustain: 1, release: 0.2 }, filter: { type: 'lowpass', cutoff: 2000 } }),
  fm: () => ({ type: 'fm', modRatio: 2, index: 2, indexEnv: { decay: 0.6, sustain: 0.3 }, env: { attack: 0.002, decay: 2, sustain: 0.3, release: 0.3 } }),
  noise: () => ({ type: 'noise', env: { attack: 0.001, decay: 0.2, sustain: 0 }, filter: { type: 'bandpass', cutoff: 2000, q: 1 } })
};

// A harmonic series as the partials it stands for (as the renderer builds it)
const seriesPartials = (count: number, slope = -6, odd = 1, even = 1) =>
  Array.from({ length: count }, (_, i) => ({ ratio: i + 1, level: clean(Math.pow(i + 1, slope / (20 * Math.log10(2))) * ((i + 1) % 2 ? odd : even)) }));

function LayerCard({ layer, index, onChange, onRemove, onDuplicate }: {
  layer: Layer; index: number; onChange: (layer: Layer) => void; onRemove: () => void; onDuplicate: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const set = (patch: Record<string, unknown>) => onChange({ ...layer, ...patch } as Layer);
  const field = (key: string) => (v: unknown) => set({ [key]: v });
  const filters = filtersOf(layer);

  let body: ReactNode = null;
  if (layer.type === 'partials') {
    const partials = layer.partials ?? [];
    const p = partials[Math.min(selected, partials.length - 1)];
    const at = partials.indexOf(p);
    const setPartial = (key: string) => (v: number | undefined) =>
      set({ partials: partials.map((q, k) => (k === at ? { ...q, [key]: v } : q)) });
    body = (
      <>
        <PartialEditor partials={partials} selected={at} onSelect={setSelected} onChange={(next) => set({ partials: next })} />
        <div className="designer-hint">Drag a bar: level · Shift-drag: frequency · double-click: add</div>
        {p && (
          <>
            <Param label="Ratio" value={p.ratio} def={1} min={0.25} max={32} log onChange={(v) => setPartial('ratio')(v ?? 1)} />
            <Param label="Level" value={p.level} def={1} min={0} max={1} onChange={(v) => setPartial('level')(v ?? 1)} />
            <Param label="Rings" value={p.decay} def={0} min={0.01} max={20} log unit="s" onChange={setPartial('decay')} />
            <Param label="Detune" value={p.detune} def={0} min={-50} max={50} unit="ct" onChange={setPartial('detune')} />
            <button className="designer-link" onClick={() => { set({ partials: partials.filter((_, k) => k !== at) }); setSelected(0); }}>
              Remove partial
            </button>
          </>
        )}
        <Section title="Harmonic series" open={!!layer.series}>
          <Optional value={layer.series} make={() => ({ count: 12, slope: -6 })} onChange={field('series')}>
            {(s) => (
              <>
                <Param label="Count" value={s.count} def={12} min={1} max={64} onChange={(v) => set({ series: { ...s, count: Math.round(v ?? 12) } })} />
                <Param label="Slope" value={s.slope} def={-6} min={-24} max={0} unit="dB" onChange={(v) => set({ series: { ...s, slope: v } })} />
                <Param label="Odd" value={s.odd} def={1} min={0} max={1} onChange={(v) => set({ series: { ...s, odd: v } })} />
                <Param label="Even" value={s.even} def={1} min={0} max={1} onChange={(v) => set({ series: { ...s, even: v } })} />
                <button className="designer-link" onClick={() => set({ series: undefined, partials: [...partials, ...seriesPartials(s.count, s.slope, s.odd, s.even)] })}>
                  Edit as partials
                </button>
              </>
            )}
          </Optional>
        </Section>
        <Param label="Stretch" value={layer.stretch} def={0} min={0} max={0.002} onChange={field('stretch')} />
        <Param label="Rings" value={layer.partialDecay} def={0} min={0.05} max={20} log unit="s" onChange={field('partialDecay')} />
        <Param label="Damping" value={layer.damping} def={0} min={0} max={2} onChange={field('damping')} />
      </>
    );
  } else if (layer.type === 'wave') {
    body = (
      <>
        <Choice<WaveShape | 'custom'> label="Shape" value={layer.harmonics ? 'custom' : layer.shape ?? 'saw'}
          options={[['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square'], ['saw', 'Saw'], ['pulse', 'Pulse'], ...(layer.harmonics ? [['custom', 'Custom'] as ['custom', string]] : [])]}
          onChange={(v) => v !== 'custom' && set({ shape: v, harmonics: undefined })} />
        {layer.shape === 'pulse' && <Param label="Width" value={layer.width} def={0.25} min={0.02} max={0.98} onChange={field('width')} />}
        <Param label="Voices" value={layer.unison?.voices} def={1} min={1} max={9}
          onChange={(v) => set({ unison: Math.round(v ?? 1) > 1 ? { detune: 15, ...layer.unison, voices: Math.round(v ?? 1) } : undefined })} />
        {layer.unison && (
          <>
            <Param label="Detune" value={layer.unison.detune} def={15} min={0} max={100} unit="ct" onChange={(v) => set({ unison: { ...layer.unison!, detune: v ?? 15 } })} />
            <Param label="Spread" value={layer.unison.spread} def={0} min={0} max={1} onChange={(v) => set({ unison: { ...layer.unison!, spread: v } })} />
          </>
        )}
        <div className="param-slider-row" title="Several oscillators at these multiples of the layer's frequency">
          <span className="param-name">Ratios</span>
          <input className="designer-text" defaultValue={(layer.ratios ?? [1]).join(', ')}
            onBlur={(e) => {
              const ratios = e.target.value.split(/[ ,]+/).map(Number).filter((x) => x > 0);
              set({ ratios: ratios.length > 1 || (ratios[0] ?? 1) !== 1 ? ratios : undefined });
            }} />
        </div>
      </>
    );
  } else if (layer.type === 'fm') {
    body = (
      <>
        <Param label="Mod ratio" value={layer.modRatio} def={1} min={0.25} max={16} log onChange={(v) => set({ modRatio: v ?? 1 })} />
        <Param label="Index" value={layer.index} def={1} min={0} max={20} onChange={(v) => set({ index: v ?? 1 })} />
        <Param label="Feedback" value={layer.feedback} def={0} min={0} max={1} onChange={field('feedback')} />
        <div className="designer-sub">Index envelope</div>
        <Optional value={layer.indexEnv} make={() => ({ decay: 0.6, sustain: 0.3 })} onChange={field('indexEnv')}>
          {(env) => <EnvelopeParams env={env} onChange={field('indexEnv')} release={false} />}
        </Optional>
      </>
    );
  } else {
    body = (
      <>
        <Choice label="Color" value={layer.color ?? 'white'} options={[['white', 'White'], ['pink', 'Pink'], ['brown', 'Brown']]} onChange={field('color')} />
        <label className="designer-check"><input type="checkbox" checked={!!layer.stereo} onChange={(e) => set({ stereo: e.target.checked || undefined })} /> Stereo</label>
      </>
    );
  }

  return (
    <div className={`device-card designer-layer ${layer.mute ? 'muted' : ''}`}>
      <div className="device-card-header">
        <span>{index + 1} · {LAYER_NAMES[layer.type]}</span>
        <span className="designer-layer-buttons">
          <button className="btn-icon" title={layer.mute ? 'Unmute layer' : 'Mute layer'} onClick={() => set({ mute: layer.mute ? undefined : true })}>
            {layer.mute ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </button>
          <button className="btn-icon" title="Duplicate layer" onClick={onDuplicate}><Copy size={12} /></button>
          <button className="btn-icon" title="Remove layer" onClick={onRemove}><Trash2 size={12} /></button>
        </span>
      </div>
      <div className="device-card-params designer-params">
        {body}
        <Section title="Level & tuning">
          <Param label="Level" value={layer.level} def={1} min={0} max={2} onChange={field('level')} />
          <Param label="Pan" value={layer.pan} def={0} min={-1} max={1} onChange={field('pan')} />
          {layer.hz !== undefined
            ? <Param label="Hz" value={layer.hz} def={440} min={20} max={12000} log unit="Hz" onChange={(v) => set({ hz: v ?? 440 })} />
            : <Param label="Ratio" value={layer.ratio} def={1} min={0.25} max={8} log onChange={field('ratio')} />}
          <Param label="Start" value={layer.start} def={0} min={0} max={2} unit="s" onChange={field('start')} />
          <Param label="Velocity" value={layer.velocity} def={1} min={0} max={1} onChange={field('velocity')} />
          <Param label="Drive" value={layer.drive} def={0} min={0} max={10} onChange={field('drive')} />
        </Section>
        <Section title="Envelope" open>
          <EnvelopeParams env={layer.env} onChange={field('env')} />
        </Section>
        <Section title={`Filter${filters.length > 1 ? `s (${filters.length})` : ''}`} open={filters.length > 0}>
          {filters.map((f, k) => (
            <FilterParams key={k} filter={f}
              onChange={(next) => set({ filter: asFilter(filters.map((g, j) => (j === k ? next : g))) })}
              onRemove={() => set({ filter: asFilter(filters.filter((_, j) => j !== k)) })} />
          ))}
          <button className="designer-link" onClick={() => set({ filter: asFilter([...filters, { type: 'lowpass', cutoff: 2000 }]) })}>+ Add filter</button>
        </Section>
        <Section title="Pitch envelope">
          <Optional value={layer.pitch} make={() => ({ amount: 12, time: 0.1 })} onChange={field('pitch')}>
            {(pitch) => (
              <>
                <Param label="Amount" value={pitch.amount} def={12} min={-48} max={48} unit="st" onChange={(v) => set({ pitch: { ...pitch, amount: v ?? 12 } })} />
                <Param label="Time" value={pitch.time} def={0.1} min={0.005} max={10} log unit="s" onChange={(v) => set({ pitch: { ...pitch, time: v ?? 0.1 } })} />
              </>
            )}
          </Optional>
        </Section>
        <Section title="Vibrato">
          <Optional<Vibrato> value={layer.vibrato} make={() => ({ rate: 5.5, depth: 15 })} onChange={field('vibrato')}>
            {(vib) => (
              <>
                <Param label="Rate" value={vib.rate} def={5.5} min={0.1} max={30} log unit="Hz" onChange={(v) => set({ vibrato: { ...vib, rate: v ?? 5.5 } })} />
                <Param label="Depth" value={vib.depth} def={15} min={0} max={200} unit="ct" onChange={(v) => set({ vibrato: { ...vib, depth: v ?? 15 } })} />
                <Param label="Delay" value={vib.delay} def={0} min={0} max={2} unit="s" onChange={(v) => set({ vibrato: { ...vib, delay: v } })} />
                <Param label="Fade" value={vib.fade} def={0} min={0} max={2} unit="s" onChange={(v) => set({ vibrato: { ...vib, fade: v } })} />
              </>
            )}
          </Optional>
        </Section>
        <Section title="Tremolo">
          <Optional value={layer.tremolo} make={() => ({ rate: 5, depth: 0.3 })} onChange={field('tremolo')}>
            {(trem) => (
              <>
                <Param label="Rate" value={trem.rate} def={5} min={0.1} max={20} log unit="Hz" onChange={(v) => set({ tremolo: { ...trem, rate: v ?? 5 } })} />
                <Param label="Depth" value={trem.depth} def={0.3} min={0} max={1} onChange={(v) => set({ tremolo: { ...trem, depth: v ?? 0.3 } })} />
              </>
            )}
          </Optional>
        </Section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- panel

const NOTES = Array.from({ length: 85 }, (_, i) => 24 + i); // C1..C8

export default function SoundDesigner({ track }: { track: any }) {
  const { updateInstrumentParameter, setTrackInstrument } = useDAWStore();
  const params = track?.instrument?.parameters;
  const lib = libraryOf(params);
  const kit = lib?.kit;
  const [padSound, setPadSound] = useState<string | null>(null);
  const kitSoundIds = kit ? [...new Set(Object.keys(kit.pads).map(Number).sort((a, b) => a - b).map((n) => kit.pads[n].sound))] : [];
  const soundId = kit ? (padSound && lib?.sounds?.[padSound] ? padSound : kitSoundIds[0]) : null;
  const recipe: SoundRecipe | undefined = kit ? (soundId ? lib?.sounds?.[soundId] : undefined) : lib?.sound;

  const [note, setNote] = useState<number | null>(null);
  const [velocity, setVelocity] = useState(0.9);
  const [audition, setAudition] = useState(false);
  const [rendered, setRendered] = useState<RenderedSound | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const latest = useRef(0);
  const edited = useRef(false);
  const playNote = note ?? recipe?.root ?? 60;

  // Re-render shortly after each change, off the main thread; the newest wins
  useEffect(() => {
    if (!recipe) return;
    const id = ++latest.current;
    const timer = setTimeout(() => {
      renderSound(recipe, { note: playNote, velocity, gate: recipe.pitched ? Math.min(recipe.length, 2) : undefined })
        .then((s) => { if (id === latest.current) setRendered(s); });
    }, 120);
    return () => clearTimeout(timer);
  }, [recipe, playNote, velocity]);

  const play = (sound = rendered) => { if (sound && track) playRendered(toAudioBuffer(sound), getStripInput(track.id)); };

  // Hear each edit as it lands, if asked
  useEffect(() => {
    if (rendered && edited.current && audition) play(rendered);
    edited.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered]);

  if (!track || !lib || !recipe) {
    return <div className="detail-empty-message">Select a MIDI track playing a library sound or kit (Browser → Library) to design its sound.</div>;
  }

  const flash = (m: string) => { setMessage(m); setTimeout(() => setMessage(null), 2500); };
  const update = (next: SoundRecipe) => {
    edited.current = true;
    if (kit) updateInstrumentParameter(track.id, 'Library', { ...lib, sounds: { ...lib.sounds, [soundId!]: next } });
    else updateInstrumentParameter(track.id, 'Library', { ...lib, sound: next });
  };
  const setLayers = (layers: Layer[]) => update({ ...recipe, layers });
  const rename = (name: string) => {
    if (!name.trim() || name === recipe.name) return;
    const next = { ...recipe, name: name.trim() };
    if (kit) update(next);
    else setTrackInstrument(track.id, { ...track.instrument, name: next.name, parameters: { ...params, Library: { ...lib, sound: next } } });
  };

  const original = findAnySound(recipe.id);
  const saveMine = async () => {
    // A built-in sound is saved as a new one of mine, sounding exactly the same
    const mine = recipe.id.startsWith('my-') ? recipe : withId(recipe, `my-${uuidv4().slice(0, 8)}`);
    await saveUserSound(mine);
    if (mine !== recipe) update(mine);
    flash(`Saved “${mine.name}” to My Sounds`);
  };

  return (
    <div className="sound-designer">
      <div className="designer-side">
        <div className="designer-row">
          <input key={recipe.id + recipe.name} className="designer-name" defaultValue={recipe.name} title="Name"
            onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          <select className="rack-map-select designer-select" value={recipe.category} title="Category"
            onChange={(e) => update({ ...recipe, category: e.target.value as Category })}>
            {Object.entries(CATEGORY_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
        {kit && (
          <select className="rack-map-select designer-pad" value={soundId!} onChange={(e) => setPadSound(e.target.value)} title="Which of the kit's sounds to edit">
            {kitSoundIds.map((id) => {
              const notes = Object.keys(kit.pads).map(Number).filter((n) => kit.pads[n].sound === id);
              return <option key={id} value={id}>{lib.sounds?.[id]?.name} · {notes.map((n) => GM_DRUM_NAMES[n] || n).slice(0, 2).join(', ')}</option>;
            })}
          </select>
        )}
        <Spectrogram sound={rendered} width={248} height={118} />
        <div className="designer-row">
          <button className="btn-icon designer-play" title="Play" onClick={() => play()}><Play size={13} /></button>
          <select className="rack-map-select designer-select" value={playNote} onChange={(e) => setNote(Number(e.target.value))} title="Note to play and show">
            {NOTES.map((n) => <option key={n} value={n}>{midiNoteName(n)}{n === recipe.root ? ' (root)' : ''}</option>)}
          </select>
          <input type="range" className="param-slider" min={0.05} max={1} step={0.05} value={velocity} title={`Velocity ${velocity}`}
            onChange={(e) => setVelocity(Number(e.target.value))} />
          <label className="designer-check" title="Play each edit as it renders">
            <input type="checkbox" checked={audition} onChange={(e) => setAudition(e.target.checked)} /> Hear edits
          </label>
        </div>
        <Param label="Length" value={recipe.length} def={1} min={0.05} max={30} log unit="s" onChange={(v) => update({ ...recipe, length: v ?? 1 })} />
        <Param label="Gain" value={recipe.gain} def={0} min={-24} max={12} unit="dB" onChange={(v) => update({ ...recipe, gain: v })} />
        <Param label="Seed" value={recipe.seed} def={0} min={0} max={999} onChange={(v) => update({ ...recipe, seed: v === undefined ? undefined : Math.round(v) })} />
        <div className="designer-row designer-actions">
          <button className="designer-button" onClick={saveMine} title="Keep this sound in My Sounds, for every project"><Save size={11} /> Save</button>
          <button className="designer-button" onClick={() => exportWav(recipe, playNote, velocity)} title="Download as a 24-bit WAV at this note"><Download size={11} /> WAV</button>
          <button className="designer-button" disabled={!original || original === recipe} onClick={() => original && update(original)}
            title={original ? `Back to the saved “${original.name}”` : 'Not a library sound'}><RotateCcw size={11} /> Revert</button>
        </div>
        <div className="designer-hint">{message ?? 'Loudness is normalized; Gain trims it.'}</div>
      </div>

      <div className="designer-layers">
        {recipe.layers.map((layer, i) => (
          <LayerCard key={`${recipe.id}-${i}`} layer={layer} index={i}
            onChange={(next) => setLayers(recipe.layers.map((l, k) => (k === i ? next : l)))}
            onRemove={() => setLayers(recipe.layers.filter((_, k) => k !== i))}
            onDuplicate={() => setLayers([...recipe.layers.slice(0, i + 1), structuredClone(layer), ...recipe.layers.slice(i + 1)])} />
        ))}
        <div className="device-card designer-add">
          <div className="designer-sub">Add a layer</div>
          {(Object.keys(NEW_LAYERS) as Layer['type'][]).map((type) => (
            <button key={type} className="designer-button" onClick={() => setLayers([...recipe.layers, NEW_LAYERS[type]()])}>+ {LAYER_NAMES[type]}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
