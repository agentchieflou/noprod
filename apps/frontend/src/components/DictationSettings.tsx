import { useState } from 'react';
import { X } from 'lucide-react';
import { forgetKey, getKey, hasKey, setKey, setKeyDialogOpen } from '../dictation/key';
import { provider } from '../dictation/session';

type Test = { state: 'idle' | 'testing' | 'ok' | 'failed'; message?: string };

// Where the user pastes the key AI dictation uses (#157)
export default function DictationSettings() {
  const [draft, setDraft] = useState(getKey());
  const [test, setTest] = useState<Test>({ state: 'idle' });
  const saved = hasKey();

  const save = () => { setKey(draft); setTest({ state: 'idle' }); };
  const runTest = async () => {
    setKey(draft);
    setTest({ state: 'testing' });
    try {
      await provider.test();
      setTest({ state: 'ok' });
    } catch (e) {
      setTest({ state: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="midi-map-dialog services-dialog" role="dialog" aria-label="Dictation settings" data-dictation-settings>
      <div className="midi-map-head">
        <b>AI dictation</b>
        <button className="btn-icon" title="Close" onClick={() => setKeyDialogOpen(false)}><X size={12} /></button>
      </div>
      <p className="native-hint">
        Dictation turns a sentence into tracks using {provider.label}. It's optional: the rest of noprod works without it.
        Get a key at <a href={provider.keyUrl} target="_blank" rel="noreferrer">{provider.keyUrl.replace('https://', '')}</a> and paste it here.
      </p>
      <label className="service-address">
        {provider.label} API key
        <input
          className="vst-path-input" type="password" autoComplete="off" spellCheck={false} value={draft}
          placeholder="Paste your key" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        />
      </label>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <button className="btn-metronome" onClick={save} disabled={draft.trim() === getKey()}>Save</button>
        <button className="btn-metronome" onClick={runTest} disabled={!draft.trim() || test.state === 'testing'}>Test key</button>
        <button className="btn-metronome" onClick={() => { forgetKey(); setDraft(''); setTest({ state: 'idle' }); }} disabled={!saved && !draft}>Forget key</button>
      </div>
      <div className="native-hint" role="status" data-test={test.state}>
        {test.state === 'testing' && 'Testing…'}
        {test.state === 'ok' && 'The key works.'}
        {test.state === 'failed' && <span style={{ color: 'var(--accent-red)' }}>{test.message}</span>}
      </div>
      <p className="native-hint">
        The key stays in this browser: it is never saved in a project or sent to noprod, only to {provider.host}.
        Dictation is billed to your own account with the provider.
      </p>
    </div>
  );
}
