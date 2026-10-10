// #44 B6a latency spike (dev only, served at /editor-spike.html): streams the
// synthetic editor from apps/audio_core/tools/EditorStreamSpike.cpp, measures
// ambient frames for a while, then drags a knob with synthetic pointer
// events and measures input -> frame-on-screen. Query parameters:
//   compression=none|deflate  fps=20  seconds=5  inputs=60  interval=33
// The summary is shown and left on window.__spikeResult.

import { useEffect, useRef, useState } from 'react';
import PluginEditorCanvas, { type EditorFrameStats } from '../components/PluginEditorCanvas';

const params = new URLSearchParams(location.search);
const compression = (params.get('compression') === 'none' ? 'none' : 'deflate') as 'none' | 'deflate';
const fps = Number(params.get('fps') || 20);
const seconds = Number(params.get('seconds') || 5);
const inputs = Number(params.get('inputs') || 60);
const interval = Number(params.get('interval') || 33);

const pct = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(2);
};
const summarize = (frames: EditorFrameStats[], key: keyof EditorFrameStats) => {
  const values = frames.map((f) => f[key]).filter((v): v is number => typeof v === 'number');
  return { p50: pct(values, 50), p95: pct(values, 95) };
};

export default function EditorSpikePage() {
  const frames = useRef<EditorFrameStats[]>([]);
  const phase = useRef<'warmup' | 'ambient' | 'input' | 'done'>('warmup');
  const [result, setResult] = useState<any>(null);
  const [size, setSize] = useState('');

  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      await sleep(1000);
      phase.current = 'ambient';
      frames.current = [];
      const t0 = performance.now();
      await sleep(seconds * 1000);
      const ambient = frames.current;
      const ambientSecs = (performance.now() - t0) / 1000;

      phase.current = 'input';
      frames.current = [];
      const canvas = document.querySelector('canvas')!;
      const rect = canvas.getBoundingClientRect();
      const at = (y: number) => ({ clientX: rect.left + rect.width * 0.1, clientY: rect.top + y, bubbles: true, pointerId: 1, buttons: 1 });
      let y = rect.height * 0.5;
      canvas.dispatchEvent(new PointerEvent('pointerdown', at(y)));
      for (let i = 0; i < inputs && !cancelled; i++) {
        await sleep(interval);
        y += i % 20 < 10 ? -3 : 3;
        canvas.dispatchEvent(new PointerEvent('pointermove', at(y)));
      }
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...at(y), buttons: 0 }));
      await sleep(500);
      const answered = frames.current.filter((f) => f.inputToPaintMs !== null);
      phase.current = 'done';

      const ids = ambient.map((f) => f.frameId);
      const summary = {
        size: `${canvas.width}x${canvas.height}`, compression, fps,
        ambientFps: +(ambient.length / ambientSecs).toFixed(1),
        dropped: ids.length > 1 ? ids[ids.length - 1] - ids[0] + 1 - ids.length : 0,
        kbPerFrame: pct(ambient.map((f) => f.bytes / 1024), 50),
        render: summarize(ambient, 'renderMs'),
        encode: summarize(ambient, 'encodeMs'),
        transfer: summarize(ambient, 'transferMs'),
        decode: summarize(ambient, 'decodeMs'),
        draw: summarize(ambient, 'drawMs'),
        receivedToScreen: summarize(ambient, 'paintMs'),
        inputToScreen: { ...summarize(answered, 'inputToPaintMs'), answered: answered.length, sent: inputs }
      };
      setResult(summary);
      (window as any).__spikeResult = summary;
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: '0 0 8px' }}>Editor streaming spike — {compression}, {fps} fps {size}</h3>
      <PluginEditorCanvas
        url="ws://localhost:8084"
        fps={fps}
        compression={compression}
        onFrame={(f) => {
          if (phase.current === 'ambient' || phase.current === 'input') frames.current.push(f);
          setSize((s) => s || `${(f.bytes / 1024).toFixed(0)} KB/frame`);
        }}
      />
      <pre>{result ? JSON.stringify(result, null, 2) : 'measuring…'}</pre>
    </div>
  );
}
