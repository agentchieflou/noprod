// A sound as a DSP chain (#78): every layer of a recipe, spectral or
// modeled, as blocks across five stages, the way an acoustic instrument is
// drawn: the player's input, what sets it vibrating (the excitation), what
// rings at the note (the resonator), what radiates it (bodies, bells and
// filters), and the output. Blocks switch off and on (a layer's `bypass`
// list, settings kept), and branches add to a chain: a radiator or filter in
// series, another exciter on the same resonator, or a parallel source.
//
// Block ids, which are also the bypass ids render.ts honours:
//   env, pitch, vibrato          player input
//   source | exciter             excitation (a spectral layer's source, or a model's exciter)
//   resonator                    a model's string or bore
//   radiator:N, filter:N         radiation, in series (radiators first)
//   tremolo, drive, mix          output (mix, the level and pan, is always on)

import type { Exciter, Filter, FilterType, Layer, Radiator, Resonator, SoundRecipe } from './types.ts';
import { closedLoop } from './model.ts';

export type Stage = 'input' | 'excitation' | 'resonator' | 'radiator' | 'output';

export const STAGES: { id: Stage; label: string; description: string }[] = [
  { id: 'input', label: 'Player input', description: 'How the note is played: its envelope (bow speed, breath, a key held), glides and vibrato' },
  { id: 'excitation', label: 'Excitation', description: 'What sets it vibrating: a pluck, a bow, lips, a reed — or a spectral source' },
  { id: 'resonator', label: 'Resonator', description: 'What rings at the note: a string or an air column, as a delay loop' },
  { id: 'radiator', label: 'Radiator', description: 'What the sound passes through on its way out: a body, a bell, toneholes, filters' },
  { id: 'output', label: 'Output', description: 'Level, pan, tremolo and drive' }
];

export type Family = 'envelope' | 'modulation' | 'exciter' | 'source' | 'resonator' | 'radiator' | 'filter' | 'dynamics' | 'mix';

export type BlockKind =
  | 'env' | 'pitch' | 'vibrato'
  | Exciter['kind'] | Exclude<Layer['type'], 'model'>
  | Resonator['kind']
  | Radiator['kind'] | FilterType
  | 'tremolo' | 'drive' | 'mix';

export interface BlockInfo {
  kind: BlockKind;
  label: string;
  description: string;
  stage: Stage;
  family: Family;
  layers: Layer['type'][];  // the layer types it can be part of
  defaults: unknown;        // what adding it adds
  closed?: boolean;         // an exciter in a closed loop with its resonator
}

const MODEL: Layer['type'][] = ['model'];
const ALL: Layer['type'][] = ['partials', 'wave', 'fm', 'noise', 'model'];

