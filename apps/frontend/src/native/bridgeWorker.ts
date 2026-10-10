/// <reference lib="webworker" />
// Owns the WebSocket of every native insert on the browser's tracks, off the
// main thread so UI work can't delay audio blocks. Each insert's worklet
// talks to this worker over its own MessagePort; the worker forwards audio
// blocks to the Audio Core's stream server and hands the processed blocks
// back. Control messages (LOAD, SET_PARAM, ...) come from the main thread and
// their replies go back there. A dropped connection is retried, re-sending
// OPEN and the last LOAD.

interface LoadMessage {
  type: 'LOAD';
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Stream {
  id: string;
  url: string;
  sampleRate: number;
  block: number;
  port: MessagePort;
  ws: WebSocket | null;
  ready: boolean;          // OPEN acknowledged
  load: LoadMessage | null; // last LOAD with every later SET_PARAM folded in, replayed after a reconnect
  queue: unknown[];        // control messages waiting for the connection
  closed: boolean;
  retry: ReturnType<typeof setTimeout> | null;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const streams = new Map<string, Stream>();

const post = (message: unknown) => ctx.postMessage(message);

function connect(s: Stream) {
  const ws = new WebSocket(s.url);
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  s.ready = false;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'OPEN', streamId: s.id, sampleRate: s.sampleRate, maxBlockSize: s.block }));
    if (s.load) ws.send(JSON.stringify(s.load));
    s.queue.forEach((m) => ws.send(JSON.stringify(m)));
    s.queue = [];
  };

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const message = JSON.parse(e.data);
      if (message.type === 'STREAM_OPENED') {
        s.ready = true;
        post({ type: 'status', streamId: s.id, connected: true });
        return;
      }
      post({ type: 'message', streamId: s.id, message });
      return;
    }
    // A processed block: hand the whole buffer to the worklet
    const buffer = e.data as ArrayBuffer;
    const block = new Uint32Array(buffer, 0, 1)[0];
    s.port.postMessage({ block, buffer, processed: true }, [buffer]);
  };

  ws.onclose = () => {
    s.ws = null;
    s.ready = false;
    if (s.closed) return;
    post({ type: 'status', streamId: s.id, connected: false });
    s.retry = setTimeout(() => connect(s), 2000);
  };
  ws.onerror = () => { /* onclose follows */ };
}

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'open') {
    const s: Stream = {
      id: msg.streamId, url: msg.url, sampleRate: msg.sampleRate, block: msg.block, port: msg.port,
      ws: null, ready: false, load: null, queue: [], closed: false, retry: null
    };
    streams.set(s.id, s);

    // Audio blocks from the worklet: { block, buffer }
    s.port.onmessage = (m) => {
      const { block, buffer } = m.data as { block: number; buffer: ArrayBuffer };
      if (s.ws && s.ready && s.ws.readyState === WebSocket.OPEN) {
        // The worklet wrote the header and the transport block (apps/audio_core/src/TrackStreams.h)
        s.ws.send(buffer);
      }
      // ws.send copied the bytes, so the buffer goes back to the worklet's pool
      s.port.postMessage({ block, buffer, processed: false }, [buffer]);
    };
    connect(s);
    return;
  }

  const s = streams.get(msg.streamId);
  if (!s) return;

  if (msg.type === 'command') {
    const m = msg.message;
    if (m.type === 'LOAD') s.load = { ...m, parameters: { ...(m.parameters || {}) } };
    if (m.type === 'UNLOAD') s.load = null;
    if (m.type === 'SET_PARAM' && s.load && m.parameterId) s.load.parameters![m.parameterId] = m.value;
    if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(msg.message));
    // LOAD is replayed on connect anyway; an editor asked for while offline isn't opened later
    else if (m.type !== 'LOAD' && m.type !== 'OPEN_EDITOR' && m.type !== 'CLOSE_EDITOR') s.queue.push(msg.message);
    return;
  }

  // A value the plug-in's editor set: part of the plug-in's state from now on
  if (msg.type === 'remember') {
    if (s.load) s.load.parameters![msg.parameterId] = msg.value;
    return;
  }

  if (msg.type === 'close') {
    s.closed = true;
    if (s.retry) clearTimeout(s.retry);
    s.ws?.close();
    s.port.close();
    streams.delete(s.id);
  }
};

export {};
