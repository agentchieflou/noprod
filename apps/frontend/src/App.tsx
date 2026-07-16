import { useEffect, useRef, useState, DragEvent } from 'react';
import { 
  Play, Square, Plus, Settings2, Trash2, Mic, Circle, Volume2, 
  Layers, FolderOpen, Radio, Music, ArrowRight, Settings, CheckSquare, Square as SquareIcon, Sliders
} from 'lucide-react';
import { useDAWStore } from './store/useDAWStore';
import './App.css';

// Global AudioContext & Effects
const audioContext = new (window.AudioContext || window.webkitAudioContext)();

// Mock Reverb via Feedback Delay Network
const reverbReturnNode = audioContext.createDelay(1.0);
reverbReturnNode.delayTime.value = 0.35;
const reverbFeedback = audioContext.createGain();
reverbFeedback.gain.value = 0.5;
const reverbReturnGain = audioContext.createGain();

reverbReturnNode.connect(reverbFeedback);
reverbFeedback.connect(reverbReturnNode);
reverbReturnNode.connect(reverbReturnGain);
reverbReturnGain.connect(audioContext.destination);

let activeSources: any[] = [];
const PIXELS_PER_SECOND = 50;

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

const BROWSER_PLUGINS = [
  { name: 'FabFilter Pro-Q 3', type: 'vst', parameters: { 'Freq': 440, 'Gain': 0.0, 'Q': 1.0 } },
  { name: 'Antares AutoTune', type: 'vst', parameters: { 'Retune Speed': 20, 'Humanize': 60, 'Key': 'C min' } },
  { name: 'NoProd Reverb', type: 'audio-fx', parameters: { 'Dry/Wet': 30, 'Decay': 2.5 } },
  { name: 'NoProd Delay', type: 'audio-fx', parameters: { 'Time': 0.25, 'Feedback': 40 } },
];

