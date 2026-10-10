import { useState, useSyncExternalStore } from 'react';
import { AppWindow, ArrowDown, ArrowUp, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import {
  subscribeAudioCore, getAudioCore, refreshAudioCore, scanNativePlugins, loadNativePlugin,
  removeNativePlugin, moveNativePlugin, setNativeBypass, setNativeParameter, openNativeEditor, busInserts,
  type NativeInsert, type NativeBusId
} from '../native/audioCore';

const busName = (bus: NativeBusId) => (bus === 'master' ? 'Master' : `Orbit ${bus}`);

// Native plugin hosting in the Audio Core (GhostDAW): scan real plugin
// folders on disk, load VST3 / AU / LPI plugins onto its master bus or onto
// a track (one per Strudel orbit; .orbit(n) in a pattern picks it) and edit
// their parameters.
export default function AudioCorePanel({ scanPaths }: { scanPaths: string[] }) {
  const { connected, state, busy, error } = useSyncExternalStore(subscribeAudioCore, getAudioCore);
  const [bus, setBus] = useState<NativeBusId>('master');
  const inserts = busInserts(state, bus);
  const available = state?.availablePlugins ?? [];
  const busIds: NativeBusId[] = ['master', ...Array.from({ length: state?.trackCount ?? 0 }, (_, i) => i)];

  return (
    <div className="native-host">
      <div className="native-host-header">
        <h5>Audio Core plug-ins</h5>
        <span className={`native-status ${connected ? 'online' : ''}`}>
          {connected
            ? `● connected · ${state ? `${Math.round(state.sampleRate / 100) / 10} kHz` : '…'}${state?.device?.name ? ` · ${state.device.name}` : ''}`
            : '○ offline'}
        </span>
        {connected && <button className="btn-icon" title="Refresh" onClick={refreshAudioCore}><RefreshCw size={11} /></button>}
      </div>

      {!connected ? (
        <p className="native-hint">
          Start the Audio Core (<code>apps/audio_core</code>, GhostDAW) and the Orchestrator to host native plug-ins.
          The Sequencer's patterns play through its master inserts.
        </p>
      ) : (
        <>
          <div className="native-row">
            <button
              className="btn-add-track"
              disabled={busy === 'scan'}
              title={scanPaths.length ? `Scan ${scanPaths.join(', ')} and the default VST3 folders` : 'Scan the default VST3 folders (add folder paths on the left to scan more)'}
              onClick={() => scanNativePlugins(scanPaths)}
            >
              {busy === 'scan' ? 'Scanning…' : 'Scan Folders in Audio Core'}
            </button>
            <span className="native-hint">{available.length} plug-in{available.length === 1 ? '' : 's'} found</span>
          </div>

          <div className="native-row">
            <span className="native-hint">Bus</span>
            <select className="rack-map-select" value={String(bus)} title="Where added plug-ins go. Patterns pick a track with .orbit(n); orbit 1 is the default."
              onChange={(e) => setBus(e.target.value === 'master' ? 'master' : Number(e.target.value))}>
              {busIds.map((id) => {
                const count = busInserts(state, id).length;
                return <option key={String(id)} value={String(id)}>{busName(id)}{count ? ` (${count})` : ''}</option>;
              })}
            </select>
            {state && state.buses.length > 1 && (
              <span className="native-hint">
                In use: {state.buses.filter((b) => b.inserts.length).map((b) => busName(b.bus)).join(', ') || 'none'}
              </span>
            )}
          </div>

          {available.length > 0 && (
            <div className="vst-path-list native-available">
              {available.map((p) => (
                <div key={`${p.format}:${p.path}:${p.pluginId}`} className="vst-path-row">
                  <span className="native-plugin-name" title={p.path}>
                    <b>{p.name}</b>
                    <span className="native-format">{p.format}</span>
                    {p.vendor && <span className="native-vendor">{p.vendor}</span>}
                  </span>
                  <button className="btn-icon" title={`Add to ${busName(bus)}`} disabled={busy === 'load'}
                    onClick={() => loadNativePlugin(p, bus)}>
                    <Plus size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="native-inserts">
            {inserts.length === 0
              ? <div className="native-hint">No inserts on {busName(bus)}. Add a plug-in above.</div>
              : inserts.map((ins, i) => <InsertCard key={ins.slotId} insert={ins} index={i} count={inserts.length} />)}
          </div>
        </>
      )}

      {error && <div className="native-error">{error}</div>}
    </div>
  );
}

function InsertCard({ insert, index, count }: { insert: NativeInsert; index: number; count: number }) {
  return (
    <div className={`native-insert ${insert.bypassed ? 'bypassed' : ''}`}>
      <div className="native-insert-header">
        <button className={`btn-icon ${insert.bypassed ? '' : 'native-on'}`} title={insert.bypassed ? 'Turn on' : 'Bypass'}
          onClick={() => setNativeBypass(insert.slotId, !insert.bypassed)}>
          <Power size={11} />
        </button>
        <span className="native-insert-name" title={insert.path}>{insert.name}</span>
        <span className="native-format">{insert.format}</span>
        {insert.latencySamples > 0 && <span className="native-vendor">{insert.latencySamples} smp</span>}
        {insert.hasEditor && (
          <button className={`btn-icon ${insert.editorOpen ? 'native-on' : ''}`} title="Open the plug-in's editor"
            onClick={() => openNativeEditor(insert.slotId)}><AppWindow size={11} /></button>
        )}
        <button className="btn-icon" title="Move up" disabled={index === 0} onClick={() => moveNativePlugin(insert.slotId, index - 1)}><ArrowUp size={11} /></button>
        <button className="btn-icon" title="Move down" disabled={index === count - 1} onClick={() => moveNativePlugin(insert.slotId, index + 1)}><ArrowDown size={11} /></button>
        <button className="btn-icon" title="Remove" onClick={() => removeNativePlugin(insert.slotId)}><Trash2 size={11} /></button>
      </div>
      <div className="native-params">
        {insert.parameters.length === 0 && <div className="native-hint">No parameters</div>}
        {insert.parameters.map((p) => (
          <div key={p.index} className="param-slider-row" title={p.id || p.name}>
            <span className="param-name">{p.name}</span>
            {p.boolean ? (
              <input type="checkbox" checked={p.value >= (p.min + p.max) / 2} disabled={p.readOnly}
                onChange={(e) => setNativeParameter(insert.slotId, p.index, e.target.checked ? p.max : p.min)} />
            ) : (
              <input type="range" className="param-slider" min={p.min} max={p.max} disabled={p.readOnly}
                step={p.stepped && p.max - p.min >= 1 ? 1 : (p.max - p.min) / 1000}
                value={p.value}
                onChange={(e) => setNativeParameter(insert.slotId, p.index, parseFloat(e.target.value))} />
            )}
            <span className="param-value">{p.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
