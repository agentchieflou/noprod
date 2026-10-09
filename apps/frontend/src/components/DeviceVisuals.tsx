import { useEffect, useRef } from 'react';
import { getDeviceDSP } from '../audio/engine';
import { deviceKind, resolvedParameters, type ParamValue } from '../audio/devices';
import { RESPONSE_FREQS, freqToX } from '../audio/response';
import EqEightPanel from './EqEightPanel';

// Live gain-reduction bar for dynamics devices; reads the DSP straight from a
// rAF loop and writes to the DOM so metering never re-renders React.
export function GainReductionMeter({ deviceId, rangeDb = 24 }: { deviceId: string; rangeDb?: number }) {
  const fillRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf: number;
    let shown = 0;
    const tick = () => {
      const gr = getDeviceDSP(deviceId)?.getReduction?.() ?? 0;
      // fast attack / slow fall so short peaks stay readable
      shown = gr < shown ? gr : shown + (gr - shown) * 0.15;
      const pct = Math.min(100, (-shown / rangeDb) * 100);
      if (fillRef.current) fillRef.current.style.width = `${pct}%`;
      if (textRef.current) textRef.current.textContent = shown < -0.05 ? shown.toFixed(1) : '0.0';
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [deviceId, rangeDb]);

  return (
    <div className="gr-meter" title="Gain reduction (dB)">
      <span className="gr-label">GR</span>
      <div className="gr-track"><div className="gr-fill" ref={fillRef} /></div>
      <span className="gr-value" ref={textRef}>0.0</span>
    </div>
  );
}

// Static input/output transfer curve (threshold, ratio, soft knee).
export function TransferCurve({ threshold, ratio, knee, size = 54 }: { threshold: number; ratio: number; knee: number; size?: number }) {
  const lo = -60;
  const out = (x: number) => {
    const over = x - threshold;
    if (knee > 0 && 2 * Math.abs(over) <= knee) {
      return x + ((1 / ratio - 1) * Math.pow(over + knee / 2, 2)) / (2 * knee);
    }
    return over > 0 ? threshold + over / ratio : x;
  };
  const toPx = (db: number) => ((db - lo) / -lo) * size;
  let d = '';
  for (let x = lo; x <= 0; x += 1) {
    d += `${d ? 'L' : 'M'}${toPx(x).toFixed(1)},${(size - toPx(out(x))).toFixed(1)}`;
  }
  return (
    <svg className="transfer-curve" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <line x1="0" y1={size} x2={size} y2="0" className="tc-unity" />
      <line x1={toPx(threshold)} y1="0" x2={toPx(threshold)} y2={size} className="tc-threshold" />
      <path d={d} className="tc-curve" />
    </svg>
  );
}

// Frequency-response curve read from the device's live DSP (log 20Hz-20kHz).
// `version` is anything that changes when the response does (the device object).
export function ResponseCurve({ deviceId, version, width = 200, height = 64, rangeDb = 18, color = '#3b82f6' }:
  { deviceId: string; version: unknown; width?: number; height?: number; rangeDb?: number; color?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const dsp = getDeviceDSP(deviceId);
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, width, height);
    const yOf = (db: number) => height / 2 - (Math.max(-rangeDb, Math.min(rangeDb, db)) / rangeDb) * (height / 2 - 2);
    // grid: 0 dB line + decade markers
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yOf(0)); ctx.lineTo(width, yOf(0));
    [100, 1000, 10000].forEach((f) => { const x = freqToX(f, width); ctx.moveTo(x, 0); ctx.lineTo(x, height); });
    ctx.stroke();
    if (!dsp?.getResponse) return;
    const db = dsp.getResponse(RESPONSE_FREQS);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < db.length; i++) {
      const x = (i / (db.length - 1)) * width;
      if (i === 0) ctx.moveTo(x, yOf(db[i])); else ctx.lineTo(x, yOf(db[i]));
    }
    ctx.stroke();
  }, [deviceId, version, width, height, rangeDb, color]);
  return <canvas ref={canvasRef} width={width} height={height} className="response-curve" />;
}

// Device-specific visuals shown above a device card's parameters.
export function DeviceExtra({ device, onChange }: { device: any; onChange: (paramName: string, value: ParamValue) => void }) {
  const kind = deviceKind(device);
  if (kind === 'eq8') return <EqEightPanel device={device} onChange={onChange} />;
  if (kind === 'eq3') {
    const p = resolvedParameters(device);
    return (
      <div className="device-visuals eq3-visuals">
        <ResponseCurve deviceId={device.id} version={device} width={196} height={56} rangeDb={24} />
        <div className="eq3-kills">
          {(['Lo', 'Mid', 'Hi'] as const).map((band) => (
            <button
              key={band}
              className={`eq3-kill ${p[`Kill ${band}`] ? 'killed' : ''}`}
              title={`${p[`Kill ${band}`] ? 'Restore' : 'Kill'} the ${band.toLowerCase()} band`}
              onClick={() => onChange(`Kill ${band}`, !p[`Kill ${band}`])}
            >
              {band === 'Hi' ? 'H' : band === 'Mid' ? 'M' : 'L'}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (kind === 'glue') {
    return (
      <div className="device-visuals">
        <GainReductionMeter deviceId={device.id} rangeDb={20} />
      </div>
    );
  }
  if (kind === 'compressor') {
    const p = resolvedParameters(device);
    return (
      <div className="device-visuals">
        <TransferCurve threshold={Number(p.Threshold)} ratio={Number(p.Ratio)} knee={Number(p.Knee)} />
        <GainReductionMeter deviceId={device.id} />
      </div>
    );
  }
  return null;
}
