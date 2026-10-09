import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useDAWStore } from '../store/useDAWStore';
import { barAt } from '../audio/timeline';
import { startFollowing, stopFollowing, subscribeFollower, getFollowerState } from '../audio/tempoFollower';
import { getAudioInputDevices, refreshAudioDevices } from '../audio/inputs';

// Tempo Following: while on, the project tempo tracks the tempo detected in
// the chosen audio input. Small changes are applied at most every 2s so the
// arrangement isn't constantly rescheduled.
function FollowControl() {
  const { tempoFollow, setTempoFollow } = useDAWStore();
  const follower = useSyncExternalStore(subscribeFollower, getFollowerState);
  const lastApplied = useRef(0);

  useEffect(() => {
    if (!tempoFollow.enabled) { stopFollowing(); return; }
    startFollowing(tempoFollow.device, tempoFollow.channel, (bpm) => {
      const st = useDAWStore.getState();
      const now = performance.now();
      if (Math.abs(bpm - st.bpm) < 0.3 || now - lastApplied.current < 2000) return;
      lastApplied.current = now;
      st.setBpmLive(bpm);
    }).then((ok) => { if (!ok) setTempoFollow({ enabled: false }); });
    return () => stopFollowing();
  }, [tempoFollow.enabled, tempoFollow.device, tempoFollow.channel, setTempoFollow]);

  return (
    <>
      <button
        className={`btn-metronome follow-btn ${tempoFollow.enabled ? 'active' : ''}`}
        onClick={() => setTempoFollow({ enabled: !tempoFollow.enabled })}
        title="Tempo Follower: adapt the project tempo to the tempo of incoming audio"
      >
        FOLLOW
      </button>
      {tempoFollow.enabled && (
        <>
          <select className="rack-map-select follow-input" value={tempoFollow.device} onFocus={() => refreshAudioDevices()}
            onChange={(e) => setTempoFollow({ device: e.target.value })} title="Input to follow">
            {getAudioInputDevices().map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <span className="follow-readout" title={`Detected tempo (confidence ${(follower.confidence * 100).toFixed(0)}%)`}>
            {follower.detectedBpm ? `≈${follower.detectedBpm.toFixed(1)}` : follower.listening ? 'listening…' : '—'}
          </span>
        </>
      )}
    </>
  );
}

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
      <FollowControl />
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
