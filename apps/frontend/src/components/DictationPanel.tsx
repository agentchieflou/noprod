import { useSyncExternalStore } from 'react';
import { getDictation, subscribeDictation } from '../dictation/session';

// The AI Dictation tab: what was asked, the code it became and the tracks made
export default function DictationPanel() {
  const { status, code, result, error } = useSyncExternalStore(subscribeDictation, getDictation);
  return (
    <div className="vst-paths-view">
      <h5>AI Dictation</h5>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
        Describe a beat or melody in the box at the top and click Dictate. Your browser sends it to
        Gemini with your own API key, and Gemini writes pattern code; the DAW's own pattern engine plays a bar of it. Each part of the
        result becomes a MIDI track playing a library sound, with a clip looping its bar.
      </p>

      {status === 'sending' && (
        <div className="detail-empty-message">Generating...</div>
      )}

      {code && status !== 'sending' && (
        <pre style={{ fontSize: '12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>
          {code}
        </pre>
      )}

      {result && (
        <div className="dictation-result">
          {result.tracks.length
            ? `New tracks: ${result.tracks.join(', ')}${result.bpm ? ` · tempo ${result.bpm} BPM` : ''}`
            : 'Nothing in the pattern to play.'}
          {result.unmapped.length > 0 && <div className="dictation-unmapped">No library sound for: {result.unmapped.join(', ')}</div>}
        </div>
      )}

      {status === 'error' && error && (
        <div style={{ fontSize: '12px', color: 'var(--accent-red)' }}>{error}</div>
      )}

      {status === 'idle' && (
        <div className="detail-empty-message">No dictation request sent yet.</div>
      )}
    </div>
  );
}
