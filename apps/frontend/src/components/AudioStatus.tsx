import { useSyncExternalStore } from 'react';
import { audioError, audioNeedsStart, onAudioStateChange, resumeAudio } from '../audio/engine';

// Says why audio isn't running, or asks for the click that starts it
export default function AudioStatus() {
  const needsStart = useSyncExternalStore(onAudioStateChange, audioNeedsStart);
  if (audioError) return <div className="audio-bar audio-bar-error" role="alert">{audioError}</div>;
  if (!needsStart) return null;
  return (
    <div className="audio-bar" role="status">
      <span>Audio is paused until you start it.</span>
      <button className="designer-button" onClick={() => { void resumeAudio(); }}>Click to start audio</button>
    </div>
  );
}
