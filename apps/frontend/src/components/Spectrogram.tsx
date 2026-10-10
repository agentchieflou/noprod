import { useEffect, useRef } from 'react';
import { analysis, type RenderedSound } from '@noprod/sound';

// A sound as its arrangement of frequencies over time: time runs left to
// right, frequency bottom to top (30 Hz to 20 kHz, log), brightness is level
// (90 dB range). Its waveform runs along the bottom.

const RAMP = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
const color = (t: number) => {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f));
};

const WAVE = 22; // waveform strip height
const FFT = 1024;

export default function Spectrogram({ sound, width = 240, height = 120 }: { sound: RenderedSound | null; width?: number; height?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    if (!sound || sound.left.length === 0) return;

    const { left, right, sampleRate } = sound;
    const mono = new Float32Array(left.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (left[i] + right[i]) / 2;
    const rows = height - WAVE;
    const hop = mono.length / width;
    const columns: Float64Array[] = [];
    let max = 1e-20;
    for (let x = 0; x < width; x++) {
      const p = analysis.powerSpectrum(mono, Math.max(0, Math.round(x * hop - FFT / 2)), FFT);
      columns.push(p);
      for (const v of p) if (v > max) max = v;
    }
    const image = ctx.createImageData(width, rows);
    for (let y = 0; y < rows; y++) {
      const hz = 30 * Math.pow(20000 / 30, (rows - 1 - y) / (rows - 1));
      const bin = Math.min(FFT / 2 - 1, Math.round((hz * FFT) / sampleRate));
      for (let x = 0; x < width; x++) {
        const db = 10 * Math.log10(columns[x][bin] / max + 1e-20);
        const [r, g, b] = color((db + 90) / 90);
        const at = (y * width + x) * 4;
        image.data[at] = r; image.data[at + 1] = g; image.data[at + 2] = b; image.data[at + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);

    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, rows, width, WAVE);
    ctx.fillStyle = '#60a5fa';
    for (let x = 0; x < width; x++) {
      let peak = 0;
      for (let i = Math.floor(x * hop); i < Math.min(mono.length, Math.floor((x + 1) * hop)); i++) peak = Math.max(peak, Math.abs(mono[i]));
      const h = Math.max(1, Math.round(peak * (WAVE - 2)));
      ctx.fillRect(x, rows + (WAVE - h) / 2, 1, h);
    }
  }, [sound, width, height]);

  return (
    <canvas
      ref={canvas} width={width} height={height} className="spectrogram"
      title={sound ? `${(sound.left.length / sound.sampleRate).toFixed(2)} s · frequency 30 Hz–20 kHz (log) over time` : 'Rendering…'}
    />
  );
}
