import { useDAWStore } from '../store/useDAWStore';
import { PIXELS_PER_SECOND, beatSeconds } from '../audio/timeline';
import { toUnit, fromUnit, type AutomationParam } from '../audio/automation';

export const LANE_HEIGHT = 56;
const PAD = 5; // keep breakpoints off the lane edges

interface Props {
  track: any;
  param: AutomationParam;
  width: number;
  color: string;
}

// Breakpoint envelope editor for one automated parameter. Click to add a
// point (and keep dragging it), drag points to move them (snapped to 1/16
// notes; hold Alt for free movement), double-click or right-click to delete.
export default function AutomationLane({ track, param, width, color }: Props) {
  const { bpm, setAutomationPoints } = useDAWStore();
  const points: { time: number; value: number }[] = track.automation?.[param.key] || [];
  const h = LANE_HEIGHT;
  const yOf = (v: number) => PAD + (1 - toUnit(param, v)) * (h - 2 * PAD);
  const vOf = (y: number) => fromUnit(param, 1 - (y - PAD) / (h - 2 * PAD));
  const grid = beatSeconds(bpm) / 4;

  const save = (pts: { time: number; value: number }[]) => setAutomationPoints(track.id, param.key, pts);

  // Drag point `index` of `pts` (the array as it will be stored)
  const dragPoint = (e: React.MouseEvent, pts: { time: number; value: number }[], index: number, svg: SVGSVGElement) => {
    const rect = svg.getBoundingClientRect();
    const target = pts[index];
    const onMove = (me: MouseEvent) => {
      const raw = Math.max(0, (me.clientX - rect.left) / PIXELS_PER_SECOND);
      const time = me.altKey ? raw : Math.round(raw / grid) * grid;
      const value = vOf(me.clientY - rect.top);
      save(pts.map((p) => (p === target ? { time, value } : p)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  };

  const onBackgroundDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const raw = (e.clientX - rect.left) / PIXELS_PER_SECOND;
    const time = Math.max(0, e.altKey ? raw : Math.round(raw / grid) * grid);
    const pt = { time, value: vOf(e.clientY - rect.top) };
    const next = [...points, pt];
    save(next);
    dragPoint(e, next, next.length - 1, svg);
  };

  const removePoint = (pt: { time: number; value: number }) => save(points.filter((p) => p !== pt));

  // Envelope path: flat before the first point and after the last
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const path = sorted.length
    ? [`M0,${yOf(sorted[0].value)}`, ...sorted.map((p) => `L${p.time * PIXELS_PER_SECOND},${yOf(p.value)}`), `L${width},${yOf(sorted[sorted.length - 1].value)}`].join(' ')
    : '';

  return (
    <svg
      className="automation-lane"
      width={width}
      height={h}
      onMouseDown={onBackgroundDown}
      onClick={(e) => e.stopPropagation()}
    >
      {sorted.length === 0 ? (
        <line x1="0" x2={width} y1={yOf(param.value)} y2={yOf(param.value)} className="automation-static" />
      ) : (
        <path d={path} className="automation-path" style={{ stroke: color }} />
      )}
      {sorted.map((p, i) => (
        <circle
          key={`${i}-${p.time}`}
          cx={p.time * PIXELS_PER_SECOND}
          cy={yOf(p.value)}
          r={4}
          className="automation-point"
          style={{ fill: color }}
          onMouseDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            const svg = (e.currentTarget as SVGCircleElement).ownerSVGElement!;
            dragPoint(e, points, points.indexOf(p), svg);
          }}
          onDoubleClick={(e) => { e.stopPropagation(); removePoint(p); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); removePoint(p); }}
        >
          <title>{`${p.time.toFixed(2)}s · ${p.value.toFixed(2)}`}</title>
        </circle>
      ))}
    </svg>
  );
}
