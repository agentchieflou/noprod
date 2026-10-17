// The connection to the Orchestrator (AI dictation, and the relay to
// GhostDAW's plug-in panel). It exists only while a service that needs it is
// on (services.ts); it retries with a capped backoff and reports where it
// stands: off, trying or connected.

import { attachOrchestrator, detachOrchestrator } from './audioCore';
import { backoffMs } from './backoff';
import { getServices, subscribeServices } from './services';

export type ConnectionStatus = 'off' | 'trying' | 'connected';

let status: ConnectionStatus = 'off';
let ws: WebSocket | null = null;
let openUrl = '';
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | null = null;
let warnedBadMessage = false;

const statusListeners = new Set<() => void>();
const messageListeners = new Set<(msg: any) => void>();

export const subscribeOrchestrator = (fn: () => void) => { statusListeners.add(fn); return () => { statusListeners.delete(fn); }; };
export const getOrchestratorStatus = () => status;
export const onOrchestratorMessage = (fn: (msg: any) => void) => { messageListeners.add(fn); return () => { messageListeners.delete(fn); }; };

const setStatus = (next: ConnectionStatus) => {
  if (next === status) return;
  status = next;
  statusListeners.forEach((fn) => fn());
};

export const sendOrchestrator = (message: unknown) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
};

const wanted = () => {
  const s = getServices();
  return s.dictation.enabled || s.ghostdaw.enabled;
};

function close() {
  if (retry) { clearTimeout(retry); retry = null; }
  const old = ws;
  ws = null;
  if (old) { detachOrchestrator(old); old.onclose = old.onerror = old.onmessage = old.onopen = null; old.close(); }
}

function open() {
  const url = getServices().dictation.url;
  openUrl = url;
  setStatus('trying');
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    // Safari throws a SecurityError for ws:// from an https page: a failed attempt, not a crash
    console.warn('Could not open the Orchestrator connection', err);
    retry = setTimeout(() => { retry = null; if (wanted()) open(); }, backoffMs(attempt++));
    return;
  }
  ws = socket;
  attachOrchestrator(socket);
  socket.onopen = () => { attempt = 0; setStatus('connected'); };
  socket.onmessage = (event) => {
    let msg: any;
    try { msg = JSON.parse(event.data); } catch { msg = null; }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      if (!warnedBadMessage) { warnedBadMessage = true; console.warn('Ignoring a message from the Orchestrator that is not a typed JSON object'); }
      return;
    }
    messageListeners.forEach((fn) => fn(msg));
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    detachOrchestrator(socket);
    ws = null;
    setStatus('trying');
    retry = setTimeout(() => { retry = null; if (wanted()) open(); }, backoffMs(attempt++));
  };
  socket.onerror = () => { /* onclose follows */ };
}

// Follows the settings: opens when a service needs it, closes when none does,
// reopens at a changed address
function follow() {
  if (!wanted()) { close(); attempt = 0; setStatus('off'); return; }
  if (ws && openUrl === getServices().dictation.url) return;
  if (!ws && retry && openUrl === getServices().dictation.url) return; // waiting out a backoff
  close();
  attempt = 0;
  open();
}

subscribeServices(follow);
follow();
