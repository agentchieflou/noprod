import type { Exciter, Filter, Layer, Radiator, Resonator } from '@noprod/sound';

// Helpers for the Sound Designer's controls

export const clean = (x: number) => Number(x.toPrecision(3));

export const filtersOf = (layer: Layer): Filter[] => (!layer.filter ? [] : Array.isArray(layer.filter) ? layer.filter : [layer.filter]);
export const asFilter = (filters: Filter[]): Layer['filter'] => (filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : filters);

// A physical model's blocks, by kind
export const EXCITERS: [Exciter['kind'], string][] = [
  ['pluck', 'Pluck'], ['strike', 'Strike'], ['bow', 'Bow'], ['lips', 'Lips'], ['jet', 'Air jet'], ['reed', 'Reed']
];
export const RESONATORS: [Resonator['kind'], string][] = [['string', 'String'], ['bore', 'Bore']];
export const RADIATORS: [Radiator['kind'], string][] = [
  ['body', 'Body'], ['helmholtz', 'Air cavity'], ['bell', 'Bell'], ['tonehole', 'Toneholes'], ['damping', 'Damping']
];
export const radiatorName = (kind: Radiator['kind']) => RADIATORS.find(([k]) => k === kind)?.[1] ?? kind;
