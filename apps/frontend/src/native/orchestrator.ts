// The connection to the Orchestrator, the relay to GhostDAW's plug-in panel
// (it goes away with #134's paired connection; AI dictation no longer uses it,
// #157). It exists only while GhostDAW is on (services.ts); it retries with a
// capped backoff and reports where it stands: off, trying or connected.

import { attachOrchestrator, detachOrchestrator, handleOrchestratorMessage } from './audioCore';
import { backoffMs } from './backoff';
import { getServices, subscribeServices } from './services';

export type ConnectionStatus = 'off' | 'trying' | 'connected';

let status: ConnectionStatus = 'off';
let ws: WebSocket | null = null;
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | null = null;
let warnedBadMessage = false;

const statusListeners = new Set<() => void>();

export const subscribeOrchestrator = (fn: () => void) => { statusListeners.add(fn); return () => { statusListeners.delete(fn); }; };
export const getOrchestratorStatus = () => status;

const setStatus = (next: ConnectionStatus) => {
  if (next === status) return;
  status = next;
  statusListeners.forEach((fn) => fn());
};

// Where the relay listens (not a setting: #134 replaces it)
export const ORCHESTRATOR_URL = 'ws://localhost:8080';

const wanted = () => getServices().ghostdaw.enabled;

function close() {
  if (retry) { clearTimeout(retry); retry = null; }
  const old = ws;
  ws = null;
  if (old) { detachOrchestrator(old); old.onclose = old.onerror = old.onmessage = old.onopen = null; old.close(); }
}

function open() {
  setStatus('trying');
  let socket: WebSocket;
  try {
    socket = new WebSocket(ORCHESTRATOR_URL);
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
    handleOrchestratorMessage(msg);
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

// Follows the settings: opens when GhostDAW is on, closes when it is off
function follow() {
  if (!wanted()) { close(); attempt = 0; setStatus('off'); return; }
  if (ws || retry) return; // open, or waiting out a backoff
  close();
  attempt = 0;
  open();
}

subscribeServices(follow);
follow();
