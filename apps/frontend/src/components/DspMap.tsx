import { Fragment, useEffect, useState } from 'react';
import { Play, Power, X } from 'lucide-react';
import {
  BLOCKS, CATEGORY_NAMES, LIBRARY, STAGES, addBlock, branchesFor, chainOf, removeBlock, setBlockOn, setKindOn, sharedBlocks,
  type Block, type BlockKind, type Category, type Chain, type Layer, type SharedBlock, type SoundRecipe, type Stage
} from '@noprod/sound';
import { useDAWStore } from '../store/useDAWStore';
import { libraryOf, createLibraryInstrument, renderSound, toAudioBuffer, playRendered } from '../audio/library';
import { getStripInput } from '../audio/engine';
import { midiNoteName } from '../audio/synth';
import { Param, Choice, EnvelopeParams, FilterParams } from './designerControls';
import { filtersOf, asFilter } from './designerUtils';
import { ExciterParams, ResonatorParams, RadiatorParams } from './ModelParams';
import { savedColumns, saveColumns, savedNote, saveNote, scratchColumn, type MapColumn } from './dspMapState';

// The DSP Map (#80): instruments side by side, each drawn as the stages its
// sound passes through (player input → excitation → resonator → radiator →
// output). What two or more share is listed by stage, and switches off or
// on in all of them at once; any block switches on its own, opens in the
// inspector, or comes out; "+" adds a branch. A track's column edits the
// track's instrument (undoable, saved with the project); a library sound's
// column edits a scratch copy.

interface Column {
  key: string;
  column: MapColumn | null;  // null: the selected track, which follows the selection
  name: string;
  source: string;
  recipe: SoundRecipe;
  chain: Chain;
  track: any | null;
}

interface Selection { col: string; layer: number; id: string }

const NOTES = Array.from({ length: 61 }, (_, i) => 36 + i); // C2..C7
const soundOf = (track: any): SoundRecipe | undefined => libraryOf(track?.instrument?.parameters)?.sound;

// ----------------------------------------------------------- block params

