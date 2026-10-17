// Where the playhead is drawn: written each frame while playing (App.tsx),
// read by the few things that follow it, so the rest of the page doesn't
// re-render every frame (#137)
let position = 0;
const listeners = new Set<() => void>();
export const subscribePlayhead = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getPlayhead = () => position;
export function setPlayhead(seconds: number) {
  if (seconds === position) return;
  position = seconds;
  listeners.forEach((fn) => fn());
}
