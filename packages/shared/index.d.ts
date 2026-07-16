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
    trackIndex?: number;// Optional: track routing
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

export interface SetVstParameterEvent {
  type: 'SET_VST_PARAMETER';
  trackIndex: number;
  pluginName: string;
  parameterIndex: number;
  value: number; // 0.0 to 1.0 normalized value
}


export type IpcMessage = HapEvent | EvalCommand | DictationCommand | SetVstParameterEvent;