function BlockParams({ layer, id, onChange, onRemove }: { layer: Layer; id: string; onChange: (l: Layer) => void; onRemove: () => void }) {
  const set = (patch: Record<string, unknown>) => onChange({ ...layer, ...patch } as Layer);
  const [group, n] = id.split(':');
  const k = Number(n);
  switch (group) {
    case 'env':
      return <EnvelopeParams env={layer.env} onChange={(env) => set({ env })} />;
    case 'pitch': {
      const p = layer.pitch!;
      return (
        <>
          <Param label="Amount" value={p.amount} def={12} min={-24} max={24} unit="st" onChange={(v) => set({ pitch: { ...p, amount: v ?? 12 } })} />
          <Param label="Glide" value={p.time} def={0.1} min={0.005} max={2} log unit="s" onChange={(v) => set({ pitch: { ...p, time: v ?? 0.1 } })} />
        </>
      );
    }
    case 'vibrato': {
      const v = layer.vibrato!;
      return (
        <>
          <Param label="Rate" value={v.rate} def={5.5} min={0.5} max={12} unit="Hz" onChange={(x) => set({ vibrato: { ...v, rate: x ?? 5.5 } })} />
          <Param label="Depth" value={v.depth} def={15} min={0} max={100} unit="ct" onChange={(x) => set({ vibrato: { ...v, depth: x ?? 15 } })} />
          <Param label="Delay" value={v.delay} def={0} min={0} max={2} unit="s" onChange={(x) => set({ vibrato: { ...v, delay: x } })} />
          <Param label="Fade in" value={v.fade} def={0} min={0} max={2} unit="s" onChange={(x) => set({ vibrato: { ...v, fade: x } })} />
        </>
      );
    }
    case 'exciter':
      return layer.type === 'model' ? <ExciterParams exciter={layer.exciter} onChange={(exciter) => set({ exciter })} /> : null;
    case 'resonator':
      return layer.type === 'model' ? <ResonatorParams resonator={layer.resonator} onChange={(resonator) => set({ resonator })} /> : null;
    case 'radiator': {
      if (layer.type !== 'model' || !layer.radiators?.[k]) return null;
      const radiators = layer.radiators;
      return <RadiatorParams radiator={radiators[k]} onChange={(r) => set({ radiators: radiators.map((x, j) => (j === k ? r : x)) })} />;
    }
    case 'filter': {
      const filters = filtersOf(layer);
      if (!filters[k]) return null;
      return <FilterParams filter={filters[k]} onRemove={onRemove} onChange={(f) => set({ filter: asFilter(filters.map((x, j) => (j === k ? f : x))) })} />;
    }
    case 'tremolo': {
      const t = layer.tremolo!;
      return (
        <>
          <Param label="Rate" value={t.rate} def={5} min={0.5} max={15} unit="Hz" onChange={(x) => set({ tremolo: { ...t, rate: x ?? 5 } })} />
          <Param label="Depth" value={t.depth} def={0.3} min={0} max={1} onChange={(x) => set({ tremolo: { ...t, depth: x ?? 0.3 } })} />
        </>
      );
    }
    case 'drive':
      return <Param label="Drive" value={layer.drive} def={0} min={0} max={10} onChange={(drive) => set({ drive })} />;
    case 'mix':
      return (
        <>
          <Param label="Level" value={layer.level} def={1} min={0} max={2} onChange={(level) => set({ level })} />
          <Param label="Pan" value={layer.pan} def={0} min={-1} max={1} onChange={(pan) => set({ pan })} />
        </>
      );
    case 'source':
      if (layer.type === 'wave') {
        return (
          <>
            <Choice label="Shape" value={layer.shape ?? 'saw'} onChange={(shape) => set({ shape, harmonics: undefined })}
              options={[['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square'], ['saw', 'Saw'], ['pulse', 'Pulse']]} />
            {layer.shape === 'pulse' && <Param label="Width" value={layer.width} def={0.25} min={0.02} max={0.98} onChange={(width) => set({ width })} />}
          </>
        );
      }
      if (layer.type === 'fm') {
        return (
          <>
            <Param label="Mod ratio" value={layer.modRatio} def={1} min={0.25} max={16} log onChange={(v) => set({ modRatio: v ?? 1 })} />
            <Param label="Index" value={layer.index} def={1} min={0} max={20} onChange={(v) => set({ index: v ?? 1 })} />
            <Param label="Feedback" value={layer.feedback} def={0} min={0} max={1} onChange={(feedback) => set({ feedback })} />
          </>
        );
      }
      if (layer.type === 'noise') {
        return <Choice label="Color" value={layer.color ?? 'white'} options={[['white', 'White'], ['pink', 'Pink'], ['brown', 'Brown']]} onChange={(color) => set({ color })} />;
      }
      if (layer.type === 'partials' && layer.series) {
        const s = layer.series;
        return (
          <>
            <Param label="Count" value={s.count} def={12} min={1} max={64} onChange={(v) => set({ series: { ...s, count: Math.round(v ?? 12) } })} />
            <Param label="Slope" value={s.slope} def={-6} min={-24} max={0} unit="dB" onChange={(v) => set({ series: { ...s, slope: v } })} />
          </>
        );
      }
      return <div className="designer-hint">Its partials are edited one by one in the Sound Designer.</div>;
    default:
      return null;
  }
}

// ------------------------------------------------------------------- map

