/// <reference lib="webworker" />
// Owns a plugin editor's stream socket (apps/audio_core/src/editor/EditorStream.h)
// and does the expensive part of each frame off the main thread: inflating
// the pixels, which are then handed (not copied) to the main thread to draw.
// Each frame is acknowledged as soon as it is decoded, and the Audio Core
// holds the next frame until then, so frames never queue behind a slow
// link or decoder; acknowledging before the paint keeps decode and the next
// render overlapping. 'closed' goes to the main thread when the editor goes
// away (the Audio Core's CLOSED) or the socket does.

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const HEADER = 64;
const wallMs = () => performance.timeOrigin + performance.now();

let ws: WebSocket | null = null;
let latest: { data: ArrayBuffer; received: number } | null = null;
let busy = false;

async function decode(data: ArrayBuffer, received: number) {
  const [, frameId, width, height, format] = new Uint32Array(data, 0, 6);
  const [sendWallMs, renderMs, encodeMs, inputClientMs] = new Float64Array(data, 24, 4);
  const t0 = wallMs();
  const pixels = format === 1
    ? await new Response(new Blob([new Uint8Array(data, HEADER)]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()
    : data.slice(HEADER);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ACK', frameId }));
  ctx.postMessage({
    type: 'frame', pixels, width, height,
    stats: { frameId, bytes: data.byteLength, renderMs, encodeMs, transferMs: received - sendWallMs, decodeMs: wallMs() - t0, received, inputClientMs }
  }, [pixels]);
}

// One frame at a time; if more arrive meanwhile, only the newest is decoded next
async function pump(data: ArrayBuffer, received: number) {
  busy = true;
  await decode(data, received);
  while (latest) {
    const next = latest;
    latest = null;
    await decode(next.data, next.received);
  }
  busy = false;
}

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'open') {
    ws = new WebSocket(m.url);
    ws.binaryType = 'arraybuffer';
    // No window given: the Audio Core picks the measured best for the compression
    ws.onopen = () => ws!.send(JSON.stringify({ type: 'START', editorId: m.editorId, fps: m.fps, compression: m.compression, acks: true, window: m.window }));
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data.includes('"CLOSED"')) ctx.postMessage({ type: 'closed' });
        return;
      }
      if (busy) latest = { data: ev.data, received: wallMs() };
      else pump(ev.data, wallMs());
    };
    ws.onclose = () => ctx.postMessage({ type: 'closed' });
  } else if (m.type === 'input' && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'INPUT', ...m.input }));
  } else if (m.type === 'close') {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'STOP' }));
    ws?.close();
    ws = null;
  }
};

export {};
