import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useDAWStore } from '../store/useDAWStore';
import { startFollowing, stopFollowing, subscribeFollower, getFollowerState } from '../audio/tempoFollower';
import { getAudioInputDevices, refreshAudioDevices } from '../audio/inputs';

// Tempo Following, while on: the project tempo tracks the tempo detected in
// the chosen audio input. Small changes are applied at most every 2s so the
// arrangement isn't constantly rescheduled.
export default function TempoFollow() {
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
      <select className="rack-map-select follow-input" value={tempoFollow.device} onFocus={() => refreshAudioDevices()}
        onChange={(e) => setTempoFollow({ device: e.target.value })} title="Input to follow">
        {getAudioInputDevices().map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <span className="follow-readout" title={`Detected tempo (confidence ${(follower.confidence * 100).toFixed(0)}%)`}>
        {follower.detectedBpm ? `≈${follower.detectedBpm.toFixed(1)}` : follower.listening ? 'listening…' : '—'}
      </span>
    </>
  );
}
