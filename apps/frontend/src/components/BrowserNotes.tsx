import { useEffect, useState } from 'react';
import { getMidiStatus, onInputsChange } from '../audio/inputs';
import { audioContext } from '../audio/engine';
import { getExtraLatencyMs, hasOutputLatency, setExtraLatencyMs } from '../audio/latency';
import { isFirefox, SMALL_SCREEN_PX } from '../platform/support';

const query = `(max-width: ${SMALL_SCREEN_PX - 1}px)`;

// Below 900 px the layout doesn't fit; say so, and let the visitor go on
export function SmallScreenNotice() {
  const [small, setSmall] = useState(() => window.matchMedia(query).matches);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setSmall(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  if (!small || dismissed) return null;
  return (
    <div className="small-screen-notice" role="dialog" aria-label="Screen size">
      <h2>noprod is built for larger screens</h2>
      <p>Its tracks, piano roll and mixer need more room than this window has. Open it on a laptop or desktop for the best experience.</p>
      <button className="btn-add-track" onClick={() => setDismissed(true)}>Continue anyway</button>
    </div>
  );
}

export function MidiNote() {
  const [status, setStatus] = useState(getMidiStatus());
  useEffect(() => onInputsChange(() => setStatus(getMidiStatus())), []);
  if (status === 'denied') {
    return (
      <p className="browser-note midi-note" role="status">
        {isFirefox()
          ? 'MIDI blocked. Firefox needs its site-permission add-on: accept the prompt, reload, then pick an input.'
          : 'MIDI blocked. Allow MIDI for this site in the address bar, then pick an input.'}
      </p>
    );
  }
  if (status === 'unsupported') {
    return <p className="browser-note midi-note" role="status">This browser has no WebMIDI: only the computer keyboard plays.</p>;
  }
  return null;
}

// Which latency a recording is placed by, and the setting for browsers without outputLatency
export function LatencyInfo() {
  const [ms, setMs] = useState(getExtraLatencyMs());
  const exact = hasOutputLatency(audioContext);
  return (
    <div className="browser-note">
      <h5>Recording latency</h5>
      {exact ? (
        <p>Recordings are placed using this browser's reported output latency.</p>
      ) : (
        <p>
          This browser doesn't report its output latency, so recordings are placed using its base latency plus{' '}
          <input type="number" min={0} max={500} step={5} value={ms} aria-label="Extra output latency in milliseconds"
            onChange={(e) => { const v = Number(e.target.value); setMs(v); setExtraLatencyMs(v); }} /> ms. Raise it if
          recordings land late.
        </p>
      )}
    </div>
  );
}
