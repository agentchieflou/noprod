import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Music, Drum, Piano, Sliders, Zap, Plug, FolderOpen, FolderPlus, Folder, Plus, Search, X, RefreshCw, AudioWaveform, Pencil, Download, Trash2 } from 'lucide-react';
import { LIBRARY, KITS, CATEGORY_NAMES, type SoundRecipe } from '@noprod/sound';
import { useDAWStore, createDefaultInstrument, createDrumKit } from '../store/useDAWStore';
import { DEVICE_DEFS, createDevice } from '../audio/devices';
import { MIDI_EFFECT_DEFS, createMidiEffect } from '../audio/midiEffects';
import { getPosition } from '../audio/transport';
import {
  subscribeLibrary, getPlaces, loadPlaces, addPlace, removePlace, reconnectPlace, allFiles,
  previewFile, stopPreview, decodeLibraryFile, type LibraryFolder, type LibraryFile
} from '../browser/library';
import { SOUND_PRESETS, DRUM_KIT_PRESETS, isDrumSample } from '../browser/presets';
import { subscribeAudioCore, getAudioCore, findNativePlugin, nativeDeviceFor } from '../native/audioCore';
import {
  createLibraryInstrument, createLibraryKit, kitSounds, previewKit, previewSound, stopSoundPreview, exportZip
} from '../audio/library';
import { subscribeUserSounds, getUserSounds, deleteUserSound } from '../audio/userSounds';

export const SAMPLE_DRAG_TYPE = 'application/x-noprod-sample';
export const SOUND_DRAG_TYPE = 'application/x-noprod-sound'; // a library sound's id

let placesLoaded = false;

interface Item {
  key: string;
  label: string;
  hint?: string;
  onLoad: () => void;          // double-click / +
  onClick?: () => void;        // single click (preview)
  dragFile?: LibraryFile;      // samples can be dragged onto tracks and slots
  dragSound?: string;          // so can library sounds (by id)
  group?: string;              // a sub-folder within its category
  recipe?: SoundRecipe;        // a library sound: its group can export as WAVs
  onEdit?: () => void;         // opens in the Sound Designer
  onDelete?: () => void;       // one of My Sounds
}

