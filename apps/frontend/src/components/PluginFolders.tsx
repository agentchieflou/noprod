import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useDAWStore } from '../store/useDAWStore';
import { findNativePlugin, nativeDeviceFor } from '../native/audioCore';
import { notify } from '../notify';
import AudioCorePanel from './AudioCorePanel';
import { LatencyInfo } from './BrowserNotes';
import { canScanFolders, FOLDER_SCAN_REASON } from '../platform/support';

// The VST Folders Scan tab: the project's note of plug-in folders, a scan
// of a folder from the browser, and the Audio Core itself
export default function PluginFolders({ selectedTrack }: { selectedTrack: any }) {
  const { vstScanPaths, addVstScanPath, removeVstScanPath, addDeviceToTrack, scannedPlugins, setScannedPlugins } = useDAWStore();
  const [isScanning, setIsScanning] = useState(false);
  const [newVstPathInput, setNewVstPathInput] = useState('');

  // Add custom path
  const handleAddVstPath = () => {
    if (newVstPathInput.trim()) {
      addVstScanPath(newVstPathInput.trim());
      setNewVstPathInput('');
    }
  };

  // Real plugin folder scan via the File System Access API: the user picks a
  // directory and we enumerate actual plugin binaries inside it.
  const PLUGIN_EXTENSIONS: { [ext: string]: string } = {
    '.vst3': 'VST3', '.dll': 'VST2', '.clap': 'CLAP', '.component': 'AU'
  };

  const scanDirectory = async (dirHandle: any, basePath: string, depth: number, found: any[]) => {
    if (depth > 3) return;
    for await (const entry of dirHandle.values()) {
      const lower = entry.name.toLowerCase();
      const ext = Object.keys(PLUGIN_EXTENSIONS).find(e => lower.endsWith(e));
      if (ext) {
        found.push({
          name: entry.name.replace(/\.(vst3|dll|clap|component)$/i, ''),
          format: PLUGIN_EXTENSIONS[ext],
          path: `${basePath}/${entry.name}`
        });
      } else if (entry.kind === 'directory') {
        await scanDirectory(entry, `${basePath}/${entry.name}`, depth + 1, found);
      }
    }
  };

  const handleScanPluginFolder = async () => {
    const picker = (window as any).showDirectoryPicker;
    if (!picker) return;
    try {
      setIsScanning(true);
      const dirHandle = await picker.call(window, { mode: 'read' });
      const found: any[] = [];
      await scanDirectory(dirHandle, dirHandle.name, 0, found);
      // Merge with already-scanned plugins, de-duplicated by path
      const merged = [...scannedPlugins];
      found.forEach(p => {
        if (!merged.some((m: any) => m.path === p.path)) merged.push(p);
      });
      setScannedPlugins(merged);
      if (found.length === 0) notify(`No plugin files (.vst3/.dll/.clap/.component) found in "${dirHandle.name}".`);
    } catch (err: any) {
      if (err?.name !== 'AbortError') notify(`Scan failed: ${err.message || err}`);
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="plugin-tab-columns">
    <div className="vst-paths-view">
      <h5>Local VST3 Plugin Scan Locations</h5>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
        GhostDAW scans the platform's plug-in folders and the ones in its own settings (<code>ghostdaw --add-scan-folder DIR</code>), never folders a page names.
        The paths here are kept with the project as a note; the button below lists a folder's plug-in files from the browser.
      </p>
      
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <input aria-label="Plug-in folder path" 
          type="text" 
          placeholder="e.g. C:/Program Files/Common Files/VST3" 
          value={newVstPathInput}
          onChange={(e) => setNewVstPathInput(e.target.value)}
          className="vst-path-input"
        />
        <button className="btn-add-track" onClick={handleAddVstPath}>
          Add Path
        </button>
      </div>

      <div className="vst-path-list">
        {vstScanPaths.map((path: string) => (
          <div key={path} className="vst-path-row">
            <span style={{ fontSize: '12px', fontFamily: 'monospace' }}>{path}</span>
            <button className="btn-icon" title="Remove this folder" onClick={() => removeVstScanPath(path)}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      
      {canScanFolders() ? (
        <button
          className="btn-add-track"
          style={{ backgroundColor: 'var(--accent-green)', marginTop: '10px' }}
          onClick={handleScanPluginFolder}
          disabled={isScanning}
        >
          {isScanning ? 'Scanning…' : 'Scan Folder for Plugins…'}
        </button>
      ) : (
        <p className="browser-note" style={{ marginTop: '10px' }}>{FOLDER_SCAN_REASON}</p>
      )}
      <LatencyInfo />

      {scannedPlugins.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <h5>Discovered Plugins ({scannedPlugins.length})</h5>
          <div className="vst-path-list" style={{ maxHeight: '110px' }}>
            {scannedPlugins.map((p: any) => (
              <div key={p.path} className="vst-path-row">
                <span style={{ fontSize: '11px' }}>
                  <b>{p.name}</b>
                  <span style={{ color: 'var(--accent-green)', marginLeft: '6px', fontSize: '9px' }}>{p.format}</span>
                  <span style={{ color: 'var(--text-secondary)', marginLeft: '6px', fontFamily: 'monospace', fontSize: '9px' }}>{p.path}</span>
                </span>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    className="btn-icon"
                    title={selectedTrack ? `Add to ${selectedTrack.name}'s device chain` : 'Select a track first'}
                    onClick={() => {
                      if (!selectedTrack) { notify('Select a track first (click a track header).'); return; }
                      // The browser only knows the path inside the picked folder;
                      // the Audio Core's scan has the full path it loads from
                      const nativePlugin = findNativePlugin(p.name);
                      if (!nativePlugin) { notify(`Scan this folder in the Audio Core (right) to host ${p.name}.`); return; }
                      addDeviceToTrack(selectedTrack.id, nativeDeviceFor(nativePlugin));
                    }}
                  >
                    <Plus size={12} />
                  </button>
                  <button
                    className="btn-icon"
                    title="Remove from list"
                    onClick={() => setScannedPlugins(scannedPlugins.filter((sp: any) => sp.path !== p.path))}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '6px' }}>
            Found by the browser, which only sees the picked folder's contents. To host plug-ins natively,
            add the folder's full path above and scan it in the Audio Core (right).
          </p>
        </div>
      )}
    </div>
    <AudioCorePanel />
    </div>
  );
}
