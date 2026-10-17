import { useState, useSyncExternalStore } from 'react';
import { X, ChevronLeft, ChevronRight, RotateCcw, GraduationCap, Check, Music, FilePlus } from 'lucide-react';
import { ACCOMPANY_STYLES, ALL_KEYS, findLesson, findStyle, keyName, sameKey, type CoachMode } from '@noprod/theory';
import {
  subscribeCoach, getCoachState, setCoachOpen, setCoachMode, setCoachKey, setCoachLesson, setCoachLessonFromNotes, restartLesson, getClipLesson, CLIP_LESSON, CLIP_PICK,
  setCoachFocus, pretty, LESSON_GROUPS, progressionsFor, clipBlocker, writeChordsToClip, type ClipSource
} from '../audio/coach';
import { useDAWStore } from '../store/useDAWStore';
import { subscribeKeyboard, getKeyboardState, setKeyboardEnabled, setKeyboardMode, setOctave } from '../audio/computerKeyboard';
import { subscribeAccompany, getAccompanyState, setAccompany, setAccompanyStyle } from '../audio/accompany';

interface MidiRegion { id: string; type: string; file: string; notes?: { pitch: number; start: number; duration: number }[] }

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
  const band = useSyncExternalStore(subscribeAccompany, getAccompanyState);
  const { readout, mode, key } = coach;
  // The clip control: re-render when the selected track changes
  useDAWStore((s: any) => `${s.selectedTrackId}`);
  const [pick, setPick] = useState('played');
  const [withBass, setWithBass] = useState(true);
  const lesson = readout.lesson;
  const about = coach.lesson === CLIP_LESSON ? getClipLesson()?.description : coach.lesson ? findLesson(coach.lesson)?.description : undefined;
  const clip = useDAWStore((s) => s.regions.find((r: MidiRegion) => r.id === s.selectedRegionId && r.type === 'midi' && r.notes?.length));
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
          <select aria-label="Lesson" className="rack-map-select coach-select" value={coach.lesson ?? ''} title={about}
            onChange={(e) => {
              if (e.target.value === CLIP_LESSON) return;   // already the lesson
              if (e.target.value !== CLIP_PICK) return setCoachLesson(e.target.value || null);
              const region = useDAWStore.getState().regions.find((r: MidiRegion) => r.id === useDAWStore.getState().selectedRegionId);
              if (region?.notes?.length) setCoachLessonFromNotes(region.notes, region.file);
            }}>
            <option value="">Pick a lesson…</option>
            {/* The action's value is one the select never holds, so it can be picked again for another clip */}
            <option value={CLIP_PICK} disabled={!clip} title="Play the notes of the MIDI clip selected in the arrangement">From the selected clip</option>
            {coach.lesson === CLIP_LESSON && <option value={CLIP_LESSON}>{pretty(getClipLesson()?.name ?? 'Clip')} (clip)</option>}
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
          <select aria-label="The key suggestions are in" className="rack-map-select coach-select" value={keyIndex} title="The key suggestions are in"
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

      {mode === 'chords' && (
        <div className="kb-row">
          <button className={`btn-metronome coach-accompany ${band.on ? 'active' : ''}`} onClick={() => setAccompany(!band.on)}
            title={band.on ? 'Stop the band' : 'A bass and keys part that follow the chords you play (starts the transport)'}>
            <Music size={11} /> Accompany
          </button>
          <select className="rack-map-select coach-select" value={band.style} title={findStyle(band.style)?.description}
            aria-label="Accompaniment style" onChange={(e) => setAccompanyStyle(e.target.value)}>
            {ACCOMPANY_STYLES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}

      {mode === 'chords' && (() => {
        const source: ClipSource | null = pick === 'played' ? { kind: 'played' } : { kind: 'progression', name: pick };
        const blocked = clipBlocker(source);
        return (
          <div className="kb-row">
            <button className="btn-metronome coach-clip" disabled={!!blocked} onClick={() => writeChordsToClip(source, withBass)}
              title={blocked ?? 'Write the chords as a clip on the selected track, one bar each, from the playhead'}>
              <FilePlus size={11} /> Write to clip
            </button>
            <select className="rack-map-select coach-select" value={pick} aria-label="Chords to write" onChange={(e) => setPick(e.target.value)}>
              <option value="played">What I played</option>
              <optgroup label="A progression">
                {progressionsFor(readout.key).map((p) => <option key={p.name} value={p.name}>{pretty(p.name)}</option>)}
              </optgroup>
            </select>
            <label className="coach-bass" title="Add each chord's root an octave below">
              <input type="checkbox" checked={withBass} onChange={(e) => setWithBass(e.target.checked)} /> Bass
            </label>
          </div>
        );
      })()}

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
