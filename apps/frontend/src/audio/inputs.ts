// Inputs: audio interfaces (getUserMedia), MIDI devices (Web MIDI) and the
// computer keyboard as a MIDI keyboard. Tracks choose an input in their I/O
// section; the engine monitors audio inputs through the track strip, and MIDI
// is played live through armed (or monitor-In) MIDI tracks' instruments.
// Every MIDI event is also published on a bus for recording / capture.

import { audioContext, getStripInput } from './engine';
import { startVoice } from './synth';

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
}

const midiListeners = new Set<(e: MidiEvent) => void>();
export const onMidiEvent = (fn: (e: MidiEvent) => void) => { midiListeners.add(fn); return () => { midiListeners.delete(fn); }; };
const publish = (e: MidiEvent) => midiListeners.forEach((fn) => fn(e));

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

// ------------------------------------------------------- computer keyboard

// Ableton's layout: A-K white keys from C, W E T Y U black keys, Z/X octave
// down/up, C/V velocity down/up.
const KEY_TO_SEMITONE: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16
};
let octave = 4;
let keyboardVelocity = 0.8;
const heldKeys = new Map<string, number>();
let computerKeyboardEnabled = false;
export const isComputerKeyboardEnabled = () => computerKeyboardEnabled;
export const getComputerKeyboardOctave = () => octave;

export function setComputerKeyboardEnabled(on: boolean) {
  computerKeyboardEnabled = on;
  if (!on) {
    heldKeys.forEach((pitch) => publish({ type: 'off', pitch, velocity: 0, channel: 1, source: 'computer', time: audioContext.currentTime }));
    heldKeys.clear();
  }
  notifyInputs();
}

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
};

window.addEventListener('keydown', (e) => {
  if (!computerKeyboardEnabled || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { octave = Math.max(0, octave - 1); notifyInputs(); return; }
  if (k === 'x') { octave = Math.min(8, octave + 1); notifyInputs(); return; }
  if (k === 'c') { keyboardVelocity = Math.max(0.1, keyboardVelocity - 0.1); return; }
  if (k === 'v') { keyboardVelocity = Math.min(1, keyboardVelocity + 0.1); return; }
  const semi = KEY_TO_SEMITONE[k];
  if (semi === undefined || heldKeys.has(k)) return;
  const pitch = (octave + 1) * 12 + semi;
  heldKeys.set(k, pitch);
  if (audioContext.state === 'suspended') audioContext.resume();
  publish({ type: 'on', pitch, velocity: keyboardVelocity, channel: 1, source: 'computer', time: audioContext.currentTime });
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  const pitch = heldKeys.get(k);
  if (pitch === undefined) return;
  heldKeys.delete(k);
  publish({ type: 'off', pitch, velocity: 0, channel: 1, source: 'computer', time: audioContext.currentTime });
});

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

const liveVoices = new Map<string, { release: (at: number) => void }>();

export function initLiveMidi(store: { getState: () => any }) {
  onMidiEvent((e) => {
    const st = store.getState();
    (st.tracks || []).forEach((t: any) => {
      if (t.type !== 'midi' || !t.instrument || !isMonitoring(t) || !trackAcceptsMidi(t, e)) return;
      const key = `${t.id}:${e.source}:${e.pitch}`;
      if (e.type === 'on') {
        liveVoices.get(key)?.release(e.time);
        liveVoices.set(key, startVoice(audioContext, getStripInput(t.id), t.instrument.parameters, e.pitch, e.time, e.velocity));
      } else {
        liveVoices.get(key)?.release(e.time);
        liveVoices.delete(key);
      }
    });
  });
}
