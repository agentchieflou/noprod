// The local services the app can talk to (#139): GhostDAW, the native plug-in
// host. Opt-in: off by default in a production build (the hosted app has no
// local services), on in dev. The choice and the address are kept per
// browser. (AI dictation is not one: it calls its provider with the user's own
// key, #157.)

export type ServiceName = 'ghostdaw';

export interface ServiceSetting {
  enabled: boolean;
  url: string;   // ghostdaw: its control server (it announces its stream and editor ports)
}

export type Services = Record<ServiceName, ServiceSetting>;

export const defaultServices = (dev: boolean): Services => ({
  ghostdaw: { enabled: dev, url: 'ws://localhost:8082' }
});

// What the GhostDAW address was before #134: its stream server, which the
// control server announces now
const OLD_GHOSTDAW_STREAM_URL = 'ws://localhost:8083';

const KEY = 'noprod.services';

export const isWebSocketUrl = (url: string) => {
  try {
    const u = new URL(url);
    return (u.protocol === 'ws:' || u.protocol === 'wss:') && u.hostname !== '';
  } catch {
    return false;
  }
};

// What was stored, kept only where it is a well-formed setting
export function readServices(raw: string | null, dev: boolean): Services {
  const out = defaultServices(dev);
  try {
    const stored = raw ? JSON.parse(raw) : null;
    (Object.keys(out) as ServiceName[]).forEach((name) => {
      const s = stored?.[name];
      if (typeof s?.enabled === 'boolean') out[name].enabled = s.enabled;
      if (typeof s?.url === 'string' && isWebSocketUrl(s.url) && !(name === 'ghostdaw' && s.url === OLD_GHOSTDAW_STREAM_URL)) out[name].url = s.url;
    });
  } catch { /* unreadable: the defaults */ }
  return out;
}

let current: Services = (() => {
  try { return readServices(localStorage.getItem(KEY), import.meta.env.DEV); } catch { return defaultServices(import.meta.env.DEV); }
})();
const listeners = new Set<() => void>();

export const subscribeServices = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getServices = () => current;

export function setService(name: ServiceName, patch: Partial<ServiceSetting>) {
  const url = patch.url !== undefined && isWebSocketUrl(patch.url.trim()) ? patch.url.trim() : current[name].url;
  const next = { ...current[name], ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}), url };
  if (next.enabled === current[name].enabled && next.url === current[name].url) return;
  current = { ...current, [name]: next };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private window: lasts until reload */ }
  listeners.forEach((fn) => fn());
}

// The host a service's address names, for the ports GhostDAW announces
export const serviceHost = (name: ServiceName) => {
  try { return new URL(current[name].url).hostname; } catch { return 'localhost'; }
};

if (import.meta.env.DEV) (window as any).__services = { get: getServices, set: setService, defaults: defaultServices };

// The Services dialog is opened from the control bar, and from the places that
// hide something until a service is on
let dialogOpen = false;
const dialogListeners = new Set<() => void>();
export const subscribeServicesDialog = (fn: () => void) => { dialogListeners.add(fn); return () => { dialogListeners.delete(fn); }; };
export const getServicesDialogOpen = () => dialogOpen;
export const setServicesDialogOpen = (open: boolean) => { dialogOpen = open; dialogListeners.forEach((fn) => fn()); };
