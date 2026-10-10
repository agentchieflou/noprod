import { useRef } from 'react';
import type { Partial as Component } from '@noprod/sound';

// A layer's sine partials as bars: across, the frequency as a multiple of the
// note (log, 1/4 to 32); up, the level (dB, 60 dB range); the brighter the
// bar, the longer it rings. Drag a bar up or down to change its level, with
// Shift held to move its frequency; double-click empty space to add one.

const W = 228, H = 96, PAD = 6;
const MIN = 0.25, MAX = 32;
const xOf = (ratio: number) => PAD + ((Math.log2(ratio) - Math.log2(MIN)) / (Math.log2(MAX) - Math.log2(MIN))) * (W - 2 * PAD);
const ratioAt = (x: number) => Math.pow(2, Math.log2(MIN) + ((x - PAD) / (W - 2 * PAD)) * (Math.log2(MAX) - Math.log2(MIN)));
const yOf = (level: number) => {
  const db = Math.max(-60, 20 * Math.log10(Math.max(level, 1e-6)));
  return H - PAD - ((db + 60) / 60) * (H - 2 * PAD);
};
const levelAt = (y: number) => Math.pow(10, (((H - PAD - y) / (H - 2 * PAD)) * 60 - 60) / 20);

// Snap a ratio to a whole harmonic when it's within 2% of one
const snap = (ratio: number) => {
  const whole = Math.round(ratio);
  return whole >= 1 && Math.abs(ratio - whole) / whole < 0.02 ? whole : Math.round(ratio * 1000) / 1000;
};

export default function PartialEditor({ partials, selected, onSelect, onChange }: {
  partials: Component[];
  selected: number;
  onSelect: (index: number) => void;
  onChange: (partials: Component[]) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ index: number } | null>(null);
  const point = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const longest = Math.max(1, ...partials.map((p) => p.decay ?? 1));

  return (
    <svg
      ref={svg} className="partial-editor" viewBox={`0 0 ${W} ${H}`}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const { x, y } = point(e);
        const i = drag.current.index;
        const next = partials.map((p, k) => k !== i ? p : e.shiftKey
          ? { ...p, ratio: snap(Math.min(MAX, Math.max(MIN, ratioAt(x)))) }
          : { ...p, level: Math.round(Math.min(1, Math.max(0.001, levelAt(y))) * 1000) / 1000 });
        onChange(next);
      }}
      onPointerUp={() => { drag.current = null; }}
      onDoubleClick={(e) => {
        if ((e.target as Element).tagName === 'rect' && (e.target as Element).classList.contains('partial-bar')) return;
        const { x, y } = point(e);
        const ratio = snap(Math.min(MAX, Math.max(MIN, ratioAt(x))));
        onChange([...partials, { ratio, level: Math.round(Math.min(1, levelAt(y)) * 1000) / 1000 }]);
        onSelect(partials.length);
      }}
    >
      {/* whole harmonics and octaves */}
      {[0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32].map((r) => (
        <g key={r}>
          <line x1={xOf(r)} x2={xOf(r)} y1={PAD} y2={H - PAD} className={Number.isInteger(Math.log2(r)) ? 'grid-octave' : 'grid-harmonic'} />
          {[0.25, 1, 2, 4, 8, 16, 32].includes(r) && <text x={xOf(r) + 2} y={H - 1} className="grid-label">{r < 1 ? `1/${1 / r}` : r}</text>}
        </g>
      ))}
      {partials.map((p, i) => {
        const x = xOf(Math.min(MAX, Math.max(MIN, p.ratio)));
        const y = yOf(p.level);
        return (
          <rect
            key={i} className={`partial-bar ${i === selected ? 'selected' : ''}`}
            x={x - 2} y={y} width={4} height={Math.max(1, H - PAD - y)}
            style={{ opacity: 0.35 + 0.65 * Math.min(1, (p.decay ?? longest) / longest) }}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              drag.current = { index: i };
              onSelect(i);
            }}
          >
            <title>{`×${p.ratio} · ${(20 * Math.log10(Math.max(p.level, 1e-6))).toFixed(1)} dB${p.decay ? ` · rings ${p.decay} s` : ''}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
