import { useSyncExternalStore } from 'react';
import { useDAWStore, RETURN_LETTERS } from '../store/useDAWStore';
import {
  getAudioInputDevices, getMidiDevices, onInputsChange, initMidi, refreshAudioDevices
} from '../audio/inputs';

// Re-render when devices appear (permission granted, MIDI plugged in)
let inputsVersion = 0;
onInputsChange(() => { inputsVersion++; });
const useInputsVersion = () => useSyncExternalStore(onInputsChange, () => inputsVersion);

const MIDI_CHANNELS = ['all', ...Array.from({ length: 16 }, (_, i) => String(i + 1))];

// A track's I/O section: input type/device + channel, output target, and
// monitoring (In / Auto / Off). Audio inputs are monitored through the
// track's strip; MIDI input plays the track's instrument.
export default function TrackIO({ track, tracks, returns }: { track: any; tracks: any[]; returns: any[] }) {
  useInputsVersion();
  const { setTrackInput, setTrackMonitor, updateTrackRouting } = useDAWStore();
  const isMidi = track.type === 'midi';
  const isGroup = track.type === 'group';
  const input = track.input || (isMidi ? { type: 'all', channel: 'all' } : { type: 'ext', device: 'default', channel: '1/2' });
  const monitor = track.monitor || 'auto';

  // Groups that can take this track's output (never itself or its own members)
  const groups = tracks.filter((t) => t.type === 'group' && t.id !== track.id && t.groupId !== track.id);
  const output = track.routing && track.routing !== 'master' ? track.routing : track.groupId || 'master';

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div className="track-io" onClick={stop}>
      {!isGroup && (
        <div className="track-io-row">
          <span className="io-label">In</span>
          {isMidi ? (
            <>
              <select className="rack-map-select" value={input.type} onFocus={() => initMidi()}
                onChange={(e) => setTrackInput(track.id, { ...input, type: e.target.value })}>
                <option value="all">All Ins</option>
                <option value="computer">Computer Keyboard</option>
                {getMidiDevices().map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                <option value="none">No Input</option>
              </select>
              <select className="rack-map-select io-channel" value={input.channel ?? 'all'}
                onChange={(e) => setTrackInput(track.id, { ...input, channel: e.target.value })}>
                {MIDI_CHANNELS.map((c) => <option key={c} value={c}>{c === 'all' ? 'All Ch.' : `Ch. ${c}`}</option>)}
              </select>
            </>
          ) : (
            <>
              <select className="rack-map-select"
                value={input.type === 'ext' ? `ext:${input.device || 'default'}` : 'none'}
                onFocus={() => refreshAudioDevices()}
                onChange={(e) => {
                  const v = e.target.value;
                  setTrackInput(track.id, v === 'none' ? { ...input, type: 'none' } : { ...input, type: 'ext', device: v.slice(4) });
                }}>
                {getAudioInputDevices().map((d) => <option key={d.id} value={`ext:${d.id}`}>Ext. In: {d.label}</option>)}
                <option value="none">No Input</option>
              </select>
              <select className="rack-map-select io-channel" value={input.channel || '1/2'} disabled={input.type !== 'ext'}
                onChange={(e) => setTrackInput(track.id, { ...input, channel: e.target.value })}>
                <option value="1/2">1/2</option>
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </>
          )}
        </div>
      )}
      <div className="track-io-row">
        <span className="io-label">Out</span>
        <select className="rack-map-select" value={output} onChange={(e) => updateTrackRouting(track.id, e.target.value)}>
          <option value="master">Master</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          {returns.map((r, i) => <option key={r.id} value={r.id}>{RETURN_LETTERS[i]} {r.name}</option>)}
        </select>
        {!isGroup && (
          <div className="monitor-switch" title="Monitoring: In = always hear the input, Auto = while armed, Off = never">
            {(['in', 'auto', 'off'] as const).map((m) => (
              <button key={m} className={monitor === m ? 'active' : ''} onClick={() => { if (isMidi) initMidi(); setTrackMonitor(track.id, m); }}>
                {m === 'in' ? 'In' : m === 'auto' ? 'Auto' : 'Off'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
