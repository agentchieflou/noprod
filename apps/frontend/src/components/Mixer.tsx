import { useEffect, useRef } from 'react';
import { useDAWStore, RETURN_LETTERS, MASTER_STRIP_ID } from '../store/useDAWStore';
import { flattenDevices, MASTER_ID, masterLoudness } from '../audio/engine';
import {
  FADER_MAX, faderToGain, gainToFader, formatDb, toDb, clearClip, drawMeter, drawLoudness,
  type MeterView, type LoudnessView
} from './mixerMeter';

type Views = Map<string, { canvas: HTMLCanvasElement | null; clip: HTMLElement | null; readout: HTMLElement | null }>;

interface StripProps {
  id: string;                  // track / return id, or MASTER_ID
  kind: 'track' | 'return' | 'master';
  item: any;
  index: number;               // return letter
  tracks: any[];
  returns: any[];
  views: Views;
  onOpenDevices: (stripId: string) => void;
}

const Strip = ({ id, kind, item, index, tracks, returns, views, onOpenDevices }: StripProps) => {
  // Actions are read when used, so a strip re-renders for its own data only
  const act = () => useDAWStore.getState();
  const isTrack = kind === 'track';
  const isGroup = item.type === 'group';
  const group = isTrack && item.groupId ? tracks.find((t) => t.id === item.groupId) : null;
  const members = isGroup ? tracks.filter((t) => t.groupId === item.id) : [];
  const devices = flattenDevices(item.plugins || []);
  const setVolume = (v: number) => (isTrack ? act().updateTrackVolume(id, v) : kind === 'return' ? act().updateReturn(id, { volume: v }) : act().setMasterVolume(v));
  const setPan = (v: number) => (isTrack ? act().updateTrackPan(id, v) : kind === 'return' ? act().updateReturn(id, { pan: v }) : act().setMasterPan(v));
  const gain = item.volume ?? 0;
  const pan = item.pan ?? 0;
  const output = item.routing && item.routing !== 'master' ? item.routing : item.groupId || 'master';
  const outGroups = tracks.filter((t) => t.type === 'group' && t.id !== id && t.groupId !== id);
  const title = kind === 'return' ? `${RETURN_LETTERS[index]} ${item.name}` : item.name;

  return (
    <div className={`mx-strip mx-${kind}`} data-strip={id} style={group ? { borderTopColor: group.color } : undefined}>
      <div className="mx-name" style={{ borderBottomColor: item.color || '#888' }} title={title}>
        {members.length > 0 && (
          <span className="mx-members">
            {members.map((m) => <i key={m.id} style={{ background: m.color }} title={m.name} />)}
          </span>
        )}
        <span className="mx-title">{title}</span>
      </div>

      <div className="mx-devices">
        {devices.length === 0 && <span className="mx-none">no inserts</span>}
        {devices.map((d: any) => (
          <button key={d.id} className="mx-device" title={`Open ${d.name} in the Device Chain`}
            onClick={() => onOpenDevices(kind === 'master' ? MASTER_STRIP_ID : id)}>{d.name}</button>
        ))}
      </div>

      {isTrack && returns.length > 0 && (
        <div className="mx-sends">
          {returns.map((r, i) => (
            <label key={r.id} title={`Send to ${r.name}`}>
              <span>{RETURN_LETTERS[i]}</span>
              <input type="range" min="0" max="1" step="0.01" className="mx-send" data-send={r.id}
                value={item.sends?.[r.id] ?? 0}
                onChange={(e) => act().updateTrackSend(id, r.id, parseFloat(e.target.value))}
                onDoubleClick={() => act().updateTrackSend(id, r.id, 0)} />
            </label>
          ))}
        </div>
      )}

      <input type="range" min="-1" max="1" step="0.01" className="mx-pan" title={`Pan ${pan.toFixed(2)} (double-click: centre)`}
        value={pan} onChange={(e) => setPan(parseFloat(e.target.value))} onDoubleClick={() => setPan(0)} />

      <div className="mx-buttons">
        {kind !== 'master' && (
          <button className={`mx-btn mx-mute ${item.isMuted ? 'on' : ''}`} title="Mute"
            onClick={() => (isTrack ? act().toggleMuteTrack(id) : act().updateReturn(id, { isMuted: !item.isMuted }))}>M</button>
        )}
        {isTrack && (
          <>
            <button className={`mx-btn mx-solo ${item.isSoloed ? 'on' : ''}`} title="Solo" onClick={() => act().toggleSoloTrack(id)}>S</button>
            {!isGroup && <button className={`mx-btn mx-arm ${item.isArmed ? 'on' : ''}`} title="Arm for recording" onClick={() => act().toggleArmTrack(id)}>●</button>}
          </>
        )}
      </div>

      {isTrack ? (
        <select className="rack-map-select mx-out" title="Output" value={output} onChange={(e) => act().updateTrackRouting(id, e.target.value)}>
          <option value="master">Master</option>
          {outGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          {returns.map((r, i) => <option key={r.id} value={r.id}>{RETURN_LETTERS[i]} {r.name}</option>)}
        </select>
      ) : (
        <span className="mx-out mx-static">{kind === 'master' ? 'Out' : 'Master'}</span>
      )}

      <div className="mx-fader-meter">
        <input type="range" className="mx-fader" min="0" max={FADER_MAX} step="1"
          title="Volume (double-click: 0 dB)"
          value={gainToFader(gain)}
          onChange={(e) => setVolume(faderToGain(parseInt(e.target.value)))}
          onDoubleClick={() => setVolume(1)} />
        <canvas className="mx-meter" data-meter={id}
          ref={(el) => {
            const v = views.get(id) ?? { canvas: null, clip: null, readout: null };
            v.canvas = el;
            views.set(id, v);
          }} />
      </div>
      <div className="mx-foot">
        <span className="mx-db" title="Fader level (dB)">{formatDb(toDb(gain))}</span>
        <span className="mx-peak" title="Peak hold (dB)"
          ref={(el) => { const v = views.get(id); if (v) v.readout = el; }}>-∞</span>
        <button className="mx-clip" title="Clipped: click to clear"
          ref={(el) => { const v = views.get(id); if (v) v.clip = el; }}
          onClick={() => { clearClip(id); views.get(id)?.clip?.classList.remove('lit'); }} />
      </div>
    </div>
  );
};

// The master's loudness readout, in BS.1770-4: momentary and short-term
// LUFS, integrated LUFS, and true peak
const Loudness = ({ view }: { view: React.MutableRefObject<LoudnessView> }) => {
  const cell = (key: keyof LoudnessView, label: string, unit: string) => (
    <div className="mx-lufs-cell" title={label}>
      <span className="mx-lufs-label">{label}</span>
      <span className="mx-lufs-value" data-lufs={key} ref={(el) => { view.current[key] = el; }}>-∞</span>
      <span className="mx-lufs-unit">{unit}</span>
    </div>
  );
  return (
    <div className="mx-loudness">
      {cell('momentary', 'Momentary', 'LUFS')}
      {cell('shortTerm', 'Short-term', 'LUFS')}
      {cell('integrated', 'Integrated', 'LUFS')}
      {cell('truePeak', 'True peak', 'dBTP')}
      <button className="mx-reset" title="Reset the integrated loudness and true peak" onClick={() => masterLoudness.reset()}>Reset</button>
    </div>
  );
};

// One channel strip per track, then the returns, then the master. The meters
// draw in a requestAnimationFrame loop that lives only while the Mixer is on
// screen; nothing about them is in the store or React state.
export default function Mixer({ onOpenDevices }: { onOpenDevices: () => void }) {
  const tracks = useDAWStore((s) => s.tracks);
  const returns = useDAWStore((s) => s.returns);
  const masterPlugins = useDAWStore((s) => s.masterPlugins);
  const masterVolume = useDAWStore((s) => s.masterVolume);
  const masterPan = useDAWStore((s) => s.masterPan);
  const views = useRef<Views>(new Map()).current;
  const loudness = useRef<LoudnessView>({ momentary: null, shortTerm: null, integrated: null, truePeak: null });

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      views.forEach((v, id) => { if (v.canvas?.isConnected) drawMeter({ id, ...v } as MeterView, now / 1000, dt); else if (!v.canvas) views.delete(id); });
      drawLoudness(loudness.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [views]);

  const open = (stripId: string) => { useDAWStore.getState().setSelectedTrackId(stripId); onOpenDevices(); };
  const master = { id: MASTER_ID, name: 'Master', color: '#e5e7eb', plugins: masterPlugins, volume: masterVolume, pan: masterPan };
  const common = { tracks, returns, views, onOpenDevices: open };

  return (
    <div className="mixer-view">
      {tracks.map((t: any) => <Strip key={t.id} id={t.id} kind="track" item={t} index={0} {...common} />)}
      {returns.map((r: any, i: number) => <Strip key={r.id} id={r.id} kind="return" item={r} index={i} {...common} />)}
      <div className="mx-master-col">
        <Strip id={MASTER_ID} kind="master" item={master} index={0} {...common} />
        <Loudness view={loudness} />
      </div>
    </div>
  );
}
