import type { DictationResult } from '../audio/dictation';

// The AI Dictation tab: what was asked, the code it became and the tracks made
export default function DictationPanel({ status, code, result, error }: {
  status: 'idle' | 'sending' | 'done' | 'error'; code: string | null; result: DictationResult | null; error: string | null;
}) {
  return (
    <div className="vst-paths-view">
      <h5>AI Dictation</h5>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
        Describe a beat or melody in the box at the top and click Dictate. The Orchestrator sends it to
        Gemini, which generates Strudel code and passes it to the Sequencer to evaluate. Each part of the
        result becomes a MIDI track playing a library sound, with a clip looping its bar.
      </p>

      {status === 'sending' && (
        <div className="detail-empty-message">Generating...</div>
      )}

      {status === 'done' && code && (
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
