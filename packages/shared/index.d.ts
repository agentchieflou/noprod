// Shared IPC schemas for the NoProd DAW

// What the Audio Core (GhostDAW) plays; nothing sends it since the headless
// sequencer went (#133), until #134 rebuilds the Audio Core
export interface HapEvent {
  type: 'HAP_STREAM';
  cps?: number;          // cycles per second the pattern set (the default is 0.5)
  code?: string;         // the evaluated pattern code
  haps: Array<{
    time: number;        // Start, in cycles (one cycle is one bar)
    note: string;        // The note, or else the sound name (e.g. 'c3', 'bd')
    duration: number;    // Length, in cycles
    sourceCode: string; // The strudel pattern snippet
    engine?: string;
    s?: string;          // Sound name (library sounds: packages/sound/src/library/strudel.ts)
    pitch?: string | number; // The note value ('c3', 60), if it has one
    bank?: string;       // Drum machine (e.g. 'RolandTR909')
    gain?: number;
    velocity?: number;
    
    // New fields for VST support
    vstPlugin?: string; // Optional: target VST name (e.g. "AutoTune")
    trackIndex?: number;// Audio Core track (0-15) the hap plays on; the Sequencer sends the hap's Strudel orbit
  }>;
}

// Addresses a plugin by name on an Audio Core track (trackIndex 0-15; a
// negative or missing trackIndex means the master bus). See also
// SetPluginParameterCommand, which addresses an insert by slotId.
export interface SetVstParameterEvent {
  type: 'SET_VST_PARAMETER';
  trackIndex?: number;
  pluginName: string;
  parameterIndex: number;
  value: number; // 0.0 to 1.0 normalized value
}

// ---- Native plugin hosting (Audio Core insert chains; apps/audio_core/src/host/PluginHost.h)
// Frontend -> Audio Core, on ws://localhost:8082/?token=<pairing token>.
// Every command except the two parameter ones and the editor ones is
// answered with AUDIO_CORE_STATE (or AUDIO_CORE_ERROR). A program of the
// user's own connects the same way, with the token from GhostDAW's data
// folder, to send haps.

export type PluginFormat = 'VST3' | 'AU' | 'LPI';

// Pairing (apps/audio_core/README.md, "Secure by design"): a connection
// without a token may only send PAIR with the code GhostDAW printed at
// launch; PAIRED brings the token every later connection presents. Five
// wrong codes lock pairing until GhostDAW restarts.
export interface PairCommand { type: 'PAIR'; code: string }
export interface PairedEvent { type: 'PAIRED'; token: string; rotated?: boolean }
export interface PairFailedEvent { type: 'PAIR_FAILED'; locked: boolean; attemptsLeft: number }
// From a paired connection: a new token; every other client pairs again
export interface RotatePairingTokenCommand { type: 'ROTATE_PAIRING_TOKEN' }

// The master bus, or a track (0-15) -- one per Strudel orbit
export type AudioCoreBus = 'master' | number;

export interface GetAudioCoreStateCommand { type: 'GET_AUDIO_CORE_STATE' }
// Scans the platform's plug-in folders and GhostDAW's own scanFolders; folders a client sends are ignored
export interface ScanPluginsCommand { type: 'SCAN_PLUGINS' }
// Plug-ins load by their id from availablePlugins, never by path (a path is refused)
export interface LoadPluginCommand { type: 'LOAD_PLUGIN'; pluginId: string; bus?: AudioCoreBus; index?: number }
export interface RemovePluginCommand { type: 'REMOVE_PLUGIN'; slotId: string }
export interface MovePluginCommand { type: 'MOVE_PLUGIN'; slotId: string; index: number }
export interface SetPluginBypassCommand { type: 'SET_PLUGIN_BYPASS'; slotId: string; bypassed: boolean }
export interface SetPluginParameterCommand {
  type: 'SET_PLUGIN_PARAMETER';
  slotId: string;
  parameterIndex?: number;
  parameterId?: string; // preferred over parameterIndex when given
  value: number;        // in the parameter's own min..max range
}

export interface NativePluginParameter {
  index: number; id: string; name: string;
  min: number; max: number; default: number; value: number; text: string;
  stepped: boolean; boolean: boolean; readOnly: boolean;
}

export interface NativeInsertSlot {
  slotId: string; name: string; format: PluginFormat; path: string;
  bypassed: boolean; latencySamples: number; parameters: NativePluginParameter[];
  hasEditor: boolean;  // an LPI plug-in with an editor the browser can show
  editorOpen: boolean;
}

