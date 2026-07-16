import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

// Undo/redo: which slice of the store is history-tracked. Transport/selection/UI
// state stays out so undoing never yanks the playhead or flips the view.
const UNDOABLE_KEYS = [
  'tracks', 'regions', 'sessionClips', 'bpm', 'vstScanPaths',
  'masterVolume', 'masterPan', 'reverbReturnVolume'
];
const HISTORY_LIMIT = 100;
// Continuous gestures (fader/dial/param drags) coalesce into one entry as long
// as change events for the same target keep arriving within this window.
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
  reverbReturnVolume: 0.5, // Return Track A volume
  isLimiterEnabled: true, // Master bus brickwall limiter
  
  // Custom VST Paths for local scanning (Antares, FabFilter)
  vstScanPaths: [
    'C:/Program Files/Common Files/VST3',
    'C:/Program Files/Steinberg/VstPlugins'
  ],

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
      sendReverb: 0.2,
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
      sendReverb: 0.0,
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
  setReverbReturnVolume: (vol) => { get().record('reverb-return'); set({ reverbReturnVolume: vol }); },
  toggleLimiter: () => set((state) => ({ isLimiterEnabled: !state.isLimiterEnabled })),

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
          sendReverb: 0.0,
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
      sendReverb: 0.0,
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

  updateTrackSendReverb: (id, val) => { get().record(`track-send-${id}`); set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, sendReverb: val } : t)
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

  // Device Chain Actions
  addDeviceToTrack: (trackId, device) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: [...t.plugins, { ...device, id: uuidv4() }]
    } : t)
  })); },

  removeDeviceFromTrack: (trackId, deviceId) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: t.plugins.filter(p => p.id !== deviceId)
    } : t)
  })); },

  updateDeviceParameter: (trackId, deviceId, paramName, val) => { get().record(`device-param-${deviceId}-${paramName}`); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: t.plugins.map(p => p.id === deviceId ? {
        ...p,
        parameters: { ...p.parameters, [paramName]: val }
      } : p)
    } : t)
  })); },

  // Audio Effect Rack Actions
  addRackToTrack: (trackId) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: [...t.plugins, createEmptyRack()]
    } : t)
  })); },

  // Wrap all of a track's loose (non-rack) devices into a new rack
  groupTrackDevicesIntoRack: (trackId) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => {
      if (t.id !== trackId) return t;
      const loose = t.plugins.filter(p => p.type !== 'rack');
      if (loose.length === 0) return t;
      const rack = { ...createEmptyRack(), devices: loose };
      return { ...t, plugins: [...t.plugins.filter(p => p.type === 'rack'), rack] };
    })
  })); },

  addDeviceToRack: (trackId, rackId, device) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: t.plugins.map(p => p.id === rackId ? {
        ...p,
        devices: [...p.devices, { ...device, id: uuidv4() }]
      } : p)
    } : t)
  })); },

  removeDeviceFromRack: (trackId, rackId, deviceId) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: t.plugins.map(p => p.id === rackId ? {
        ...p,
        devices: p.devices.filter(d => d.id !== deviceId),
        macros: p.macros.map(m => ({ ...m, mappings: m.mappings.filter(mp => mp.deviceId !== deviceId) }))
      } : p)
    } : t)
  })); },

  updateRackDeviceParameter: (trackId, rackId, deviceId, paramName, val) => { get().record(`rack-device-${deviceId}-${paramName}`); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: t.plugins.map(p => p.id === rackId ? {
        ...p,
        devices: p.devices.map(d => d.id === deviceId ? {
          ...d,
          parameters: { ...d.parameters, [paramName]: val }
        } : d)
      } : p)
    } : t)
  })); },

  // Move a macro: store its value and push every mapped parameter to
  // min + (value/100) * (max - min).
  updateMacroValue: (trackId, rackId, macroId, value) => { get().record(`macro-${macroId}`); set((state) => ({
    tracks: state.tracks.map(t => {
      if (t.id !== trackId) return t;
      return {
        ...t,
        plugins: t.plugins.map(p => {
          if (p.id !== rackId) return p;
          const macros = p.macros.map(m => m.id === macroId ? { ...m, value } : m);
          const macro = macros.find(m => m.id === macroId);
          let devices = p.devices;
          macro.mappings.forEach(mp => {
            const mapped = Math.round((mp.min + (value / 100) * (mp.max - mp.min)) * 100) / 100;
            devices = devices.map(d => d.id === mp.deviceId ? {
              ...d,
              parameters: { ...d.parameters, [mp.paramName]: mapped }
            } : d);
          });
          return { ...p, macros, devices };
        })
      };
    })
  })); },

  addMacroMapping: (trackId, rackId, macroId, deviceId, paramName) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: t.plugins.map(p => p.id === rackId ? {
        ...p,
        macros: p.macros.map(m => m.id === macroId ? {
          ...m,
          mappings: m.mappings.some(mp => mp.deviceId === deviceId && mp.paramName === paramName)
            ? m.mappings
            : [...m.mappings, { deviceId, paramName, min: 0, max: 100 }]
        } : m)
      } : p)
    } : t)
  })); },

  removeMacroMapping: (trackId, rackId, macroId, index) => { get().record(); set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: t.plugins.map(p => p.id === rackId ? {
        ...p,
        macros: p.macros.map(m => m.id === macroId ? {
          ...m,
          mappings: m.mappings.filter((_, i) => i !== index)
        } : m)
      } : p)
    } : t)
  })); },

  saveRackPreset: (rack) => set((state) => ({
    savedRacks: [...state.savedRacks, { ...cloneRack(rack), name: `${rack.name} ${state.savedRacks.length + 1}` }]
  })),

  addSavedRackToTrack: (trackId, presetIndex) => { get().record(); set((state) => {
    const preset = state.savedRacks[presetIndex];
    if (!preset) return {};
    return {
      tracks: state.tracks.map(t => t.id === trackId ? {
        ...t,
        plugins: [...t.plugins, cloneRack(preset)]
      } : t)
    };
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
