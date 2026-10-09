// Inputs: audio interfaces (getUserMedia) and MIDI devices (Web MIDI); the
// computer keyboard publishes onto the same MIDI bus (computerKeyboard.ts).
// Tracks choose an input in their I/O section; the engine monitors audio
// inputs through the track strip, and MIDI is played live through the
// instruments of the tracks each event targets. Every MIDI event is also
// published on a bus for recording / capture.

import { audioContext, getStripInput } from './engine';
import { startVoice } from './synth';
import { applyMidiEffects } from './midiEffects';

// ------------------------------------------------------------------ audio

export interface AudioInputDevice { id: string; label: string }

interface OpenInput {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  outputs: Record<string, AudioNode>; // '1/2' (stereo) | '1' | '2'
}

const openInputs = new Map<string, OpenInput>();
const opening = new Map<string, Promise<OpenInput | null>>();
const inputListeners = new Set<() => void>();
const notifyInputs = () => inputListeners.forEach((fn) => fn());
export const onInputsChange = (fn: () => void) => { inputListeners.add(fn); return () => { inputListeners.delete(fn); }; };

let audioDevices: AudioInputDevice[] = [{ id: 'default', label: 'Default input' }];
export const getAudioInputDevices = () => audioDevices;

export async function refreshAudioDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const ins = all.filter((d) => d.kind === 'audioinput');
    if (ins.length) {
      audioDevices = ins.map((d, i) => ({ id: d.deviceId || 'default', label: d.label || `Input ${i + 1}` }));
      notifyInputs();
    }
  } catch { /* no mediaDevices (insecure context) */ }
}

// Open (once) the device and return the node for the requested channel(s).
// Resolves null when the browser refuses access.
export function openAudioInput(deviceId: string): Promise<OpenInput | null> {
  const ready = openInputs.get(deviceId);
  if (ready) return Promise.resolve(ready);
  let p = opening.get(deviceId);
  if (p) return p;
  p = navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId === 'default' ? undefined : { exact: deviceId },
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2
    }
  }).then((stream) => {
    const source = audioContext.createMediaStreamSource(stream);
    const stereo = audioContext.createGain();
    source.connect(stereo);
    const splitter = audioContext.createChannelSplitter(2);
    source.connect(splitter);
    const left = audioContext.createGain();
    const right = audioContext.createGain();
    splitter.connect(left, 0);
    splitter.connect(right, 1);
    const open = { stream, source, outputs: { '1/2': stereo, '1': left, '2': right } };
    openInputs.set(deviceId, open);
    refreshAudioDevices(); // labels become available once permission is granted
    notifyInputs();
    return open;
  }).catch((err) => {
    console.warn('Audio input unavailable', err);
    return null;
  }).finally(() => { opening.delete(deviceId); });
  opening.set(deviceId, p);
  return p;
}

// Already-open input node, or null (and starts opening it)
export function getAudioInputNode(deviceId: string, channel: string): AudioNode | null {
  const open = openInputs.get(deviceId);
  if (open) return open.outputs[channel] || open.outputs['1/2'];
  openAudioInput(deviceId);
  return null;
}

// ------------------------------------------------------------------ MIDI bus

export interface MidiEvent {
  type: 'on' | 'off';
  pitch: number;
  velocity: number;  // 0..1
  channel: number;   // 1..16
  source: string;    // MIDI input id, or 'computer'
  time: number;      // audio-context time
  targets?: string[]; // explicit track ids (the computer keyboard plays the selected track)
}

const midiListeners = new Set<(e: MidiEvent) => void>();
export const onMidiEvent = (fn: (e: MidiEvent) => void) => { midiListeners.add(fn); return () => { midiListeners.delete(fn); }; };
const publish = (e: MidiEvent) => midiListeners.forEach((fn) => fn(e));
export const publishMidi = publish;

export interface MidiDevice { id: string; name: string }
let midiDevices: MidiDevice[] = [];
export const getMidiDevices = () => midiDevices;
let midiAccess: any = null;

export async function initMidi() {
  const req = (navigator as any).requestMIDIAccess;
  if (!req || midiAccess) return;
  try {
    midiAccess = await req.call(navigator);
    const attach = () => {
      midiDevices = [];
      midiAccess.inputs.forEach((input: any) => {
        midiDevices.push({ id: input.id, name: input.name || input.id });
        input.onmidimessage = (msg: any) => {
          const [status, d1, d2] = msg.data;
          const kind = status & 0xf0;
          const channel = (status & 0x0f) + 1;
          if (kind === 0x90 && d2 > 0) publish({ type: 'on', pitch: d1, velocity: d2 / 127, channel, source: input.id, time: audioContext.currentTime });
          else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) publish({ type: 'off', pitch: d1, velocity: 0, channel, source: input.id, time: audioContext.currentTime });
        };
      });
      notifyInputs();
    };
    attach();
    midiAccess.onstatechange = attach;
  } catch { /* MIDI permission denied or unsupported */ }
}

// ------------------------------------------------------ live MIDI playing

// Does a MIDI track take this event? (input: 'all' | 'computer' | device id | 'none')
export const trackAcceptsMidi = (track: any, e: MidiEvent) => {
  const input = track.input?.type ?? 'all';
  if (input === 'none') return false;
  if (input !== 'all' && input !== e.source) return false;
  const ch = track.input?.channel ?? 'all';
  return ch === 'all' || Number(ch) === e.channel;
};

// Monitoring: 'auto' (default) hears input while armed, 'in' always, 'off' never
export const isMonitoring = (track: any) => {
  const m = track.monitor ?? 'auto';
  return m === 'in' || (m === 'auto' && !!track.isArmed);
};

// The MIDI tracks an event plays on: its explicit targets, else every armed
// (or monitor-In) MIDI track whose input takes it
export function midiEventTargets(state: any, e: MidiEvent): any[] {
  const tracks: any[] = state.tracks || [];
  if (e.targets) return tracks.filter((t) => e.targets!.includes(t.id) && t.type === 'midi');
  return tracks.filter((t) => t.type === 'midi' && isMonitoring(t) && trackAcceptsMidi(t, e));
}

// One input note can sound several notes (Chord effect), so voices are kept per input key
const liveVoices = new Map<string, { release: (at: number) => void }[]>();

export function initLiveMidi(store: { getState: () => any }) {
  onMidiEvent((e) => {
    const st = store.getState();
    midiEventTargets(st, e).forEach((t: any) => {
      if (!t.instrument) return;
      const key = `${t.id}:${e.source}:${e.pitch}`;
      liveVoices.get(key)?.forEach((v) => v.release(e.time));
      liveVoices.delete(key);
      if (e.type !== 'on') return;
      const played = applyMidiEffects([{ pitch: e.pitch, velocity: e.velocity, start: e.time, end: e.time + 1 }], t.midiEffects);
      liveVoices.set(key, played.map((n) => startVoice(audioContext, getStripInput(t.id), t.instrument.parameters, n.pitch, e.time, n.velocity)));
    });
  });
}
