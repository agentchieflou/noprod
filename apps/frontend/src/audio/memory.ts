// Memory budgets (#137): how much each cache may hold, from the device's
// memory where the browser says (navigator.deviceMemory, in GB: Chrome
// rounds it to 0.25–8), else as for a 4 GB device. A cache over its budget
// evicts what was used longest ago.
//
// Per GB of device memory: rendered library notes 16 MB, decoded sample
// previews 6 MB, audio that only undo history still holds 8 MB, warped clips
// stretched to the tempo 32 MB (a whole clip each). A 4 GB device:
// 64 + 24 + 32 + 128 MB; an 8 GB one twice that.

const MB = 1024 * 1024;

export const deviceMemoryGB = () => {
  const gb = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
  return typeof gb === 'number' && gb > 0 ? Math.min(8, Math.max(0.5, gb)) : 4;
};

export interface Budgets { renders: number; decoded: number; history: number; stretched: number }

export const budgets = (gb = deviceMemoryGB()): Budgets => ({
  renders: Math.round(16 * MB * gb),
  decoded: Math.round(6 * MB * gb),
  history: Math.round(8 * MB * gb),
  stretched: Math.round(32 * MB * gb)
});

export const bufferBytes = (b: AudioBuffer) => b.length * b.numberOfChannels * 4;

// A Map that keeps its entries' total size under `budget`, least recently used out first
export class LruBytes<K, V> {
  private map = new Map<K, { value: V; bytes: number }>();
  bytes = 0;
  budget: number;
  private sizeOf: (v: V) => number;
  private onEvict: (key: K, value: V) => void;
  constructor(budget: number, sizeOf: (v: V) => number, onEvict: (key: K, value: V) => void = () => {}) {
    this.budget = budget;
    this.sizeOf = sizeOf;
    this.onEvict = onEvict;
  }

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  has(key: K) { return this.map.has(key); }

  set(key: K, value: V) {
    this.delete(key);
    const bytes = this.sizeOf(value);
    this.map.set(key, { value, bytes });
    this.bytes += bytes;
    for (const [k, e] of this.map) {
      if (this.bytes <= this.budget || k === key) break;
      this.map.delete(k);
      this.bytes -= e.bytes;
      this.onEvict(k, e.value);
    }
  }

  delete(key: K) {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.bytes -= e.bytes;
  }

  get size() { return this.map.size; }
  values() { return [...this.map.values()].map((e) => e.value); }
}