// Plugin editors (#44 B6): OPEN_EDITOR opens one in the Audio Core, which
// then streams it from ws://localhost:<port> (apps/audio_core/src/editor/EditorStream.h:
// send START { editorId }; binary frames come back, CLOSED when it goes away).
// One editor is open at a time.
export interface OpenEditorCommand { type: 'OPEN_EDITOR'; slotId: string; scale?: number }
export interface CloseEditorCommand { type: 'CLOSE_EDITOR' }
export interface EditorOpenedEvent {
  type: 'EDITOR_OPENED';
  editorId: string; slotId: string; name: string;
  port: number;
  width: number; height: number; // frame size in pixels
  scale: number;                 // frame pixels per CSS pixel
  keyboard: boolean;             // takes keys while focused (LPI lpi.gui.keyboard.v1)
}
export interface EditorClosedEvent { type: 'EDITOR_CLOSED'; editorId?: string; slotId?: string }

export interface AudioCoreStateEvent {
  type: 'AUDIO_CORE_STATE';
  protocolVersion: number; // 2
  sampleRate: number;
  blockSize: number;
  device?: { name: string; running: boolean };
  outputPeak?: number; // post-master peak since the previous state report
  trackCount: number;
  streamPort: number; // where browser tracks stream their audio (the stream server, below)
  buses: Array<{ bus: AudioCoreBus; inserts: NativeInsertSlot[] }>; // master first, then tracks with inserts
  availablePlugins: Array<{ name: string; vendor: string; format: PluginFormat; path: string; pluginId: string }>;
  skippedPlugins: Array<{ path: string; reason: string }>; // binaries that crashed or hung while scanning
  scanFolders: string[];
  scanning: boolean;
  streams?: Array<{ streamId: string; inserts: NativeInsertSlot[] }>; // browser-track plug-ins
}

export interface PluginParameterChangedEvent {
  type: 'PLUGIN_PARAMETER_CHANGED';
  slotId: string; parameterIndex: number; value: number; text: string;
  source?: 'editor'; // changed in the plug-in's own editor, not an answer to a SET
  // A drag in the editor: its first change, and its release (with the final
  // value). Only from plug-ins that report gestures (LPI lpi.params.changes.v1).
  gestureBegin?: boolean;
  gestureEnd?: boolean;
}

export interface AudioCoreErrorEvent { type: 'AUDIO_CORE_ERROR'; message: string; request: string }

// ---- Browser-track streams (the stream port the state announces, apps/audio_core/src/host/TrackStreams.h)
// One connection per track device hosting a plug-in. Binary messages are
// audio: uint32 block, uint32 frames, uint32 channels, uint32 flags; when
// flags bit 0 is set, a transport block (float64 tempo, float64 position in
// quarter notes, uint32 flags as LPI_TRANSPORT_*, uint32 reserved); then
// float32 planar samples. Each comes back processed in place.
export type TrackStreamCommand =
  | { type: 'OPEN'; streamId: string; sampleRate: number; maxBlockSize: number }
  | { type: 'LOAD'; path: string; format?: PluginFormat; pluginId?: string; parameters?: Record<string, number> }
  | { type: 'UNLOAD' }
  | { type: 'SET_PARAM'; parameterId?: string; parameterIndex?: number; value: number }
  | { type: 'GET_STATE' }
  | { type: 'OPEN_EDITOR'; scale?: number }
  | CloseEditorCommand;

export type TrackStreamEvent =
  | { type: 'STREAM_OPENED' }
  | { type: 'STREAM_STATE'; streamId: string; sampleRate: number; maxBlockSize: number; insert: NativeInsertSlot | null }
  | PluginParameterChangedEvent
  | EditorOpenedEvent | EditorClosedEvent
  | AudioCoreErrorEvent;

export type AudioCoreCommand =
  | GetAudioCoreStateCommand | ScanPluginsCommand | LoadPluginCommand | RemovePluginCommand
  | MovePluginCommand | SetPluginBypassCommand | SetPluginParameterCommand | SetVstParameterEvent
  | OpenEditorCommand | CloseEditorCommand;

export type AudioCoreEvent = AudioCoreStateEvent | PluginParameterChangedEvent | EditorOpenedEvent | EditorClosedEvent
  | AudioCoreErrorEvent | PairedEvent | PairFailedEvent;

export type IpcMessage = HapEvent | AudioCoreCommand | AudioCoreEvent;
