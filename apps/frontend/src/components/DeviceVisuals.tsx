import { useEffect, useRef } from 'react';
import { getDeviceDSP } from '../audio/engine';
import { deviceKind, resolvedParameters } from '../audio/devices';

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

// Device-specific visuals shown above a device card's parameters.
export function DeviceExtra({ device }: { device: any }) {
  const kind = deviceKind(device);
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
