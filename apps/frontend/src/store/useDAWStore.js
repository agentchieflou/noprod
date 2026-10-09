import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { createDevice } from '../audio/devices';

// Undo/redo: which slice of the store is history-tracked. Transport/selection/UI
// state stays out so undoing never yanks the playhead or flips the view.
const UNDOABLE_KEYS = [
  'tracks', 'regions', 'sessionClips', 'bpm', 'vstScanPaths',
  'masterVolume', 'masterPan', 'returns', 'masterPlugins'
];
const HISTORY_LIMIT = 100;
// Continuous gestures (fader/dial/param drags) coalesce into one entry as long
// as change events for the same target keep arriving within this window.
// Device params coalesce per device, since one gesture can move several
// params at once (e.g. dragging an EQ band changes its Freq and Gain).
const COALESCE_MS = 800;

let lastCoalesceKey = null;
let lastCoalesceTime = 0;

const takeSnapshot = (state) => {
  const snap = {};
  UNDOABLE_KEYS.forEach((k) => { snap[k] = state[k]; });
  return snap;
};

// Audio Effect Rack: a container device with nested devices and 4 macro knobs.
// Macro mappings scale a contained device's parameter across [min, max] as the
// macro sweeps 0..100.
export const createEmptyRack = () => ({
  id: uuidv4(),
  name: 'Audio Effect Rack',
  type: 'rack',
  parameters: {},
  devices: [],
  macros: [1, 2, 3, 4].map(i => ({ id: uuidv4(), name: `Macro ${i}`, value: 0, mappings: [] }))
});

// Deep-copy a rack with fresh ids (device ids remapped inside macro mappings)
// so presets can be instantiated on any track without sharing state.
export const cloneRack = (rack) => {
  const idMap = {};
  const devices = rack.devices.map(d => {
    const nid = uuidv4();
    idMap[d.id] = nid;
    return { ...d, id: nid, parameters: { ...d.parameters } };
  });
  return {
    ...rack,
    id: uuidv4(),
    devices,
    macros: rack.macros.map(m => ({
      ...m,
      id: uuidv4(),
      mappings: m.mappings
        .map(mp => ({ ...mp, deviceId: idMap[mp.deviceId] }))
        .filter(mp => mp.deviceId)
    }))
  };
};

// Device chains live on tracks, returns and the master strip. Apply
// `fn(plugins) -> plugins` to whichever strip `stripId` names and return the
// partial state to set.
export const MASTER_STRIP_ID = 'master';

const mapStripPlugins = (state, stripId, fn) => {
  if (stripId === MASTER_STRIP_ID) return { masterPlugins: fn(state.masterPlugins) };
  if (state.returns.some(r => r.id === stripId)) {
    return { returns: state.returns.map(r => r.id === stripId ? { ...r, plugins: fn(r.plugins) } : r) };
  }
  return { tracks: state.tracks.map(t => t.id === stripId ? { ...t, plugins: fn(t.plugins) } : t) };
};

const mapRack = (state, stripId, rackId, fn) =>
  mapStripPlugins(state, stripId, plugins => plugins.map(p => p.id === rackId ? fn(p) : p));

// Return tracks: each has its own device chain; every track has a send
// level per return (track.sends[returnId], 0..1, post-fader).
export const RETURN_LETTERS = 'ABCDEFGHIJKL';

const createReturn = (name, plugins = []) => ({
  id: uuidv4(),
  name,
  volume: 0.5,
  pan: 0,
  isMuted: false,
  plugins
});

// Returns are fully wet: the dry signal already reaches the master directly.
const wet = (kind, overrides = {}) => {
  const d = createDevice(kind);
  return { ...d, id: uuidv4(), parameters: { ...d.parameters, 'Dry/Wet': 100, ...overrides } };
};

const DEFAULT_RETURNS = [
  { ...createReturn('Reverb', [wet('reverb')]), id: 'return-a' },
  { ...createReturn('Delay', [wet('delay', { Time: 0.375, Feedback: 35 })]), id: 'return-b' }
];