export const BLOCKS: Record<BlockKind, BlockInfo> = {
  env: { kind: 'env', label: 'Envelope', description: 'The level over the note: attack, decay, sustain, release. On a closed-loop model, the bow speed or breath pressure', stage: 'input', family: 'envelope', layers: ALL, defaults: { attack: 0.002, sustain: 1, release: 0.05 } },
  pitch: { kind: 'pitch', label: 'Pitch glide', description: 'Starts off the note and glides to it', stage: 'input', family: 'modulation', layers: ALL, defaults: { amount: 12, time: 0.1 } },
  vibrato: { kind: 'vibrato', label: 'Vibrato', description: 'The pitch wavering', stage: 'input', family: 'modulation', layers: ALL, defaults: { rate: 5.5, depth: 15, delay: 0.2, fade: 0.3 } },

  pluck: { kind: 'pluck', label: 'Pluck', description: 'A finger or pick displaces the string and lets go', stage: 'excitation', family: 'exciter', layers: MODEL, defaults: { kind: 'pluck' } },
  strike: { kind: 'strike', label: 'Strike', description: 'A hammer or mallet hits it once', stage: 'excitation', family: 'exciter', layers: MODEL, defaults: { kind: 'strike' } },
  bow: { kind: 'bow', label: 'Bow', description: 'Stick-slip friction: the bow grips the string, slips, grips again', stage: 'excitation', family: 'exciter', layers: MODEL, defaults: { kind: 'bow' }, closed: true },
  lips: { kind: 'lips', label: 'Lips', description: 'Buzzing lips, a valve the air pressure opens and closes', stage: 'excitation', family: 'exciter', layers: MODEL, defaults: { kind: 'lips' }, closed: true },
  jet: { kind: 'jet', label: 'Air jet', description: 'A jet of air across an edge, flipping in and out of the pipe', stage: 'excitation', family: 'exciter', layers: MODEL, defaults: { kind: 'jet' }, closed: true },
  reed: { kind: 'reed', label: 'Reed', description: 'A cane reed beating against the mouthpiece', stage: 'excitation', family: 'exciter', layers: MODEL, defaults: { kind: 'reed' }, closed: true },
  partials: { kind: 'partials', label: 'Partials', description: 'Sine waves at chosen frequencies', stage: 'excitation', family: 'source', layers: ['partials'], defaults: { type: 'partials', series: { count: 12, slope: -6 } } },
  wave: { kind: 'wave', label: 'Oscillator', description: 'A classic waveform, band-limited', stage: 'excitation', family: 'source', layers: ['wave'], defaults: { type: 'wave', shape: 'saw' } },
  fm: { kind: 'fm', label: 'FM', description: 'One frequency modulating another', stage: 'excitation', family: 'source', layers: ['fm'], defaults: { type: 'fm', modRatio: 1, index: 2 } },
  noise: { kind: 'noise', label: 'Noise', description: 'Every frequency at once', stage: 'excitation', family: 'source', layers: ['noise'], defaults: { type: 'noise', color: 'pink', level: 0.3 } },

  string: { kind: 'string', label: 'String', description: 'A vibrating string: two travelling waves, losing energy at each reflection', stage: 'resonator', family: 'resonator', layers: MODEL, defaults: { kind: 'string' } },
  bore: { kind: 'bore', label: 'Bore', description: 'An air column: a pressure wave reflecting from the open or closed end', stage: 'resonator', family: 'resonator', layers: MODEL, defaults: { kind: 'bore' } },

  body: { kind: 'body', label: 'Body', description: 'A wooden body\'s resonances', stage: 'radiator', family: 'radiator', layers: MODEL, defaults: { kind: 'body', preset: 'box' } },
  helmholtz: { kind: 'helmholtz', label: 'Air cavity', description: 'The air in the body ringing through its sound hole', stage: 'radiator', family: 'radiator', layers: MODEL, defaults: { kind: 'helmholtz' } },
  bell: { kind: 'bell', label: 'Bell', description: 'A flared bell lets the highs out and keeps the lows in', stage: 'radiator', family: 'radiator', layers: MODEL, defaults: { kind: 'bell' } },
  tonehole: { kind: 'tonehole', label: 'Toneholes', description: 'Open toneholes radiate above a cutoff', stage: 'radiator', family: 'radiator', layers: MODEL, defaults: { kind: 'tonehole' } },
  damping: { kind: 'damping', label: 'Damping', description: 'A one-pole low-pass, H(z) = (1 − a) / (1 − a·z⁻¹)', stage: 'radiator', family: 'radiator', layers: MODEL, defaults: { kind: 'damping' } },
  lowpass: { kind: 'lowpass', label: 'Lowpass', description: 'Lets the lows through', stage: 'radiator', family: 'filter', layers: ALL, defaults: { type: 'lowpass', cutoff: 2000 } },
  highpass: { kind: 'highpass', label: 'Highpass', description: 'Lets the highs through', stage: 'radiator', family: 'filter', layers: ALL, defaults: { type: 'highpass', cutoff: 200 } },
  bandpass: { kind: 'bandpass', label: 'Bandpass', description: 'Lets one band through', stage: 'radiator', family: 'filter', layers: ALL, defaults: { type: 'bandpass', cutoff: 1000, q: 2 } },
  notch: { kind: 'notch', label: 'Notch', description: 'Takes one band out', stage: 'radiator', family: 'filter', layers: ALL, defaults: { type: 'notch', cutoff: 1000, q: 2 } },

  tremolo: { kind: 'tremolo', label: 'Tremolo', description: 'The level wobbling', stage: 'output', family: 'modulation', layers: ALL, defaults: { rate: 5, depth: 0.3 } },
  drive: { kind: 'drive', label: 'Drive', description: 'Saturation', stage: 'output', family: 'dynamics', layers: ALL, defaults: 2 },
  mix: { kind: 'mix', label: 'Level & pan', description: 'The layer\'s level and place in the stereo field', stage: 'output', family: 'mix', layers: ALL, defaults: undefined }
};

