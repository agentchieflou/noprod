import { useState, useSyncExternalStore, type DragEvent } from 'react';
import { Play, Square, Plus, Trash2 } from 'lucide-react';
import { useDAWStore } from '../store/useDAWStore';
import {
  subscribeSession, getSessionSnapshot, launchClip, launchScene, stopTrack, stopAll, backToArrangement
} from '../audio/session';

const FOLLOW_ACTIONS: [string, string][] = [
  ['next', 'Next scene'], ['previous', 'Previous scene'], ['first', 'First scene'],
  ['random', 'Random scene'], ['again', 'Play again'], ['stop', 'Stop']
];

interface Props {
  tracks: any[];
  onDropFile: (e: DragEvent<HTMLDivElement>, trackId: string, slot: number) => void;
  onOpenClip: () => void;
}

// Session View: a clip-launcher grid (tracks x scenes) with quantized launch,
// per-track stop, and a scene column whose scenes can be named and given a
// tempo / time-signature override and a follow action.
export default function SessionView({ tracks, onDropFile, onOpenClip }: Props) {
  const {
    scenes, sessionClips, launchQuantization, setLaunchQuantization, addScene, removeScene, updateScene,
    toggleMuteTrack, updateTrackVolume, selectedSessionClip, setSelectedSessionClip, setSelectedRegionId,
    removeSessionClip, createSessionMidiClip
  } = useDAWStore();
  const session = useSyncExternalStore(subscribeSession, getSessionSnapshot);
  const [sceneSel, setSceneSel] = useState<number | null>(null);
  const scene = sceneSel !== null ? scenes[sceneSel] : null;
  const launchTracks = tracks.filter((t) => t.type !== 'group');

  const selectClip = (trackId: string, slot: number) => {
    setSelectedRegionId(null);
    setSelectedSessionClip({ trackId, slot });
  };

  return (
    <div className="session-wrap">
      <div className="session-toolbar">
        <label className="session-quant">
          Launch quantize
          <select className="rack-map-select" value={launchQuantization} onChange={(e) => setLaunchQuantization(e.target.value)}>
            <option value="1 bar">1 Bar</option>
            <option value="1/4">1/4</option>
            <option value="none">None</option>
          </select>
        </label>
        <button className="btn-metronome" onClick={stopAll} title="Stop all clips at the next launch point">
          <Square size={11} style={{ marginRight: 4 }} />Stop All Clips
        </button>
        <button
          className={`btn-metronome ${session.arrangementOverridden ? 'back-to-arr' : ''}`}
          onClick={backToArrangement}
          disabled={!session.arrangementOverridden}
          title="Session clips override their track's arrangement clips; click to hand every track back to the arrangement"
        >
          Back to Arrangement
        </button>
        <button className="btn-metronome" onClick={addScene}><Plus size={11} style={{ marginRight: 4 }} />Scene</button>
      </div>

      {scene && sceneSel !== null && (
        <div className="scene-editor">
          <strong>Scene {sceneSel + 1}</strong>
          <input
            className="clip-name-input" placeholder="Name" value={scene.name}
            onChange={(e) => updateScene(sceneSel, { name: e.target.value })}
          />
          <label>
            <input type="checkbox" checked={!!scene.tempo}
              onChange={(e) => updateScene(sceneSel, { tempo: e.target.checked ? useDAWStore.getState().bpm : null })} />
            Tempo
          </label>
          {scene.tempo ? (
            <input type="number" className="clip-input" min={20} max={999} step={0.01} value={scene.tempo}
              onChange={(e) => updateScene(sceneSel, { tempo: Math.max(20, Math.min(999, parseFloat(e.target.value) || 120)) })} />
          ) : null}
          <label>
            <input type="checkbox" checked={!!scene.signature}
              onChange={(e) => updateScene(sceneSel, { signature: e.target.checked ? { numerator: 4, denominator: 4 } : null })} />
            Signature
          </label>
          {scene.signature && (
            <>
              <input type="number" className="clip-input" min={1} max={32} value={scene.signature.numerator}
                onChange={(e) => updateScene(sceneSel, { signature: { ...scene.signature, numerator: Math.max(1, Math.min(32, parseInt(e.target.value) || 4)) } })} />
              /
              <select className="rack-map-select" value={scene.signature.denominator}
                onChange={(e) => updateScene(sceneSel, { signature: { ...scene.signature, denominator: parseInt(e.target.value) } })}>
                {[1, 2, 4, 8, 16].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </>
          )}
          <label>
            <input type="checkbox" checked={scene.follow.enabled}
              onChange={(e) => updateScene(sceneSel, { follow: { ...scene.follow, enabled: e.target.checked } })} />
            Follow
          </label>
          {scene.follow.enabled && (
            <>
              after
              <input type="number" className="clip-input" min={1} max={256} value={scene.follow.bars}
                onChange={(e) => updateScene(sceneSel, { follow: { ...scene.follow, bars: Math.max(1, parseInt(e.target.value) || 1) } })} />
              bars →
              <select className="rack-map-select" value={scene.follow.action}
                onChange={(e) => updateScene(sceneSel, { follow: { ...scene.follow, action: e.target.value } })}>
                {FOLLOW_ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </>
          )}
          <button className="btn-icon" style={{ marginLeft: 'auto' }} title="Delete scene (later scenes move up)" disabled={scenes.length <= 1}
            onClick={() => { removeScene(sceneSel); setSceneSel(null); }}><Trash2 size={12} /></button>
          <button className="btn-icon" title="Close" onClick={() => setSceneSel(null)}>✕</button>
        </div>
      )}

      <div className="session-view">
        {launchTracks.map((track) => (
          <div key={track.id} className="session-track-column" style={{ borderTop: `4px solid ${track.color}` }}>
            <div className="session-track-header">{track.name}</div>
            {scenes.map((_: any, slot: number) => {
              const clip = sessionClips[track.id]?.[slot];
              const isPlaying = session.playing[track.id] === slot;
              const queued = session.queued[track.id];
              const isQueued = queued === slot;
              const isSelected = selectedSessionClip?.trackId === track.id && selectedSessionClip?.slot === slot;
              return (
                <div
                  key={slot}
                  className={`session-clip-slot ${clip ? 'has-clip' : ''} ${isPlaying ? 'playing' : ''} ${isQueued ? 'queued' : ''} ${isSelected ? 'selected' : ''}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDropFile(e, track.id, slot)}
                  style={{ backgroundColor: clip ? `${track.color}40` : '' }}
                  onClick={() => { if (!clip) stopTrack(track.id); }}
                  onDoubleClick={() => { if (!clip && track.type === 'midi') { createSessionMidiClip(track.id, slot); selectClip(track.id, slot); onOpenClip(); } }}
                  title={clip ? undefined : track.type === 'midi' ? 'Empty: click to stop this track, double-click to create a MIDI clip, or drop audio' : 'Empty: click to stop this track, or drop audio'}
                >
                  {clip ? (
                    <div className="clip-launcher-btn">
                      <button className="session-launch" title="Launch clip" onClick={(e) => { e.stopPropagation(); launchClip(track.id, slot); }}>
                        <Play size={10} fill="#fff" />
                      </button>
                      <span
                        className="session-clip-name"
                        onClick={(e) => { e.stopPropagation(); selectClip(track.id, slot); }}
                        onDoubleClick={(e) => { e.stopPropagation(); selectClip(track.id, slot); onOpenClip(); }}
                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); removeSessionClip(track.id, slot); }}
                        title="Click to select, double-click to edit in Clip View, right-click to delete"
                      >
                        {clip.file}
                      </span>
                    </div>
                  ) : (
                    <Square size={8} className="session-empty-stop" />
                  )}
                </div>
              );
            })}
            <div className="session-track-mixer">
              <button className={`btn-stop-track ${queuedSlot(session, track.id) === null ? 'queued' : ''}`}
                title="Stop this track's clip" onClick={() => stopTrack(track.id)}><Square size={10} /></button>
              <button className={`btn-mute ${track.isMuted ? 'muted' : ''}`} onClick={() => toggleMuteTrack(track.id)}>Activator</button>
              <input
                type="range" min="0" max="1" step="0.01"
                value={track.volume}
                onChange={(e) => updateTrackVolume(track.id, parseFloat(e.target.value))}
                className="session-volume"
              />
            </div>
          </div>
        ))}

        {/* Scene launcher column */}
        <div className="session-track-column scene-launcher">
          <div className="session-track-header">Scenes</div>
          {scenes.map((sc: any, i: number) => (
            <div
              key={sc.id}
              className={`scene-row ${session.playingScene === i ? 'playing' : ''} ${session.queuedScene === i ? 'queued' : ''} ${sceneSel === i ? 'selected' : ''}`}
            >
              <button className="btn-scene-launch" title="Launch scene" onClick={() => launchScene(i)}>
                <Play size={10} fill="currentColor" />
              </button>
              <span className="scene-name" onClick={() => setSceneSel(i)} title="Click to edit this scene">
                {sc.name || `Scene ${i + 1}`}
              </span>
              <span className="scene-badges">
                {sc.tempo ? <span>{Number(sc.tempo).toFixed(0)}</span> : null}
                {sc.signature ? <span>{sc.signature.numerator}/{sc.signature.denominator}</span> : null}
                {sc.follow?.enabled ? <span title={`Follow after ${sc.follow.bars} bars`}>→{sc.follow.bars}</span> : null}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const queuedSlot = (s: { queued: Record<string, number | null> }, trackId: string) =>
  trackId in s.queued ? s.queued[trackId] : undefined;