// Default instrument attached to new MIDI tracks so their clips are audible.
export const createDefaultInstrument = () => ({
  id: uuidv4(),
  name: 'NoProd Synth',
  type: 'instrument',
  parameters: {
    Waveform: 'sawtooth',
    Attack: 0.01,
    Decay: 0.15,
    Sustain: 0.6,
    Release: 0.2,
    Gain: 0.7
  }
});

export const useDAWStore = create((set, get) => ({
  // Global State
  isPlaying: false,
  isRecording: false,
  isMetronomeEnabled: false,
  viewMode: 'arrangement', // 'arrangement' | 'session'
  playbackPosition: 0, // in seconds
  selectedTrackId: null,
  selectedRegionId: null,
  bpm: 120,
  
  // Mix Bus Volumes
  masterVolume: 0.8,
  masterPan: 0.0, // -1 (left) to 1 (right)
  // Return tracks (A Reverb, B Delay by default) and the master device chain
  returns: DEFAULT_RETURNS,
  masterPlugins: [],
  isLimiterEnabled: true, // Master bus brickwall limiter

  // Punch recording: auto start/stop recording at these timeline positions
  punchInTime: 4,
  punchOutTime: 8,
  isPunchEnabled: false,
  
  // Custom VST Paths for local scanning (Antares, FabFilter)
  vstScanPaths: [
    'C:/Program Files/Common Files/VST3',
    'C:/Program Files/Steinberg/VstPlugins'
  ],

  // Plugins found by scanning real folders (persisted in localStorage).
  // [{ name, format, path }]
  scannedPlugins: (() => {
    try {
      return JSON.parse(localStorage.getItem('noprod-scanned-plugins') || '[]');
    } catch {
      return [];
    }
  })(),

  // Tracks list
  tracks: [
    {
      id: 'track-audio-1',
      name: '1 Audio',
      type: 'audio',
      routing: 'master', // "master", "group-id", "reverb"
      groupId: null, // If member of a group
      volume: 0.8,
      pan: 0.0,
      sends: { 'return-a': 0.2 },
      isMuted: false,
      isSoloed: false,
      isArmed: false,
      color: '#3b82f6',
      plugins: [
        { id: uuidv4(), name: 'Antares AutoTune', type: 'vst', parameters: { 'Retune Speed': 20, 'Humanize': 60 } }
      ],
    },
    {
      id: 'track-midi-2',
      name: '2 MIDI',
      type: 'midi',
      routing: 'master',
      groupId: null,
      volume: 0.8,
      pan: 0.0,
      sends: {},
      isMuted: false,
      isSoloed: false,
      isArmed: false,
      color: '#10b981',
      instrument: createDefaultInstrument(),
      plugins: [
        { id: uuidv4(), name: 'FabFilter Pro-Q 3', type: 'vst', parameters: { 'Freq': 440, 'Gain': 0.0 } }
      ],
    },
  ],
  
  // Arrangement Regions
  regions: [], // { id, trackId, file, audioBuffer, startTime, duration }

  // Session View Grid slots: { [trackId]: { [slotIndex]: clipData } }
  sessionClips: {},

  // Saved Audio Effect Rack presets, reusable across tracks
  savedRacks: [],

  // Undo/Redo History
  past: [],
  future: [],

  // Push the current undoable slice onto the history stack. Call BEFORE mutating.
  // Pass a coalesceKey for continuous gestures so a drag lands as one entry.
  record: (coalesceKey = null) => {
    const now = Date.now();
    if (coalesceKey && coalesceKey === lastCoalesceKey && now - lastCoalesceTime < COALESCE_MS) {
      lastCoalesceTime = now;
      return;
    }
    lastCoalesceKey = coalesceKey;
    lastCoalesceTime = now;
    set((state) => ({
      past: [...state.past.slice(-(HISTORY_LIMIT - 1)), takeSnapshot(state)],
      future: []
    }));
  },

  undo: () => set((state) => {
    if (state.past.length === 0) return {};
    lastCoalesceKey = null;
    const previous = state.past[state.past.length - 1];
    return {
      ...previous,
      past: state.past.slice(0, -1),
      future: [...state.future, takeSnapshot(state)]
    };
  }),

  redo: () => set((state) => {
    if (state.future.length === 0) return {};
    lastCoalesceKey = null;
    const next = state.future[state.future.length - 1];
    return {
      ...next,
      past: [...state.past, takeSnapshot(state)],
      future: state.future.slice(0, -1)
    };
  }),

  // Global Actions
  togglePlayback: () => set((state) => ({ isPlaying: !state.isPlaying })),
  toggleRecording: () => set((state) => ({ isRecording: !state.isRecording })),
  toggleMetronome: () => set((state) => ({ isMetronomeEnabled: !state.isMetronomeEnabled })),
  setViewMode: (mode) => set({ viewMode: mode }),
  setPlaybackPosition: (pos) => set({ playbackPosition: pos }),
  setBpm: (bpm) => { get().record('bpm'); set({ bpm }); },
  
  setSelectedTrackId: (id) => set({ selectedTrackId: id }),
  setSelectedRegionId: (id) => set({ selectedRegionId: id }),
  
  setMasterVolume: (vol) => { get().record('master-volume'); set({ masterVolume: vol }); },
  setMasterPan: (pan) => { get().record('master-pan'); set({ masterPan: pan }); },
  // Return Track Actions
  addReturn: () => { get().record(); set((state) => ({
    returns: [...state.returns, createReturn('Return')]
  })); },

  // Removing a return also drops every track's send to it
  removeReturn: (id) => { get().record(); set((state) => ({
    returns: state.returns.filter(r => r.id !== id),
    tracks: state.tracks.map(t => {
      if (!t.sends || !(id in t.sends)) return t;
      const { [id]: _removed, ...sends } = t.sends;
      return { ...t, sends };
    }),
    selectedTrackId: state.selectedTrackId === id ? null : state.selectedTrackId
  })); },

  // patch: { volume, pan, isMuted, name }
  updateReturn: (id, patch) => {
    get().record('volume' in patch || 'pan' in patch ? `return-${id}-${Object.keys(patch).join()}` : null);
    set((state) => ({ returns: state.returns.map(r => r.id === id ? { ...r, ...patch } : r) }));
  },
  toggleLimiter: () => set((state) => ({ isLimiterEnabled: !state.isLimiterEnabled })),

  setRecording: (isRecording) => set({ isRecording }),
  togglePunch: () => set((state) => ({ isPunchEnabled: !state.isPunchEnabled })),
  setPunchRegion: (punchInTime, punchOutTime) => set({ punchInTime, punchOutTime }),

  loadAbletonSet: (tempo, tracks, regions) => { get().record(); set({
    bpm: tempo,
    tracks,
    regions,
    selectedTrackId: null,
    selectedRegionId: null
  }); },

  addVstScanPath: (path) => { get().record(); set((state) => ({
    vstScanPaths: [...state.vstScanPaths, path]
  })); },

  removeVstScanPath: (path) => { get().record(); set((state) => ({
    vstScanPaths: state.vstScanPaths.filter(p => p !== path)
  })); },

  setScannedPlugins: (scannedPlugins) => {
    try {
      localStorage.setItem('noprod-scanned-plugins', JSON.stringify(scannedPlugins));
    } catch { /* storage full/unavailable: list still lives in memory */ }
    set({ scannedPlugins });
  },

  // Track Actions
  addTrack: (type) => { get().record(); set((state) => {
    const id = uuidv4();
    return {
      tracks: [
        ...state.tracks,
        {
          id,
          name: `${state.tracks.length + 1} ${type === 'audio' ? 'Audio' : type === 'midi' ? 'MIDI' : 'Group'}`,
          type, // 'audio' | 'midi' | 'group'
          routing: 'master',
          groupId: null,
          volume: 0.8,
          pan: 0.0,
          sends: {},
          isMuted: false,
          isSoloed: false,
          isArmed: false,
          color: type === 'audio' ? '#3b82f6' : type === 'midi' ? '#10b981' : '#a855f7',
          instrument: type === 'midi' ? createDefaultInstrument() : null,
          plugins: [],
        }
      ]
    };
  }); },

  // Group Track functionality: links selected tracks into a Group Track
  groupTracks: (trackIds) => { get().record(); set((state) => {
    const groupId = uuidv4();
    const groupTrackName = `${state.tracks.filter(t => t.type === 'group').length + 1} Group`;
    
    // Create new group track
    const newGroupTrack = {
      id: groupId,
      name: groupTrackName,
      type: 'group',
      routing: 'master',
      groupId: null,
      isCollapsed: false,
      volume: 0.8,
      pan: 0.0,
      sends: {},
      isMuted: false,
      isSoloed: false,
      isArmed: false,
      color: '#a855f7', // Purple
      plugins: []
    };

    // Update member tracks to link to group and route to group
    const updatedTracks = state.tracks.map(t => {
      if (trackIds.includes(t.id)) {
        return { ...t, groupId: groupId, routing: groupId };
      }
      return t;
    });

    return {
      tracks: [...updatedTracks, newGroupTrack]
    };
  }); },

  removeTrack: (id) => { get().record(); set((state) => {
    // If we delete a group, set its members groupId back to null and routing back to master
    const updatedTracks = state.tracks.map(t => {
      if (t.groupId === id) {
        return { ...t, groupId: null, routing: 'master' };
      }
      return t;
    }).filter(t => t.id !== id);

    return {
      tracks: updatedTracks,
      regions: state.regions.filter(r => r.trackId !== id),
      selectedTrackId: state.selectedTrackId === id ? null : state.selectedTrackId
    };
  }); },

  updateTrackRouting: (id, routing) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, routing } : t)
  })); },

  updateTrackVolume: (id, volume) => { get().record(`track-volume-${id}`); set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, volume } : t)
  })); },

  updateTrackPan: (id, pan) => { get().record(`track-pan-${id}`); set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, pan } : t)
  })); },

  updateTrackSend: (id, returnId, val) => { get().record(`track-send-${id}-${returnId}`); set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, sends: { ...(t.sends || {}), [returnId]: val } } : t)
  })); },

  toggleMuteTrack: (id) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, isMuted: !t.isMuted } : t)
  })); },

  toggleSoloTrack: (id) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, isSoloed: !t.isSoloed } : t)
  })); },

  toggleArmTrack: (id) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, isArmed: !t.isArmed } : t)
  })); },

  updateTrackColor: (id, color) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, color } : t)
  })); },

  // Fold/unfold a group track (view state — deliberately not in undo history)
  toggleGroupCollapse: (id) => set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, isCollapsed: !t.isCollapsed } : t)
  })),

  // Instrument Actions (MIDI tracks)
  setTrackInstrument: (trackId, instrument) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? { ...t, instrument } : t)
  })); },

  removeTrackInstrument: (trackId) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? { ...t, instrument: null } : t)
  })); },

  updateInstrumentParameter: (trackId, paramName, val) => { get().record(`instrument-param-${trackId}-${paramName}`); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId && t.instrument ? {
      ...t,
      instrument: {
        ...t.instrument,
        parameters: { ...t.instrument.parameters, [paramName]: val }
      }
    } : t)
  })); },

  // Device Chain Actions. `stripId` is a track id, a return id or MASTER_STRIP_ID.
  addDeviceToTrack: (stripId, device) => { get().record(); set((state) =>
    mapStripPlugins(state, stripId, plugins => [...plugins, { ...device, id: uuidv4() }])
  ); },

  removeDeviceFromTrack: (stripId, deviceId) => { get().record(); set((state) =>
    mapStripPlugins(state, stripId, plugins => plugins.filter(p => p.id !== deviceId))
  ); },

  updateDeviceParameter: (stripId, deviceId, paramName, val) => { get().record(`device-param-${deviceId}`); set((state) =>
    mapStripPlugins(state, stripId, plugins => plugins.map(p => p.id === deviceId ? {
      ...p,
      parameters: { ...p.parameters, [paramName]: val }
    } : p))
  ); },

  // Audio Effect Rack Actions
  addRackToTrack: (stripId) => { get().record(); set((state) =>
    mapStripPlugins(state, stripId, plugins => [...plugins, createEmptyRack()])
  ); },

  // Wrap all of a strip's loose (non-rack) devices into a new rack
  groupTrackDevicesIntoRack: (stripId) => { get().record(); set((state) =>
    mapStripPlugins(state, stripId, plugins => {
      const loose = plugins.filter(p => p.type !== 'rack');
      if (loose.length === 0) return plugins;
      return [...plugins.filter(p => p.type === 'rack'), { ...createEmptyRack(), devices: loose }];
    })
  ); },

  addDeviceToRack: (stripId, rackId, device) => { get().record(); set((state) =>
    mapRack(state, stripId, rackId, rack => ({ ...rack, devices: [...rack.devices, { ...device, id: uuidv4() }] }))
  ); },

  removeDeviceFromRack: (stripId, rackId, deviceId) => { get().record(); set((state) =>
    mapRack(state, stripId, rackId, rack => ({
      ...rack,
      devices: rack.devices.filter(d => d.id !== deviceId),
      macros: rack.macros.map(m => ({ ...m, mappings: m.mappings.filter(mp => mp.deviceId !== deviceId) }))
    }))
  ); },

  updateRackDeviceParameter: (stripId, rackId, deviceId, paramName, val) => { get().record(`rack-device-${deviceId}`); set((state) =>
    mapRack(state, stripId, rackId, rack => ({
      ...rack,
      devices: rack.devices.map(d => d.id === deviceId ? {
        ...d,
        parameters: { ...d.parameters, [paramName]: val }
      } : d)
    }))
  ); },

  // Move a macro: store its value and push every mapped parameter to
  // min + (value/100) * (max - min).
  updateMacroValue: (stripId, rackId, macroId, value) => { get().record(`macro-${macroId}`); set((state) =>
    mapRack(state, stripId, rackId, rack => {
      const macros = rack.macros.map(m => m.id === macroId ? { ...m, value } : m);
      const macro = macros.find(m => m.id === macroId);
      let devices = rack.devices;
      macro.mappings.forEach(mp => {
        const mapped = Math.round((mp.min + (value / 100) * (mp.max - mp.min)) * 100) / 100;
        devices = devices.map(d => d.id === mp.deviceId ? {
          ...d,
          parameters: { ...d.parameters, [mp.paramName]: mapped }
        } : d);
      });
      return { ...rack, macros, devices };
    })
  ); },

  addMacroMapping: (stripId, rackId, macroId, deviceId, paramName, min = 0, max = 100) => { get().record(); set((state) =>
    mapRack(state, stripId, rackId, rack => ({
      ...rack,
      macros: rack.macros.map(m => m.id === macroId ? {
        ...m,
        mappings: m.mappings.some(mp => mp.deviceId === deviceId && mp.paramName === paramName)
          ? m.mappings
          : [...m.mappings, { deviceId, paramName, min, max }]
      } : m)
    }))
  ); },

  removeMacroMapping: (stripId, rackId, macroId, index) => { get().record(); set((state) =>
    mapRack(state, stripId, rackId, rack => ({
      ...rack,
      macros: rack.macros.map(m => m.id === macroId ? {
        ...m,
        mappings: m.mappings.filter((_, i) => i !== index)
      } : m)
    }))
  ); },

  saveRackPreset: (rack) => set((state) => ({
    savedRacks: [...state.savedRacks, { ...cloneRack(rack), name: `${rack.name} ${state.savedRacks.length + 1}` }]
  })),

  addSavedRackToTrack: (stripId, presetIndex) => { get().record(); set((state) => {
    const preset = state.savedRacks[presetIndex];
    if (!preset) return {};
    return mapStripPlugins(state, stripId, plugins => [...plugins, cloneRack(preset)]);
  }); },

  // Region Actions
  addRegion: (regionData) => { get().record(); set((state) => {
    const id = uuidv4();
    return {
      regions: [...state.regions, { startOffset: 0, ...regionData, id }],
      selectedRegionId: id
    };
  }); },

  updateRegionPosition: (id, startTime) => { get().record(`region-move-${id}`); set((state) => ({
    regions: state.regions.map(r => r.id === id ? { ...r, startTime } : r)
  })); },

  updateRegionTrim: (id, startTime, duration, startOffset) => { get().record(`region-trim-${id}`); set((state) => ({
    regions: state.regions.map(r => r.id === id ? { ...r, startTime, duration, startOffset } : r)
  })); },

  // Warp properties: { warpEnabled, warpMode, originalBpm, transients }
  updateRegionWarp: (id, patch) => { get().record(`region-warp-${id}`); set((state) => ({
    regions: state.regions.map(r => r.id === id ? { ...r, ...patch } : r)
  })); },

  // Freeze & Flatten
  setTrackFrozen: (trackId, frozenBuffer, frozenDuration) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? { ...t, isFrozen: true, frozenBuffer, frozenDuration } : t)
  })); },

  unfreezeTrack: (trackId) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? { ...t, isFrozen: false, frozenBuffer: null, frozenDuration: 0 } : t)
  })); },

  // Permanently replace a frozen track's clips and devices with the rendered audio
  flattenTrack: (trackId) => { get().record(); set((state) => {
    const track = state.tracks.find(t => t.id === trackId);
    if (!track || !track.isFrozen || !track.frozenBuffer) return {};
    const flatRegion = {
      id: uuidv4(),
      trackId,
      file: `${track.name} (flattened)`,
      audioBuffer: track.frozenBuffer,
      startTime: 0,
      duration: track.frozenDuration,
      startOffset: 0
    };
    return {
      regions: [...state.regions.filter(r => r.trackId !== trackId), flatRegion],
      tracks: state.tracks.map(t => t.id === trackId ? {
        ...t,
        type: 'audio',
        instrument: null,
        plugins: [],
        isFrozen: false,
        frozenBuffer: null,
        frozenDuration: 0
      } : t)
    };
  }); },

  // MIDI Region Actions
  // notes: [{ id, pitch (MIDI number), start (sec, region-relative), duration (sec), velocity (0..1) }]
  addMidiRegion: (trackId, startTime, duration, notes = []) => { get().record(); set((state) => {
    const id = uuidv4();
    return {
      regions: [...state.regions, {
        id,
        trackId,
        type: 'midi',
        file: 'MIDI Clip',
        audioBuffer: null,
        startTime,
        duration,
        startOffset: 0,
        notes
      }],
      selectedRegionId: id
    };
  }); },

  updateRegionNotes: (id, notes) => { get().record(`region-notes-${id}`); set((state) => ({
    regions: state.regions.map(r => r.id === id ? { ...r, notes } : r)
  })); },

  removeRegion: (id) => { get().record(); set((state) => ({
    regions: state.regions.filter(r => r.id !== id),
    selectedRegionId: state.selectedRegionId === id ? null : state.selectedRegionId
  })); },

  // Session Actions
  setSessionClip: (trackId, slotIndex, clipData) => { get().record(); set((state) => ({
    sessionClips: {
      ...state.sessionClips,
      [trackId]: {
        ...(state.sessionClips[trackId] || {}),
        [slotIndex]: clipData
      }
    }
  })); }
}));
