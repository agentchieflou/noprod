// MIDI learn targets: the controls a controller can drive. A target is plain
// data (saved in the project); resolveTarget turns it into the current
// normalized value (0..1) and the state change that sets a new one. No store
// import, so the store can use it.

import { getParamSpecs, resolvedParameters, sliderToValue, valueToSlider, SLIDER_STEPS, type ParamSpec } from './devices';

export type MidiTarget =
  | { kind: 'track'; trackId: string; param: 'volume' | 'pan' | 'mute' | 'solo' }
  | { kind: 'send'; trackId: string; returnId: string }
  | { kind: 'master'; param: 'volume' }
  | { kind: 'device'; deviceId: string; param: string }
  | { kind: 'instrument'; trackId: string; param: string }
  | { kind: 'tempo' };

export interface MidiSource {
  input: string;            // MIDI input id, or 'computer'
  channel: number;          // 1..16
  type: 'cc' | 'note';
  number: number;           // CC number or note
}

export interface MidiMapping {
  id: string;
  target: MidiTarget;
  source: MidiSource;
  min: number;              // 0..1 of the control's range
  max: number;
  mode: 'pickup' | 'jump';
  invert: boolean;
}

export interface ResolvedTarget {
  label: string;
  toggle: boolean;
  norm: number;                                  // current value, 0..1 (toggles: 0 or 1)
  apply: (state: any, norm: number) => any;      // partial state for the new value (pass the state it was resolved from)
}

// Instrument parameters the detail panel shows as sliders (InstrumentCard)
const INSTRUMENT_RANGES: Record<string, [number, number]> = {
  Gain: [0, 1], Attack: [0, 1], Sustain: [0, 1], Release: [0, 1]
};
// The detail panel's sliders: library sounds tune ±24; the classic kit ±12
// and stretches its decay; the synth has none of those
const instrumentRange = (instrument: any, param: string): [number, number] | null => {
  const p = instrument.parameters ?? {};
  const classicKit = p.Kit === 'drums' && !p.Library;
  if (param === 'Tune') return p.Library ? [-24, 24] : classicKit ? [-12, 12] : null;
  if (param === 'Decay') return classicKit ? [0.2, 2.5] : p.Library ? null : [0, 1];
  return INSTRUMENT_RANGES[param] ?? null;
};

export const TEMPO_RANGE: [number, number] = [40, 240];

