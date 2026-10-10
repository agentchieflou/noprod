import { useSyncExternalStore } from 'react';
import { X, ChevronLeft, ChevronRight, RotateCcw, GraduationCap, Check } from 'lucide-react';
import { ALL_KEYS, findLesson, keyName, sameKey, type CoachMode } from '@noprod/theory';
import {
  subscribeCoach, getCoachState, setCoachOpen, setCoachMode, setCoachKey, setCoachLesson, restartLesson, setCoachFocus, pretty, LESSON_GROUPS
} from '../audio/coach';
import { subscribeKeyboard, getKeyboardState, setKeyboardEnabled, setKeyboardMode, setOctave } from '../audio/computerKeyboard';

const MODES: [CoachMode, string, string][] = [
  ['off', 'Off', 'No suggestions'],
  ['chords', 'Chords', 'The chords that usually come next, voiced close to your hands'],
  ['melody', 'Melody', 'The notes that usually come next in a tune'],
  ['complement', 'Complement', 'Notes that go with the ones you hold'],
  ['lesson', 'Lessons', 'Play a progression or a tune step by step']
];

// 'C (I) → try G (V) or F (IV)': the chord held stands out
function Message({ text }: { text: string }) {
  const [held, next] = pretty(text).split(' → ');
  return next === undefined ? <>{held}</> : <><b>{held}</b> <span className="coach-arrow">→</span> {next}</>;
}

// The Keyboard Coach beside the keys: its mode, key or lesson, and what to
// play next in words. `onPiano` is false while the keys show pads (the
// computer keyboard's Scale and Drums modes): highlights need the piano.
export default function KeyboardCoach({ onPiano }: { onPiano: boolean }) {
  const coach = useSyncExternalStore(subscribeCoach, getCoachState);
  const kb = useSyncExternalStore(subscribeKeyboard, getKeyboardState);
  const { readout, mode, key } = coach;
  const lesson = readout.lesson;
  const about = coach.lesson ? findLesson(coach.lesson)?.description : undefined;
  const keyIndex = key === 'auto' ? 'auto' : String(ALL_KEYS.findIndex((k) => sameKey(k, key)));
  const strongest = Math.max(0, ...readout.suggestions.map((s) => s.weight));

  return (
    <div className="kb-coach">
      <div className="kb-title">
        <GraduationCap size={13} className="coach-icon" />
        <span className="coach-name">Coach</span>
        {mode !== 'off' && (mode !== 'lesson' || lesson) && (
          <span className="coach-key" title={mode === 'lesson' ? "The lesson's key" : key === 'auto' ? 'Key: from what you play' : 'Key: fixed'}>
            {pretty(readout.keyName)}{mode !== 'lesson' && key === 'auto' ? ' · auto' : ''}
          </span>
        )}
        {!kb.enabled && (
          <span className="coach-octave">
            <button className="btn-icon" title="Octave down" onClick={() => setOctave(kb.octave - 1)}><ChevronLeft size={13} /></button>
            <span className="kb-value">C{kb.octave}</span>
            <button className="btn-icon" title="Octave up" onClick={() => setOctave(kb.octave + 1)}><ChevronRight size={13} /></button>
            <button className="btn-icon coach-kb-on" title="Play from the computer keyboard" onClick={() => setKeyboardEnabled(true)}>⌨</button>
          </span>
        )}
        <button className={`btn-icon ${kb.enabled ? 'kb-close' : ''}`} title="Close the coach" onClick={() => setCoachOpen(false)}><X size={13} /></button>
      </div>

      <div className="kb-segment coach-modes">
        {MODES.map(([m, label, title]) => (
          <button key={m} className={mode === m ? 'active' : ''} title={title} onClick={() => setCoachMode(m)}>{label}</button>
        ))}
      </div>

      {mode === 'lesson' ? (
        <div className="kb-row">
          <select className="rack-map-select coach-select" value={coach.lesson ?? ''} title={about}
            onChange={(e) => setCoachLesson(e.target.value || null)}>
            <option value="">Pick a lesson…</option>
            {LESSON_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.lessons.map((l) => <option key={l.id} value={l.id}>{pretty(l.name)}</option>)}
              </optgroup>
            ))}
          </select>
          {lesson && <button className="btn-metronome coach-restart" title="Start the lesson again" onClick={restartLesson}><RotateCcw size={11} /> Restart</button>}
        </div>
      ) : mode !== 'off' && (
        <div className="kb-row">
          <span className="kb-label">Key</span>
          <select className="rack-map-select coach-select" value={keyIndex} title="The key suggestions are in"
            onChange={(e) => setCoachKey(e.target.value === 'auto' ? 'auto' : ALL_KEYS[Number(e.target.value)])}>
            <option value="auto">Auto</option>
            {(['major', 'minor'] as const).map((m) => (
              <optgroup key={m} label={m === 'major' ? 'Major' : 'Minor'}>
                {ALL_KEYS.map((k, i) => k.mode === m && <option key={i} value={i}>{pretty(keyName(k))}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
      )}

      <div className={`coach-readout ${lesson?.done ? 'done' : ''}`}>
        {lesson && (lesson.done ? (
          <div className="coach-progress"><Check size={12} /> <b>Done!</b> {pretty(lesson.name)}, all {lesson.total} steps</div>
        ) : (
          <div className="coach-progress">
            <b>Step {lesson.step + 1} / {lesson.total}</b> {pretty(lesson.label)}
            <div className="coach-progress-bar"><div style={{ width: `${(lesson.step / lesson.total) * 100}%` }} /></div>
          </div>
        ))}
        <div className="coach-message">
          {mode === 'off'
            ? (readout.chord ? <b>{pretty(`${readout.chord.name} (${readout.roman})`)}</b> : <span className="coach-muted">Pick a mode to see what to play next</span>)
            : lesson?.done ? <span className="coach-muted">Restart, or pick another lesson</span>
            : <Message text={readout.message} />}
        </div>
        {lesson && !lesson.done && about && <div className="coach-about">{pretty(about)}</div>}
        {(mode === 'chords' || mode === 'melody' || mode === 'complement') && readout.suggestions.length > 0 && (
          <div className="coach-chips" onMouseLeave={() => setCoachFocus(null)}>
            {readout.suggestions.map((s, i) => (
              // Chords keep their numeral; a note's reason is in the message
              <span key={i} className={`coach-chip ${mode}`} onMouseEnter={() => setCoachFocus(i)}
                title={`${pretty(s.label)}: ${Math.round(s.weight * 100)}%`}>
                {pretty(mode === 'chords' ? s.label : s.label.replace(/ \(.*\)$/, ''))}
                <i style={{ width: `${(s.weight / strongest) * 100}%` }} />
              </span>
            ))}
          </div>
        )}
        {!onPiano && mode !== 'off' && (
          <div className="coach-muted">
            The keys light up on the piano: <button className="coach-link" onClick={() => setKeyboardMode('piano')}>switch to Piano</button>
          </div>
        )}
      </div>
    </div>
  );
}
