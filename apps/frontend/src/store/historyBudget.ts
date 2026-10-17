// Undo history bounded by memory, not just by count (#137): audio that only
// past snapshots still hold (a deleted clip's buffer, a take replaced) stays
// within its budget (memory.ts). Over it, the oldest snapshots go first;
// the newest is always kept, so the last edit can be undone.

import { budgets, bufferBytes } from '../audio/memory';

const NONE: AudioBuffer[] = [];
const found = new WeakMap<object, AudioBuffer[]>();

// Every AudioBuffer in a value, remembered per object (snapshots share them)
function buffersIn(value: unknown): AudioBuffer[] {
  if (!value || typeof value !== 'object') return NONE;
  if (value instanceof AudioBuffer) return [value];
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return NONE;
  const known = found.get(value);
  if (known) return known;
  found.set(value, NONE); // cycles
  let out = NONE;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const inner = buffersIn(child);
    if (inner.length) out = out === NONE ? [...inner] : out.concat(inner);
  }
  found.set(value, out);
  return out;
}

// Audio that `past` holds beyond what `current` (the project now) does
export function historyBytes(past: object[], current: object) {
  const live = new Set(buffersIn(current));
  const counted = new Set<AudioBuffer>();
  let bytes = 0;
  for (const snap of past) for (const b of buffersIn(snap)) {
    if (live.has(b) || counted.has(b)) continue;
    counted.add(b);
    bytes += bufferBytes(b);
  }
  return bytes;
}

// `past` (oldest first), trimmed from the oldest end to fit the budget
export function boundHistory<T extends object>(past: T[], current: object, budget = budgets().history): T[] {
  const live = new Set(buffersIn(current));
  const counted = new Set<AudioBuffer>();
  let bytes = 0;
  for (let i = past.length - 1; i >= 0; i--) {
    for (const b of buffersIn(past[i])) {
      if (live.has(b) || counted.has(b)) continue;
      counted.add(b);
      bytes += bufferBytes(b);
    }
    if (bytes > budget && i < past.length - 1) return past.slice(i + 1);
  }
  return past;
}
