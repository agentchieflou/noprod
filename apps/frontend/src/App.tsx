import { Fragment, lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import {
  Play, Square, Plus, Trash2, Mic, Circle, Volume2,
  Layers, CheckSquare, Square as SquareIcon, Sliders, Wand2,
  Undo2, Redo2, ChevronDown, ChevronRight, Snowflake, ArrowDownToLine, Activity, Eraser, X, ListMusic, GraduationCap
} from 'lucide-react';
import { APP_VERSION, APP_COMMIT } from './buildInfo';
import { useDAWStore, RETURN_LETTERS, MASTER_STRIP_ID } from './store/useDAWStore';
import { startVoice } from './audio/synth';
import { clipTimelineLength } from './audio/clipPlayback';
import BrowserSidebar, { SAMPLE_DRAG_TYPE, SOUND_DRAG_TYPE } from './components/BrowserSidebar';
import { getFile } from './browser/library';
import { createLibraryInstrument, soundAsBuffer, libraryStats } from './audio/library';
import { renderArrangement } from './audio/scheduler';
import { startLibraryWarmup } from './audio/libraryWarmup';
import { findAnySound, loadUserSounds } from './audio/userSounds';
import type { DictationResult } from './audio/dictation';
import type { SoundRecipe } from '@noprod/sound';
import { captureMidi, hasCapturable, onCaptureBufferChange } from './audio/capture';
import { initMidi } from './audio/inputs';
import { subscribeKeyboard, getKeyboardState, setKeyboardEnabled } from './audio/computerKeyboard';
import { subscribeCoachOpen, getCoachOpen, setCoachOpen, accompanyDebug } from './audio/coachLoader';
import { getPluginEditor, subscribePluginEditor } from './native/pluginEditor';
import { onNativeEditorParameter, connectNativeTransport } from './native/trackBridge';
import './native/audioCore'; // GhostDAW's own, paired connection (follows Services)
import { getOrchestratorStatus, onOrchestratorMessage, sendOrchestrator, subscribeOrchestrator } from './native/orchestrator';
import { getServices, subscribeServices, getServicesDialogOpen, subscribeServicesDialog, setServicesDialogOpen } from './native/services';
import { watchNativeConsent } from './native/consent';
import NativeConsentDialog from './components/NativeConsentDialog';
import ArrangementRuler from './components/ArrangementRuler';
import TempoControls from './components/TempoControls';
import Playhead from './components/Playhead';
import { setPlayhead } from './components/playhead';
import MidiLearnControls from './components/MidiLearnControls';
import { useMidiLearn } from './components/useMidiLearn';
import FileMenu from './components/FileMenu';
import { SmallScreenNotice } from './components/BrowserNotes';
import { automationParams } from './audio/automation';
import { PIXELS_PER_SECOND, barsUntil } from './audio/timeline';
import { audioContext, masterAnalyser, masterLimiter, getStripInput, resumeAudio } from './audio/engine';
import { notify, guarded } from './notify';
import { Panel } from './components/ErrorBoundary';
import AudioStatus from './components/AudioStatus';
import Notices from './components/Notices';
import { liveModelStats } from './audio/liveModels';
import { getPosition, isCountingIn, onTransportChange, onSegmentScheduled, getTransportSnapshot, setPosition as setTransportPosition, clickGain, engineStats, engineReady, getScheduler } from './audio/transport';
// Not lazy with the DSP Map: it notes each track's sound as it's selected, for the map's A/B
import './components/dspMapState';
import './App.css';

// Panels that aren't on screen at first load arrive when opened (#137)
const SoundDesigner = lazy(() => import('./components/SoundDesigner'));
const DspMap = lazy(() => import('./components/DspMap'));
const Mixer = lazy(() => import('./components/Mixer'));
const KeyboardPanel = lazy(() => import('./components/KeyboardPanel'));
const DeviceChain = lazy(() => import('./components/DeviceChain'));
const PluginFolders = lazy(() => import('./components/PluginFolders'));
const DictationPanel = lazy(() => import('./components/DictationPanel'));
const ClipView = lazy(() => import('./components/ClipView'));
const SessionView = lazy(() => import('./components/SessionView'));
const PluginEditorWindow = lazy(() => import('./components/PluginEditorWindow'));
const TrackIO = lazy(() => import('./components/TrackIO'));
const TakeLane = lazy(() => import('./components/TakeLane'));
const AutomationLane = lazy(() => import('./components/AutomationLane'));
const MidiRegionNode = lazy(() => import('./components/ClipNodes').then((m) => ({ default: m.MidiRegionNode })));
const AudioRegionNode = lazy(() => import('./components/ClipNodes').then((m) => ({ default: m.AudioRegionNode })));


// Dev-only handle for driving the store from the console / automated tests
if (import.meta.env.DEV) {
  (window as any).__dawStore = useDAWStore;
  (window as any).__transport = { getPosition, setPosition: setTransportPosition, isCountingIn, clickGain, audioContext, masterAnalyser, getStripInput, liveModelStats, libraryStats, engineStats, engineReady, getScheduler,
    // the coach's band, once it has loaded (coachLoader.ts)
    get accompany() { return accompanyDebug(); } };
}
const ServicesDialog = lazy(() => import('./components/ServicesDialog'));

// A project that wants native plug-ins asks before GhostDAW loads them
watchNativeConsent(useDAWStore);

// A hosted plug-in's own editor changed a parameter: its device keeps it
onNativeEditorParameter((deviceId, parameterId, value, gesture) =>
  useDAWStore.getState().setDeviceParameterFromPlugin(deviceId, parameterId, value, gesture));

// Plug-ins on browser tracks learn tempo and position with each audio block
const nativeTransportChanged = connectNativeTransport(getTransportSnapshot);
onTransportChange(nativeTransportChanged);
onSegmentScheduled(nativeTransportChanged);

// Library sounds render ahead of playback, as the project changes
startLibraryWarmup(useDAWStore);
loadUserSounds();

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
  const learn = useMidiLearn();
  const { 
    tracks, regions, isPlaying, isRecording, isMetronomeEnabled, viewMode,
    selectedTrackId, selectedRegionId, masterVolume, returns, masterPlugins, sessionClips, bpm,
    togglePlayback, toggleMetronome, setViewMode, setSelectedTrackId, setSelectedRegionId,
    addTrack, removeTrack, addRegion, removeRegion, updateTrackColor, toggleArmTrack,
    updateTrackVolume, updateTrackPan, updateTrackSend, toggleMuteTrack, toggleSoloTrack,
    setMasterVolume, addReturn, removeReturn, updateReturn,
    setSessionClip, groupTracks, loadAbletonSet,
    undo, redo, past, future,
    addMidiRegion, setTrackInstrument,
    isLimiterEnabled, toggleLimiter, toggleGroupCollapse,
    setTrackFrozen, unfreezeTrack, flattenTrack,
    punchInTime, punchOutTime, isPunchEnabled, togglePunch,
    isLoopEnabled, loopStart, loopEnd, toggleLoop, locators, addLocator, timeSignatures,
    toggleAutomationView, setAutomationLanes, clearAutomation,
    selectedSessionClip, updateSessionClip, updateClip,
    compTakeRange, removeTakeLane, toggleTakesView
  } = useDAWStore();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draggedOverTrack, setDraggedOverTrack] = useState<string | null>(null);
  const [chosenTab, setActiveTab] = useState<'devices' | 'clip' | 'sound' | 'dspmap' | 'mixer' | 'vst-paths' | 'dictation'>('devices');
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [activeColorPickerTrackId, setActiveColorPickerTrackId] = useState<string | null>(null);
  const [showIO, setShowIO] = useState(false);
  const keyboardMidi = useSyncExternalStore(subscribeKeyboard, () => getKeyboardState().enabled);
  const coachOpen = useSyncExternalStore(subscribeCoachOpen, getCoachOpen);
  const pluginEditor = useSyncExternalStore(subscribePluginEditor, getPluginEditor);
  // Capture lights up when there is uncaptured playing for an armed MIDI track
  const capturable = useSyncExternalStore(onCaptureBufferChange, () => hasCapturable(useDAWStore.getState())) && tracks.length > 0;

  // AI Dictation (Orchestrator connection)
  const services = useSyncExternalStore(subscribeServices, getServices);
  const servicesOpen = useSyncExternalStore(subscribeServicesDialog, getServicesDialogOpen);
  const orchestratorConnected = useSyncExternalStore(subscribeOrchestrator, getOrchestratorStatus) === 'connected';
  const dictationOn = services.dictation.enabled;
  const ghostdawOn = services.ghostdaw.enabled;
  // A tab for a service that is off isn't there to stay on
  const activeTab = (chosenTab === 'dictation' && !dictationOn) || (chosenTab === 'vst-paths' && !ghostdawOn) ? 'devices' : chosenTab;
  const [dictationInput, setDictationInput] = useState('');
  const [dictationStatus, setDictationStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [dictationCode, setDictationCode] = useState<string | null>(null);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [dictationResult, setDictationResult] = useState<DictationResult | null>(null);
  const awaitingCode = useRef(false); // only the window that dictated makes tracks from the result

  useEffect(() => onOrchestratorMessage((msg) => {
    if (msg.type === 'GENERATED') {
      // The code Gemini wrote: our pattern engine plays a cycle of it here,
      // and its parts become tracks playing library sounds
      setDictationCode(msg.code);
      if (!awaitingCode.current) return;
      awaitingCode.current = false;
      import('./audio/dictation').then((d) => {
        try {
          setDictationResult(d.applyDictation(useDAWStore, msg.code));
          setDictationStatus('done');
        } catch (e) {
          setDictationError(e instanceof Error ? e.message : String(e));
          setDictationStatus('error');
        }
      });
    } else if (msg.type === 'ERROR') {
      awaitingCode.current = false;
      setDictationError(msg.message);
      setDictationStatus('error');
    }
  }), []);

  const handleSendDictation = () => {
    if (!dictationInput.trim() || !orchestratorConnected) return;

    setDictationStatus('sending');
    setDictationError(null);
    setDictationCode(null);
    setDictationResult(null);
    awaitingCode.current = true;
    sendOrchestrator({ type: 'DICTATION', text: dictationInput.trim() });
  };

  // Playhead display: the transport owns position and scheduling; this just
  // follows it (rAF while playing) and runs punch-in/out at the punch points.
  const [countingIn, setCountingIn] = useState(false);

  useEffect(() => onTransportChange(() => setPlayhead(Math.max(0, getPosition()))), []);

  useEffect(() => {
    if (!isPlaying) return;
    let raf: number;
    const updatePlayhead = () => {
      const currentPos = getPosition();
      setPlayhead(Math.max(0, currentPos));
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

    // A library sound: a MIDI track plays it as its instrument, anything
    // else gets it as a rendered audio clip
    const sound = findAnySound(e.dataTransfer.getData(SOUND_DRAG_TYPE));
    if (sound) {
      if (tracks.find((t: any) => t.id === trackId)?.type === 'midi') {
        setTrackInstrument(trackId, createLibraryInstrument(sound));
        return;
      }
      const audioBuffer = await soundAsBuffer(sound).catch(() => null);
      if (!audioBuffer) return;
      if (slotIndex !== undefined) {
        setSessionClip(trackId, slotIndex, { name: sound.name, audioBuffer, duration: audioBuffer.duration });
      } else {
        const dropTime = Math.max(0, (rect ? clientX - rect.left : 0) / PIXELS_PER_SECOND);
        addRegion({ trackId, file: sound.name, audioBuffer, startTime: dropTime, duration: audioBuffer.duration });
      }
      return;
    }

    // Samples dragged from the Browser carry a library reference, not a File
    const fromBrowser = e.dataTransfer.getData(SAMPLE_DRAG_TYPE);
    const file = fromBrowser ? await getFile(JSON.parse(fromBrowser).id) : e.dataTransfer.files[0];
    if (!file) return;

    // Case insensitive validation for WAV, MP3, OGG, M4A
    const fileNameLower = file.name.toLowerCase();
    if (
      !fileNameLower.endsWith('.wav') && 
      !fileNameLower.endsWith('.mp3') && 
      !fileNameLower.endsWith('.ogg') && 
      !fileNameLower.endsWith('.m4a')
    ) {
      notify("Unsupported file format. Please drop a WAV, MP3, OGG, or M4A file.", 'error');
      return;
    }

    try {
      // Ensure audio context is running to decode
      await resumeAudio();

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
      notify(`Audio decoding failed: ${err.message || err}. Ensure the file is not corrupted.`, 'error');
    }
  };

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // (a plugin editor with keyboard focus counts as typing)
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || !!target.closest?.('[data-keyboard-capture]');
      if (e.code === 'Space' && !isInput) {
        e.preventDefault();
        togglePlayback();
      }
      // Delete / Backspace removes the selected arrangement clip (Ctrl+Z restores
      // it). A note selected in the Clip View's piano roll takes the key first.
      const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable || !!target.closest?.('[data-keyboard-capture]');
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isTyping && selectedRegionId && !selectedSessionClip) {
        e.preventDefault();
        removeRegion(selectedRegionId);
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
  }, [togglePlayback, undo, redo, removeRegion, selectedRegionId, selectedSessionClip]);

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
      notify("Please select at least 2 tracks using the checkboxes to group them.");
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

  // Edit a library sound: it plays on the selected MIDI track (or a new one)
  // and opens in the Sound Designer
  const editSound = (recipe: SoundRecipe) => {
    const st = useDAWStore.getState();
    const target = st.tracks.find((t: any) => t.id === st.selectedTrackId && t.type === 'midi');
    if (target) setTrackInstrument(target.id, createLibraryInstrument(recipe));
    else st.addMidiTrackWithInstrument(createLibraryInstrument(recipe), recipe.name);
    setActiveTab('sound');
  };

  // Audition a note immediately through the track's channel (instrument panel keyboard)
  const auditionNote = (track: any, pitch: number) => {
    if (!track?.instrument) return;
    void resumeAudio();
    // played as a key is, so a note that isn't rendered yet still sounds
    const now = audioContext.currentTime;
    startVoice(audioContext, getStripInput(track.id), track.instrument.parameters, pitch, now, 1).release(now + 0.35);
  };

  // Freeze: render the track's clips offline (instrument included for MIDI),
  // store the buffer on the track and lock its devices. Unfreeze reverses it.
  const handleFreezeTrack = guarded('Freezing the track', async (track: any) => {
    if (track.isFrozen) {
      unfreezeTrack(track.id);
      return;
    }
    if (isPlaying) togglePlayback();
    const trackRegions = regions.filter((r: any) => r.trackId === track.id);
    if (trackRegions.length === 0) {
      notify('Nothing to freeze: this track has no clips.');
      return;
    }
    const end = Math.max(...trackRegions.map((r: any) => r.startTime + clipTimelineLength(r, bpm))) + 0.5; // headroom for release tails
    // The engine renders the track as playback plays it: gain, transpose, loop and warp baked in
    const rendered = await renderArrangement({ state: useDAWStore.getState(), trackIds: [track.id], from: 0, to: end, sampleRate: audioContext.sampleRate });
    setTrackFrozen(track.id, rendered, end);
  });

  // Ableton Live Set (.als) Import Handler
  const handleAlsImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const { parseAbletonSet } = await import('./alsImport');
      const set = await parseAbletonSet(file, returns, PRESET_COLORS);
      if (!set) {
        notify("Invalid file format. Ensure this is a valid Ableton Live Set (.als) file.", 'error');
        return;
      }
      const { tempo, tracksList, regionsList, skippedAudioClips } = set;

      // Update store state
      loadAbletonSet(tempo, tracksList, regionsList);
      notify(`Loaded Ableton Live Set “${file.name}”: ${tempo} BPM, ${tracksList.length} tracks, ${regionsList.length} MIDI clips${skippedAudioClips ? `; ${skippedAudioClips} audio clips not imported (their recordings aren't in the set)` : ''}`);

    } catch (err: any) {
      console.error("ALS Import Error:", err);
      notify(`Failed to load Ableton Live Set: ${err.message || err}`, 'error');
    }
  };

  return (
    <div className="daw-container">
      <AudioStatus />
      <Notices />
      <SmallScreenNotice />
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
            if (!n) notify('Nothing to capture: play something on an armed MIDI track (or one with monitoring In) first.');
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

        <TempoControls />
        <MidiLearnControls />
        {countingIn && <span className="count-in-badge">COUNT-IN</span>}

        {/* Keyboard Coach: opens the keyboard panel, computer keyboard on or off */}
        <button className={`btn-metronome coach-toggle ${coachOpen ? 'active' : ''}`} onClick={() => setCoachOpen(!coachOpen)}
          title="Keyboard Coach: lights up the keys to play next, from a MIDI keyboard, the computer keyboard or the mouse">
          <GraduationCap size={14} style={{ marginRight: '5px' }} />
          Coach
        </button>

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleAlsImport}
          accept=".als"
          style={{ display: 'none' }}
        />

        <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-color)', margin: '0 2px' }} />

        {/* AI Dictation */}
        {dictationOn && <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
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
            title={orchestratorConnected ? 'Generate a pattern from text via the Orchestrator' : 'Orchestrator offline'}
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
        </div>}

        <button className="btn-metronome" onClick={() => setServicesDialogOpen(!servicesOpen)} title="Turn local services on or off: GhostDAW plug-in host, AI dictation">
          Services
        </button>
        {servicesOpen && <Suspense fallback={null}><ServicesDialog /></Suspense>}
        <NativeConsentDialog />

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
            {...learn({ kind: 'master', param: 'volume' }, 'fader-input')}
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
        <BrowserSidebar onShowPluginScan={() => setActiveTab('vst-paths')} onEditSound={editSound} />

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
                <Playhead />
                
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
                    <Suspense fallback={null}>
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
                    </Suspense>
                  </div>
                  {/* Automation lanes under the track */}
                  {track.showAutomation && (track.automationLanes || []).map((key: string) => {
                    const param = automationParams(track, returns).find((p) => p.key === key);
                    return param ? (
                      <div key={key} className="automation-lane-row" style={{ width: timelineWidth }}>
                        <Suspense fallback={null}><AutomationLane track={track} param={param} width={timelineWidth} color={track.color} /></Suspense>
                      </div>
                    ) : <div key={key} className="automation-lane-row" style={{ width: timelineWidth }} />;
                  })}
                  {/* Take lanes (recorded passes) under the track */}
                  {track.showTakes && (track.takeLanes || []).map((lane: any) => (
                    <Suspense key={lane.id} fallback={null}><TakeLane track={track} lane={lane} width={timelineWidth} /></Suspense>
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
                    onClick={() => setKeyboardEnabled(!keyboardMidi)}
                    title={`Computer MIDI keyboard ${keyboardMidi ? 'on' : 'off'}: play the selected MIDI track from your keyboard`}>⌨</button>
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
                        
                        <span className="track-name" title={track.name}>{track.name}</span>
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
                      <button {...learn({ kind: 'track', trackId: track.id, param: 'mute' }, `btn-mute ${track.isMuted ? 'muted' : ''}`)} onClick={() => toggleMuteTrack(track.id)} title="Mute Track">M</button>
                      <button {...learn({ kind: 'track', trackId: track.id, param: 'solo' }, `btn-solo ${track.isSoloed ? 'soloed' : ''}`)} onClick={() => toggleSoloTrack(track.id)} title="Solo Track">S</button>
                      
                      <div className="strip-val">
                        <span style={{ fontSize: '9px' }}>PAN</span>
                        <input 
                          type="range" min="-1" max="1" step="0.1" 
                          value={track.pan} 
                          onChange={(e) => updateTrackPan(track.id, parseFloat(e.target.value))}
                          {...learn({ kind: 'track', trackId: track.id, param: 'pan' }, 'mixer-dial')}
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
                              {...learn({ kind: 'send', trackId: track.id, returnId: r.id }, 'mixer-dial')}
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
                        {...learn({ kind: 'track', trackId: track.id, param: 'volume' }, 'mixer-fader')}
                      />
                    </div>
                    {showIO && <Suspense fallback={null}><TrackIO track={track} tracks={tracks} returns={returns} /></Suspense>}
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
                      {...learn({ kind: 'master', param: 'volume' }, 'mixer-fader')}
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
            <Panel name="session"><Suspense fallback={null}><SessionView tracks={visibleTracks} onDropFile={handleDrop} onOpenClip={() => setActiveTab('clip')} /></Suspense></Panel>
          )}
        </div>
      </div>

      {(keyboardMidi || coachOpen) && <Panel name="keyboard"><Suspense fallback={null}><KeyboardPanel /></Suspense></Panel>}
      {pluginEditor && <Panel name="plugin-editor"><Suspense fallback={null}><PluginEditorWindow /></Suspense></Panel>}

      {/* Bottom Detail panel */}
      <div className={`bottom-detail-panel ${(activeTab === 'clip' && (selectedSessionClipData || selectedRegion)?.type === 'midi') || activeTab === 'sound' || activeTab === 'dspmap' || activeTab === 'mixer' ? 'tall' : ''}`}>
        <div className="detail-tabs">
          <button className={`detail-tab ${activeTab === 'devices' ? 'active' : ''}`} onClick={() => setActiveTab('devices')}>Device Chain</button>
          <button className={`detail-tab ${activeTab === 'clip' ? 'active' : ''}`} onClick={() => setActiveTab('clip')}>Clip View</button>
          <button className={`detail-tab ${activeTab === 'sound' ? 'active' : ''}`} onClick={() => setActiveTab('sound')}>Sound Designer</button>
          <button className={`detail-tab ${activeTab === 'dspmap' ? 'active' : ''}`} onClick={() => setActiveTab('dspmap')}>DSP Map</button>
          <button className={`detail-tab ${activeTab === 'mixer' ? 'active' : ''}`} onClick={() => setActiveTab('mixer')}>Mixer</button>
          {ghostdawOn && <button className={`detail-tab ${activeTab === 'vst-paths' ? 'active' : ''}`} onClick={() => setActiveTab('vst-paths')}>VST Folders Scan</button>}
          {dictationOn && <button className={`detail-tab ${activeTab === 'dictation' ? 'active' : ''}`} onClick={() => setActiveTab('dictation')}>AI Dictation</button>}
        <span className="app-version" title={`noprod ${APP_VERSION}, build ${APP_COMMIT}`}>v{APP_VERSION} · {APP_COMMIT}</span>
        </div>
        
        <div className="detail-content">
          <Panel key={activeTab} name={activeTab}>
          {activeTab === 'devices' && (
            <div className={`device-chain-view ${selectedTrack?.isFrozen ? 'frozen-locked' : ''}`}>
              {selectedTrack ? (
                <Suspense fallback={null}>
                  <DeviceChain track={selectedTrack} onAudition={(pitch: number) => auditionNote(selectedTrack, pitch)} onEditSound={() => setActiveTab('sound')} />
                </Suspense>
              ) : (
                <div className="detail-empty-message">No track selected. Click a track header to configure its plugins.</div>
              )}
            </div>
          )}
          
          {activeTab === 'clip' && (
            <div className="clip-properties-view">
              <Suspense fallback={null}>
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
                  onDelete={() => removeRegion(selectedRegion.id)}
                  trackColor={tracks.find((t: any) => t.id === selectedRegion.trackId)?.color || '#3b82f6'}
                  onAudition={(pitch: number) => auditionNote(tracks.find((t: any) => t.id === selectedRegion.trackId), pitch)}
                />
              ) : (
                <div className="detail-empty-message">No clip selected. Click a clip on the timeline (double-click opens it here).</div>
              )}
              </Suspense>
            </div>
          )}
          
          {activeTab === 'sound' && (
            <Suspense fallback={null}><SoundDesigner track={selectedTrack?.type === 'midi' ? selectedTrack : null} onOpenDspMap={() => setActiveTab('dspmap')} /></Suspense>
          )}

          {activeTab === 'dspmap' && <Suspense fallback={null}><DspMap onOpenDesigner={() => setActiveTab('sound')} /></Suspense>}

          {activeTab === 'mixer' && <Suspense fallback={null}><Mixer onOpenDevices={() => setActiveTab('devices')} /></Suspense>}

          {activeTab === 'vst-paths' && ghostdawOn && (
            <Suspense fallback={null}><PluginFolders selectedTrack={selectedTrack} /></Suspense>
          )}

          {activeTab === 'dictation' && dictationOn && (
            <Suspense fallback={null}>
              <DictationPanel status={dictationStatus} code={dictationCode} result={dictationResult} error={dictationError} />
            </Suspense>
          )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

export default App;
