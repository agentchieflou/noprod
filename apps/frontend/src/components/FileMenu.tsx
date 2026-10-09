import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useDAWStore, isProjectDirty, PROJECT_KEYS } from '../store/useDAWStore';
import { serializeProject, deserializeProject } from '../project/projectFile';
import { writeAutosave, readAutosave, clearAutosave, type AutosaveRecord } from '../project/autosave';
import { audioContext } from '../audio/engine';
import { setPosition } from '../audio/transport';

const EXT = '.noprod';
const AUTOSAVE_MS = 20000;
const PICKER_TYPES = [{ description: 'NoProd project', accept: { 'application/x-noprod': [EXT] } }];

// The file handle of the open project, so Save writes back in place
// (File System Access API; other browsers download a copy instead).
let fileHandle: any = null;

const baseName = (n: string) => n.replace(/\.noprod$/i, '');

// File menu: New / Open / Save / Save As / Import ALS, Ctrl+S / Ctrl+Shift+S /
// Ctrl+O, the unsaved-changes dot, a close-tab warning, and autosave with
// recovery of the last unsaved project.
export default function FileMenu({ onImportAls }: { onImportAls: () => void }) {
  const projectName = useDAWStore((s: any) => s.projectName);
  const dirty = useDAWStore(isProjectDirty);
  const [open, setOpen] = useState(false);
  const [menuLeft, setMenuLeft] = useState(0);
  const [recovery, setRecovery] = useState<AutosaveRecord | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const flash = (msg: string) => { setStatus(msg); setTimeout(() => setStatus(null), 2500); };

  const confirmDiscard = () => !isProjectDirty(useDAWStore.getState())
    || window.confirm('Discard unsaved changes to the current project?');

  const saveAs = async () => {
    const state = useDAWStore.getState();
    const blob = await serializeProject(state);
    const picker = (window as any).showSaveFilePicker;
    if (picker) {
      try {
        fileHandle = await picker.call(window, { suggestedName: `${state.projectName}${EXT}`, types: PICKER_TYPES });
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        throw err;
      }
      const w = await fileHandle.createWritable();
      await w.write(blob);
      await w.close();
      state.markSaved(baseName(fileHandle.name));
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.projectName}${EXT}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      state.markSaved();
    }
    clearAutosave();
    flash(`Saved ${(blob.size / 1024).toFixed(0)} KB`);
  };

  const save = async () => {
    if (!fileHandle) return saveAs();
    const state = useDAWStore.getState();
    const blob = await serializeProject(state);
    const w = await fileHandle.createWritable();
    await w.write(blob);
    await w.close();
    state.markSaved();
    clearAutosave();
    flash(`Saved ${(blob.size / 1024).toFixed(0)} KB`);
  };

  const loadBlob = async (blob: Blob, name: string) => {
    const project = await deserializeProject(blob, audioContext);
    useDAWStore.getState().loadProject(project, name);
    setPosition(0);
  };

  const openProject = async () => {
    if (!confirmDiscard()) return;
    const picker = (window as any).showOpenFilePicker;
    if (!picker) { inputRef.current?.click(); return; }
    try {
      const [handle] = await picker.call(window, { types: PICKER_TYPES });
      const file = await handle.getFile();
      await loadBlob(file, baseName(file.name));
      fileHandle = handle;
      clearAutosave();
      flash(`Opened ${file.name}`);
    } catch (err: any) {
      if (err?.name !== 'AbortError') alert(`Could not open project: ${err.message || err}`);
    }
  };

  const newProject = () => {
    if (!confirmDiscard()) return;
    fileHandle = null;
    useDAWStore.getState().newProject();
    setPosition(0);
    clearAutosave();
  };

  const run = (fn: () => unknown) => async () => {
    setOpen(false);
    try { await fn(); } catch (err: any) { alert(`${err.message || err}`); }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); run(e.shiftKey ? saveAs : save)(); }
      else if (k === 'o') { e.preventDefault(); run(openProject)(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Close the menu on outside clicks
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  // Warn before closing the tab with unsaved changes
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (isProjectDirty(useDAWStore.getState())) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  // Autosave unsaved work; offer to restore it on the next launch
  useEffect(() => {
    readAutosave().then((rec) => { if (rec) setRecovery(rec); });
    let version = 0;
    let savedVersion = 0;
    const unsub = useDAWStore.subscribe((st: any, prev: any) => {
      if (PROJECT_KEYS.some((k) => st[k] !== prev[k])) version++;
    });
    const timer = setInterval(async () => {
      const st = useDAWStore.getState();
      if (!isProjectDirty(st) || st.isPlaying || version === savedVersion) return;
      savedVersion = version;
      try {
        await writeAutosave({ blob: await serializeProject(st), name: st.projectName, savedAt: Date.now() });
      } catch { /* storage unavailable or full: recovery just isn't offered */ }
    }, AUTOSAVE_MS);
    return () => { clearInterval(timer); unsub(); };
  }, []);

  return (
    <div className="file-menu" ref={menuRef}>
      <button
        className="btn-metronome file-menu-btn"
        onClick={(e) => {
          // the transport bar scrolls horizontally, so the menu is fixed-positioned
          setMenuLeft((e.currentTarget as HTMLElement).getBoundingClientRect().left);
          setOpen(!open);
        }} title={`${projectName}${dirty ? ' (unsaved changes)' : ''}`}>
        <span className="project-name">{projectName}</span>
        {dirty && <span className="dirty-dot" title="Unsaved changes">●</span>}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="file-menu-list" style={{ left: menuLeft }}>
          <button onClick={run(newProject)}>New Project</button>
          <button onClick={run(openProject)}>Open… <kbd>Ctrl+O</kbd></button>
          <button onClick={run(save)}>Save <kbd>Ctrl+S</kbd></button>
          <button onClick={run(saveAs)}>Save As… <kbd>Ctrl+Shift+S</kbd></button>
          <hr />
          <button onClick={run(onImportAls)}>Import Ableton Set (.als)…</button>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={EXT}
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try { await loadBlob(file, baseName(file.name)); fileHandle = null; flash(`Opened ${file.name}`); }
          catch (err: any) { alert(`Could not open project: ${err.message || err}`); }
        }}
      />
      {status && <div className="file-status">{status}</div>}
      {recovery && (
        <div className="recovery-banner">
          Unsaved project “{recovery.name}” from {new Date(recovery.savedAt).toLocaleString()} was recovered.
          <button className="btn-metronome" onClick={async () => {
            try { await loadBlob(recovery.blob, recovery.name); useDAWStore.setState({ savedSnapshot: null }); }
            catch (err: any) { alert(`Could not restore: ${err.message || err}`); }
            setRecovery(null);
          }}>Restore</button>
          <button className="btn-metronome" onClick={() => { clearAutosave(); setRecovery(null); }}>Discard</button>
        </div>
      )}
    </div>
  );
}
