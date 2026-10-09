import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import {
  Play, Square, Plus, Trash2, Mic, Circle, Volume2,
  Layers, FolderOpen, Radio, Music, CheckSquare, Square as SquareIcon, Sliders, Wand2,
  Undo2, Redo2, ChevronDown, ChevronRight, Snowflake, ArrowDownToLine, Activity, Eraser, X, ListMusic
} from 'lucide-react';
import { useDAWStore, createDefaultInstrument, RETURN_LETTERS, MASTER_STRIP_ID } from './store/useDAWStore';
import { triggerNote, midiNoteName } from './audio/synth';
import { scheduleClip, clipTimelineLength } from './audio/clipPlayback';
import ClipView from './components/ClipView';
import SessionView from './components/SessionView';
import TrackIO from './components/TrackIO';
import TakeLane from './components/TakeLane';
import { captureMidi, hasCapturable, onCaptureBufferChange } from './audio/capture';
import { initMidi, onInputsChange, isComputerKeyboardEnabled, setComputerKeyboardEnabled, getComputerKeyboardOctave } from './audio/inputs';
import { AudioRegionNode, MidiRegionNode } from './components/ClipNodes';
import RackDevice from './components/RackDevice';
import DeviceCard from './components/DeviceCard';
import ArrangementRuler from './components/ArrangementRuler';
import TempoControls from './components/TempoControls';
import FileMenu from './components/FileMenu';
import AutomationLane from './components/AutomationLane';
import { automationParams } from './audio/automation';
import { PIXELS_PER_SECOND, barsUntil } from './audio/timeline';
import { DEVICE_DEFS, createDevice } from './audio/devices';
import { audioContext, masterAnalyser, masterLimiter, getStripInput } from './audio/engine';
import { getPosition, isCountingIn, onTransportChange, setPosition as setTransportPosition, clickGain } from './audio/transport';
import './App.css';


// Dev-only handle for driving the store from the console / automated tests
if (import.meta.env.DEV) {
  (window as any).__dawStore = useDAWStore;
  (window as any).__transport = { getPosition, setPosition: setTransportPosition, isCountingIn, clickGain, audioContext, masterAnalyser };
}
const ORCHESTRATOR_WS_URL = 'ws://localhost:8080';

// Ableton-style Color Palette Presets
const PRESET_COLORS = [
  '#ef4444', // Red
  '#f97316', // Orange
  '#eab308', // Yellow
  '#22c55e', // Green
  '#06b6d4', // Cyan
  '#3b82f6', // Blue
  '#6366f1', // Indigo
  '#a855f7', // Purple
  '#ec4899', // Pink
  '#6b7280'  // Grey
];

// Add Device choices: stock devices with real DSP first, then third-party
// plugins (passed through untouched until Audio Core hosts them natively).
const BROWSER_PLUGINS = [
  ...Object.keys(DEVICE_DEFS).map(createDevice),
  { name: 'FabFilter Pro-Q 3', type: 'vst', parameters: { 'Freq': 440, 'Gain': 0.0, 'Q': 1.0 } },
  { name: 'Antares AutoTune', type: 'vst', parameters: { 'Retune Speed': 20, 'Humanize': 60, 'Key': 'C min' } },
];

