// Stock audio-effect devices: parameter specs (drive the generic device UI,
// macro ranges and automation) plus a Web Audio DSP factory per device kind.
// Device objects in the store look like:
//   { id, name, type: 'audio-fx', kind: 'compressor', parameters: { Threshold: -18, ... } }
// Third-party 'vst' entries have no kind and pass audio through untouched
// (native hosting is audio_core's job, not the browser's).

import dynamicsProcessorUrl from './worklets/dynamics-processor.js?url';

export type ParamValue = number | boolean | string;

export interface ParamSpec {
  name: string;
  kind?: 'number' | 'bool' | 'enum'; // default 'number'
  min?: number;
  max?: number;
  step?: number;
  log?: boolean;        // slider moves logarithmically (frequencies, times)
  unit?: string;
  options?: string[];   // enum choices
  default: ParamValue;
  minLabel?: string;    // shown when the value sits at min (e.g. '-inf')
}

// One automation/modulation target: an AudioParam plus a mapping from the
// device-parameter value (in its own units) to the AudioParam's value.
export interface ParamTarget {
  param: AudioParam;
  map: (v: number) => number;
}

export interface DeviceDSP {
  input: AudioNode;
  output: AudioNode;
  update(params: Record<string, ParamValue>): void;
  targets?(paramName: string): ParamTarget[];
  getReduction?(): number;                        // current gain reduction in dB (<= 0)
  getResponse?(freqs: Float32Array): Float32Array; // magnitude response in dB
  dispose(): void;
}

export interface DeviceDef {
  kind: string;
  name: string;
  description: string;
  params: ParamSpec[];
  create(ctx: BaseAudioContext): DeviceDSP;
}

export const dbToGain = (db: number, floorDb = -60) => (db <= floorDb ? 0 : Math.pow(10, db / 20));

const num = (v: ParamValue | undefined, fallback: number) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
};

// Set an AudioParam only when the value actually changes, so a store update
// for an unrelated field never clobbers scheduled automation on this param.
const setParam = (p: AudioParam, v: number) => {
  if (Math.abs(p.value - v) > 1e-6) p.value = v;
};

// Shared dry/wet crossfade used by several devices.
const createMix = (ctx: BaseAudioContext) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);
  const setMix = (pct: number) => {
    const w = Math.max(0, Math.min(1, pct / 100));
    setParam(dry.gain, 1 - w);
    setParam(wet.gain, w);
  };
  const targets = (): ParamTarget[] => [
    { param: dry.gain, map: (v) => 1 - Math.max(0, Math.min(1, v / 100)) },
    { param: wet.gain, map: (v) => Math.max(0, Math.min(1, v / 100)) }
  ];
  return { input, output, wet, setMix, targets };
};

// ---------------------------------------------------------------- Dynamics

// AudioWorklet modules must be registered on a context before devices that use
// them can be created there (done once at startup for the live context).
export const loadDeviceWorklets = (ctx: BaseAudioContext) => ctx.audioWorklet.addModule(dynamicsProcessorUrl);

// Wrap the shared dynamics worklet: AudioParams are exposed by name for
// automation and the processor reports its current gain reduction.
const createDynamics = (ctx: BaseAudioContext) => {
  const node = new AudioWorkletNode(ctx, 'noprod-dynamics', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2]
  });
  let gr = 0;
  node.port.onmessage = (e) => { gr = e.data.gr; };
  const param = (name: string) => node.parameters.get(name)!;
  return { node, param, getReduction: () => gr };
};

const compressorDef: DeviceDef = {
  kind: 'compressor',
  name: 'Compressor',
  description: 'Dynamics compressor with knee, makeup gain and gain-reduction metering',
  params: [
    { name: 'Threshold', min: -60, max: 0, step: 0.1, unit: 'dB', default: -18 },
    { name: 'Ratio', min: 1, max: 20, step: 0.1, unit: ':1', default: 4 },
    { name: 'Attack', min: 0.1, max: 300, log: true, unit: 'ms', default: 10 },
    { name: 'Release', min: 10, max: 1000, log: true, unit: 'ms', default: 100 },
    { name: 'Knee', min: 0, max: 40, step: 0.1, unit: 'dB', default: 6 },
    { name: 'Makeup', min: 0, max: 24, step: 0.1, unit: 'dB', default: 0 },
    { name: 'Dry/Wet', min: 0, max: 100, step: 1, unit: '%', default: 100 }
  ],
  create(ctx) {
    const dyn = createDynamics(ctx);
    const map: Record<string, ParamTarget> = {
      Threshold: { param: dyn.param('threshold'), map: (v) => v },
      Ratio: { param: dyn.param('ratio'), map: (v) => v },
      Attack: { param: dyn.param('attack'), map: (v) => v / 1000 },
      Release: { param: dyn.param('release'), map: (v) => v / 1000 },
      Knee: { param: dyn.param('knee'), map: (v) => v },
      Makeup: { param: dyn.param('makeup'), map: (v) => v },
      'Dry/Wet': { param: dyn.param('mix'), map: (v) => v / 100 }
    };
    return {
      input: dyn.node,
      output: dyn.node,
      update(p) {
        Object.entries(map).forEach(([name, t]) => setParam(t.param, t.map(num(p[name], 0))));
      },
      targets: (name) => (map[name] ? [map[name]] : []),
      getReduction: dyn.getReduction,
      dispose() { dyn.node.disconnect(); dyn.node.port.onmessage = null; }
    };
  }
};

// ---------------------------------------------------------------- Reverb

// Exponentially decaying stereo noise: a cheap but convincing room tail.
const makeImpulse = (ctx: BaseAudioContext, decay: number) => {
  const len = Math.max(1, Math.floor(ctx.sampleRate * decay));
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return ir;
};

