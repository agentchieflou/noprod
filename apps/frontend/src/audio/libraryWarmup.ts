// Renders the library notes a project's MIDI clips play shortly after the
// project changes, so playback finds them ready (see library.ts).

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
    prewarmLibrary((st.tracks || [])
      .filter((t: any) => t.type === 'midi' && libraryOf(t.instrument?.parameters))
      .map((t: any) => ({
        params: t.instrument.parameters,
        notes: midiClips(t.id).flatMap((clip: any) => applyMidiEffects(expandMidiNotes(clip), t.midiEffects)
          .map((n) => ({ pitch: n.pitch, velocity: n.velocity, duration: n.end - n.start })))
      })));
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
  schedule();
  return store.subscribe((state, previous) => {
    if (state.tracks !== previous.tracks || state.regions !== previous.regions || state.sessionClips !== previous.sessionClips) schedule();
  });
}
