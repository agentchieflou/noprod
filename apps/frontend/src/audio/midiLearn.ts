// MIDI learn: binds controller messages to controls, and drives the mapped
// controls from incoming CCs and notes (see midiTargets.ts for the targets).

import { onMidiClaim, type MidiEvent } from './inputs';
import { resolveTarget, mappedValue, type MidiMapping, type MidiSource } from './midiTargets';

// Pickup: a mapping takes over only once the controller's value reaches the
// control's current one. Runtime state, per mapping.
const PICKUP_TOLERANCE = 0.02;
const pickup = new Map<string, { engaged: boolean; last?: number; applied?: number }>();

const sourceOf = (e: MidiEvent): MidiSource | null =>
  e.type === 'cc' ? { input: e.source, channel: e.channel, type: 'cc', number: e.controller ?? 0 }
    : e.type === 'on' ? { input: e.source, channel: e.channel, type: 'note', number: e.pitch }
      : null;

const matches = (m: MidiMapping, s: MidiSource) =>
  m.source.type === s.type && m.source.number === s.number && m.source.channel === s.channel
  && (m.source.input === 'any' || m.source.input === s.input);

// Notes this listener took. Their note-offs are taken too, so the instruments
// never start a note they then have to stop.
const takenNotes = new Set<string>();
const noteKey = (e: MidiEvent) => `${e.source}:${e.channel}:${e.pitch}`;
const takeNote = (e: MidiEvent) => {
  if (e.type !== 'on') return false;
  takenNotes.add(noteKey(e));
  return true;
};

export function initMidiLearn(store: { getState: () => any }) {
  onMidiClaim((e) => {
    if (e.type === 'off') return takenNotes.delete(noteKey(e));
    const source = sourceOf(e);
    if (!source) return false;
    const st = store.getState();

    // Learn mode with a control chosen: the next CC or note binds to it
    if (st.midiLearn.active && st.midiLearn.pending) {
      st.addMidiMapping(st.midiLearn.pending, source);
      return takeNote(e);
    }

    const mapped = (st.midiMappings as MidiMapping[]).filter((m) => matches(m, source));
    if (!mapped.length) return false;
    for (const m of mapped) {
      const resolved = resolveTarget(store.getState(), m.target);
      if (!resolved) continue;
      // A note flips a toggle; otherwise its velocity is the value
      const incoming = e.type === 'on' ? (resolved.toggle ? 1 - resolved.norm : e.velocity) : e.value ?? 0;
      const value = e.type === 'on' && resolved.toggle ? incoming : mappedValue(m, incoming);

      if (m.mode === 'pickup' && !resolved.toggle) {
        const p = pickup.get(m.id) ?? { engaged: false };
        pickup.set(m.id, p);
        // The control moved some other way since we last set it: pick up again
        if (p.engaged && p.applied !== undefined && Math.abs(resolved.norm - p.applied) > PICKUP_TOLERANCE) p.engaged = false;
        if (!p.engaged) {
          const crossed = p.last !== undefined && (p.last - resolved.norm) * (value - resolved.norm) <= 0;
          p.last = value;
          if (!crossed && Math.abs(value - resolved.norm) > PICKUP_TOLERANCE) continue;
          p.engaged = true;
        }
        p.applied = value;
      }
      st.applyMidiValue(m.target, value);
    }
    return takeNote(e);
  });
}

export const resetPickup = (id: string) => { pickup.delete(id); };