export interface Block {
  id: string;         // within its layer (and its bypass id)
  layer: number;
  stage: Stage;
  kind: BlockKind;
  family: Family;
  label: string;
  detail?: string;    // what sets this one apart: "violin", "800 Hz"
  on: boolean;
  switchable: boolean;
  removable: boolean;
  loop: boolean;      // in a closed loop: the exciter and resonator of a bowed or blown model
}

export interface LayerChain {
  index: number;
  type: Layer['type'];
  label: string;
  muted: boolean;
  closed: boolean;    // a closed-loop model
  blocks: Block[];
}

export interface Chain {
  id: string;
  name: string;
  layers: LayerChain[];
}

const STAGE_ORDER = STAGES.map((s) => s.id);
const filtersOf = (layer: Layer): Filter[] => (!layer.filter ? [] : Array.isArray(layer.filter) ? layer.filter : [layer.filter]);
const hz = (x: number) => (x >= 1000 ? `${+(x / 1000).toFixed(1)} kHz` : `${Math.round(x)} Hz`);

function sourceDetail(layer: Layer): string | undefined {
  switch (layer.type) {
    case 'partials': return layer.series ? `${layer.series.count} harmonics` : `${layer.partials?.length ?? 0} partials`;
    case 'wave': return `${layer.harmonics ? 'custom' : layer.shape ?? 'saw'}${layer.unison && layer.unison.voices > 1 ? ` ×${layer.unison.voices}` : ''}`;
    case 'fm': return `${layer.modRatio}:1`;
    case 'noise': return layer.color ?? 'white';
    default: return undefined;
  }
}

function radiatorDetail(r: Radiator): string | undefined {
  switch (r.kind) {
    case 'body': return r.modes ? 'custom' : r.preset ?? 'box';
    case 'helmholtz': return hz(r.hz ?? 110);
    case 'bell': return hz(r.cutoff ?? 700);
    case 'tonehole': return `${r.cutoff ?? 0.7}× note`;
    case 'damping': return `a ${r.a ?? 0.5}`;
  }
}

const LAYER_LABELS: Record<Layer['type'], string> = { partials: 'Partials', wave: 'Oscillator', fm: 'FM', noise: 'Noise', model: 'Model' };

export function layerChain(layer: Layer, index: number): LayerChain {
  const off = new Set(layer.bypass ?? []);
  const closed = layer.type === 'model' && closedLoop(layer.exciter);
  const blocks: Block[] = [];
  const add = (id: string, kind: BlockKind, extra: Partial<Block> = {}) => {
    const info = BLOCKS[kind];
    blocks.push({
      id, layer: index, stage: info.stage, kind, family: info.family, label: info.label,
      on: !off.has(id), switchable: true, removable: true, loop: false, ...extra
    });
  };

  add('env', 'env', { removable: false, detail: layer.env?.sustain === 0 ? 'one-shot' : undefined });
  if (layer.pitch) add('pitch', 'pitch', { detail: `${layer.pitch.amount > 0 ? '+' : ''}${layer.pitch.amount} st` });
  if (layer.vibrato) add('vibrato', 'vibrato', { detail: `${layer.vibrato.rate} Hz` });

  if (layer.type === 'model') {
    add('exciter', layer.exciter.kind, { removable: false, loop: closed });
    add('resonator', layer.resonator.kind, {
      removable: false, loop: closed,
      detail: layer.resonator.kind === 'bore' ? layer.resonator.end ?? 'open' : undefined
    });
    (layer.radiators ?? []).forEach((r, k) => add(`radiator:${k}`, r.kind, { detail: radiatorDetail(r) }));
  } else {
    add('source', layer.type, { removable: false, detail: sourceDetail(layer) });
  }
  filtersOf(layer).forEach((f, k) => add(`filter:${k}`, f.type, { detail: hz(f.cutoff) }));

  if (layer.tremolo) add('tremolo', 'tremolo', { detail: `${layer.tremolo.rate} Hz` });
  if (layer.drive) add('drive', 'drive', { detail: `${layer.drive}` });
  add('mix', 'mix', { switchable: false, removable: false, on: true });

  const label = layer.type === 'model' ? `${BLOCKS[layer.exciter.kind].label} · ${BLOCKS[layer.resonator.kind].label}` : LAYER_LABELS[layer.type];
  return { index, type: layer.type, label, muted: !!layer.mute, closed, blocks };
}

