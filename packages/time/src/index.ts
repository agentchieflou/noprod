// @noprod/time: musical time for the DAW. Positions are float64 beats
// (quarter notes); the tempo map turns them into seconds and back, the
// meter map into bars and grid lines.

export { TempoMap, MIN_BPM, MAX_BPM } from './tempo.ts';
export type { TempoEvent } from './tempo.ts';
export { MeterMap, DEFAULT_METER, beatsPerBar } from './meter.ts';
export type { MeterEvent, Bar, Bbt, GridLine } from './meter.ts';
export { TICKS_PER_BEAT, DIVISIONS, toTicks, fromTicks, divisionBeats, snap, gridAround, quantize, onGrid } from './grid.ts';
export type { Division } from './grid.ts';