export const targetKey = (t: MidiTarget): string => {
  switch (t.kind) {
    case 'track': return `track:${t.trackId}:${t.param}`;
    case 'send': return `send:${t.trackId}:${t.returnId}`;
    case 'master': return `master:${t.param}`;
    case 'device': return `device:${t.deviceId}:${t.param}`;
    case 'instrument': return `instrument:${t.trackId}:${t.param}`;
    case 'tempo': return 'tempo';
  }
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const lerp = (lo: number, hi: number, n: number) => lo + clamp01(n) * (hi - lo);
const unlerp = (lo: number, hi: number, v: number) => clamp01((v - lo) / (hi - lo));

// A device anywhere: any strip's chain, or inside a rack
export function findDevice(state: any, deviceId: string): any | null {
  const search = (plugins: any[] = []): any => {
    for (const p of plugins) {
      if (p.id === deviceId) return p;
      if (p.type === 'rack') { const hit = search(p.devices); if (hit) return hit; }
    }
    return null;
  };
  for (const strip of [...state.tracks, ...state.returns]) { const hit = search(strip.plugins); if (hit) return hit; }
  return search(state.masterPlugins);
}

// Updates the device with this id wherever it sits (mirrors the store's mapDeviceAnywhere)
const patchDevice = (state: any, deviceId: string, fn: (d: any) => any) => {
  const inList = (plugins: any[] = []): any[] => {
    let changed = false;
    const next = plugins.map((p) => {
      if (p.id === deviceId) { changed = true; return fn(p); }
      if (p.type === 'rack') {
        const devices = inList(p.devices);
        if (devices !== p.devices) { changed = true; return { ...p, devices }; }
      }
      return p;
    });
    return changed ? next : plugins;
  };
  const inStrips = (strips: any[]) => strips.map((s) => {
    const plugins = s.plugins && inList(s.plugins);
    return plugins === s.plugins ? s : { ...s, plugins };
  });
  return { tracks: inStrips(state.tracks), returns: inStrips(state.returns), masterPlugins: inList(state.masterPlugins) };
};

export function resolveTarget(state: any, t: MidiTarget): ResolvedTarget | null {
  const track = 'trackId' in t ? state.tracks.find((x: any) => x.id === t.trackId) : null;
  const patchTrack = (patch: (tr: any) => any) => ({
    tracks: state.tracks.map((x: any) => (x.id === (t as any).trackId ? patch(x) : x))
  });
  switch (t.kind) {
    case 'track': {
      if (!track) return null;
      if (t.param === 'volume') return { label: `${track.name} · Volume`, toggle: false, norm: clamp01(track.volume), apply: (_s, n) => patchTrack((x) => ({ ...x, volume: clamp01(n) })) };
      if (t.param === 'pan') return { label: `${track.name} · Pan`, toggle: false, norm: unlerp(-1, 1, track.pan), apply: (_s, n) => patchTrack((x) => ({ ...x, pan: Math.round(lerp(-1, 1, n) * 1000) / 1000 })) };
      const key = t.param === 'mute' ? 'isMuted' : 'isSoloed';
      return { label: `${track.name} · ${t.param === 'mute' ? 'Mute' : 'Solo'}`, toggle: true, norm: track[key] ? 1 : 0, apply: (_s, n) => patchTrack((x) => ({ ...x, [key]: n >= 0.5 })) };
    }
    case 'send': {
      const ret = state.returns.find((r: any) => r.id === t.returnId);
      if (!track || !ret) return null;
      return { label: `${track.name} · Send ${ret.name}`, toggle: false, norm: clamp01(track.sends?.[t.returnId] ?? 0), apply: (_s, n) => patchTrack((x) => ({ ...x, sends: { ...(x.sends || {}), [t.returnId]: clamp01(n) } })) };
    }
    case 'master':
      return { label: 'Master · Volume', toggle: false, norm: clamp01(state.masterVolume), apply: (_s, n) => ({ masterVolume: clamp01(n) }) };
    case 'tempo':
      return { label: 'Tempo', toggle: false, norm: unlerp(...TEMPO_RANGE, state.bpm), apply: (_s, n) => ({ bpm: Math.round(lerp(...TEMPO_RANGE, n) * 10) / 10 }) };
    case 'instrument': {
      const inst = track?.instrument;
      const range = inst && typeof inst.parameters?.[t.param] === 'number' ? instrumentRange(inst, t.param) : null;
      if (!range) return null;
      return {
        label: `${track.name} · ${t.param}`, toggle: false, norm: unlerp(...range, inst.parameters[t.param]),
        apply: (_s, n) => patchTrack((x) => ({ ...x, instrument: { ...x.instrument, parameters: { ...x.instrument.parameters, [t.param]: Math.round(lerp(...range, n) * 1000) / 1000 } } }))
      };
    }
    case 'device': {
      const device = findDevice(state, t.deviceId);
      if (!device) return null;
      const set = (v: number | boolean) => patchDevice(state, t.deviceId, (d) => ({ ...d, parameters: { ...d.parameters, [t.param]: v } }));
      const specs = getParamSpecs(device);
      const spec: ParamSpec | undefined = specs?.find((s) => s.name === t.param);
      const params = resolvedParameters(device);
      const label = `${device.name} · ${t.param}`;
      if (specs) {
        if (!spec || spec.kind === 'enum') return null;
        if (spec.kind === 'bool') return { label, toggle: true, norm: params[t.param] ? 1 : 0, apply: (_s, n) => set(n >= 0.5) };
        return {
          label, toggle: false, norm: valueToSlider(spec, Number(params[t.param])) / SLIDER_STEPS,
          apply: (_s, n) => set(sliderToValue(spec, clamp01(n) * SLIDER_STEPS))
        };
      }
      // Unhosted plug-in: generic 0..100 parameters
      if (typeof device.parameters?.[t.param] !== 'number') return null;
      return { label, toggle: false, norm: unlerp(0, 100, device.parameters[t.param]), apply: (_s, n) => set(Math.round(lerp(0, 100, n) * 10) / 10) };
    }
  }
}

// What a mapping turns an incoming value (0..1) into: the control's normalized value
export const mappedValue = (m: MidiMapping, incoming: number) =>
  m.min + (m.invert ? 1 - incoming : incoming) * (m.max - m.min);

// Mappings to a track, return or device the project doesn't have
export const splitMappings = (state: any, mappings: MidiMapping[]) => {
  const kept: MidiMapping[] = [], dropped: MidiMapping[] = [];
  (mappings || []).forEach((m) => (resolveTarget(state, m.target) ? kept : dropped).push(m));
  return { kept, dropped };
};
