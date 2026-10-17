// The Keyboard Coach (coach.ts) and its band (accompany.ts) load, with the
// theory engine, when the coach first opens (#137): the first paint doesn't
// wait for them. Until then the coach is closed, which is all the rest of
// the app needs to know.

interface Store { getState: () => any }

let store: Store = { getState: () => ({}) };
let open = false;
const listeners = new Set<() => void>();
export const subscribeCoachOpen = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getCoachOpen = () => open;

let band: typeof import('./accompany') | null = null;
let loading: Promise<typeof import('./coach')> | null = null;
export function loadCoach() {
  loading ??= Promise.all([import('./coach'), import('./accompany')]).then(([coach, accompany]) => {
    accompany.initAccompany(store);
    band = accompany;
    return coach;
  });
  return loading;
}

// coach.ts calls this as it loads, however it was loaded (here, or by a
// panel or test importing it): it starts listening at once, the app follows
// whether it's open, and the band loads after it
type CoachModule = Pick<typeof import('./coach'), 'initCoach' | 'subscribeCoach' | 'getCoachState'>;
let adopted = false;
export function adoptCoach(coach: CoachModule) {
  if (adopted) return;
  adopted = true;
  coach.initCoach(store);
  const follow = () => {
    if (coach.getCoachState().open === open) return;
    open = coach.getCoachState().open;
    listeners.forEach((fn) => fn());
  };
  coach.subscribeCoach(follow);
  follow();
  loadCoach();
}

export const setCoachOpen = (next: boolean) => loadCoach().then((coach) => coach.setCoachOpen(next));

// For the browser tests: the band's debug view (accompany.ts), once loaded
export const accompanyDebug = () => band?.accompanyDebug
  ?? { played: () => [], warming: () => 0, sounding: () => 0, running: () => false };

export function initCoachLoader(s: Store) {
  store = s;
}
