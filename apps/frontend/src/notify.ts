// In-app notices: a message that doesn't block, in place of alert().
export type NoticeKind = 'info' | 'error';
export interface Notice { id: number; kind: NoticeKind; message: string }

let notices: Notice[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const subscribeNotices = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getNotices = () => notices;

export function dismissNotice(id: number) {
  notices = notices.filter((n) => n.id !== id);
  emit();
}

// Shows `message`; the same message already showing isn't stacked again.
export function notify(message: string, kind: NoticeKind = 'info', ms = kind === 'error' ? 8000 : 4000) {
  if (notices.some((n) => n.message === message)) return;
  const id = nextId++;
  notices = [...notices, { id, kind, message }].slice(-4);
  emit();
  setTimeout(() => dismissNotice(id), ms);
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// An async action that reports its failure instead of rejecting unhandled
export function guarded<A extends unknown[]>(what: string, fn: (...args: A) => Promise<unknown>) {
  return (...args: A) => fn(...args).catch((err) => {
    console.error(`${what} failed`, err);
    notify(`${what} failed: ${errorMessage(err)}`, 'error');
  });
}

// Test hook: panels named here throw when they render (see Panel)
export const panelFaults = new Set<string>();
const faultListeners = new Set<() => void>();
export const subscribeFaults = (fn: () => void) => { faultListeners.add(fn); return () => { faultListeners.delete(fn); }; };
export const setPanelFault = (name: string, on: boolean) => {
  if (on) panelFaults.add(name); else panelFaults.delete(name);
  faultListeners.forEach((fn) => fn());
};