export function chainOf(recipe: SoundRecipe): Chain {
  return { id: recipe.id, name: recipe.name, layers: recipe.layers.map(layerChain) };
}

// ----------------------------------------------------------------- editing
// Every edit returns a new recipe; the one passed in is left as it was.

const withLayer = (recipe: SoundRecipe, index: number, edit: (layer: Layer) => Layer): SoundRecipe => {
  if (!recipe.layers[index]) throw new RangeError(`${recipe.id} has no layer ${index}`);
  return { ...recipe, layers: recipe.layers.map((l, k) => (k === index ? edit(l) : l)) };
};
const clone = <T>(x: T): T => (x === undefined ? x : structuredClone(x));
const withBypass = <L extends Layer>(layer: L, bypass: string[]): L => {
  const next = { ...layer };
  if (bypass.length) next.bypass = bypass; else delete next.bypass;
  return next;
};

export function setBlockOn(recipe: SoundRecipe, layer: number, id: string, on: boolean): SoundRecipe {
  return withLayer(recipe, layer, (l) => {
    const block = layerChain(l, layer).blocks.find((b) => b.id === id);
    if (!block) throw new RangeError(`layer ${layer} has no block ${id}`);
    if (!block.switchable) throw new Error(`${id} can't be switched off`);
    const rest = (l.bypass ?? []).filter((x) => x !== id);
    return withBypass(l, on ? rest : [...rest, id]);
  });
}

// Switches every block of a kind, in every layer that has one: a chain's
// shared blocks, turned off or on together
export function setKindOn(recipe: SoundRecipe, kind: BlockKind, on: boolean): SoundRecipe {
  let next = recipe;
  chainOf(recipe).layers.forEach((lc) => lc.blocks.forEach((b) => {
    if (b.kind === kind && b.switchable && b.on !== on) next = setBlockOn(next, lc.index, b.id, on);
  }));
  return next;
}

// What can be added to a layer: what its type accepts, and it doesn't
// have yet (another exciter or resonator swaps the one it has)
export function branchesFor(recipe: SoundRecipe, layer: number, stage?: Stage): BlockKind[] {
  const l = recipe.layers[layer];
  if (!l) return [];
  const has = new Set(layerChain(l, layer).blocks.map((b) => b.kind));
  return (Object.values(BLOCKS) as BlockInfo[])
    .filter((info) => (!stage || info.stage === stage) && !has.has(info.kind) && info.kind !== 'mix' && info.kind !== 'env')
    .filter((info) => info.layers.includes(l.type) || info.family === 'source')
    .map((info) => info.kind);
}

