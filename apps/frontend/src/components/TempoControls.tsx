import { useEffect, useRef, useState } from 'react';
import { useDAWStore } from '../store/useDAWStore';
import { barAt } from '../audio/timeline';

const VALID_DENOMINATORS = [1, 2, 4, 8, 16];

// Transport-bar tempo section: editable BPM, tap tempo, the time signature at
// the playhead's bar (editing it inserts a change there), and count-in length.
export default function TempoControls({ position }: { position: number }) {
  const { bpm, setBpm, timeSignatures, setTimeSignature, countInBars, setCountInBars } = useDAWStore();
  const taps = useRef<number[]>([]);
  const [tapFlash, setTapFlash] = useState(false);

  const bar = barAt(bpm, position, timeSignatures);
  const sigText = `${bar.numerator}/${bar.denominator}`;
  const [sigDraft, setSigDraft] = useState(sigText);
  const [bpmDraft, setBpmDraft] = useState(bpm.toFixed(2));
  useEffect(() => setSigDraft(sigText), [sigText]);
  useEffect(() => setBpmDraft(bpm.toFixed(2)), [bpm]);

  // Tap tempo: average the last few intervals; a pause over 2s starts over
  const tap = () => {
    const now = performance.now();
    const prev = taps.current;
    if (prev.length && now - prev[prev.length - 1] > 2000) prev.length = 0;
    prev.push(now);
    if (prev.length > 5) prev.shift();
    if (prev.length >= 2) {
      const avg = (prev[prev.length - 1] - prev[0]) / (prev.length - 1);
      setBpm(Math.round((60000 / avg) * 100) / 100);
    }
    setTapFlash(true);
    setTimeout(() => setTapFlash(false), 90);
  };

  const commitBpm = () => {
    const v = parseFloat(bpmDraft);
    if (Number.isFinite(v)) setBpm(v); else setBpmDraft(bpm.toFixed(2));
  };

  const commitSig = () => {
    const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(sigDraft);
    const n = m ? parseInt(m[1]) : NaN, d = m ? parseInt(m[2]) : NaN;
    if (n >= 1 && n <= 32 && VALID_DENOMINATORS.includes(d)) {
      if (`${n}/${d}` !== sigText) setTimeSignature(bar.index, n, d);
    } else {
      setSigDraft(sigText);
    }
  };

  return (
    <div className="tempo-controls">
      <input
        className="bpm-input"
        value={bpmDraft}
        onChange={(e) => setBpmDraft(e.target.value)}
        onBlur={commitBpm}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        title="Tempo (BPM)"
      />
      <span className="tempo-unit">BPM</span>
      <button className={`btn-metronome tap-btn ${tapFlash ? 'active' : ''}`} onClick={tap} title="Tap tempo: click on the beat">TAP</button>
      <input
        className="sig-input"
        value={sigDraft}
        onChange={(e) => setSigDraft(e.target.value)}
        onBlur={commitSig}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        title={`Time signature at bar ${bar.index + 1} (editing inserts a change at that bar)`}
      />
      <select
        className="rack-map-select countin-select"
        value={countInBars}
        onChange={(e) => setCountInBars(parseInt(e.target.value))}
        title="Bars of count-in before recording starts"
      >
        <option value={0}>No count-in</option>
        <option value={1}>Count-in 1</option>
        <option value={2}>Count-in 2</option>
        <option value={4}>Count-in 4</option>
      </select>
    </div>
  );
}
