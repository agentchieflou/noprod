import { useState, useSyncExternalStore } from 'react';
import { AppWindow, ArrowDown, ArrowUp, Plus, Power, RefreshCw, Trash2, Unlink } from 'lucide-react';
import {
  subscribeAudioCore, getAudioCore, refreshAudioCore, scanNativePlugins, loadNativePlugin, pairAudioCore, unpairAudioCore,
  removeNativePlugin, moveNativePlugin, setNativeBypass, setNativeParameter, openNativeEditor, busInserts,
  type NativeInsert, type NativeBusId
} from '../native/audioCore';
import { isHostedPage } from '../native/pairing';

const busName = (bus: NativeBusId) => (bus === 'master' ? 'Master' : `Orbit ${bus}`);

// Native plugin hosting in the Audio Core (GhostDAW): pair with it once
// (the code it prints at launch), scan the plug-in folders on disk, load
// VST3 / AU / LPI plugins onto its master bus or onto a track (one per
// orbit; .orbit(n) in a pattern picks it) and edit their parameters.
export default function AudioCorePanel() {
  const { connected, state, busy, error, needsPairing, pairing, pairingError } = useSyncExternalStore(subscribeAudioCore, getAudioCore);
  const [bus, setBus] = useState<NativeBusId>('master');
  const [code, setCode] = useState('');
  const inserts = busInserts(state, bus);
  const available = state?.availablePlugins ?? [];
  const skipped = state?.skippedPlugins ?? [];
  const busIds: NativeBusId[] = ['master', ...Array.from({ length: state?.trackCount ?? 0 }, (_, i) => i)];
  const scanning = busy === 'scan' || !!state?.scanning;

  return (
    <div className="native-host">
      <div className="native-host-header">
        <h5>Audio Core plug-ins</h5>
        <span className={`native-status ${connected ? 'online' : ''}`}>
          {connected
            ? `● paired · ${state ? `${Math.round(state.sampleRate / 100) / 10} kHz` : '…'}${state?.device?.name ? ` · ${state.device.name}` : ''}`
            : needsPairing ? '○ not paired' : '○ offline'}
        </span>
        {connected && <button className="btn-icon" title="Refresh" onClick={refreshAudioCore}><RefreshCw size={11} /></button>}
        {connected && <button className="btn-icon" title="Forget the pairing (pair again with a new code)" onClick={unpairAudioCore}><Unlink size={11} /></button>}
      </div>

      {!connected && !needsPairing ? (
        <p className="native-hint">
          GhostDAW is a companion app that runs VST3 and other native plug-ins for noprod. It isn't running, or noprod
          can't reach it at the address in Services. Start GhostDAW on this computer and noprod connects on its own.
          {isHostedPage() && <> This page runs on your computer's GhostDAW over localhost: if the browser asks whether
          this site may access devices on your local network, allow it (nothing leaves your machine).</>}
        </p>
      ) : !connected ? (
        <form
          className="native-row native-pairing"
          onSubmit={(e) => { e.preventDefault(); if (code.trim()) pairAudioCore(code); }}
        >
          <span className="native-hint">GhostDAW is running. Enter the pairing code it printed:</span>
          <input
            type="text" className="vst-path-input native-pairing-code" placeholder="XXXX-XXXX" value={code}
            autoComplete="off" spellCheck={false} aria-label="Pairing code"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button type="submit" className="btn-add-track" disabled={pairing || !code.trim()}>{pairing ? 'Pairing…' : 'Pair'}</button>
          {pairingError && <span className="native-error">{pairingError}</span>}
        </form>
      ) : (
        <>
          <div className="native-row">
            <button
              className="btn-add-track"
              disabled={scanning}
              title={`Scan ${state?.scanFolders?.length ? state.scanFolders.join(', ') : 'the plug-in folders'} (ghostdaw --add-scan-folder DIR adds one)`}
              onClick={() => scanNativePlugins()}
            >
              {scanning ? 'Scanning…' : 'Scan Folders in Audio Core'}
            </button>
            <span className="native-hint">
              {available.length} plug-in{available.length === 1 ? '' : 's'} found
              {skipped.length > 0 && <span title={skipped.map((p) => `${p.path}: ${p.reason}`).join('\n')}> · {skipped.length} skipped</span>}
            </span>
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
                <div key={`${p.format}:${p.pluginId}`} className="vst-path-row">
                  <span className="native-plugin-name" title={`${p.pluginId}\n${p.path}`}>
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
