// Pairing with GhostDAW (apps/audio_core). Every connection to it presents
// the install's token as ?token= in its URL; the browser gets the token
// once, by sending PAIR with the code GhostDAW prints at launch, and keeps
// it in localStorage (see the README's "Secure by design"). Where to
// connect comes from the GhostDAW service (services.ts): its control
// server, which announces the stream and editor ports.

const KEY = 'noprod.ghostdaw.token';

export function getPairingToken(): string | null {
  try {
    const token = localStorage.getItem(KEY);
    return token && /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function setPairingToken(token: string | null) {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // private windows and blocked storage: pairing lasts for this page only
  }
}

// The URL to open a GhostDAW socket with: `base` is ws://host:port, the
// token (the stored one unless given) goes in the query
export function withPairingToken(base: string, token = getPairingToken()) {
  if (!token) return base;
  try {
    const url = new URL(base);
    url.searchParams.set('token', token);
    return url.toString();
  } catch {
    return base;
  }
}

// Whether this page comes from somewhere other than this machine (the
// hosted app on GitHub Pages): browsers then ask the user before the page
// may reach a program on their own computer (Chrome's Local Network
// Access permission)
export const isHostedPage = () => {
  try {
    return !['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
  } catch {
    return false;
  }
};