export default function DspMap() {
  const { tracks, selectedTrackId, updateInstrumentParameter, addMidiTrackWithInstrument } = useDAWStore();
  const [columns, setColumns] = useState<MapColumn[]>(savedColumns);
  useEffect(() => saveColumns(columns), [columns]);
  const [note, setNote] = useState(savedNote);
  useEffect(() => saveNote(note), [note]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hover, setHover] = useState<BlockKind | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  // The columns, resolved to what they play now
  const trackColumn = (track: any, column: MapColumn | null): Column => {
    const recipe = soundOf(track)!;
    return { key: `track:${track.id}`, column, name: recipe.name, source: `Track · ${track.name}${column ? '' : ' (selected)'}`, recipe, chain: chainOf(recipe), track };
  };
  const shown: Column[] = [];
  const selectedTrack = tracks.find((t: any) => t.id === selectedTrackId && t.type === 'midi' && soundOf(t));
  if (selectedTrack && !columns.some((c) => c.kind === 'track' && c.trackId === selectedTrack.id)) shown.push(trackColumn(selectedTrack, null));
  for (const c of columns) {
    if (c.kind === 'track') {
      const track = tracks.find((t: any) => t.id === c.trackId);
      if (track && soundOf(track)) shown.push(trackColumn(track, c));
    } else {
      shown.push({ key: c.key, column: c, name: c.recipe.name, source: 'Library · scratch copy', recipe: c.recipe, chain: chainOf(c.recipe), track: null });
    }
  }
  const shared = sharedBlocks(shown.map((c) => c.chain));
  const sharedKinds = new Set(shared.map((s) => s.kind));

  const edit = (c: Column, next: SoundRecipe) => {
    if (c.track) {
      const lib = libraryOf(c.track.instrument.parameters)!;
      updateInstrumentParameter(c.track.id, 'Library', { ...lib, sound: next });
    } else {
      setColumns((cols) => cols.map((x) => (x.kind === 'scratch' && x.key === c.key ? { ...x, recipe: next } : x)));
    }
  };
  // The common chain toggle: a shared kind off (or on) in every instrument that has it
  const toggleShared = (s: SharedBlock) => {
    const on = !s.on.every(Boolean);
    s.chains.forEach((i) => edit(shown[i], setKindOn(shown[i].recipe, s.kind, on)));
  };

  const play = async (c: Column) => {
    setPlaying(c.key);
    const pitched = c.recipe.pitched;
    const sound = await renderSound(c.recipe, { note: pitched ? note : undefined, velocity: 0.9, gate: pitched ? 1.2 : undefined });
    playRendered(toAudioBuffer(sound), c.track ? getStripInput(c.track.id) : undefined);
    setTimeout(() => setPlaying((p) => (p === c.key ? null : p)), 1400);
  };
  const playAll = async () => {
    for (const c of shown) {
      await play(c);
      await new Promise((r) => setTimeout(r, 1500));
    }
  };

  const add = (value: string) => {
    const [kind, id] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
    if (kind === 'track') setColumns((cols) => [...cols, { kind: 'track', trackId: id }]);
    const recipe = kind === 'sound' ? LIBRARY.find((r) => r.id === id) : undefined;
    if (recipe) setColumns((cols) => [...cols, scratchColumn(recipe)]);
  };
  const remove = (c: Column) => setColumns((cols) => cols.filter((x) => x !== c.column));
  // A scratch copy onto a new track: the column then edits the track
  const moveToTrack = (c: Column) => {
    addMidiTrackWithInstrument(createLibraryInstrument(c.recipe), c.recipe.name);
    const trackId = useDAWStore.getState().selectedTrackId;
    setColumns((cols) => cols.map((x) => (x === c.column ? { kind: 'track', trackId } : x)));
  };

  const present = new Set(shown.filter((c) => c.track).map((c) => c.track.id));
  const categories = Object.keys(CATEGORY_NAMES) as Category[];

  // The inspector's block
  const selCol = selection && shown.find((c) => c.key === selection.col);
  const selLayer = selCol?.recipe.layers[selection!.layer];
  const selBlock = selCol?.chain.layers[selection!.layer]?.blocks.find((b) => b.id === selection!.id);

  const cell = (c: Column, stage: Stage, first: boolean) => {
    const lanes = c.chain.layers.map((lc) => ({ lc, blocks: lc.blocks.filter((b) => b.stage === stage) })).filter((l) => l.blocks.length);
    // What can be added here: per layer (a source adds a layer beside them, so it's offered once)
    const branches = c.recipe.layers.flatMap((_, i) => branchesFor(c.recipe, i, stage)
      .filter((kind) => i === 0 || BLOCKS[kind].family !== 'source')
      .map((kind) => ({ layer: i, kind })));
    const loop = stage === 'resonator' && c.chain.layers.some((l) => l.closed);
    const many = c.recipe.layers.length > 1;
    const swaps = (layer: number, kind: BlockKind) => {
      const family = BLOCKS[kind].family;
      const now = c.chain.layers[layer].blocks.find((b) => b.family === family && (family === 'exciter' || family === 'resonator'));
      return now ? ` (replaces ${now.label})` : BLOCKS[kind].family === 'source' ? ' (a layer beside it)' : '';
    };
    return (
      <div key={c.key + stage} className={`dsp-map-cell ${first ? 'first' : ''} ${loop ? 'loop' : ''}`} data-col={c.key} data-stage={stage}
        title={loop ? 'The exciter and the resonator drive each other: a closed loop, sustained for as long as the player plays' : undefined}>
        {lanes.map(({ lc, blocks }) => (
          <div key={lc.index} className={`dsp-lane ${lc.muted ? 'muted' : ''}`}>
            {many && <span className="dsp-lane-label" title={`Layer ${lc.index + 1}: ${lc.label}`}>{lc.index + 1}</span>}
            {blocks.map((b) => blockChip(c, b))}
          </div>
        ))}
        {branches.length > 0 && (
          <select className="dsp-add" value="" title="Add a block here" aria-label={`Add to ${c.name}'s ${stage}`}
            onChange={(e) => {
              const [layer, kind] = e.target.value.split('|');
              if (!kind) return;
              const next = addBlock(c.recipe, Number(layer), kind as BlockKind);
              edit(c, next);
              // and open what was added
              const added = chainOf(next).layers.flatMap((lc) => lc.blocks).filter((b) => b.kind === kind).at(-1);
              if (added) setSelection({ col: c.key, layer: added.layer, id: added.id });
            }}>
            <option value="">+</option>
            {branches.map(({ layer, kind }) => (
              <option key={`${layer}|${kind}`} value={`${layer}|${kind}`}>
                {many && BLOCKS[kind].family !== 'source' ? `${layer + 1} · ` : ''}{BLOCKS[kind].label}{swaps(layer, kind)}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  };

  const blockChip = (c: Column, b: Block) => {
    const isShared = sharedKinds.has(b.kind);
    const selected = selection?.col === c.key && selection.layer === b.layer && selection.id === b.id;
    return (
      <div key={b.id}
        className={`dsp-block family-${b.family} ${b.on ? 'on' : 'off'} ${selected ? 'selected' : ''} ${isShared ? 'shared' : ''} ${hover === b.kind ? 'hover' : ''} ${b.loop ? 'loop' : ''}`}
        data-kind={b.kind} data-id={b.id} data-layer={b.layer}
        title={`${BLOCKS[b.kind].label}: ${BLOCKS[b.kind].description}${isShared ? ' (shared)' : ''}`}
        onClick={() => setSelection({ col: c.key, layer: b.layer, id: b.id })}
        onMouseEnter={() => isShared && setHover(b.kind)} onMouseLeave={() => setHover(null)}>
        {b.switchable && (
          <button className={`dsp-power ${b.on ? 'on' : ''}`} title={b.on ? 'Switch off (settings kept)' : 'Switch on'}
            onClick={(e) => { e.stopPropagation(); edit(c, setBlockOn(c.recipe, b.layer, b.id, !b.on)); }}>
            <Power size={9} />
          </button>
        )}
        <span className="dsp-block-label">{b.label}</span>
        {b.detail && <span className="dsp-block-detail">{b.detail}</span>}
        {b.removable && (
          <button className="dsp-remove" title="Remove" onClick={(e) => { e.stopPropagation(); edit(c, removeBlock(c.recipe, b.layer, b.id)); }}>
            <X size={9} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="dsp-map">
      <div className="dsp-map-main">
        <div className="dsp-map-toolbar">
          <span className="dsp-map-title">DSP Map</span>
          <select className="rack-map-select designer-select" value={note} onChange={(e) => setNote(Number(e.target.value))} title="The note every column plays">
            {NOTES.map((n) => <option key={n} value={n}>{midiNoteName(n)}</option>)}
          </select>
          <button className="designer-button" onClick={playAll} disabled={!shown.length}><Play size={10} /> Play all</button>
          <select className="rack-map-select designer-select dsp-map-picker" value="" onChange={(e) => e.target.value && add(e.target.value)} title="Add an instrument to compare">
            <option value="">+ Add instrument…</option>
            <optgroup label="Tracks">
              {tracks.filter((t: any) => t.type === 'midi' && soundOf(t) && !present.has(t.id)).map((t: any) => (
                <option key={t.id} value={`track:${t.id}`}>{t.name}</option>
              ))}
            </optgroup>
            {categories.map((cat) => (
              <optgroup key={cat} label={`Library · ${CATEGORY_NAMES[cat]}`}>
                {LIBRARY.filter((r) => r.category === cat).map((r) => <option key={r.id} value={`sound:${r.id}`}>{r.name}</option>)}
              </optgroup>
            ))}
          </select>
          <span className="designer-hint">Hover a shared block to find it in every column; its switch turns it off or on in all of them.</span>
        </div>
        {shown.length === 0 ? (
          <div className="detail-empty-message">Add an instrument to see its DSP chain.</div>
        ) : (
          <div className="dsp-map-grid" style={{ gridTemplateColumns: `132px repeat(${shown.length}, minmax(168px, 1fr))` }}>
            <div className="dsp-map-corner">Stages · shared</div>
            {shown.map((c) => (
              <div key={c.key} className={`dsp-map-head ${playing === c.key ? 'playing' : ''}`} data-col={c.key}>
                <div className="designer-row">
                  <button className="btn-icon designer-play" title={`Play ${midiNoteName(note)}`} onClick={() => play(c)}><Play size={12} /></button>
                  <span className="dsp-head-name" title={c.name}>{c.name}</span>
                  {c.column && <button className="btn-icon" title="Take off the map" onClick={() => remove(c)}><X size={11} /></button>}
                </div>
                <div className="dsp-head-source">
                  <span>{c.source}</span>
                  {!c.track && <button className="designer-link" onClick={() => moveToTrack(c)}>Use on a new track</button>}
                </div>
              </div>
            ))}
            {STAGES.map((stage, row) => (
              <Fragment key={stage.id}>
                <div className="dsp-map-stage" data-stage={stage.id}>
                  <div className="dsp-stage-name" title={stage.description}>{stage.label}</div>
                  {shared.filter((s) => s.stage === stage.id).map((s) => {
                    const allOn = s.on.every(Boolean);
                    const names = s.chains.map((i) => shown[i].name).join(', ');
                    return (
                      <div key={s.kind} className={`dsp-shared ${hover === s.kind ? 'hover' : ''} ${allOn ? 'on' : s.on.some(Boolean) ? 'some' : 'off'}`}
                        data-kind={s.kind} title={`${s.label}, in ${names}: switch it off or on in all of them`}
                        onMouseEnter={() => setHover(s.kind)} onMouseLeave={() => setHover(null)}>
                        <button className={`dsp-power ${allOn ? 'on' : ''}`} onClick={() => toggleShared(s)} title={allOn ? `Switch ${s.label} off everywhere` : `Switch ${s.label} on everywhere`}>
                          <Power size={9} />
                        </button>
                        <span>{s.label}</span>
                        <span className="dsp-shared-count">×{s.chains.length}</span>
                      </div>
                    );
                  })}
                </div>
                {shown.map((c) => cell(c, stage.id, row === 0))}
              </Fragment>
            ))}
          </div>
        )}
      </div>

      <div className="dsp-inspector">
        {selCol && selLayer && selBlock ? (
          <>
            <div className="dsp-inspector-title">
              {BLOCKS[selBlock.kind].label}
              <span>{selCol.name}{selCol.recipe.layers.length > 1 ? ` · layer ${selection!.layer + 1}` : ''}</span>
            </div>
            <div className="designer-hint">{BLOCKS[selBlock.kind].description}</div>
            <div className="designer-row">
              {selBlock.switchable && (
                <label className="designer-check">
                  <input type="checkbox" checked={selBlock.on} onChange={(e) => edit(selCol, setBlockOn(selCol.recipe, selBlock.layer, selBlock.id, e.target.checked))} /> On
                </label>
              )}
              {selBlock.removable && (
                <button className="designer-link" onClick={() => { edit(selCol, removeBlock(selCol.recipe, selBlock.layer, selBlock.id)); setSelection(null); }}>Remove</button>
              )}
            </div>
            <BlockParams key={`${selection!.col}/${selection!.layer}/${selection!.id}`} layer={selLayer} id={selBlock.id}
              onChange={(l) => edit(selCol, { ...selCol.recipe, layers: selCol.recipe.layers.map((x, i) => (i === selection!.layer ? l : x)) })}
              onRemove={() => { edit(selCol, removeBlock(selCol.recipe, selBlock.layer, selBlock.id)); setSelection(null); }} />
          </>
        ) : (
          <>
            <div className="dsp-inspector-title">Inspector</div>
            <div className="designer-hint">Click a block to edit it. Every sound, synth or acoustic, passes through the same stages:</div>
            {STAGES.map((s) => <div key={s.id} className="dsp-stage-help"><b>{s.label}</b> {s.description}</div>)}
          </>
        )}
      </div>
    </div>
  );
}