// Live peak meter + clip LED + limiter gain-reduction readout for the master bus.
// Writes straight to the DOM from a rAF loop; only the latching clip LED is React state.
const MasterMeter = ({ limiterEnabled }: { limiterEnabled: boolean }) => {
  const fillRef = useRef<HTMLDivElement>(null);
  const dbRef = useRef<HTMLSpanElement>(null);
  const grRef = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  const clippedRef = useRef(false);

  useEffect(() => {
    const data = new Float32Array(masterAnalyser.fftSize);
    let raf: number;
    const tick = () => {
      masterAnalyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      if (peak >= 0.999 && !clippedRef.current) {
        clippedRef.current = true;
        setClipped(true);
      }
      const db = 20 * Math.log10(peak || 0.00001);
      const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
      if (fillRef.current) {
        fillRef.current.style.width = `${pct}%`;
        fillRef.current.style.backgroundColor = db > -3 ? 'var(--accent-red)' : db > -12 ? '#eab308' : 'var(--accent-green)';
      }
      if (dbRef.current) dbRef.current.textContent = peak > 0.0001 ? `${db.toFixed(1)}` : '-inf';
      if (grRef.current) {
        const gr = masterLimiter.reduction;
        grRef.current.textContent = gr < -0.5 ? `GR ${gr.toFixed(1)}` : '';
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="master-meter-block" title="Master output peak level">
      <div className="master-meter">
        <div className="master-meter-fill" ref={fillRef} />
      </div>
      <span className="master-meter-db" ref={dbRef}>-inf</span>
      <button
        className={`clip-led ${clipped ? 'lit' : ''}`}
        title={clipped ? 'Clipped! Click to reset' : 'Clip indicator'}
        onClick={() => { clippedRef.current = false; setClipped(false); }}
      />
      <span className="master-meter-gr" ref={grRef} style={{ opacity: limiterEnabled ? 1 : 0.3 }} />
    </div>
  );
};

function App() {
  const { 
    tracks, regions, isPlaying, isRecording, isMetronomeEnabled, viewMode,
    selectedTrackId, selectedRegionId, masterVolume, returns, masterPlugins, sessionClips, vstScanPaths, bpm,
    togglePlayback, toggleMetronome, setViewMode, setSelectedTrackId, setSelectedRegionId,
    addTrack, removeTrack, addRegion, updateTrackColor, toggleArmTrack,
    updateTrackVolume, updateTrackPan, updateTrackSend, toggleMuteTrack, toggleSoloTrack,
    setMasterVolume, addReturn, removeReturn, updateReturn, addDeviceToTrack, removeDeviceFromTrack, updateDeviceParameter,
    setSessionClip, groupTracks, addVstScanPath, removeVstScanPath, loadAbletonSet,
    undo, redo, past, future,
    addMidiRegion, setTrackInstrument, updateInstrumentParameter,
    isLimiterEnabled, toggleLimiter, toggleGroupCollapse,
    savedRacks, addRackToTrack, groupTrackDevicesIntoRack, addSavedRackToTrack,
    setTrackFrozen, unfreezeTrack, flattenTrack,
    punchInTime, punchOutTime, isPunchEnabled, togglePunch,
    isLoopEnabled, loopStart, loopEnd, toggleLoop, locators, addLocator, timeSignatures,
    toggleAutomationView, setAutomationLanes, clearAutomation,
    selectedSessionClip, updateSessionClip, updateClip,
    compTakeRange, removeTakeLane, toggleTakesView,
    scannedPlugins, setScannedPlugins
  } = useDAWStore();
  const [isScanning, setIsScanning] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draggedOverTrack, setDraggedOverTrack] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'devices' | 'clip' | 'vst-paths' | 'dictation'>('devices');
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [activeColorPickerTrackId, setActiveColorPickerTrackId] = useState<string | null>(null);
  const [newVstPathInput, setNewVstPathInput] = useState('');
  const [newDeviceIdx, setNewDeviceIdx] = useState(0);
  const [showIO, setShowIO] = useState(false);
  const keyboardMidi = useSyncExternalStore(onInputsChange, isComputerKeyboardEnabled);
  // Capture lights up when there is uncaptured playing for an armed MIDI track
  const capturable = useSyncExternalStore(onCaptureBufferChange, () => hasCapturable(useDAWStore.getState())) && tracks.length > 0;

  // AI Dictation (Orchestrator connection)
  const orchestratorWsRef = useRef<WebSocket | null>(null);
  const [orchestratorConnected, setOrchestratorConnected] = useState(false);
  const [dictationInput, setDictationInput] = useState('');
  const [dictationStatus, setDictationStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [dictationCode, setDictationCode] = useState<string | null>(null);
  const [dictationError, setDictationError] = useState<string | null>(null);

  useEffect(() => {
    const ws = new WebSocket(ORCHESTRATOR_WS_URL);
    orchestratorWsRef.current = ws;

    ws.onopen = () => setOrchestratorConnected(true);
    ws.onclose = () => setOrchestratorConnected(false);
    ws.onerror = () => setOrchestratorConnected(false);
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'GENERATED') {
        setDictationCode(msg.code);
        setDictationStatus('done');
      } else if (msg.type === 'ERROR') {
        setDictationError(msg.message);
        setDictationStatus('error');
      }
    };

    return () => ws.close();
  }, []);

  const handleSendDictation = () => {
    const ws = orchestratorWsRef.current;
    if (!dictationInput.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;

    setDictationStatus('sending');
    setDictationError(null);
    setDictationCode(null);
    ws.send(JSON.stringify({ type: 'DICTATION', text: dictationInput.trim() }));
  };

  // Playhead display: the transport owns position and scheduling; this just
  // follows it (rAF while playing) and runs punch-in/out at the punch points.
  const [localPlaybackPosition, setLocalPlaybackPosition] = useState(0);
  const [countingIn, setCountingIn] = useState(false);

  useEffect(() => onTransportChange(() => setLocalPlaybackPosition(Math.max(0, getPosition()))), []);

  useEffect(() => {
    if (!isPlaying) return;
    let raf: number;
    const updatePlayhead = () => {
      const currentPos = getPosition();
      setLocalPlaybackPosition(Math.max(0, currentPos));
      setCountingIn(isCountingIn());
      const st = useDAWStore.getState();
      if (st.isPunchEnabled && !isCountingIn()) {
        if (currentPos >= st.punchInTime && currentPos < st.punchOutTime) {
          if (!st.isRecording) st.setRecording(true);
        } else if (st.isRecording) {
          st.setRecording(false);
        }
      }
      raf = requestAnimationFrame(updatePlayhead);
    };
    updatePlayhead();
    return () => { cancelAnimationFrame(raf); setCountingIn(false); };
  }, [isPlaying]);

  // Record: arm recording and start the transport; the transport plays the
  // count-in first when one is set. Pressing again while recording disarms.
  const handleRecord = () => {
    const st = useDAWStore.getState();
    if (st.isRecording) { st.setRecording(false); return; }
    st.setRecording(true);
    if (!st.isPlaying) st.togglePlayback();
  };

  // Stop; stopping again while stopped returns to zero
  const handleStop = () => {
    if (isPlaying) togglePlayback();
    else setTransportPosition(0);
  };

  // Drag and Drop files onto timelines or slots
  const handleDrop = async (e: DragEvent<HTMLDivElement>, trackId: string, slotIndex?: number) => {
    e.preventDefault();
    setDraggedOverTrack(null);
    
    // Capture event properties synchronously before any await calls
    const currentTarget = e.currentTarget;
    const clientX = e.clientX;
    const rect = currentTarget ? (currentTarget as HTMLElement).getBoundingClientRect() : null;

    const file = e.dataTransfer.files[0];
    if (!file) return;

    // Case insensitive validation for WAV, MP3, OGG, M4A
    const fileNameLower = file.name.toLowerCase();
    if (
      !fileNameLower.endsWith('.wav') && 
      !fileNameLower.endsWith('.mp3') && 
      !fileNameLower.endsWith('.ogg') && 
      !fileNameLower.endsWith('.m4a')
    ) {
      alert("Unsupported file format. Please drop a WAV, MP3, OGG, or M4A file.");
      return;
    }

    try {
      // Ensure audio context is running to decode
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      if (slotIndex !== undefined) {
        // Session View drop
        setSessionClip(trackId, slotIndex, {
          name: file.name,
          audioBuffer,
          duration: audioBuffer.duration
        });
      } else {
        // Arrangement View drop
        const dropX = rect ? clientX - rect.left : 0;
        const dropTime = Math.max(0, dropX / PIXELS_PER_SECOND);
        addRegion({
          trackId,
          file: file.name,
          audioBuffer,
          startTime: dropTime,
          duration: audioBuffer.duration
        });
      }
    } catch (err: any) {
      console.error("Audio Decoding Error:", err);
      alert(`Audio decoding failed: ${err.message || err}. Ensure the file is not corrupted.`);
    }
  };

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput = (e.target as HTMLElement).tagName === 'INPUT';
      if (e.code === 'Space' && !isInput) {
        e.preventDefault();
        togglePlayback();
      }
      // Undo/Redo: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (skip while typing in text fields)
      if ((e.ctrlKey || e.metaKey) && !isInput) {
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) redo(); else undo();
        } else if (key === 'y') {
          e.preventDefault();
          redo();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlayback, undo, redo]);

  // Find selected track and region
  // The device chain view edits whichever strip is selected: a track or a return
  const returnStrips = returns.map((r: any, i: number) => ({
    ...r, type: 'return', color: '#6b7280', name: `${RETURN_LETTERS[i]} ${r.name}`
  }));
  const masterStrip = { id: MASTER_STRIP_ID, name: 'Master', type: 'master', color: '#e5e7eb', plugins: masterPlugins };
  const selectedTrack = tracks.find((t: any) => t.id === selectedTrackId)
    || returnStrips.find((r: any) => r.id === selectedTrackId)
    || (selectedTrackId === MASTER_STRIP_ID ? masterStrip : undefined);
  const selectedRegion = regions.find((r: any) => r.id === selectedRegionId);
  const selectedSessionClipData = selectedSessionClip
    ? sessionClips[selectedSessionClip.trackId]?.[selectedSessionClip.slot]
    : null;

  // Members of collapsed groups are hidden from the track lists (audio still plays)
  const collapsedGroupIds = new Set(
    tracks.filter((t: any) => t.type === 'group' && t.isCollapsed).map((t: any) => t.id)
  );
  const visibleTracks = tracks.filter((t: any) => !(t.groupId && collapsedGroupIds.has(t.groupId)));

  // Timeline extends past the last clip / loop / locator with room to work
  const contentEnd = Math.max(
    40,
    ...regions.map((r: any) => r.startTime + r.duration + 16),
    loopEnd + 16,
    ...locators.map((l: any) => l.time + 16)
  );
  const timelineWidth = Math.ceil(contentEnd * PIXELS_PER_SECOND);

  // Track lanes and their headers live in two scroll containers; keep them in step
  const arrangerScrollRef = useRef<HTMLDivElement>(null);
  const headersScrollRef = useRef<HTMLDivElement>(null);
  const syncScroll = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (from && to && Math.abs(to.scrollTop - from.scrollTop) > 1) to.scrollTop = from.scrollTop;
  };

  // Jump to the previous/next locator relative to the playhead
  const jumpLocator = (dir: 1 | -1) => {
    const pos = getPosition();
    const target = dir > 0
      ? locators.find((l: any) => l.time > pos + 0.01)
      : [...locators].reverse().find((l: any) => l.time < pos - 0.05);
    if (target) setTransportPosition(target.time);
  };

  // Toggle track selection for grouping
  const toggleSelectTrackForGroup = (trackId: string) => {
    if (selectedTrackIds.includes(trackId)) {
      setSelectedTrackIds(selectedTrackIds.filter(id => id !== trackId));
    } else {
      setSelectedTrackIds([...selectedTrackIds, trackId]);
    }
  };

  // Run grouping
  const handleGroupSelectedTracks = () => {
    if (selectedTrackIds.length < 2) {
      alert("Please select at least 2 tracks using the checkboxes to group them.");
      return;
    }
    groupTracks(selectedTrackIds);
    setSelectedTrackIds([]); // reset selection
  };

  // Create a 1-bar MIDI clip seeded with a simple root-note pattern so it's
  // immediately audible; notes become editable in the piano roll.
  const handleCreateMidiClip = (trackId: string, startTime: number) => {
    const secondsPerBeat = 60 / bpm;
    const barLength = secondsPerBeat * 4;
    const seedNotes = [48, 51, 55, 60].map((pitch, i) => ({
      id: `${Date.now()}-${i}`,
      pitch,
      start: i * secondsPerBeat,
      duration: secondsPerBeat * 0.9,
      velocity: 0.9
    }));
    addMidiRegion(trackId, startTime, barLength, seedNotes);
  };

  // Audition a note immediately through the track's channel (instrument panel keyboard)
  const auditionNote = (track: any, pitch: number) => {
    if (!track?.instrument) return;
    if (audioContext.state === 'suspended') audioContext.resume();
    triggerNote(audioContext, getStripInput(track.id), track.instrument.parameters, pitch, audioContext.currentTime, 0.35);
  };

  // Freeze: render the track's clips offline (instrument included for MIDI),
  // store the buffer on the track and lock its devices. Unfreeze reverses it.
  const handleFreezeTrack = async (track: any) => {
    if (track.isFrozen) {
      unfreezeTrack(track.id);
      return;
    }
    if (isPlaying) togglePlayback();
    const trackRegions = regions.filter((r: any) => r.trackId === track.id);
    if (trackRegions.length === 0) {
      alert('Nothing to freeze: this track has no clips.');
      return;
    }
    const end = Math.max(...trackRegions.map((r: any) => r.startTime + clipTimelineLength(r, bpm))) + 0.5; // headroom for release tails
    const sampleRate = audioContext.sampleRate;
    const offline = new OfflineAudioContext(2, Math.ceil(sampleRate * end), sampleRate);

    // Same clip renderer as playback, so gain/transpose/loop/warp are baked in
    trackRegions.forEach((region: any) => {
      scheduleClip(offline, region, track.instrument?.parameters, offline.destination,
        region.startTime, 0, clipTimelineLength(region, bpm), bpm);
    });

    const rendered = await offline.startRendering();
    setTrackFrozen(track.id, rendered, end);
  };

  // Add custom path
  const handleAddVstPath = () => {
    if (newVstPathInput.trim()) {
      addVstScanPath(newVstPathInput.trim());
      setNewVstPathInput('');
    }
  };

  // Real plugin folder scan via the File System Access API: the user picks a
  // directory and we enumerate actual plugin binaries inside it.
  const PLUGIN_EXTENSIONS: { [ext: string]: string } = {
    '.vst3': 'VST3', '.dll': 'VST2', '.clap': 'CLAP', '.component': 'AU'
  };

  const scanDirectory = async (dirHandle: any, basePath: string, depth: number, found: any[]) => {
    if (depth > 3) return;
    for await (const entry of dirHandle.values()) {
      const lower = entry.name.toLowerCase();
      const ext = Object.keys(PLUGIN_EXTENSIONS).find(e => lower.endsWith(e));
      if (ext) {
        found.push({
          name: entry.name.replace(/\.(vst3|dll|clap|component)$/i, ''),
          format: PLUGIN_EXTENSIONS[ext],
          path: `${basePath}/${entry.name}`
        });
      } else if (entry.kind === 'directory') {
        await scanDirectory(entry, `${basePath}/${entry.name}`, depth + 1, found);
      }
    }
  };

  const handleScanPluginFolder = async () => {
    const picker = (window as any).showDirectoryPicker;
    if (!picker) {
      alert('Folder scanning needs the File System Access API (Chromium-based browser).');
      return;
    }
    try {
      setIsScanning(true);
      const dirHandle = await picker.call(window, { mode: 'read' });
      const found: any[] = [];
      await scanDirectory(dirHandle, dirHandle.name, 0, found);
      // Merge with already-scanned plugins, de-duplicated by path
      const merged = [...scannedPlugins];
      found.forEach(p => {
        if (!merged.some((m: any) => m.path === p.path)) merged.push(p);
      });
      setScannedPlugins(merged);
      if (found.length === 0) alert(`No plugin files (.vst3/.dll/.clap/.component) found in "${dirHandle.name}".`);
    } catch (err: any) {
      if (err?.name !== 'AbortError') alert(`Scan failed: ${err.message || err}`);
    } finally {
      setIsScanning(false);
    }
  };

  // Ableton Live Set (.als) Import Handler
  const handleAlsImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      // Decompress using modern native browser DecompressionStream (GZIP)
      const decompressedStream = file.stream().pipeThrough(new DecompressionStream('gzip'));
      const response = new Response(decompressedStream);
      const xmlText = await response.text();

      // Parse decompressed XML text
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

      // Validate Ableton XML root node
      const abletonNode = xmlDoc.querySelector('Ableton');
      if (!abletonNode) {
        alert("Invalid file format. Ensure this is a valid Ableton Live Set (.als) file.");
        return;
      }

      // 1. Extract BPM/Tempo
      const tempoNode = xmlDoc.querySelector('Tempo Manual Value, Tempo Manual');
      const tempo = tempoNode ? parseFloat(tempoNode.getAttribute('Value') || '120') : 120;

      // 2. Extract Tracks & Placed clips
      const tracksList: any[] = [];
      const regionsList: any[] = [];

      // Query both audio and midi tracks
      const trackNodes = xmlDoc.querySelectorAll('Tracks AudioTrack, Tracks MidiTrack');
      trackNodes.forEach((trackNode, index) => {
        const type = trackNode.nodeName === 'AudioTrack' ? 'audio' : 'midi';
        const id = `als-track-${index}-${Math.random().toString(36).substr(2, 9)}`;
        
        const nameNode = trackNode.querySelector('Name UserName');
        const name = nameNode && nameNode.getAttribute('Value') 
          ? nameNode.getAttribute('Value') 
          : `${index + 1} ${type === 'audio' ? 'Audio' : 'MIDI'}`;
        
        const colorNode = trackNode.querySelector('Color');
        const colorValue = colorNode ? parseInt(colorNode.getAttribute('Value') || '0') : 0;
        const color = PRESET_COLORS[colorValue % PRESET_COLORS.length];

        // Vol, Pan, Sends
        const volNode = trackNode.querySelector('DeviceChain Mixer Volume Manual');
        const volume = volNode ? parseFloat(volNode.getAttribute('Value') || '0.8') : 0.8;

        const panNode = trackNode.querySelector('DeviceChain Mixer Pan Manual');
        const pan = panNode ? parseFloat(panNode.getAttribute('Value') || '0.0') : 0.0;

        // One TrackSendHolder per return, in return order
        const sends: { [returnId: string]: number } = {};
        trackNode.querySelectorAll('DeviceChain Mixer Sends TrackSendHolder Send Manual')
          .forEach((sendNode, i) => {
            const ret = returns[i];
            if (ret) sends[ret.id] = parseFloat(sendNode.getAttribute('Value') || '0') || 0;
          });

        // Scanned plugins / VSTs under the track's device chain
        const plugins: any[] = [];
        const pluginNodes = trackNode.querySelectorAll('DeviceChain Devices *');
        pluginNodes.forEach(dev => {
          const devName = dev.nodeName;
          if (devName.includes('Vst') || devName.includes('Plugin') || devName.includes('PluginDevice')) {
            const pluginNameNode = dev.querySelector('PluginDescName, UserName');
            const nameAttr = pluginNameNode ? pluginNameNode.getAttribute('Value') : null;
            if (nameAttr) {
              plugins.push({
                id: Math.random().toString(36).substr(2, 9),
                name: nameAttr,
                type: 'vst',
                parameters: {}
              });
            }
          }
        });

        tracksList.push({
          id,
          name,
          type,
          routing: 'master',
          groupId: null,
          volume,
          pan,
          sends,
          color,
          instrument: type === 'midi' ? createDefaultInstrument() : null,
          plugins
        });

        // Placed Clips / Arranger Regions
        const clipNodes = trackNode.querySelectorAll('ArrangerClipSource AudioClip, ArrangerClipSource MidiClip');
        clipNodes.forEach((clipNode, clipIdx) => {
          const clipNameNode = clipNode.querySelector('Name');
          const clipName = clipNameNode ? clipNameNode.getAttribute('Value') || 'Clip' : 'Clip';

          const clipParent = clipNode.parentElement;
          const startNode = clipParent ? clipParent.querySelector('CurrentStart') : null;
          const endNode = clipParent ? clipParent.querySelector('CurrentEnd') : null;
          const startTime = startNode ? parseFloat(startNode.getAttribute('Value') || '0') : 0;
          const endTime = endNode ? parseFloat(endNode.getAttribute('Value') || '10') : 10;
          const duration = Math.max(0.1, endTime - startTime);

          // Create a faint playable 440Hz sine buffer for visual rendering and audio feedback
          const sampleRate = audioContext.sampleRate;
          const dummyBuffer = audioContext.createBuffer(1, Math.floor(sampleRate * duration), sampleRate);
          const channelData = dummyBuffer.getChannelData(0);
          for (let i = 0; i < channelData.length; i++) {
            channelData[i] = Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 0.05; // 5% amplitude
          }

          regionsList.push({
            id: `als-region-${index}-${clipIdx}-${Math.random().toString(36).substr(2, 9)}`,
            trackId: id,
            file: clipName,
            audioBuffer: dummyBuffer,
            startTime,
            duration,
            startOffset: 0
          });
        });
      });

      // Update store state
      loadAbletonSet(tempo, tracksList, regionsList);
      alert(`Loaded Ableton Live Set: "${file.name}"!\nBPM: ${tempo}\nTracks: ${tracksList.length}\nRegions: ${regionsList.length}`);

    } catch (err: any) {
      console.error("ALS Import Error:", err);
      alert(`Failed to load Ableton Live Set: ${err.message || err}`);
    }
  };

  return (
    <div className="daw-container">
      {/* Ableton-style Control Bar */}
      <div className="control-bar">
        <div className="logo-section">NoProd</div>
        <FileMenu onImportAls={() => fileInputRef.current?.click()} />
        <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-color)', margin: '0 2px' }} />
        
        {/* Transport */}
        <button className={`btn-transport ${isRecording ? 'recording' : ''}`} onClick={handleRecord} title="Record (starts playback, after the count-in if one is set)">
          <Circle size={18} fill={isRecording ? 'var(--accent-red)' : 'none'} color={isRecording ? 'var(--accent-red)' : 'var(--text-primary)'} />
        </button>
        <button
          className={`btn-transport capture-btn ${capturable ? 'capturable' : ''}`}
          onClick={() => {
            const n = captureMidi(useDAWStore.getState());
            if (!n) alert('Nothing to capture: play something on an armed MIDI track (or one with monitoring In) first.');
          }}
          title="Capture MIDI: turn what you just played on armed MIDI tracks into a clip"
        >
          <ListMusic size={16} />
        </button>
        <button className={`btn-transport ${isPlaying ? 'playing' : ''}`} onClick={togglePlayback} title="Play">
          <Play size={18} />
        </button>
        <button className="btn-transport" onClick={handleStop} title="Stop">
          <Square size={18} />
        </button>

        <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-color)', margin: '0 2px' }} />

        {/* Undo / Redo */}
        <button className="btn-transport" onClick={undo} disabled={past.length === 0} title="Undo (Ctrl+Z)">
          <Undo2 size={16} />
        </button>
        <button className="btn-transport" onClick={redo} disabled={future.length === 0} title="Redo (Ctrl+Shift+Z)">
          <Redo2 size={16} />
        </button>

        <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-color)', margin: '0 2px' }} />

        {/* Metronome */}
        <button className={`btn-metronome ${isMetronomeEnabled ? 'active' : ''}`} onClick={toggleMetronome}>
          Click
        </button>

        {/* Punch In/Out */}
        <button
          className={`btn-metronome ${isPunchEnabled ? 'active punch-active' : ''}`}
          onClick={togglePunch}
          title={`Punch recording ${isPunchEnabled ? 'on' : 'off'}: auto record from ${punchInTime.toFixed(1)}s to ${punchOutTime.toFixed(1)}s (drag the red strip on the timeline to move)`}
        >
          PUNCH
        </button>

        {/* Arrangement loop + locators */}
        <button
          className={`btn-metronome ${isLoopEnabled ? 'active' : ''}`}
          onClick={toggleLoop}
          title={`Loop ${isLoopEnabled ? 'on' : 'off'} (${loopStart.toFixed(2)}s - ${loopEnd.toFixed(2)}s; drag on the ruler to set)`}
        >
          LOOP
        </button>
        <div className="locator-nav">
          <button className="btn-metronome" onClick={() => jumpLocator(-1)} disabled={locators.length === 0} title="Previous locator">◀</button>
          <button className="btn-metronome" onClick={() => addLocator(getPosition())} title="Add a locator at the playhead">SET</button>
          <button className="btn-metronome" onClick={() => jumpLocator(1)} disabled={locators.length === 0} title="Next locator">▶</button>
        </div>

        <TempoControls position={localPlaybackPosition} />
        {countingIn && <span className="count-in-badge">COUNT-IN</span>}

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleAlsImport}
          accept=".als"
          style={{ display: 'none' }}
        />

        <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-color)', margin: '0 2px' }} />

        {/* AI Dictation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <input
            type="text"
            placeholder="Describe a beat or melody..."
            value={dictationInput}
            onChange={(e) => setDictationInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSendDictation(); }}
            className="vst-path-input"
            style={{ width: '120px' }}
          />
          <button
            className="btn-metronome"
            onClick={() => { handleSendDictation(); setActiveTab('dictation'); }}
            disabled={!orchestratorConnected || dictationStatus === 'sending'}
            title={orchestratorConnected ? 'Generate a Strudel pattern from text via the Orchestrator' : 'Orchestrator offline'}
          >
            <Wand2 size={14} style={{ marginRight: '5px' }} />
            {dictationStatus === 'sending' ? 'Generating...' : 'Dictate'}
          </button>
          <span
            style={{ fontSize: '10px', color: orchestratorConnected ? 'var(--accent-green)' : 'var(--accent-red)' }}
            title={orchestratorConnected ? 'Orchestrator connected' : 'Orchestrator offline'}
          >
            {orchestratorConnected ? '●' : '○'}
          </span>
        </div>

        {/* View Switcher */}
        <div className="view-switcher">
          <button className={`btn-view ${viewMode === 'session' ? 'active' : ''}`} onClick={() => setViewMode('session')} title="Session View">
            <Sliders size={16} />
          </button>
          <button className={`btn-view ${viewMode === 'arrangement' ? 'active' : ''}`} onClick={() => setViewMode('arrangement')} title="Arrangement View">
            <Layers size={16} />
          </button>
        </div>

        {/* Master Controls */}
        <div className="master-fader">
          <Volume2 size={16} aria-label="Master volume" />
          <input
            type="range" min="0" max="1" step="0.01"
            value={masterVolume}
            onChange={(e) => setMasterVolume(parseFloat(e.target.value))}
            className="fader-input"
          />
          <MasterMeter limiterEnabled={isLimiterEnabled} />
          <button
            className={`btn-metronome ${isLimiterEnabled ? 'active' : ''}`}
            onClick={toggleLimiter}
            title={isLimiterEnabled ? 'Limiter on (brickwall at -1dB)' : 'Limiter bypassed'}
          >
            LIM
          </button>
        </div>
      </div>

      <div className="main-workspace">
        {/* Browser Sidebar */}
        <div className="browser-sidebar">
          <div className="browser-header">
            <h4>Browser</h4>
          </div>
          <div className="browser-categories">
            <button className="btn-category active">
              <FolderOpen size={14} /> All Sounds
            </button>
            <button className="btn-category">
              <Radio size={14} /> Plug-ins (VSTs)
            </button>
            <button className="btn-category">
              <Sliders size={14} /> Audio FX
            </button>
          </div>
          <div className="browser-list">
            <div className="browser-item">
              <Music size={14} style={{ marginRight: '6px' }} /> Sample_DrumLoop.wav
            </div>
            <div className="browser-item">
              <Music size={14} style={{ marginRight: '6px' }} /> Synth_Bass.wav
            </div>
          </div>
        </div>

        {/* Timeline / Grid - Tracks moved to the right! */}
        <div className="timeline-section">
          {viewMode === 'arrangement' ? (
            <div className={`arrangement-view ${showIO ? 'show-io' : ''}`}>
              
              {/* Arranger Track Grid (Moved to left) */}
              <div
                className="arranger-timeline"
                ref={arrangerScrollRef}
                onScroll={() => syncScroll(arrangerScrollRef.current, headersScrollRef.current)}
                onClick={() => setSelectedRegionId(null)}
              >
                {/* Bar / beat grid follows the tempo */}
                <svg className="arranger-grid" width={timelineWidth} height="100%">
                  {barsUntil(bpm, timelineWidth / PIXELS_PER_SECOND, timeSignatures).map((b) => (
                    <g key={b.index}>
                      <line x1={b.time * PIXELS_PER_SECOND} x2={b.time * PIXELS_PER_SECOND} y1="0" y2="100%" className="grid-bar" />
                      {b.length * PIXELS_PER_SECOND / b.numerator >= 12 && Array.from({ length: b.numerator - 1 }, (_, k) => {
                        const x = (b.time + (k + 1) * (b.length / b.numerator)) * PIXELS_PER_SECOND;
                        return <line key={k} x1={x} x2={x} y1="0" y2="100%" className="grid-beat" />;
                      })}
                    </g>
                  ))}
                </svg>
                <ArrangementRuler width={timelineWidth} onSeek={setTransportPosition} />
                {isLoopEnabled && (
                  <div className="loop-shade" style={{ left: loopStart * PIXELS_PER_SECOND, width: (loopEnd - loopStart) * PIXELS_PER_SECOND }} />
                )}
                <div className="playhead" style={{ left: `${localPlaybackPosition * PIXELS_PER_SECOND}px` }} />
                
                {visibleTracks.map((track: any) => (
                  <Fragment key={track.id}>
                  <div
                    className={`arranger-track ${draggedOverTrack === track.id ? 'drag-over' : ''}`}
                    style={{ width: timelineWidth }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDraggedOverTrack(track.id);
                    }}
                    onDragLeave={() => setDraggedOverTrack(null)}
                    onDrop={(e) => handleDrop(e, track.id)}
                    onDoubleClick={(e) => {
                      if (track.type !== 'midi') return;
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const clickTime = Math.max(0, (e.clientX - rect.left) / PIXELS_PER_SECOND);
                      handleCreateMidiClip(track.id, clickTime);
                    }}
                  >
                    {regions.filter((r: any) => r.trackId === track.id).map((region: any) => (
                      region.type === 'midi' ? (
                        <MidiRegionNode
                          key={region.id}
                          region={region}
                          trackColor={track.color}
                          isSelected={selectedRegionId === region.id}
                          onClick={() => setSelectedRegionId(region.id)}
                          onOpenClip={() => { setSelectedRegionId(region.id); setActiveTab('clip'); }}
                        />
                      ) : (
                        <AudioRegionNode
                          key={region.id}
                          region={region}
                          trackColor={track.color}
                          isSelected={selectedRegionId === region.id}
                          onClick={() => setSelectedRegionId(region.id)}
                          onOpenClip={() => { setSelectedRegionId(region.id); setActiveTab('clip'); }}
                        />
                      )
                    ))}
                  </div>
                  {/* Automation lanes under the track */}
                  {track.showAutomation && (track.automationLanes || []).map((key: string) => {
                    const param = automationParams(track, returns).find((p) => p.key === key);
                    return param ? (
                      <div key={key} className="automation-lane-row" style={{ width: timelineWidth }}>
                        <AutomationLane track={track} param={param} width={timelineWidth} color={track.color} />
                      </div>
                    ) : <div key={key} className="automation-lane-row" style={{ width: timelineWidth }} />;
                  })}
                  {/* Take lanes (recorded passes) under the track */}
                  {track.showTakes && (track.takeLanes || []).map((lane: any) => (
                    <TakeLane key={lane.id} track={track} lane={lane} width={timelineWidth} />
                  ))}
                  </Fragment>
                ))}
                {/* Room to scroll as far as the return/master strips in the header column */}
                <div style={{ height: 120 + returns.length * 82 + 82 }} />
              </div>

              {/* Mixer Headers / Tracks Panel (Moved to right) */}
              <div
                className="mixer-headers"
                ref={headersScrollRef}
                onScroll={() => syncScroll(headersScrollRef.current, arrangerScrollRef.current)}
              >
                <div className="track-list-actions">
                  <button className="btn-add-track" onClick={() => addTrack('audio')} title="Add Audio Track">
                    + Audio
                  </button>
                  <button className="btn-add-track" onClick={() => addTrack('midi')} title="Add MIDI Track" style={{ backgroundColor: '#10b981' }}>
                    + MIDI
                  </button>
                  <button 
                    className="btn-add-track" 
                    onClick={handleGroupSelectedTracks} 
                    style={{ backgroundColor: '#a855f7' }}
                    title="Group Selected Tracks"
                  >
                    Group ({selectedTrackIds.length})
                  </button>
                  <button className={`btn-add-track io-toggle ${showIO ? 'active' : ''}`} onClick={() => setShowIO(!showIO)}
                    title="Show each track's input, output and monitoring">I/O</button>
                  <button className={`btn-add-track io-toggle ${keyboardMidi ? 'active' : ''}`}
                    onClick={() => setComputerKeyboardEnabled(!keyboardMidi)}
                    title={`Computer MIDI keyboard ${keyboardMidi ? 'on' : 'off'}: A-K play notes (W E T Y U sharps), Z/X octave (now ${getComputerKeyboardOctave()}), C/V velocity`}>⌨</button>
                </div>

                {visibleTracks.map((track: any) => (
                  <Fragment key={track.id}>
                  <div
                    className={`track-header-box ${selectedTrackId === track.id ? 'selected' : ''} ${track.type === 'group' ? 'group-track' : ''}`}
                    onClick={() => setSelectedTrackId(track.id)}
                    style={{
                      borderLeft: `4px solid ${track.color}`,
                      paddingLeft: track.groupId ? '1.5rem' : '0.5rem' // Visually indent grouped tracks
                    }}
                  >
                    <div className="track-title-row">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        {track.type === 'group' && (
                          <button
                            className="btn-checkbox"
                            title={track.isCollapsed ? 'Unfold group' : 'Fold group'}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleGroupCollapse(track.id);
                            }}
                          >
                            {track.isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                          </button>
                        )}
                        {track.type !== 'group' && (
                          <button 
                            className="btn-checkbox" 
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSelectTrackForGroup(track.id);
                            }}
                          >
                            {selectedTrackIds.includes(track.id) ? <CheckSquare size={12} /> : <SquareIcon size={12} />}
                          </button>
                        )}
                        
                        {/* Custom Color Panel Picker */}
                        <div style={{ position: 'relative' }}>
                          <div 
                            className="color-dot" 
                            style={{ backgroundColor: track.color }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveColorPickerTrackId(activeColorPickerTrackId === track.id ? null : track.id);
                            }}
                          />
                          {activeColorPickerTrackId === track.id && (
                            <div className="color-palette-popover">
                              {PRESET_COLORS.map(c => (
                                <div 
                                  key={c} 
                                  className="color-palette-square" 
                                  style={{ backgroundColor: c }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    updateTrackColor(track.id, c);
                                    setActiveColorPickerTrackId(null);
                                  }}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                        
                        <span>{track.name}</span>
                        {track.type === 'group' && (
                          <span style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>
                            ({tracks.filter((m: any) => m.groupId === track.id).length})
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '2px' }}>
                        {(track.takeLanes || []).length > 0 && (
                          <button
                            className={`btn-icon ${track.showTakes ? 'automation-active' : ''}`}
                            title={`${track.showTakes ? 'Hide' : 'Show'} take lanes (${track.takeLanes.length})`}
                            onClick={(e) => { e.stopPropagation(); toggleTakesView(track.id); }}
                          >
                            <Layers size={12} />
                          </button>
                        )}
                        <button
                          className={`btn-icon ${track.showAutomation ? 'automation-active' : ''}`}
                          title={track.showAutomation ? 'Hide automation lanes' : 'Show automation lanes'}
                          onClick={(e) => { e.stopPropagation(); toggleAutomationView(track.id); }}
                        >
                          <Activity size={12} />
                        </button>
                        {track.type !== 'group' && (
                          <button
                            className={`btn-icon ${track.isFrozen ? 'frozen-active' : ''}`}
                            title={track.isFrozen ? 'Unfreeze Track' : 'Freeze Track (render to audio, lock devices)'}
                            onClick={(e) => { e.stopPropagation(); handleFreezeTrack(track); }}
                          >
                            <Snowflake size={12} />
                          </button>
                        )}
                        {track.isFrozen && (
                          <button
                            className="btn-icon"
                            title="Flatten (replace clips & devices with frozen audio)"
                            onClick={(e) => { e.stopPropagation(); flattenTrack(track.id); }}
                          >
                            <ArrowDownToLine size={12} />
                          </button>
                        )}
                        <button className="btn-icon" title={track.type === 'group' ? 'Ungroup (members return to Master)' : 'Delete Track'} onClick={() => removeTrack(track.id)}><Trash2 size={12} /></button>
                      </div>
                    </div>
                    
                    {/* Track Mixer Controls */}
                    <div className="mixer-strip">
                      <button className={`btn-arm ${track.isArmed ? 'armed' : ''}`}
                        onClick={() => { if (track.type === 'midi') initMidi(); toggleArmTrack(track.id); }}
                        title="Arm recording (an armed track also monitors its input)"><Mic size={12} /></button>
                      <button className={`btn-mute ${track.isMuted ? 'muted' : ''}`} onClick={() => toggleMuteTrack(track.id)} title="Mute Track">M</button>
                      <button className={`btn-solo ${track.isSoloed ? 'soloed' : ''}`} onClick={() => toggleSoloTrack(track.id)} title="Solo Track">S</button>
                      
                      <div className="strip-val">
                        <span style={{ fontSize: '9px' }}>PAN</span>
                        <input 
                          type="range" min="-1" max="1" step="0.1" 
                          value={track.pan} 
                          onChange={(e) => updateTrackPan(track.id, parseFloat(e.target.value))}
                          className="mixer-dial"
                        />
                      </div>
                      
                      {/* One send per return track (post-fader) */}
                      <div className="send-dials">
                        {returns.map((r: any, i: number) => (
                          <div key={r.id} className="strip-val" title={`Send to ${RETURN_LETTERS[i]} ${r.name}`}>
                            <span style={{ fontSize: '9px' }}>{RETURN_LETTERS[i]}</span>
                            <input
                              type="range" min="0" max="1" step="0.01"
                              value={track.sends?.[r.id] ?? 0}
                              onChange={(e) => updateTrackSend(track.id, r.id, parseFloat(e.target.value))}
                              className="mixer-dial"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                    
                    {/* Fader */}
                    <div className="fader-row">
                      <Volume2 size={12} />
                      <input 
                        type="range" min="0" max="1" step="0.01" 
                        value={track.volume} 
                        onChange={(e) => updateTrackVolume(track.id, parseFloat(e.target.value))}
                        className="mixer-fader"
                      />
                    </div>
                    {showIO && <TrackIO track={track} tracks={tracks} returns={returns} />}
                  </div>
                  {/* Automation lane headers: choose the parameter, clear, add/remove lanes */}
                  {track.showAutomation && (track.automationLanes || []).map((key: string, laneIdx: number) => {
                    const params = automationParams(track, returns);
                    const lanes: string[] = track.automationLanes;
                    const points = track.automation?.[key]?.length || 0;
                    return (
                      <div key={key} className="automation-lane-header" style={{ borderLeft: `4px solid ${track.color}` }}>
                        <select
                          className="rack-map-select"
                          value={key}
                          onChange={(e) => setAutomationLanes(track.id, lanes.map((k, i) => (i === laneIdx ? e.target.value : k)))}
                        >
                          {params.filter((p) => p.key === key || !lanes.includes(p.key)).map((p) => (
                            <option key={p.key} value={p.key}>{p.label}{track.automation?.[p.key]?.length ? ' •' : ''}</option>
                          ))}
                        </select>
                        <span className="automation-count">{points ? `${points} pts` : 'empty'}</span>
                        <div style={{ display: 'flex', gap: '2px' }}>
                          <button className="btn-icon" title="Clear this envelope" disabled={!points}
                            onClick={() => clearAutomation(track.id, key)}><Eraser size={12} /></button>
                          <button className="btn-icon" title="Show another automation lane"
                            onClick={() => {
                              const next = params.find((p) => !lanes.includes(p.key));
                              if (next) setAutomationLanes(track.id, [...lanes, next.key]);
                            }}><Plus size={12} /></button>
                          <button className="btn-icon" title="Hide this lane (its automation keeps playing)"
                            onClick={() => setAutomationLanes(track.id, lanes.filter((_, i) => i !== laneIdx))}><X size={12} /></button>
                        </div>
                      </div>
                    );
                  })}
                  {track.showTakes && (track.takeLanes || []).map((lane: any) => {
                    const inComp = regions.some((r: any) => r.trackId === track.id && r.takeLaneId === lane.id);
                    return (
                      <div key={lane.id} className="take-lane-header" style={{ borderLeft: `4px solid ${track.color}` }}>
                        <span className={`take-name ${inComp ? 'in-comp' : ''}`} title={inComp ? 'Parts of this take are in the comp' : 'Not used in the comp'}>{lane.name}</span>
                        <div style={{ display: 'flex', gap: '2px' }}>
                          <button className="btn-metronome take-use" title="Use this whole take in the comp"
                            onClick={() => lane.regions.forEach((c: any) => compTakeRange(track.id, lane.id, c.startTime, c.startTime + clipTimelineLength(c, bpm)))}>Use</button>
                          <button className="btn-icon" title="Delete this take lane (comped parts stay)" onClick={() => removeTakeLane(track.id, lane.id)}><Trash2 size={12} /></button>
                        </div>
                      </div>
                    );
                  })}
                  </Fragment>
                ))}

                {/* Return Tracks: each has its own device chain (click to edit) */}
                {returnStrips.map((r: any) => (
                  <div
                    key={r.id}
                    className={`track-header-box return-master ${selectedTrackId === r.id ? 'selected' : ''}`}
                    onClick={() => setSelectedTrackId(r.id)}
                  >
                    <div className="track-title-row">
                      <span style={{ fontSize: '10px', fontWeight: 'bold' }}>{r.name.toUpperCase()} <span className="strip-kind">RETURN</span></span>
                      <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                        <button className={`btn-mute ${r.isMuted ? 'muted' : ''}`} title="Mute Return"
                          onClick={(e) => { e.stopPropagation(); updateReturn(r.id, { isMuted: !r.isMuted }); }}>M</button>
                        <button className="btn-icon" title="Delete Return (removes every track's send to it)"
                          onClick={(e) => { e.stopPropagation(); removeReturn(r.id); }}><Trash2 size={12} /></button>
                      </div>
                    </div>
                    <div className="fader-row">
                      <span style={{ fontSize: '9px' }}>PAN</span>
                      <input
                        type="range" min="-1" max="1" step="0.1"
                        value={r.pan}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => updateReturn(r.id, { pan: parseFloat(e.target.value) })}
                        className="mixer-dial"
                      />
                      <Volume2 size={12} />
                      <input
                        type="range" min="0" max="1" step="0.01"
                        value={r.volume}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => updateReturn(r.id, { volume: parseFloat(e.target.value) })}
                        className="mixer-fader"
                      />
                    </div>
                  </div>
                ))}
                {/* Master strip: its device chain sits before the master fader and limiter */}
                <div
                  className={`track-header-box return-master master-strip ${selectedTrackId === MASTER_STRIP_ID ? 'selected' : ''}`}
                  onClick={() => setSelectedTrackId(MASTER_STRIP_ID)}
                  title="Click to edit the master device chain"
                >
                  <div className="track-title-row">
                    <span style={{ fontSize: '10px', fontWeight: 'bold' }}>MASTER</span>
                    <span style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>
                      {masterPlugins.length ? `${masterPlugins.length} device${masterPlugins.length > 1 ? 's' : ''}` : 'no devices'}
                    </span>
                  </div>
                  <div className="fader-row">
                    <Volume2 size={12} />
                    <input
                      type="range" min="0" max="1" step="0.01"
                      value={masterVolume}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setMasterVolume(parseFloat(e.target.value))}
                      className="mixer-fader"
                    />
                  </div>
                </div>
                <div className="track-list-actions">
                  <button className="btn-add-track" style={{ backgroundColor: '#6b7280' }} onClick={addReturn}
                    disabled={returns.length >= RETURN_LETTERS.length} title="Add Return Track">
                    + Return
                  </button>
                </div>
              </div>

            </div>
          ) : (
            <SessionView tracks={visibleTracks} onDropFile={handleDrop} onOpenClip={() => setActiveTab('clip')} />
          )}
        </div>
      </div>

      {/* Bottom Detail panel */}
      <div className={`bottom-detail-panel ${activeTab === 'clip' && (selectedSessionClipData || selectedRegion)?.type === 'midi' ? 'tall' : ''}`}>
        <div className="detail-tabs">
          <button className={`detail-tab ${activeTab === 'devices' ? 'active' : ''}`} onClick={() => setActiveTab('devices')}>Device Chain</button>
          <button className={`detail-tab ${activeTab === 'clip' ? 'active' : ''}`} onClick={() => setActiveTab('clip')}>Clip View</button>
          <button className={`detail-tab ${activeTab === 'vst-paths' ? 'active' : ''}`} onClick={() => setActiveTab('vst-paths')}>VST Folders Scan</button>
          <button className={`detail-tab ${activeTab === 'dictation' ? 'active' : ''}`} onClick={() => setActiveTab('dictation')}>AI Dictation</button>
        </div>
        
        <div className="detail-content">
          {activeTab === 'devices' && (
            <div className={`device-chain-view ${selectedTrack?.isFrozen ? 'frozen-locked' : ''}`}>
              {selectedTrack ? (
                <>
                  {selectedTrack.isFrozen && (
                    <div className="frozen-banner" title="Unfreeze the track to edit devices">
                      <Snowflake size={12} /> Frozen
                    </div>
                  )}
                  <div style={{ marginRight: '1rem', borderRight: '1px solid var(--border-color)', paddingRight: '1rem', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    <h5 style={{ color: selectedTrack.color }}>{selectedTrack.name} Device Chain</h5>
                    <div style={{ display: 'flex', gap: '3px' }}>
                      <select className="rack-map-select" value={newDeviceIdx} onChange={(e) => setNewDeviceIdx(parseInt(e.target.value))} title="Device to add">
                        {BROWSER_PLUGINS.map((p: any, i: number) => <option key={p.name} value={i}>{p.name}</option>)}
                      </select>
                      <button className="btn-add-track" onClick={() => addDeviceToTrack(selectedTrack.id, BROWSER_PLUGINS[newDeviceIdx])}>
                        <Plus size={12} /> Add
                      </button>
                    </div>
                    <button className="btn-add-track" style={{ backgroundColor: '#a855f7' }} onClick={() => addRackToTrack(selectedTrack.id)}>
                      <Plus size={12} /> Add Rack
                    </button>
                    {selectedTrack.plugins.some((p: any) => p.type !== 'rack') && (
                      <button className="btn-add-track" style={{ backgroundColor: '#6366f1' }}
                        title="Wrap this track's devices into an Audio Effect Rack"
                        onClick={() => groupTrackDevicesIntoRack(selectedTrack.id)}>
                        Group into Rack
                      </button>
                    )}
                    {savedRacks.length > 0 && (
                      <select
                        className="rack-map-select"
                        title="Insert a saved rack preset"
                        value=""
                        onChange={(e) => {
                          if (e.target.value !== '') addSavedRackToTrack(selectedTrack.id, parseInt(e.target.value));
                        }}
                      >
                        <option value="">Saved racks…</option>
                        {savedRacks.map((r: any, i: number) => <option key={i} value={i}>{r.name}</option>)}
                      </select>
                    )}
                  </div>
                  
                  {/* Instrument Card (MIDI tracks) */}
                  {selectedTrack.type === 'midi' && (
                    selectedTrack.instrument ? (
                      <div className="device-card instrument-card">
                        <div className="device-card-header">
                          <span>{selectedTrack.instrument.name}</span>
                          <span style={{ fontSize: '9px', color: 'var(--accent-green)' }}>INSTRUMENT</span>
                        </div>
                        <div className="device-card-params">
                          <div className="param-slider-row">
                            <span style={{ fontSize: '10px' }}>Waveform</span>
                            <select
                              className="clip-input"
                              value={selectedTrack.instrument.parameters.Waveform}
                              onChange={(e) => updateInstrumentParameter(selectedTrack.id, 'Waveform', e.target.value)}
                            >
                              <option value="sawtooth">Sawtooth</option>
                              <option value="square">Square</option>
                              <option value="sine">Sine</option>
                              <option value="triangle">Triangle</option>
                            </select>
                          </div>
                          {['Attack', 'Decay', 'Sustain', 'Release', 'Gain'].map((paramName) => (
                            <div key={paramName} className="param-slider-row">
                              <span style={{ fontSize: '10px' }}>{paramName}</span>
                              <input
                                type="range" min="0" max="1" step="0.01"
                                value={selectedTrack.instrument.parameters[paramName]}
                                onChange={(e) => updateInstrumentParameter(selectedTrack.id, paramName, parseFloat(e.target.value))}
                                className="param-slider"
                              />
                              <span style={{ fontSize: '10px', width: '28px', textAlign: 'right' }}>{Number(selectedTrack.instrument.parameters[paramName]).toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                        {/* Audition keyboard: one octave from C4 */}
                        <div className="audition-keys">
                          {[60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71].map(pitch => (
                            <button
                              key={pitch}
                              className={`audition-key ${midiNoteName(pitch).includes('#') ? 'black-key' : ''}`}
                              onMouseDown={() => auditionNote(selectedTrack, pitch)}
                              title={midiNoteName(pitch)}
                            >
                              {midiNoteName(pitch).includes('#') ? '' : midiNoteName(pitch)}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <button className="btn-add-track" style={{ backgroundColor: '#10b981', alignSelf: 'flex-start' }}
                        onClick={() => setTrackInstrument(selectedTrack.id, createDefaultInstrument())}>
                        <Plus size={12} /> Add Instrument
                      </button>
                    )
                  )}

                  {/* Plugin Cards */}
                  <div className="device-cards">
                    {selectedTrack.plugins.map((plugin: any) => (
                      plugin.type === 'rack' ? (
                        <RackDevice
                          key={plugin.id}
                          trackId={selectedTrack.id}
                          rack={plugin}
                          browserPlugins={BROWSER_PLUGINS}
                          onRemove={() => removeDeviceFromTrack(selectedTrack.id, plugin.id)}
                        />
                      ) : (
                        <DeviceCard
                          key={plugin.id}
                          device={plugin}
                          onChange={(paramName, val) => updateDeviceParameter(selectedTrack.id, plugin.id, paramName, val)}
                          onRemove={() => removeDeviceFromTrack(selectedTrack.id, plugin.id)}
                        />
                      )
                    ))}
                  </div>
                </>
              ) : (
                <div className="detail-empty-message">No track selected. Click a track header to configure its plugins.</div>
              )}
            </div>
          )}
          
          {activeTab === 'clip' && (
            <div className="clip-properties-view">
              {selectedSessionClipData ? (
                <ClipView
                  key={`${selectedSessionClip.trackId}-${selectedSessionClip.slot}`}
                  region={selectedSessionClipData}
                  onChange={(patch: any) => updateSessionClip(selectedSessionClip.trackId, selectedSessionClip.slot, patch)}
                  trackColor={tracks.find((t: any) => t.id === selectedSessionClip.trackId)?.color || '#3b82f6'}
                  onAudition={(pitch: number) => auditionNote(tracks.find((t: any) => t.id === selectedSessionClip.trackId), pitch)}
                />
              ) : selectedRegion ? (
                <ClipView
                  key={selectedRegion.id}
                  region={selectedRegion}
                  onChange={(patch: any) => updateClip(selectedRegion.id, patch)}
                  trackColor={tracks.find((t: any) => t.id === selectedRegion.trackId)?.color || '#3b82f6'}
                  onAudition={(pitch: number) => auditionNote(tracks.find((t: any) => t.id === selectedRegion.trackId), pitch)}
                />
              ) : (
                <div className="detail-empty-message">No clip selected. Click a clip on the timeline (double-click opens it here).</div>
              )}
            </div>
          )}
          
          {activeTab === 'vst-paths' && (
            <div className="vst-paths-view">
              <h5>Local VST3 Plugin Scan Locations</h5>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                Wire your Antares, FabFilter, and Ableton local VST paths here. NoProd scans these directories to link native plugins.
              </p>
              
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                <input 
                  type="text" 
                  placeholder="e.g. C:/Program Files/Common Files/VST3" 
                  value={newVstPathInput}
                  onChange={(e) => setNewVstPathInput(e.target.value)}
                  className="vst-path-input"
                />
                <button className="btn-add-track" onClick={handleAddVstPath}>
                  Add Path
                </button>
              </div>

              <div className="vst-path-list">
                {vstScanPaths.map((path: string) => (
                  <div key={path} className="vst-path-row">
                    <span style={{ fontSize: '12px', fontFamily: 'monospace' }}>{path}</span>
                    <button className="btn-icon" onClick={() => removeVstScanPath(path)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
              
              <button
                className="btn-add-track"
                style={{ backgroundColor: 'var(--accent-green)', marginTop: '10px' }}
                onClick={handleScanPluginFolder}
                disabled={isScanning}
              >
                {isScanning ? 'Scanning…' : 'Scan Folder for Plugins…'}
              </button>

              {scannedPlugins.length > 0 && (
                <div style={{ marginTop: '10px' }}>
                  <h5>Discovered Plugins ({scannedPlugins.length})</h5>
                  <div className="vst-path-list" style={{ maxHeight: '110px' }}>
                    {scannedPlugins.map((p: any) => (
                      <div key={p.path} className="vst-path-row">
                        <span style={{ fontSize: '11px' }}>
                          <b>{p.name}</b>
                          <span style={{ color: 'var(--accent-green)', marginLeft: '6px', fontSize: '9px' }}>{p.format}</span>
                          <span style={{ color: 'var(--text-secondary)', marginLeft: '6px', fontFamily: 'monospace', fontSize: '9px' }}>{p.path}</span>
                        </span>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button
                            className="btn-icon"
                            title={selectedTrack ? `Add to ${selectedTrack.name}'s device chain` : 'Select a track first'}
                            onClick={() => {
                              if (!selectedTrack) { alert('Select a track first (click a track header).'); return; }
                              addDeviceToTrack(selectedTrack.id, {
                                name: p.name, type: 'vst', pluginPath: p.path, format: p.format,
                                parameters: { 'Dry/Wet': 100, 'Gain': 50 }
                              });
                            }}
                          >
                            <Plus size={12} />
                          </button>
                          <button
                            className="btn-icon"
                            title="Remove from list"
                            onClick={() => setScannedPlugins(scannedPlugins.filter((sp: any) => sp.path !== p.path))}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '6px' }}>
                    Scanned plugins persist across sessions and can be added to device chains.
                    Native audio processing through Audio Core (JUCE) is not wired up yet.
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'dictation' && (
            <div className="vst-paths-view">
              <h5>AI Dictation</h5>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                Describe a beat or melody in the box at the top and click Dictate. The Orchestrator sends it to
                Gemini, which generates Strudel code and passes it to the Sequencer to evaluate.
              </p>

              {dictationStatus === 'sending' && (
                <div className="detail-empty-message">Generating...</div>
              )}

              {dictationStatus === 'done' && dictationCode && (
                <pre style={{ fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>
                  {dictationCode}
                </pre>
              )}

              {dictationStatus === 'error' && dictationError && (
                <div style={{ fontSize: '12px', color: 'var(--accent-red)' }}>{dictationError}</div>
              )}

              {dictationStatus === 'idle' && (
                <div className="detail-empty-message">No dictation request sent yet.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
