// Shared IPC schemas for the NoProd DAW

export interface HapEvent {
  type: 'HAP_STREAM';
  haps: Array<{
    time: number;        // Context time in seconds
    note: string;        // E.g. 'C4'
    duration: number;    // Duration in seconds
    sourceCode: string; // The strudel pattern snippet
    engine?: string;
    
    // New fields for VST support
    vstPlugin?: string; // Optional: target VST name (e.g. "AutoTune")
    trackIndex?: number;// Audio Core track (0-15) the hap plays on; the Sequencer sends the hap's Strudel orbit
  }>;
}

export interface EvalCommand {
  type: 'EVAL';
  code: string; // The Strudel code to evaluate
}

export interface DictationCommand {
  type: 'DICTATION';
  text: string;
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

// ---- Native plugin hosting (Audio Core insert chains; apps/audio_core/src/PluginHost.h)
// Frontend -> Orchestrator -> Audio Core. Every command except the two
// parameter ones is answered with AUDIO_CORE_STATE (or AUDIO_CORE_ERROR).

export type PluginFormat = 'VST3' | 'AudioUnit' | 'LPI';

// The master bus, or a track (0-15) -- one per Strudel orbit
export type AudioCoreBus = 'master' | number;

export interface GetAudioCoreStateCommand { type: 'GET_AUDIO_CORE_STATE' }
export interface ScanPluginsCommand { type: 'SCAN_PLUGINS'; paths?: string[] }
export interface LoadPluginCommand { type: 'LOAD_PLUGIN'; path: string; format?: PluginFormat; pluginId?: string; bus?: AudioCoreBus; index?: number }
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
}

export interface AudioCoreStateEvent {
  type: 'AUDIO_CORE_STATE';
  sampleRate: number;
  blockSize: number;
  device?: { name: string; running: boolean };
  outputPeak?: number; // post-master peak since the previous state report
  trackCount: number;
  buses: Array<{ bus: AudioCoreBus; inserts: NativeInsertSlot[] }>; // master first, then tracks with inserts
  availablePlugins: Array<{ name: string; vendor: string; format: PluginFormat; path: string; pluginId: string }>;
  scanFolders: string[];
  streams?: Array<{ streamId: string; inserts: NativeInsertSlot[] }>; // browser-track plug-ins
}

export interface PluginParameterChangedEvent {
  type: 'PLUGIN_PARAMETER_CHANGED';
  slotId: string; parameterIndex: number; value: number; text: string;
}

export interface AudioCoreErrorEvent { type: 'AUDIO_CORE_ERROR'; message: string; request: string }

// Sent by the Orchestrator when its Audio Core connection opens or drops
export interface AudioCoreStatusEvent { type: 'AUDIO_CORE_STATUS'; connected: boolean }

// ---- Browser-track streams (ws://localhost:8083, apps/audio_core/src/TrackStreams.h)
// One connection per track device hosting a plug-in. Binary messages are
// audio: uint32 block, uint32 frames, uint32 channels, uint32 flags (0), then
// float32 planar samples; each comes back processed in place.
export type TrackStreamCommand =
  | { type: 'OPEN'; streamId: string; sampleRate: number; maxBlockSize: number }
  | { type: 'LOAD'; path: string; format?: PluginFormat; pluginId?: string; parameters?: Record<string, number> }
  | { type: 'UNLOAD' }
  | { type: 'SET_PARAM'; parameterId?: string; parameterIndex?: number; value: number }
  | { type: 'GET_STATE' };

export type TrackStreamEvent =
  | { type: 'STREAM_OPENED' }
  | { type: 'STREAM_STATE'; streamId: string; sampleRate: number; maxBlockSize: number; insert: NativeInsertSlot | null }
  | PluginParameterChangedEvent
  | AudioCoreErrorEvent;

export type AudioCoreCommand =
  | GetAudioCoreStateCommand | ScanPluginsCommand | LoadPluginCommand | RemovePluginCommand
  | MovePluginCommand | SetPluginBypassCommand | SetPluginParameterCommand | SetVstParameterEvent;

export type AudioCoreEvent = AudioCoreStateEvent | PluginParameterChangedEvent | AudioCoreErrorEvent | AudioCoreStatusEvent;

export type IpcMessage = HapEvent | EvalCommand | DictationCommand | AudioCoreCommand | AudioCoreEvent;
