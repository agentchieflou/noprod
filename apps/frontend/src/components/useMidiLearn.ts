import { useDAWStore } from '../store/useDAWStore';
import { targetKey, type MidiTarget } from '../audio/midiTargets';

// Makes controls mappable. Call once per component, then spread the result
// onto the control's element (it replaces className, so pass the control's
// own classes in):
//
//   const learn = useMidiLearn();
//   <input {...learn({ kind: 'master', param: 'volume' }, 'fader-input')} />
//
// Outside learn mode it is just the class name. In learn mode the control
// shows an outline, and clicking it picks it to be bound to the next CC or note.
export function useMidiLearn() {
  const active = useDAWStore((s: any) => s.midiLearn.active);
  const pending = useDAWStore((s: any) => s.midiLearn.pending);
  const mappings = useDAWStore((s: any) => s.midiMappings);
  const setMidiLearn = useDAWStore((s: any) => s.setMidiLearn);

  return (target: MidiTarget, className = '') => {
    if (!active) return { className };
    const key = targetKey(target);
    const mapped = mappings.some((m: any) => targetKey(m.target) === key);
    const pick = (e: { preventDefault: () => void; stopPropagation: () => void }) => { e.preventDefault(); e.stopPropagation(); };
    return {
      className: `${className} midi-mappable${mapped ? ' midi-mapped' : ''}${pending && targetKey(pending) === key ? ' midi-pending' : ''}`.trim(),
      'data-midi-target': key,
      onMouseDownCapture: pick,
      onPointerDownCapture: pick,
      onClickCapture: (e: { preventDefault: () => void; stopPropagation: () => void }) => { pick(e); setMidiLearn({ pending: target }); },
      onDoubleClickCapture: pick
    };
  };
}