// Adds a block to a layer, with its defaults. An exciter or resonator
// replaces the model's own; a spectral source adds a layer beside it (a
// parallel branch), played the same way. Returns the new recipe.
export function addBlock(recipe: SoundRecipe, layer: number, kind: BlockKind): SoundRecipe {
  const info = BLOCKS[kind];
  const l = recipe.layers[layer];
  if (!info || !l) throw new RangeError(`can't add ${kind} to layer ${layer}`);
  if (info.family === 'source') {
    const branch = { ...clone(info.defaults as Layer), env: clone(l.env) } as Layer;
    if (!branch.env) delete branch.env;
    return { ...recipe, layers: [...recipe.layers, branch] };
  }
  if (!info.layers.includes(l.type)) throw new Error(`a ${l.type} layer can't take a ${info.label.toLowerCase()}`);
  return withLayer(recipe, layer, (layer0) => {
    const next = { ...layer0 } as Layer;
    const unbypass = (id: string) => withBypass(next, (next.bypass ?? []).filter((x) => x !== id));
    switch (info.family) {
      case 'exciter':
        (next as Extract<Layer, { type: 'model' }>).exciter = clone(info.defaults as Exciter);
        return unbypass('exciter');
      case 'resonator':
        (next as Extract<Layer, { type: 'model' }>).resonator = clone(info.defaults as Resonator);
        return unbypass('resonator');
      case 'radiator': {
        const m = next as Extract<Layer, { type: 'model' }>;
        m.radiators = [...(m.radiators ?? []), clone(info.defaults as Radiator)];
        return next;
      }
      case 'filter': {
        const filters = [...filtersOf(next), clone(info.defaults as Filter)];
        next.filter = filters.length === 1 ? filters[0] : filters;
        return next;
      }
      default:
        if (kind === 'pitch') next.pitch = clone(info.defaults as typeof next.pitch);
        else if (kind === 'vibrato') next.vibrato = clone(info.defaults as typeof next.vibrato);
        else if (kind === 'tremolo') next.tremolo = clone(info.defaults as typeof next.tremolo);
        else if (kind === 'drive') next.drive = info.defaults as number;
        else if (kind === 'env') next.env = clone(info.defaults as typeof next.env);
        return unbypass(kind);
    }
  });
}

// Removes a block. The exciter, resonator, source, envelope and mix can't
// be removed (switch them off instead); removing a radiator or filter
// renumbers the ones after it, and their bypass ids with them.
export function removeBlock(recipe: SoundRecipe, layer: number, id: string): SoundRecipe {
  return withLayer(recipe, layer, (l) => {
    const block = layerChain(l, layer).blocks.find((b) => b.id === id);
    if (!block) throw new RangeError(`layer ${layer} has no block ${id}`);
    if (!block.removable) throw new Error(`${id} can't be removed`);
    const next = { ...l } as Layer;
    const [group, n] = id.split(':');
    let bypass = (l.bypass ?? []).filter((x) => x !== id);
    if (n !== undefined) {
      const k = Number(n);
      bypass = bypass.map((x) => {
        const [g, m] = x.split(':');
        return g === group && m !== undefined && Number(m) > k ? `${g}:${Number(m) - 1}` : x;
      });
      if (group === 'radiator') {
        const m = next as Extract<Layer, { type: 'model' }>;
        const radiators = (m.radiators ?? []).filter((_, j) => j !== k);
        if (radiators.length) m.radiators = radiators; else delete m.radiators;
      } else {
        const filters = filtersOf(l).filter((_, j) => j !== k);
        if (filters.length === 0) delete next.filter;
        else next.filter = filters.length === 1 ? filters[0] : filters;
      }
    } else {
      delete (next as unknown as Record<string, unknown>)[id];
    }
    return withBypass(next, bypass);
  });
}

// ------------------------------------------------------------------ sharing

export interface SharedBlock {
  stage: Stage;
  kind: BlockKind;
  label: string;
  chains: number[];  // which of the chains have it
  on: boolean[];     // per chain in `chains`: is every one of its blocks of this kind on
}

// The block kinds two or more chains have in common, stage by stage (the
// mix, always there and always on, isn't counted)
export function sharedBlocks(chains: (Chain | SoundRecipe)[]): SharedBlock[] {
  const described = chains.map((c) => ('layers' in c && c.layers[0] && 'blocks' in c.layers[0] ? c as Chain : chainOf(c as SoundRecipe)));
  const found = new Map<BlockKind, { chains: number[]; on: boolean[] }>();
  described.forEach((chain, i) => {
    const mine = new Map<BlockKind, boolean>();
    for (const lc of chain.layers) for (const b of lc.blocks) {
      if (!b.switchable) continue;
      mine.set(b.kind, (mine.get(b.kind) ?? true) && b.on);
    }
    for (const [kind, on] of mine) {
      const entry = found.get(kind) ?? { chains: [], on: [] };
      entry.chains.push(i);
      entry.on.push(on);
      found.set(kind, entry);
    }
  });
  return [...found.entries()]
    .filter(([, e]) => e.chains.length >= 2)
    .map(([kind, e]) => ({ stage: BLOCKS[kind].stage, kind, label: BLOCKS[kind].label, ...e }))
    .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || b.chains.length - a.chains.length || a.label.localeCompare(b.label));
}
