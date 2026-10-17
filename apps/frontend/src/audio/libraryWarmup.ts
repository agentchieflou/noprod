// Renders the library notes a project's MIDI clips play shortly after the
// project changes, so playback finds them ready (see library.ts); the
// notes the coach's band may play while it's on; then the selected track's
// sound across two octaves, for playing it live (a physical model's keys
// are measured for its live voice instead: liveModels.ts).

import { playsLive } from '@noprod/sound';
import { expandMidiNotes } from './clipPlayback';
import { applyMidiEffects } from './midiEffects';
import { libraryOf, prewarmLibrary } from './library';
import { prewarmLive } from './liveModels';
import { audioContext } from './engine';
import { getKeyboardState } from './computerKeyboard';

type Notes = { params: any; notes: { pitch: number; velocity: number; duration: number }[] }[];

// More notes to warm, from parts that load later (the coach's band): what
// they need now, and when that changes
const extra: { notes: () => Notes; subscribe: (fn: () => void) => () => void }[] = [];
let rewarm = () => {};
export function addWarmupSource(notes: () => Notes, subscribe: (fn: () => void) => () => void) {
  extra.push({ notes, subscribe });
  subscribe(() => rewarm());
  rewarm();
}

interface Store {
  getState: () => any;
  subscribe: (fn: (state: any, previous: any) => void) => () => void;
}

export function startLibraryWarmup(store: Store) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    const st = store.getState();
    const midiClips = (trackId: string) => [
      ...(st.regions || []).filter((r: any) => r.trackId === trackId),
      ...Object.values(st.sessionClips?.[trackId] || {})
    ].filter((c: any) => c?.type === 'midi');
    const libraryTracks = (st.tracks || []).filter((t: any) => t.type === 'midi' && libraryOf(t.instrument?.parameters));
    const clipNotes = libraryTracks.map((t: any) => ({
      params: t.instrument.parameters,
      notes: midiClips(t.id).flatMap((clip: any) => applyMidiEffects(expandMidiNotes(clip), t.midiEffects)
        .map((n) => ({ pitch: n.pitch, velocity: n.velocity, duration: n.end - n.start })))
    }));
    // Live notes play the full-velocity render held for the sound's length
    const selected = libraryTracks.find((t: any) => t.id === st.selectedTrackId);
    const sound = libraryOf(selected?.instrument?.parameters)?.sound;
    // middle C outwards, so the keys played most are ready first
    const keys = Array.from({ length: 25 }, (_, i) => 60 + (i % 2 ? (i + 1) / 2 : -i / 2));
    const live = sound && playsLive(sound);
    if (live) prewarmLive(sound, selected.instrument.parameters, keys, getKeyboardState().velocity, audioContext.sampleRate);
    const liveNotes = sound?.pitched && !live ? [{
      params: selected.instrument.parameters,
      notes: keys.map((pitch) => ({ pitch, velocity: 1, duration: sound.length }))
    }] : [];
    prewarmLibrary([...clipNotes, ...extra.flatMap((x) => x.notes()), ...liveNotes]);
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
  rewarm = schedule;
  schedule();
  const project = store.subscribe((state, previous) => {
    if (state.tracks !== previous.tracks || state.regions !== previous.regions || state.sessionClips !== previous.sessionClips
      || state.selectedTrackId !== previous.selectedTrackId || state.bpm !== previous.bpm) schedule();
  });
  return project;
}
