import { useEffect, useRef } from 'react';
import { lpiKeyCode, lpiModifiers, lpiTypedChar } from '../native/editorKeys';

// A plugin editor streamed from the Audio Core (#44 B6): frames arrive over a
// WebSocket (apps/audio_core/src/editor/EditorStream.h) in a worker
// (native/editorStreamWorker.ts), which inflates them, acknowledges them
// (that paces the Audio Core) and hands the pixels over to be drawn here.
// Mouse input goes back the same way. Every frame's timing is reported (the
// B6a spike uses it). The canvas holds the frame's pixels; its CSS size is
// up to the caller (pointer positions are mapped back to frame pixels).
//
// With `keyboard`, a click gives the editor keyboard focus. While it has it,
// every key goes to the plugin, and the DAW's own shortcuts and the computer
// MIDI keyboard stand down (they skip [data-keyboard-capture] targets).

export interface EditorFrameStats {
  frameId: number;
  bytes: number;
  renderMs: number;      // Audio Core: drawing the frame
  encodeMs: number;      // Audio Core: RGBA conversion (+ deflate)
  transferMs: number;    // send -> received (same-machine wall clocks)
  decodeMs: number;      // worker: inflate
  drawMs: number;        // main thread: putImageData
  paintMs: number;       // received -> the frame is on screen (next animation frame)
  inputToPaintMs: number | null; // mouse event -> its frame on screen
}

const wallMs = () => performance.timeOrigin + performance.now();

interface Props {
  url: string;
  editorId?: string;     // which editor (PluginHost's EDITOR_OPENED)
  width?: number;        // the frame size, if known before the first frame
  height?: number;
  fps?: number;
  compression?: 'none' | 'deflate';
  inFlight?: number; // frames the Audio Core may send ahead of the browser's acknowledgements
  keyboard?: boolean; // the editor takes keys (lpi.gui.keyboard.v1)
  onFrame?: (stats: EditorFrameStats) => void;
  onClosed?: () => void; // the editor went away (or the Audio Core did)
  className?: string;
  style?: React.CSSProperties;
}

export default function PluginEditorCanvas({ url, editorId, width, height, fps = 20, compression = 'deflate', inFlight, keyboard = false, onFrame, onClosed, className, style }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  useEffect(() => {
    const worker = new Worker(new URL('../native/editorStreamWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    let closed = false;

    worker.onmessage = (e) => {
      if (closed) return;
      if (e.data.type === 'closed') {
        onClosedRef.current?.();
        return;
      }
      if (e.data.type !== 'frame') return;
      const { pixels, width, height, stats } = e.data as { pixels: ArrayBuffer; width: number; height: number; stats: any };
      const canvas = canvasRef.current;
      if (!canvas) return;
      const t0 = wallMs();
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      const drawMs = wallMs() - t0;
      requestAnimationFrame(() => {
        const painted = wallMs();
        onFrameRef.current?.({
          frameId: stats.frameId, bytes: stats.bytes, renderMs: stats.renderMs, encodeMs: stats.encodeMs,
          transferMs: stats.transferMs, decodeMs: stats.decodeMs, drawMs, paintMs: painted - stats.received,
          inputToPaintMs: stats.inputClientMs ? painted - stats.inputClientMs : null
        });
      });
    };
    worker.postMessage({ type: 'open', url, editorId, fps, compression, window: inFlight });

    return () => {
      closed = true;
      worker.postMessage({ type: 'close' });
      setTimeout(() => worker.terminate(), 100);
      workerRef.current = null;
    };
  }, [url, editorId, fps, compression, inFlight]);

  // The key each held physical key went down as (its UP must match)
  const heldKeys = useRef(new Map<string, number>());
  const sendKey = (kind: 'down' | 'up' | 'char', key: number, modifiers: number) =>
    workerRef.current?.postMessage({ type: 'key', key: { kind, key, modifiers, t: wallMs() } });
  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    e.preventDefault(); // Tab stays here, Space doesn't scroll
    e.stopPropagation();
    const key = lpiKeyCode(e.nativeEvent);
    heldKeys.current.set(e.code, key);
    sendKey('down', key, lpiModifiers(e.nativeEvent));
    const typed = lpiTypedChar(e.nativeEvent);
    if (typed !== null) sendKey('char', typed, lpiModifiers(e.nativeEvent));
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const key = heldKeys.current.get(e.code) ?? lpiKeyCode(e.nativeEvent);
    heldKeys.current.delete(e.code);
    sendKey('up', key, lpiModifiers(e.nativeEvent));
  };
  const setFocus = (focused: boolean) => {
    if (!focused) heldKeys.current.clear();
    workerRef.current?.postMessage({ type: 'focus', focused });
  };

  const send = (kind: 'down' | 'move' | 'up') => (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !workerRef.current || !canvas.width) return;
    // A drag keeps going when the pointer leaves the canvas
    if (kind === 'down') canvas.setPointerCapture?.(e.pointerId);
    if (kind === 'down' && keyboard) canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    workerRef.current.postMessage({ type: 'input', input: { kind, x, y, buttons: e.buttons, t: wallMs() } });
  };

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={style}
      width={width}
      height={height}
      {...(keyboard ? {
        tabIndex: 0,
        'data-keyboard-capture': true,
        onKeyDown,
        onKeyUp,
        onFocus: () => setFocus(true),
        onBlur: () => setFocus(false)
      } : {})}
      onPointerDown={send('down')}
      onPointerMove={send('move')}
      onPointerUp={send('up')}
    />
  );
}