// Ableton-style Browser: categories backed by real data (the sound library,
// stock devices, MIDI effects, instrument presets, scanned plug-ins, saved
// racks, and audio files in user folders). Double-click or + loads an item
// onto the selected track (or a new one); click previews a sound, kit or
// sample; sounds and samples drag onto tracks/slots.
export default function BrowserSidebar({ onShowPluginScan, onEditSound }: { onShowPluginScan: () => void; onEditSound: (recipe: SoundRecipe) => void }) {
  const st = useDAWStore();
  const places = useSyncExternalStore(subscribeLibrary, getPlaces);
  const mySounds = useSyncExternalStore(subscribeUserSounds, getUserSounds);
  const audioCore = useSyncExternalStore(subscribeAudioCore, getAudioCore);
  const [open, setOpen] = useState<Record<string, boolean>>({ library: true });
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!placesLoaded) { placesLoaded = true; loadPlaces(); }
    return () => { stopPreview(); stopSoundPreview(); };
  }, []);

  const flash = (m: string) => { setMessage(m); setTimeout(() => setMessage(null), 2500); };
  const selected = st.tracks.find((t: any) => t.id === st.selectedTrackId)
    || st.returns.find((r: any) => r.id === st.selectedTrackId)
    || (st.selectedTrackId === 'master' ? { id: 'master', name: 'Master', type: 'master' } : null);
  const stripName = (s: any) => (s?.type === 'master' ? 'Master' : s?.name);

  // ---- load actions
  const loadInstrument = (inst: any, label: string) => {
    if (selected?.type === 'midi') { st.setTrackInstrument(selected.id, inst); flash(`${label} → ${selected.name}`); }
    else { st.addMidiTrackWithInstrument(inst, label); flash(`New MIDI track with ${label}`); }
  };
  const loadAudioDevice = (device: any) => {
    if (!selected) { flash('Select a track, return or the master first'); return; }
    st.addDeviceToTrack(selected.id, device);
    flash(`${device.name} → ${stripName(selected)}`);
  };
  const loadMidiEffect = (kind: string) => {
    if (selected?.type !== 'midi') { flash('Select a MIDI track first'); return; }
    st.addMidiEffect(selected.id, createMidiEffect(kind));
    flash(`${MIDI_EFFECT_DEFS[kind].name} → ${selected.name}`);
  };
  const loadSample = async (f: LibraryFile) => {
    if (selected?.type !== 'audio') { flash('Select an audio track, or drag the sample onto one'); return; }
    try {
      const buf = await decodeLibraryFile(f.id);
      st.addRegion({ trackId: selected.id, file: f.name, audioBuffer: buf, startTime: getPosition(), duration: buf.duration });
      flash(`${f.name} → ${selected.name}`);
    } catch (err: any) { flash(`Could not load: ${err.message || err}`); }
  };
  const sampleItem = (f: LibraryFile): Item => ({
    key: f.id, label: f.name, hint: f.path, dragFile: f,
    onClick: () => previewFile(f.id).catch(() => flash('Could not preview this file')),
    onLoad: () => loadSample(f)
  });

  // ---- categories
  const files = allFiles();
  const categories: { id: string; label: string; icon: ReactNode; items: Item[]; empty: ReactNode }[] = [
    {
      // Sounds built from scratch (packages/sound), in folders by kind
      id: 'library', label: 'Library', icon: <AudioWaveform size={13} />,
      items: [
        ...KITS.map((k) => ({
          key: k.id, label: k.name, group: 'Drum Kits', hint: `Drum kit · ${Object.keys(k.pads).length} pads`,
          onClick: () => previewKit(k, kitSounds(k)), onLoad: () => loadInstrument(createLibraryKit(k), k.name)
        })),
        ...mySounds.map((r) => ({
          key: r.id, label: r.name, group: 'My Sounds', dragSound: r.id, recipe: r,
          hint: `My sound · ${CATEGORY_NAMES[r.category]}`,
          onClick: () => previewSound(r), onLoad: () => loadInstrument(createLibraryInstrument(r), r.name),
          onEdit: () => onEditSound(r),
          onDelete: () => { if (confirm(`Delete “${r.name}” from My Sounds?`)) deleteUserSound(r.id); }
        })),
        ...LIBRARY.map((r) => ({
          key: r.id, label: r.name, group: CATEGORY_NAMES[r.category], dragSound: r.id, recipe: r,
          hint: `${CATEGORY_NAMES[r.category]}${r.tags?.length ? ` · ${r.tags.join(', ')}` : ''}`,
          onClick: () => previewSound(r), onLoad: () => loadInstrument(createLibraryInstrument(r), r.name),
          onEdit: () => onEditSound(r)
        }))
      ],
      empty: null
    },
    {
      id: 'sounds', label: 'Sounds', icon: <Music size={13} />,
      items: SOUND_PRESETS.map((p) => ({ key: p.name, label: p.name, hint: 'NoProd Synth preset', onLoad: () => loadInstrument(p.make(), p.name) })),
      empty: null
    },
    {
      id: 'drums', label: 'Drums', icon: <Drum size={13} />,
      items: [
        ...DRUM_KIT_PRESETS.map((p) => ({ key: p.name, label: p.name, hint: 'NoProd Drums kit', onLoad: () => loadInstrument(p.make(), p.name) })),
        ...files.filter((f) => isDrumSample(f.path)).map(sampleItem)
      ],
      empty: null
    },
    {
      id: 'instruments', label: 'Instruments', icon: <Piano size={13} />,
      items: [
        { key: 'synth', label: 'NoProd Synth', hint: 'Subtractive synth', onLoad: () => loadInstrument(createDefaultInstrument(), 'NoProd Synth') },
        { key: 'drums', label: 'NoProd Drums', hint: 'Synthesized drum kit', onLoad: () => loadInstrument(createDrumKit(), 'NoProd Drums') }
      ],
      empty: null
    },
    {
      id: 'audio-fx', label: 'Audio Effects', icon: <Sliders size={13} />,
      items: [
        ...Object.values(DEVICE_DEFS).map((d) => ({ key: d.kind, label: d.name, hint: d.description, onLoad: () => loadAudioDevice(createDevice(d.kind)) })),
        { key: 'rack', label: 'Audio Effect Rack', hint: 'Empty rack with 4 macros', onLoad: () => { if (!selected) { flash('Select a track first'); return; } st.addRackToTrack(selected.id); flash(`Rack → ${stripName(selected)}`); } },
        ...st.savedRacks.map((r: any, i: number) => ({ key: `rack-${i}`, label: r.name, hint: 'Saved rack preset', onLoad: () => { if (!selected) { flash('Select a track first'); return; } st.addSavedRackToTrack(selected.id, i); flash(`${r.name} → ${stripName(selected)}`); } }))
      ],
      empty: null
    },
    {
      id: 'midi-fx', label: 'MIDI Effects', icon: <Zap size={13} />,
      items: Object.values(MIDI_EFFECT_DEFS).map((d) => ({ key: d.kind, label: d.name, hint: d.description, onLoad: () => loadMidiEffect(d.kind) })),
      empty: null
    },
    {
      // Plug-ins the Audio Core found (hostable on any track), then ones only
      // the browser's folder scan saw, which need scanning in the Audio Core
      id: 'plugins', label: 'Plug-ins', icon: <Plug size={13} />,
      items: [
        ...(audioCore.state?.availablePlugins ?? []).map((p) => ({
          key: `native:${p.path}:${p.pluginId}`, label: p.name, hint: `${p.format}${p.vendor ? ` · ${p.vendor}` : ''} · hosted by the Audio Core`,
          onLoad: () => loadAudioDevice(nativeDeviceFor(p))
        })),
        ...st.scannedPlugins.filter((p: any) => !findNativePlugin(p.name)).map((p: any) => ({
          key: p.path, label: p.name, hint: `${p.format} · ${p.path} · scan its folder in the Audio Core to host it`,
          onLoad: () => { flash('Scan this folder in the Audio Core first (VST Folders Scan tab)'); onShowPluginScan(); }
        }))
      ],
      empty: <button className="browser-link" onClick={onShowPluginScan}>Scan plug-in folders…</button>
    },
    {
      id: 'samples', label: 'Samples', icon: <Music size={13} />,
      items: files.map(sampleItem),
      empty: <button className="browser-link" onClick={() => addPlace()}>Add a sample folder…</button>
    }
  ];

  const q = query.trim().toLowerCase();
  const matches = (it: Item) => !q || it.label.toLowerCase().includes(q) || it.hint?.toLowerCase().includes(q);
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  const renderItem = (it: Item, depth = 1) => (
    <div
      key={it.key}
      className="browser-item"
      style={{ paddingLeft: 8 + depth * 12 }}
      title={`${it.hint ? `${it.hint}\n` : ''}Double-click to load${it.onClick ? ', click to preview' : ''}${it.dragFile || it.dragSound ? ', drag onto a track' : ''}`}
      draggable={!!(it.dragFile || it.dragSound)}
      onDragStart={(e) => {
        if (it.dragFile) e.dataTransfer.setData(SAMPLE_DRAG_TYPE, JSON.stringify(it.dragFile));
        if (it.dragSound) e.dataTransfer.setData(SOUND_DRAG_TYPE, it.dragSound);
      }}
      onClick={it.onClick}
      onDoubleClick={it.onLoad}
    >
      <span className="browser-item-label">{it.label}</span>
      {it.onDelete && <button className="btn-icon browser-load" title="Delete" onClick={(e) => { e.stopPropagation(); it.onDelete!(); }}><Trash2 size={11} /></button>}
      {it.onEdit && <button className="btn-icon browser-load" title="Edit in the Sound Designer" onClick={(e) => { e.stopPropagation(); it.onEdit!(); }}><Pencil size={11} /></button>}
      <button className="btn-icon browser-load" title="Load" onClick={(e) => { e.stopPropagation(); it.onLoad(); }}><Plus size={11} /></button>
    </div>
  );

  // A category's items, in collapsible groups when they have them
  const renderItems = (categoryId: string, items: Item[]) => {
    if (!items.some((it) => it.group)) return items.map((it) => renderItem(it));
    const groups = [...new Set(items.map((it) => it.group || ''))];
    return groups.map((group) => {
      const key = `${categoryId}/${group}`;
      const inGroup = items.filter((it) => (it.group || '') === group);
      const groupOpen = open[key] || !!q;
      return (
        <div key={key}>
          <div className="browser-folder" style={{ paddingLeft: 20 }} onClick={() => toggle(key)}>
            {groupOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<Folder size={12} /> {group}
            <span className="browser-count">{inGroup.length}</span>
            {inGroup.some((it) => it.recipe) && (
              <button className="btn-icon browser-load" title={`Download ${group} as WAVs (zip)`}
                onClick={(e) => {
                  e.stopPropagation();
                  flash(`Rendering ${group}…`);
                  exportZip(group, inGroup.flatMap((it) => (it.recipe ? [it.recipe] : []))).then(() => flash(`${group}.zip downloaded`));
                }}>
                <Download size={11} />
              </button>
            )}
          </div>
          {groupOpen && inGroup.map((it) => renderItem(it, 2))}
        </div>
      );
    });
  };

  const renderFolder = (folder: LibraryFolder, depth: number, key: string): ReactNode => {
    const isOpen = open[key];
    return (
      <div key={key}>
        <div className="browser-folder" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(key)}>
          {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<Folder size={12} /> {folder.name || 'Folder'}
        </div>
        {isOpen && (
          <>
            {folder.folders.map((sub) => renderFolder(sub, depth + 1, `${key}/${sub.name}`))}
            {folder.files.map(sampleItem).filter(matches).map((it) => renderItem(it, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="browser-sidebar">
      <div className="browser-header">
        <h4>Browser</h4>
      </div>
      <div className="browser-search">
        <Search size={12} />
        <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button className="btn-icon" onClick={() => setQuery('')}><X size={11} /></button>}
      </div>
      <div className="browser-tree">
        {categories.map((c) => {
          const items = c.items.filter(matches);
          const isOpen = open[c.id] || (!!q && items.length > 0);
          return (
            <div key={c.id}>
              <div className={`btn-category ${isOpen ? 'active' : ''}`} onClick={() => toggle(c.id)}>
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{c.icon} {c.label}
                <span className="browser-count">{c.items.length}</span>
              </div>
              {isOpen && (items.length ? renderItems(c.id, items) : <div className="browser-empty">{c.empty || 'Nothing here yet'}</div>)}
            </div>
          );
        })}

        {/* Places: user folders as expandable trees */}
        <div className={`btn-category ${open.places ? 'active' : ''}`} onClick={() => toggle('places')}>
          {open.places ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<FolderOpen size={13} /> Places
          <span className="browser-count">{places.length}</span>
          <button className="btn-icon" style={{ marginLeft: 'auto' }} title="Add a folder" onClick={(e) => { e.stopPropagation(); addPlace(); setOpen((o) => ({ ...o, places: true })); }}>
            <FolderPlus size={12} />
          </button>
        </div>
        {open.places && (places.length === 0 ? (
          <div className="browser-empty"><button className="browser-link" onClick={() => addPlace()}>Add a folder…</button></div>
        ) : places.map((p) => (
          <div key={p.id}>
            {p.root ? renderFolder(p.root, 1, `place:${p.id}`) : (
              <div className="browser-folder" style={{ paddingLeft: 20 }}>
                <Folder size={12} /> {p.name}
                {p.status === 'needs-permission' && <button className="browser-link" onClick={() => reconnectPlace(p.id)}><RefreshCw size={10} /> reconnect</button>}
                {p.status === 'scanning' && <span className="browser-count">scanning…</span>}
              </div>
            )}
            <button className="browser-link browser-remove-place" onClick={() => removePlace(p.id)}>remove {p.name}</button>
          </div>
        )))}
      </div>
      {message && <div className="browser-message">{message}</div>}
    </div>
  );
}
