import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

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
      plugins: [
        { id: uuidv4(), name: 'FabFilter Pro-Q 3', type: 'vst', parameters: { 'Freq': 440, 'Gain': 0.0 } }
      ],
    },
  ],
  
  // Arrangement Regions
  regions: [], // { id, trackId, file, audioBuffer, startTime, duration }

  // Session View Grid slots: { [trackId]: { [slotIndex]: clipData } }
  sessionClips: {},

  // Global Actions
  togglePlayback: () => set((state) => ({ isPlaying: !state.isPlaying })),
  toggleRecording: () => set((state) => ({ isRecording: !state.isRecording })),
  toggleMetronome: () => set((state) => ({ isMetronomeEnabled: !state.isMetronomeEnabled })),
  setViewMode: (mode) => set({ viewMode: mode }),
  setPlaybackPosition: (pos) => set({ playbackPosition: pos }),
  setBpm: (bpm) => set({ bpm }),
  
  setSelectedTrackId: (id) => set({ selectedTrackId: id }),
  setSelectedRegionId: (id) => set({ selectedRegionId: id }),
  
  setMasterVolume: (vol) => set({ masterVolume: vol }),
  setMasterPan: (pan) => set({ masterPan: pan }),
  setReverbReturnVolume: (vol) => set({ reverbReturnVolume: vol }),
  
  loadAbletonSet: (tempo, tracks, regions) => set({
    bpm: tempo,
    tracks,
    regions,
    selectedTrackId: null,
    selectedRegionId: null
  }),
  
  addVstScanPath: (path) => set((state) => ({
    vstScanPaths: [...state.vstScanPaths, path]
  })),
  
  removeVstScanPath: (path) => set((state) => ({
    vstScanPaths: state.vstScanPaths.filter(p => p !== path)
  })),

  // Track Actions
  addTrack: (type) => set((state) => {
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
          plugins: [],
        }
      ]
    };
  }),

  // Group Track functionality: links selected tracks into a Group Track
  groupTracks: (trackIds) => set((state) => {
    const groupId = uuidv4();
    const groupTrackName = `${state.tracks.filter(t => t.type === 'group').length + 1} Group`;
    
    // Create new group track
    const newGroupTrack = {
      id: groupId,
      name: groupTrackName,
      type: 'group',
      routing: 'master',
      groupId: null,
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
  }),

  removeTrack: (id) => set((state) => {
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
  }),

  updateTrackRouting: (id, routing) => set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, routing } : t)
  })),
  
  updateTrackVolume: (id, volume) => set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, volume } : t)
  })),

  updateTrackPan: (id, pan) => set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, pan } : t)
  })),

  updateTrackSendReverb: (id, val) => set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, sendReverb: val } : t)
  })),

  toggleMuteTrack: (id) => set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, isMuted: !t.isMuted } : t)
  })),

  toggleSoloTrack: (id) => set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, isSoloed: !t.isSoloed } : t)
  })),

  toggleArmTrack: (id) => set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, isArmed: !t.isArmed } : t)
  })),
  
  updateTrackColor: (id, color) => set((state) => ({
    tracks: state.tracks.map(t => t.id === id ? { ...t, color } : t)
  })),

  // Device Chain Actions
  addDeviceToTrack: (trackId, device) => set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: [...t.plugins, { ...device, id: uuidv4() }]
    } : t)
  })),

  removeDeviceFromTrack: (trackId, deviceId) => set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: t.plugins.filter(p => p.id !== deviceId)
    } : t)
  })),

  updateDeviceParameter: (trackId, deviceId, paramName, val) => set((state) => ({
    tracks: state.tracks.map(t => t.id === trackId ? {
      ...t,
      plugins: t.plugins.map(p => p.id === deviceId ? {
        ...p,
        parameters: { ...p.parameters, [paramName]: val }
      } : p)
    } : t)
  })),

  // Region Actions
  addRegion: (regionData) => set((state) => {
    const id = uuidv4();
    return {
      regions: [...state.regions, { startOffset: 0, ...regionData, id }],
      selectedRegionId: id
    };
  }),

  updateRegionPosition: (id, startTime) => set((state) => ({
    regions: state.regions.map(r => r.id === id ? { ...r, startTime } : r)
  })),

  updateRegionTrim: (id, startTime, duration, startOffset) => set((state) => ({
    regions: state.regions.map(r => r.id === id ? { ...r, startTime, duration, startOffset } : r)
  })),

  // Session Actions
  setSessionClip: (trackId, slotIndex, clipData) => set((state) => ({
    sessionClips: {
      ...state.sessionClips,
      [trackId]: {
        ...(state.sessionClips[trackId] || {}),
        [slotIndex]: clipData
      }
    }
  }))
}));
