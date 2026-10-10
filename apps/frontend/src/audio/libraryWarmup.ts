// Renders the library notes a project's MIDI clips play shortly after the
// project changes, so playback finds them ready (see library.ts); then the
// selected track's sound across two octaves, for playing it live.

import { expandMidiNotes } from './clipPlayback';
import { applyMidiEffects } from './midiEffects';
import { libraryOf, prewarmLibrary } from './library';

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
    const liveNotes = sound?.pitched ? [{
      params: selected.instrument.parameters,
      // middle C outwards, so the keys played most are ready first
      notes: Array.from({ length: 25 }, (_, i) => 60 + (i % 2 ? (i + 1) / 2 : -i / 2))
        .map((pitch) => ({ pitch, velocity: 1, duration: sound.length }))
    }] : [];
    prewarmLibrary([...clipNotes, ...liveNotes]);
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
  schedule();
  return store.subscribe((state, previous) => {
    if (state.tracks !== previous.tracks || state.regions !== previous.regions || state.sessionClips !== previous.sessionClips
      || state.selectedTrackId !== previous.selectedTrackId) schedule();
  });
}
