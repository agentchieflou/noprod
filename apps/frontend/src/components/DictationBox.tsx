import { useState, useSyncExternalStore } from 'react';
import { Wand2 } from 'lucide-react';
import { getKey, hasKey, subscribeKey, setKeyDialogOpen, getKeyDialogOpen, subscribeKeyDialog } from '../dictation/key';
import { cancelDictation, dictate, getDictation, subscribeDictation } from '../dictation/session';
import { LIMITS } from '../dictation/provider';
import DictationSettings from './DictationSettings';

// The control bar's dictation box. Without a key it is one line that opens
// the settings; nothing else about the app changes and nothing connects.
export default function DictationBox({ onOpenTab }: { onOpenTab: () => void }) {
  useSyncExternalStore(subscribeKey, getKey);
  const { status } = useSyncExternalStore(subscribeDictation, getDictation);
  const open = useSyncExternalStore(subscribeKeyDialog, getKeyDialogOpen);
  const [input, setInput] = useState('');
  const sending = status === 'sending';

  const send = () => {
    if (!input.trim() || sending) return;
    onOpenTab();
    dictate(input);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', position: 'relative' }}>
      {hasKey() ? <>
        <input
          type="text" placeholder="Describe a beat or melody..." value={input} maxLength={LIMITS.promptChars}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          className="vst-path-input" style={{ width: '120px' }}
        />
        {sending
          ? <button className="btn-metronome" onClick={cancelDictation} title="Stop waiting for the answer">Cancel</button>
          : <button className="btn-metronome" onClick={send} title="Generate a pattern from text, with your own Gemini key">
              <Wand2 size={14} style={{ marginRight: '5px' }} />Dictate
            </button>}
        {sending && <span className="native-hint">Generating...</span>}
        <button className="btn-metronome" onClick={() => setKeyDialogOpen(!open)} title="Your API key for dictation">Key</button>
      </> : (
        <button className="btn-metronome" onClick={() => setKeyDialogOpen(!open)} title="Dictation needs your own Gemini API key; it stays in this browser">
          <Wand2 size={14} style={{ marginRight: '5px' }} />Add your API key to dictate
        </button>
      )}
      {open && <DictationSettings />}
    </div>
  );
}
