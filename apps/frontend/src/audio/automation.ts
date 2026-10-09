// What a track can automate, keyed the same way as track.automation:
//   'volume' | 'pan' | 'send:<returnId>' | 'device:<deviceId>:<param>'

import { getDeviceDef, resolvedParameters } from './devices';
import { flattenDevices } from './engine';

export interface AutomationParam {
  key: string;
  label: string;
  min: number;
  max: number;
  log?: boolean;
  value: number; // current static value (shown when the lane is empty)
}

const RETURN_LETTERS = 'ABCDEFGHIJKL';

export function automationParams(track: any, returns: any[]): AutomationParam[] {
  const out: AutomationParam[] = [
    { key: 'volume', label: 'Volume', min: 0, max: 1, value: track.volume },
    { key: 'pan', label: 'Pan', min: -1, max: 1, value: track.pan || 0 }
  ];
  returns.forEach((r, i) => {
    out.push({ key: `send:${r.id}`, label: `Send ${RETURN_LETTERS[i]} (${r.name})`, min: 0, max: 1, value: track.sends?.[r.id] ?? 0 });
  });
  flattenDevices(track.plugins).forEach((d: any) => {
    const def = getDeviceDef(d);
    if (!def) return;
    const params = resolvedParameters(d);
    def.params.forEach((spec) => {
      if (spec.kind && spec.kind !== 'number') return;
      out.push({
        key: `device:${d.id}:${spec.name}`,
        label: `${d.name}: ${spec.name}`,
        min: spec.min ?? 0,
        max: spec.max ?? 100,
        log: spec.log,
        value: Number(params[spec.name])
      });
    });
  });
  return out;
}

// Normalized 0..1 position of a value within a lane (log-aware), and back
export const toUnit = (p: AutomationParam, v: number) =>
  p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min);
export const fromUnit = (p: AutomationParam, u: number) => {
  const c = Math.max(0, Math.min(1, u));
  return p.log ? p.min * Math.pow(p.max / p.min, c) : p.min + c * (p.max - p.min);
};