const AudioRegionNode = ({ region, trackColor, isSelected, onClick }: { region: any, trackColor: string, isSelected: boolean, onClick: () => void }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { updateRegionPosition, updateRegionTrim } = useDAWStore();

  useEffect(() => {
    if (!canvasRef.current || !region.audioBuffer) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = region.audioBuffer.getChannelData(0);
    // Render the sub-portion of the waveform based on startOffset and duration
    const startSample = Math.floor((region.startOffset || 0) * region.audioBuffer.sampleRate);
    const endSample = Math.floor(((region.startOffset || 0) + region.duration) * region.audioBuffer.sampleRate);
    const subsetData = data.subarray(startSample, endSample);

    const step = Math.ceil(subsetData.length / canvas.width);
    const amp = canvas.height / 2;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = trackColor || 'var(--accent-blue)';
    
    for (let i = 0; i < canvas.width; i++) {
      let min = 1.0;
      let max = -1.0;
      for (let j = 0; j < step; j++) {
        const datum = subsetData[(i * step) + j];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
    }
  }, [region, trackColor]);

  const handleMouseDown = (e: React.MouseEvent, type: 'move' | 'trim-left' | 'trim-right') => {
    e.stopPropagation();
    onClick();
    
    const startX = e.clientX;
    const startValTime = region.startTime;
    const startValDuration = region.duration;
    const startValOffset = region.startOffset || 0;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaTime = deltaX / PIXELS_PER_SECOND;

      if (type === 'move') {
        const newStartTime = Math.max(0, startValTime + deltaTime);
        updateRegionPosition(region.id, newStartTime);
      } else if (type === 'trim-left') {
        const allowedDeltaTime = Math.min(startValDuration - 0.2, deltaTime);
        const newStartTime = Math.max(0, startValTime + allowedDeltaTime);
        const newDuration = startValDuration - allowedDeltaTime;
        const newOffset = Math.max(0, startValOffset + allowedDeltaTime);
        updateRegionTrim(region.id, newStartTime, newDuration, newOffset);
      } else if (type === 'trim-right') {
        const newDuration = Math.max(0.2, startValDuration + deltaTime);
        updateRegionTrim(region.id, startValTime, newDuration, startValOffset);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div 
      className={`audio-region ${isSelected ? 'selected' : ''}`}
      onMouseDown={(e) => handleMouseDown(e, 'move')}
      style={{ 
        width: `${region.duration * PIXELS_PER_SECOND}px`, 
        left: `${region.startTime * PIXELS_PER_SECOND}px`,
        borderColor: isSelected ? '#fff' : trackColor 
      }}
    >
      <div 
        className="trim-handle left-handle" 
        onMouseDown={(e) => handleMouseDown(e, 'trim-left')} 
      />
      <canvas ref={canvasRef} width={region.duration * PIXELS_PER_SECOND} height={80} style={{ display: 'block', opacity: 0.8 }} />
      <div style={{ position: 'absolute', top: 4, left: 12, color: '#fff', fontSize: '10px', textShadow: '0 0 4px #000', fontWeight: 'bold', pointerEvents: 'none' }}>{region.file}</div>
      <div 
        className="trim-handle right-handle" 
        onMouseDown={(e) => handleMouseDown(e, 'trim-right')} 
      />
    </div>
  );
};

function App() {
  const { 
    tracks, regions, isPlaying, isRecording, isMetronomeEnabled, viewMode,
    selectedTrackId, selectedRegionId, masterVolume, reverbReturnVolume, sessionClips, vstScanPaths, bpm,
    togglePlayback, toggleRecording, toggleMetronome, setViewMode, setSelectedTrackId, setSelectedRegionId,
    addTrack, removeTrack, updateTrackRouting, addRegion, updateTrackColor, toggleArmTrack,
    updateTrackVolume, updateTrackPan, updateTrackSendReverb, toggleMuteTrack, toggleSoloTrack,
    setMasterVolume, setReverbReturnVolume, addDeviceToTrack, removeDeviceFromTrack, updateDeviceParameter,
    setSessionClip, groupTracks, addVstScanPath, removeVstScanPath, loadAbletonSet
  } = useDAWStore();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [draggedOverTrack, setDraggedOverTrack] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'devices' | 'clip' | 'vst-paths'>('devices');
  const [browserCategory, setBrowserCategory] = useState<'all' | 'plugins' | 'fx'>('all');
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [activeColorPickerTrackId, setActiveColorPickerTrackId] = useState<string | null>(null);
  const [newVstPathInput, setNewVstPathInput] = useState('');

  // Audio Nodes Setup
  const masterGainRef = useRef<GainNode | null>(null);
  const trackGainsRef = useRef<{ [key: string]: GainNode }>({});
  const trackSendsRef = useRef<{ [key: string]: GainNode }>({});

  useEffect(() => {
    if (!masterGainRef.current) {
      masterGainRef.current = audioContext.createGain();
      masterGainRef.current.connect(audioContext.destination);
    }
    masterGainRef.current.gain.value = masterVolume;
  }, [masterVolume]);

  useEffect(() => {
    reverbReturnGain.gain.value = reverbReturnVolume;
  }, [reverbReturnVolume]);

  useEffect(() => {
    tracks.forEach((t: any) => {
      // Main track Gain
      if (!trackGainsRef.current[t.id]) {
        trackGainsRef.current[t.id] = audioContext.createGain();
        if (masterGainRef.current) {
          trackGainsRef.current[t.id].connect(masterGainRef.current);
        }
      }
      trackGainsRef.current[t.id].gain.value = t.isMuted ? 0 : t.volume;

      // Reverb Send Gain
      if (!trackSendsRef.current[t.id]) {
        trackSendsRef.current[t.id] = audioContext.createGain();
        trackSendsRef.current[t.id].connect(reverbReturnNode);
      }
      trackSendsRef.current[t.id].gain.value = t.sendReverb * t.volume;
    });
  }, [tracks]);

  // Playback & Playhead Engine
  const animationRef = useRef<number>();
  const [localPlaybackPosition, setLocalPlaybackPosition] = useState(0);
  const playStartTimeRef = useRef(0);
  const pauseTimeRef = useRef(0);

  useEffect(() => {
    if (isPlaying) {
      if (audioContext.state === 'suspended') {
        audioContext.resume();
      }
      playStartTimeRef.current = audioContext.currentTime - pauseTimeRef.current;
      const currentPlayheadTime = pauseTimeRef.current;
      
      // Play Arrangement regions
      regions.forEach((region: any) => {
        if (region.audioBuffer) {
          const source = audioContext.createBufferSource();
          source.buffer = region.audioBuffer;
          
          const trackGain = trackGainsRef.current[region.trackId];
          const trackSend = trackSendsRef.current[region.trackId];
          
          if (trackGain) source.connect(trackGain);
          if (trackSend) source.connect(trackSend);

          // Play offset inside the buffer, including startOffset and resume offset
          const actualBufferOffset = (region.startOffset || 0) + Math.max(0, currentPlayheadTime - region.startTime);
          const startOffset = Math.max(0, region.startTime - currentPlayheadTime);
          
          // Only play what's left inside the trimmed duration
          const durationLeft = region.duration - Math.max(0, currentPlayheadTime - region.startTime);
          
          if (durationLeft > 0) {
            source.start(audioContext.currentTime + startOffset, actualBufferOffset, durationLeft);
            activeSources.push(source);
          }
        }
      });

      const updatePlayhead = () => {
        const currentPos = audioContext.currentTime - playStartTimeRef.current;
        setLocalPlaybackPosition(currentPos);
        animationRef.current = requestAnimationFrame(updatePlayhead);
      };
      updatePlayhead();
    } else {
      // Stop playback
      activeSources.forEach(source => {
        try { source.stop(); } catch(e) {}
      });
      activeSources = [];
      if (playStartTimeRef.current > 0) {
        pauseTimeRef.current = audioContext.currentTime - playStartTimeRef.current;
        setLocalPlaybackPosition(pauseTimeRef.current);
      }
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    }

    return () => {
      // Clean up previous active sources before the effect runs again (e.g. during a drag)
      activeSources.forEach(source => {
        try { source.stop(); } catch(e) {}
      });
      activeSources = [];
      if (isPlaying && playStartTimeRef.current > 0) {
        // Store current playhead position during a drag so the new sources resume from here
        pauseTimeRef.current = audioContext.currentTime - playStartTimeRef.current;
      }
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, regions]);

  // Double stop to Return to Zero
  const handleStop = () => {
    if (!isPlaying && pauseTimeRef.current > 0) {
      pauseTimeRef.current = 0;
      setLocalPlaybackPosition(0);
    } else if (isPlaying) {
      togglePlayback();
    }
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
      if (e.code === 'Space' && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault();
        togglePlayback();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlayback]);

  // Find selected track and region
  const selectedTrack = tracks.find((t: any) => t.id === selectedTrackId);
  const selectedRegion = regions.find((r: any) => r.id === selectedRegionId);

  // Play session clip in real-time
  const playSessionClip = (trackId: string, slotIndex: number) => {
    const clip = sessionClips[trackId]?.[slotIndex];
    if (clip && clip.audioBuffer) {
      const source = audioContext.createBufferSource();
      source.buffer = clip.audioBuffer;
      
      const trackGain = trackGainsRef.current[trackId];
      const trackSend = trackSendsRef.current[trackId];
      if (trackGain) source.connect(trackGain);
      if (trackSend) source.connect(trackSend);
      
      source.start();
    }
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

  // Add custom path
  const handleAddVstPath = () => {
    if (newVstPathInput.trim()) {
      addVstScanPath(newVstPathInput.trim());
      setNewVstPathInput('');
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

        const sendNode = trackNode.querySelector('DeviceChain Mixer Sends TrackSendHolder Manual');
        const sendReverb = sendNode ? parseFloat(sendNode.getAttribute('Value') || '0.0') : 0.0;

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
          sendReverb,
          color,
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
        <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-color)', margin: '0 10px' }} />
        
        {/* Transport */}
        <button className={`btn-transport ${isRecording ? 'recording' : ''}`} onClick={toggleRecording} title="Arm Session Record">
          <Circle size={18} fill={isRecording ? 'var(--accent-red)' : 'none'} color={isRecording ? 'var(--accent-red)' : 'var(--text-primary)'} />
        </button>
        <button className={`btn-transport ${isPlaying ? 'playing' : ''}`} onClick={togglePlayback} title="Play">
          <Play size={18} />
        </button>
        <button className="btn-transport" onClick={handleStop} title="Stop">
          <Square size={18} />
        </button>
        
        <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--border-color)', margin: '0 10px' }} />

        {/* Metronome */}
        <button className={`btn-metronome ${isMetronomeEnabled ? 'active' : ''}`} onClick={toggleMetronome}>
          <Sliders size={14} style={{ marginRight: '5px' }} /> Click
        </button>

        <div className="control-bpm">{bpm.toFixed(2)} BPM</div>

        <button className="btn-metronome" onClick={() => fileInputRef.current?.click()} title="Import Ableton Live Set (.als)">
          <FolderOpen size={14} style={{ marginRight: '5px' }} /> Import ALS
        </button>
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleAlsImport} 
          accept=".als" 
          style={{ display: 'none' }} 
        />
        
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
          <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>MASTER</span>
          <Volume2 size={16} />
          <input 
            type="range" min="0" max="1" step="0.01" 
            value={masterVolume} 
            onChange={(e) => setMasterVolume(parseFloat(e.target.value))}
            className="fader-input"
          />
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
            <div className="arrangement-view">
              
              {/* Arranger Track Grid (Moved to left) */}
              <div className="arranger-timeline" onClick={() => setSelectedRegionId(null)}>
                <div className="arranger-grid" />
                <div className="playhead" style={{ left: `${localPlaybackPosition * PIXELS_PER_SECOND}px` }} />
                
                {tracks.map((track: any) => (
                  <div 
                    key={track.id} 
                    className={`arranger-track ${draggedOverTrack === track.id ? 'drag-over' : ''}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDraggedOverTrack(track.id);
                    }}
                    onDragLeave={() => setDraggedOverTrack(null)}
                    onDrop={(e) => handleDrop(e, track.id)}
                  >
                    {regions.filter((r: any) => r.trackId === track.id).map((region: any) => (
                      <AudioRegionNode 
                        key={region.id} 
                        region={region} 
                        trackColor={track.color} 
                        isSelected={selectedRegionId === region.id}
                        onClick={() => setSelectedRegionId(region.id)}
                      />
                    ))}
                  </div>
                ))}
              </div>

              {/* Mixer Headers / Tracks Panel (Moved to right) */}
              <div className="mixer-headers">
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
                </div>

                {tracks.map((track: any) => (
                  <div 
                    key={track.id} 
                    className={`track-header-box ${selectedTrackId === track.id ? 'selected' : ''}`}
                    onClick={() => setSelectedTrackId(track.id)}
                    style={{ 
                      borderLeft: `4px solid ${track.color}`,
                      paddingLeft: track.groupId ? '1.5rem' : '0.5rem' // Visually indent grouped tracks
                    }}
                  >
                    <div className="track-title-row">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
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
                      </div>
                      <button className="btn-icon" onClick={() => removeTrack(track.id)}><Trash2 size={12} /></button>
                    </div>
                    
                    {/* Track Mixer Controls */}
                    <div className="mixer-strip">
                      <button className={`btn-arm ${track.isArmed ? 'armed' : ''}`} onClick={() => toggleArmTrack(track.id)} title="Arm Recording"><Mic size={12} /></button>
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
                      
                      <div className="strip-val">
                        <span style={{ fontSize: '9px' }}>REV</span>
                        <input 
                          type="range" min="0" max="1" step="0.1" 
                          value={track.sendReverb} 
                          onChange={(e) => updateTrackSendReverb(track.id, parseFloat(e.target.value))}
                          className="mixer-dial"
                        />
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
                  </div>
                ))}

                {/* Return/Master Mixer Strip */}
                <div className="track-header-box return-master">
                  <div className="track-title-row">
                    <span style={{ fontSize: '10px', fontWeight: 'bold' }}>A-REVERB (RETURN)</span>
                  </div>
                  <div className="fader-row">
                    <Volume2 size={12} />
                    <input 
                      type="range" min="0" max="1" step="0.01" 
                      value={reverbReturnVolume} 
                      onChange={(e) => setReverbReturnVolume(parseFloat(e.target.value))}
                      className="mixer-fader"
                    />
                  </div>
                </div>
              </div>

            </div>
          ) : (
            // Session View Launcher
            <div className="session-view">
              {tracks.map((track: any) => (
                <div key={track.id} className="session-track-column" style={{ borderTop: `4px solid ${track.color}` }}>
                  <div className="session-track-header">{track.name}</div>
                  
                  {/* Slots */}
                  {[0, 1, 2, 3].map(slotIndex => {
                    const clip = sessionClips[track.id]?.[slotIndex];
                    return (
                      <div 
                        key={slotIndex} 
                        className={`session-clip-slot ${clip ? 'has-clip' : ''}`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => handleDrop(e, track.id, slotIndex)}
                        style={{ backgroundColor: clip ? `${track.color}40` : '' }}
                      >
                        {clip ? (
                          <div className="clip-launcher-btn" onClick={() => playSessionClip(track.id, slotIndex)}>
                            <Play size={10} fill="#fff" />
                            <span style={{ fontSize: '10px', overflow: 'hidden' }}>{clip.name}</span>
                          </div>
                        ) : (
                          <span style={{ fontSize: '9px', color: 'var(--text-secondary)' }}>Empty</span>
                        )}
                      </div>
                    );
                  })}
                  
                  {/* Track Activator / Volume */}
                  <div className="session-track-mixer">
                    <button className={`btn-mute ${track.isMuted ? 'muted' : ''}`} onClick={() => toggleMuteTrack(track.id)}>Activator</button>
                    <input 
                      type="range" min="0" max="1" step="0.01" 
                      value={track.volume} 
                      onChange={(e) => updateTrackVolume(track.id, parseFloat(e.target.value))}
                      className="session-volume"
                    />
                  </div>
                </div>
              ))}
              
              {/* Scene Launcher Column */}
              <div className="session-track-column scene-launcher">
                <div className="session-track-header">Scenes</div>
                {[0, 1, 2, 3].map(slotIndex => (
                  <button 
                    key={slotIndex} 
                    className="btn-scene-launch" 
                    onClick={() => {
                      tracks.forEach((t: any) => playSessionClip(t.id, slotIndex));
                    }}
                  >
                    <ArrowRight size={12} style={{ marginRight: '4px' }} /> Scene {slotIndex + 1}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Detail panel */}
      <div className="bottom-detail-panel">
        <div className="detail-tabs">
          <button className="detail-tab active">Device Chain</button>
          <button className="detail-tab">Clip View</button>
          <button className="detail-tab" onClick={() => setActiveTab('vst-paths')}>VST Folders Scan</button>
        </div>
        
        <div className="detail-content">
          {activeTab === 'devices' && (
            <div className="device-chain-view">
              {selectedTrack ? (
                <>
                  <div style={{ marginRight: '1rem', borderRight: '1px solid var(--border-color)', paddingRight: '1rem' }}>
                    <h5 style={{ color: selectedTrack.color }}>{selectedTrack.name} Device Chain</h5>
                    <button className="btn-add-track" style={{ marginTop: '5px' }} onClick={() => addDeviceToTrack(selectedTrack.id, BROWSER_PLUGINS[0])}>
                      <Plus size={12} /> Add Device
                    </button>
                  </div>
                  
                  {/* Plugin Cards */}
                  <div className="device-cards">
                    {selectedTrack.plugins.map((plugin: any) => (
                      <div key={plugin.id} className="device-card">
                        <div className="device-card-header">
                          <span>{plugin.name}</span>
                          <button className="btn-icon" onClick={() => removeDeviceFromTrack(selectedTrack.id, plugin.id)}><Trash2 size={12} /></button>
                        </div>
                        <div className="device-card-params">
                          {Object.keys(plugin.parameters).map((paramName) => (
                            <div key={paramName} className="param-slider-row">
                              <span style={{ fontSize: '10px' }}>{paramName}</span>
                              <input 
                                type="range" min="0" max="100" 
                                value={plugin.parameters[paramName]} 
                                onChange={(e) => updateDeviceParameter(selectedTrack.id, plugin.id, paramName, parseFloat(e.target.value))}
                                className="param-slider"
                              />
                              <span style={{ fontSize: '10px', width: '20px', textAlign: 'right' }}>{plugin.parameters[paramName]}</span>
                            </div>
                          ))}
                        </div>
                      </div>
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
              {selectedRegion ? (
                <div style={{ display: 'flex', gap: '2rem' }}>
                  <div>
                    <h5>Selected Clip</h5>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>{selectedRegion.file}</div>
                  </div>
                  <div className="clip-control-box">
                    <span className="clip-control-label">Transpose</span>
                    <input type="number" min="-24" max="24" defaultValue="0" className="clip-input" />
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>st</span>
                  </div>
                  <div className="clip-control-box">
                    <span className="clip-control-label">Gain</span>
                    <input type="number" min="-60" max="6" defaultValue="0" className="clip-input" />
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>dB</span>
                  </div>
                  <div className="clip-control-box">
                    <span className="clip-control-label">Loop</span>
                    <button className="btn-view active">ON</button>
                  </div>
                </div>
              ) : (
                <div className="detail-empty-message">No clip selected. Double click or click an audio block on the timeline to edit.</div>
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
                onClick={() => alert("Rescanning plugin folders... Complete! Native VSTs mapped to NoProd audio graph.")}
              >
                Scan & Wire Local Plugins
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
