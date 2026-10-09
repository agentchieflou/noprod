import { useRef, useState } from 'react';
import { EQ8_BANDS, eq8HasGain, getDeviceDef, resolvedParameters, type ParamValue } from '../audio/devices';
import { freqToX, xToFreq } from '../audio/response';
import { ResponseCurve } from './DeviceVisuals';
import ParamControl from './ParamControl';

const W = 404;
const H = 104;
const RANGE_DB = 18;
const BAND_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899'];

const gainToY = (db: number) => H / 2 - (db / RANGE_DB) * (H / 2 - 2);
const yToGain = (y: number) => Math.max(-15, Math.min(15, ((H / 2 - y) / (H / 2 - 2)) * RANGE_DB));

// EQ Eight editor: response curve with a draggable dot per band (x = freq,
// y = gain, wheel = Q), band on/off chips, and the selected band's controls.
export default function EqEightPanel({ device, onChange }: { device: any; onChange: (name: string, v: ParamValue) => void }) {
  const p = resolvedParameters(device);
  const def = getDeviceDef(device)!;
  const [sel, setSel] = useState(3);
  const areaRef = useRef<HTMLDivElement>(null);
  const spec = (name: string) => def.params.find((s) => s.name === name)!;

  const startDrag = (e: React.MouseEvent, band: number) => {
    e.preventDefault();
    setSel(band);
    const rect = areaRef.current!.getBoundingClientRect();
    const type = String(p[`${band} Type`]);
    if (!p[`${band} On`]) onChange(`${band} On`, true);
    const onMove = (me: MouseEvent) => {
      const f = Math.round(xToFreq(me.clientX - rect.left, W));
      onChange(`${band} Freq`, f);
      if (eq8HasGain(type)) onChange(`${band} Gain`, Math.round(yToGain(me.clientY - rect.top) * 10) / 10);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onWheel = (e: React.WheelEvent, band: number) => {
    const q = Number(p[`${band} Q`]);
    const next = Math.max(0.1, Math.min(18, q * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    onChange(`${band} Q`, Math.round(next * 100) / 100);
  };

  return (
    <div className="eq8-panel">
      <div className="eq8-curve" ref={areaRef} style={{ width: W, height: H }}>
        <ResponseCurve deviceId={device.id} version={device} width={W} height={H} rangeDb={RANGE_DB} />
        {Array.from({ length: EQ8_BANDS }, (_, i) => i + 1).map((band) => {
          const on = p[`${band} On`] === true;
          const type = String(p[`${band} Type`]);
          const x = freqToX(Number(p[`${band} Freq`]), W);
          const y = eq8HasGain(type) ? gainToY(Number(p[`${band} Gain`])) : H / 2;
          return (
            <div
              key={band}
              className={`eq8-dot ${on ? 'on' : ''} ${sel === band ? 'selected' : ''}`}
              style={{ left: x, top: y, borderColor: BAND_COLORS[band - 1], backgroundColor: on ? BAND_COLORS[band - 1] : 'transparent' }}
              title={`Band ${band}: ${type} — drag to move, wheel for Q, double-click to toggle`}
              onMouseDown={(e) => startDrag(e, band)}
              onWheel={(e) => onWheel(e, band)}
              onDoubleClick={() => onChange(`${band} On`, !on)}
            >
              {band}
            </div>
          );
        })}
      </div>

      <div className="eq8-bands">
        {Array.from({ length: EQ8_BANDS }, (_, i) => i + 1).map((band) => (
          <div key={band} className={`eq8-band-chip ${sel === band ? 'selected' : ''}`} onClick={() => setSel(band)}>
            <button
              className={`eq8-led ${p[`${band} On`] ? 'on' : ''}`}
              style={{ backgroundColor: p[`${band} On`] ? BAND_COLORS[band - 1] : undefined }}
              title={p[`${band} On`] ? `Turn band ${band} off` : `Turn band ${band} on`}
              onClick={(e) => { e.stopPropagation(); onChange(`${band} On`, !p[`${band} On`]); }}
            />
            {band}
          </div>
        ))}
      </div>

      <div className="eq8-band-editor">
        <ParamControl spec={spec(`${sel} Type`)} label="Type" value={p[`${sel} Type`]} onChange={(v) => onChange(`${sel} Type`, v)} />
        <ParamControl spec={spec(`${sel} Freq`)} label="Freq" value={p[`${sel} Freq`]} onChange={(v) => onChange(`${sel} Freq`, v)} />
        <ParamControl spec={spec(`${sel} Gain`)} label="Gain" value={p[`${sel} Gain`]} onChange={(v) => onChange(`${sel} Gain`, v)}
          disabled={!eq8HasGain(String(p[`${sel} Type`]))} />
        <ParamControl spec={spec(`${sel} Q`)} label="Q" value={p[`${sel} Q`]} onChange={(v) => onChange(`${sel} Q`, v)}
          disabled={String(p[`${sel} Type`]).includes('Shelf')} />
      </div>
    </div>
  );
}