const reverbDef: DeviceDef = {
  kind: 'reverb',
  name: 'NoProd Reverb',
  description: 'Convolution room reverb',
  params: [
    { name: 'Dry/Wet', min: 0, max: 100, step: 1, unit: '%', default: 30 },
    { name: 'Decay', min: 0.2, max: 10, step: 0.1, log: true, unit: 's', default: 2.5 }
  ],
  create(ctx) {
    const mix = createMix(ctx);
    const conv = ctx.createConvolver();
    mix.input.connect(conv);
    conv.connect(mix.wet);
    let decay = -1;
    return {
      input: mix.input,
      output: mix.output,
      update(p) {
        const d = num(p.Decay, 2.5);
        if (d !== decay) { decay = d; conv.buffer = makeImpulse(ctx, d); }
        mix.setMix(num(p['Dry/Wet'], 30));
      },
      targets: (name) => (name === 'Dry/Wet' ? mix.targets() : []),
      dispose() { mix.input.disconnect(); conv.disconnect(); mix.output.disconnect(); }
    };
  }
};

// ---------------------------------------------------------------- Delay

const delayDef: DeviceDef = {
  kind: 'delay',
  name: 'NoProd Delay',
  description: 'Feedback delay',
  params: [
    { name: 'Time', min: 0.01, max: 2, step: 0.01, log: true, unit: 's', default: 0.25 },
    { name: 'Feedback', min: 0, max: 95, step: 1, unit: '%', default: 40 },
    { name: 'Dry/Wet', min: 0, max: 100, step: 1, unit: '%', default: 30 }
  ],
  create(ctx) {
    const mix = createMix(ctx);
    const delay = ctx.createDelay(2.5);
    const fb = ctx.createGain();
    mix.input.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(mix.wet);
    return {
      input: mix.input,
      output: mix.output,
      update(p) {
        setParam(delay.delayTime, num(p.Time, 0.25));
        setParam(fb.gain, Math.min(0.95, num(p.Feedback, 40) / 100));
        mix.setMix(num(p['Dry/Wet'], 30));
      },
      targets(name) {
        if (name === 'Time') return [{ param: delay.delayTime, map: (v) => v }];
        if (name === 'Feedback') return [{ param: fb.gain, map: (v) => Math.min(0.95, v / 100) }];
        if (name === 'Dry/Wet') return mix.targets();
        return [];
      },
      dispose() { mix.input.disconnect(); delay.disconnect(); fb.disconnect(); mix.output.disconnect(); }
    };
  }
};

export const DEVICE_DEFS: Record<string, DeviceDef> = {
  compressor: compressorDef,
  reverb: reverbDef,
  delay: delayDef
};

// Older saved/imported devices predate `kind`; resolve them by name.
const LEGACY_KINDS: Record<string, string> = {
  'NoProd Reverb': 'reverb',
  'NoProd Delay': 'delay'
};

export const deviceKind = (device: any): string | null =>
  device?.kind || LEGACY_KINDS[device?.name] || null;

export const getDeviceDef = (device: any): DeviceDef | null => {
  const k = deviceKind(device);
  return k ? DEVICE_DEFS[k] || null : null;
};

export const defaultParameters = (def: DeviceDef) => {
  const out: Record<string, ParamValue> = {};
  def.params.forEach((p) => { out[p.name] = p.default; });
  return out;
};

// A fresh device object for the store (id is assigned by the store action).
export const createDevice = (kind: string) => {
  const def = DEVICE_DEFS[kind];
  return { name: def.name, type: 'audio-fx', kind, parameters: defaultParameters(def) };
};

// Device parameters with spec defaults filled in for anything missing.
export const resolvedParameters = (device: any) => {
  const def = getDeviceDef(device);
  return def ? { ...defaultParameters(def), ...(device.parameters || {}) } : device.parameters || {};
};

export const formatParam = (spec: ParamSpec | undefined, v: ParamValue): string => {
  if (!spec || typeof v !== 'number') return String(v);
  if (spec.minLabel && spec.min !== undefined && v <= spec.min) return spec.minLabel;
  const unit = spec.unit || '';
  if (unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : `${Math.round(v)}`;
  if (unit === 'ms') return v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : `${Math.round(v)}`;
  if (unit === '%') return `${Math.round(v)}`;
  if (Math.abs(v) >= 100) return `${Math.round(v)}`;
  return v.toFixed(Math.abs(v) < 10 ? 2 : 1);
};

// Slider position (0..1000) <-> value, logarithmic where the spec asks for it.
export const SLIDER_STEPS = 1000;
export const valueToSlider = (spec: ParamSpec, v: number) => {
  const min = spec.min ?? 0, max = spec.max ?? 100;
  const t = spec.log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
  return Math.round(Math.max(0, Math.min(1, t)) * SLIDER_STEPS);
};
export const sliderToValue = (spec: ParamSpec, pos: number) => {
  const min = spec.min ?? 0, max = spec.max ?? 100;
  const t = pos / SLIDER_STEPS;
  const raw = spec.log ? min * Math.pow(max / min, t) : min + t * (max - min);
  const step = spec.step ?? (spec.log ? 0 : 0.01);
  const v = step ? Math.round(raw / step) * step : raw;
  return Math.round(v * 1000) / 1000;
};

// Instantiate a device's DSP (null for pass-through devices like unhosted VSTs).
export const createDeviceDSP = (ctx: BaseAudioContext, device: any): DeviceDSP | null => {
  const def = getDeviceDef(device);
  if (!def) return null;
  try {
    const dsp = def.create(ctx);
    dsp.update(resolvedParameters(device));
    return dsp;
  } catch (err) {
    // e.g. a worklet module not registered on this context: pass audio through
    console.warn(`Could not create ${def.name} DSP`, err);
    return null;
  }
};
