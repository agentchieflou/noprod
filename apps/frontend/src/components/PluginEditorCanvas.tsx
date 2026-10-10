import { useEffect, useRef } from 'react';

// A plugin editor streamed from the Audio Core (#44 B6): frames arrive as
// binary WebSocket messages (apps/audio_core/src/editor/EditorStream.h),
// are decoded and painted into a canvas, and mouse input goes back the same
// way. Built for the B6a latency spike; every frame's timing is reported.

export interface EditorFrameStats {
  frameId: number;
  bytes: number;
  renderMs: number;      // Audio Core: drawing the frame
  encodeMs: number;      // Audio Core: RGBA conversion (+ deflate)
  transferMs: number;    // send -> received (same-machine wall clocks)
  decodeMs: number;      // inflate (if compressed)
  drawMs: number;        // putImageData
  paintMs: number;       // received -> the frame is on screen (next animation frame)
  inputToPaintMs: number | null; // mouse event -> its frame on screen
}

const HEADER = 64;
const wallMs = () => performance.timeOrigin + performance.now();

interface Props {
  url: string;
  fps?: number;
  compression?: 'none' | 'deflate';
  onFrame?: (stats: EditorFrameStats) => void;
  className?: string;
}

export default function PluginEditorCanvas({ url, fps = 20, compression = 'deflate', onFrame, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    let latest: { data: ArrayBuffer; received: number } | null = null; // newest frame waiting while one is being drawn
    let busy = false;
    let closed = false;

    ws.onopen = () => ws.send(JSON.stringify({ type: 'START', fps, compression }));

    const show = async (data: ArrayBuffer, received: number) => {
      const ints = new Uint32Array(data, 0, 6);
      const doubles = new Float64Array(data, 24, 4);
      const [, frameId, width, height, format] = ints;
      const [sendWallMs, renderMs, encodeMs, inputClientMs] = doubles;
      const payload = new Uint8Array(data, HEADER);

      const t0 = wallMs();
      const pixels = format === 1
        ? await new Response(new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()
        : data.slice(HEADER);
      const t1 = wallMs();

      const canvas = canvasRef.current;
      if (!canvas || closed) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      const t2 = wallMs();

      await new Promise((r) => requestAnimationFrame(r));
      const painted = wallMs();
      onFrameRef.current?.({
        frameId, bytes: data.byteLength, renderMs, encodeMs,
        transferMs: received - sendWallMs, decodeMs: t1 - t0, drawMs: t2 - t1, paintMs: painted - received,
        inputToPaintMs: inputClientMs ? painted - inputClientMs : null
      });
    };

    // Draw frames one at a time; if several arrive meanwhile, only the newest
    // is drawn next (an ambient frame never delays one answering input more
    // than one draw).
    const pump = async (data: ArrayBuffer, received: number) => {
      busy = true;
      await show(data, received);
      while (latest && !closed) {
        const next = latest;
        latest = null;
        await show(next.data, next.received);
      }
      busy = false;
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') return;
      if (busy) latest = { data: e.data, received: wallMs() };
      else pump(e.data, wallMs());
    };

    return () => {
      closed = true;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'STOP' }));
      ws.close();
      wsRef.current = null;
    };
  }, [url, fps, compression]);

  const send = (kind: 'down' | 'move' | 'up') => (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const ws = wsRef.current;
    if (!canvas || !ws || ws.readyState !== WebSocket.OPEN) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    ws.send(JSON.stringify({ type: 'INPUT', kind, x, y, buttons: e.buttons, t: wallMs() }));
  };

  return (
    <canvas
      ref={canvasRef}
      className={className}
      onPointerDown={send('down')}
      onPointerMove={send('move')}
      onPointerUp={send('up')}
    />
  );
}
