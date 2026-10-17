import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown } from 'lucide-react';
import { useDAWStore, isProjectDirty, PROJECT_KEYS } from '../store/useDAWStore';
import { serializeProject, deserializeProject, reviveProject } from '../project/projectFile';
import {
  writeAutosave, clearAutosave, startProject, listRecoveryCopies, readRecoveryCopy, adoptRecoveryCopy, dropRecoveryCopy,
  type RecoveryCopy
} from '../project/autosave';
import { subscribeStorageIssue, getStorageIssue, reportStorageError, clearStorageIssue, requestPersistence } from '../project/storage';
import { exportUserSounds, importUserSounds } from '../audio/userSounds';
import { audioContext } from '../audio/engine';
import { setPosition } from '../audio/transport';

const EXT = '.noprod';
// Autosave once edits pause for a moment, and at least this often while they don't
const AUTOSAVE_QUIET_MS = 1500;
const AUTOSAVE_MAX_MS = 10000;
const PICKER_TYPES = [{ description: 'NoProd project', accept: { 'application/x-noprod': [EXT] } }];

// The file handle of the open project, so Save writes back in place
// (File System Access API; other browsers download a copy instead).
let fileHandle: any = null;
const forgetFileHandle = () => { fileHandle = null; };

const baseName = (n: string) => n.replace(/\.noprod$/i, '');
// A project name as a file name (no path separators or reserved characters)
const fileName = (name: string, ext: string) => `${name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\p{Cc}+/gu, '').trim() || 'Untitled'}${ext}`;

const sizeOf = (blob: Blob) => (blob.size < 1 << 20 ? `${(blob.size / 1024).toFixed(0)} KB` : `${(blob.size / (1 << 20)).toFixed(1)} MB`);

const download = (blob: Blob, name: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// File menu: New / Open / Save / Save As / Import ALS, Ctrl+S / Ctrl+Shift+S /
// Ctrl+O, the unsaved-changes dot, a close-tab warning, autosave with
// recovery of unsaved projects, storage problems, and My Sounds export/import.
export default function FileMenu({ onImportAls }: { onImportAls: () => void }) {
  const projectName = useDAWStore((s: any) => s.projectName);
  const dirty = useDAWStore(isProjectDirty);
  const [open, setOpen] = useState(false);
  const [menuLeft, setMenuLeft] = useState(0);
  const [recovery, setRecovery] = useState<RecoveryCopy[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const storageIssue = useSyncExternalStore(subscribeStorageIssue, getStorageIssue);
  const inputRef = useRef<HTMLInputElement>(null);
  const soundsInputRef = useRef<HTMLInputElement>(null);
  const canSaveInPlace = !!(window as any).showSaveFilePicker;
  const menuRef = useRef<HTMLDivElement>(null);

  const flash = (msg: string, ms = 2500) => { setStatus(msg); setTimeout(() => setStatus(null), ms); };

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
      // No File System Access (Firefox, Safari): every Save is a download
      const name = fileName(state.projectName, EXT);
      download(blob, name);
      state.markSaved();
      clearAutosave();
      flash(`Downloaded “${name}” (${sizeOf(blob)}): this browser saves a new copy to your downloads each time`, 6000);
      return;
    }
    clearAutosave();
    flash(`Saved ${sizeOf(blob)}`);
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
    flash(`Saved ${sizeOf(blob)}`);
  };

  const loadBlob = async (blob: Blob, name: string) => {
    const project = await deserializeProject(blob, audioContext);
    clearAutosave();
    startProject();
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
      flash(`Opened ${file.name}`);
    } catch (err: any) {
      if (err?.name !== 'AbortError') alert(`Could not open project: ${err.message || err}`);
    }
  };

  const newProject = () => {
    if (!confirmDiscard()) return;
    fileHandle = null;
    clearAutosave();
    startProject();
    useDAWStore.getState().newProject();
    setPosition(0);
  };

  const restore = async (copy: RecoveryCopy) => {
    if (!confirmDiscard()) return;
    try {
      const { doc, pcm } = await readRecoveryCopy(copy);
      forgetFileHandle();
      clearAutosave();
      useDAWStore.getState().loadProject(reviveProject(doc, pcm, audioContext), copy.name);
      useDAWStore.setState({ savedSnapshot: null });
      setPosition(0);
      await adoptRecoveryCopy(copy, useDAWStore.getState());
      setRecovery((list) => list.filter((c) => c.key !== copy.key));
      flash(`Restored “${copy.name}”`);
    } catch (err: any) {
      alert(`Could not restore “${copy.name}”: ${err.message || err}`);
    }
  };

  const discard = (copy: RecoveryCopy) => {
    dropRecoveryCopy(copy.key);
    setRecovery((list) => list.filter((c) => c.key !== copy.key));
  };

  const exportSounds = () => {
    const { blob, count } = exportUserSounds();
    if (!count) { flash('My Sounds is empty: save a sound from the Sound Designer first'); return; }
    download(blob, 'My Sounds.noprod-sounds.json');
    flash(`Downloaded ${count} of My Sounds`);
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

  // Autosave unsaved work shortly after each change, playing or not (a take
  // lands in the project when recording stops); offer recovery copies on launch
  useEffect(() => {
    listRecoveryCopies().then(setRecovery, (err) => reportStorageError('Recovery', err));
    let timer: ReturnType<typeof setTimeout> | null = null;
    let firstChange = 0;
    const flush = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      firstChange = 0;
      const st = useDAWStore.getState();
      if (!isProjectDirty(st)) return;
      try {
        await writeAutosave(st);
        clearStorageIssue('Autosave');
        requestPersistence();
      } catch (err) {
        reportStorageError('Autosave', err);
      }
    };
    const unsub = useDAWStore.subscribe((st: any, prev: any) => {
      if (!PROJECT_KEYS.some((k) => st[k] !== prev[k]) && st.savedSnapshot === prev.savedSnapshot) return;
      const now = Date.now();
      if (!firstChange) firstChange = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, Math.min(AUTOSAVE_QUIET_MS, Math.max(0, firstChange + AUTOSAVE_MAX_MS - now)));
    });
    // A tab going away saves what it has (best effort: the timer may not get to run)
    const onHide = () => { if (document.visibilityState === 'hidden' && timer) flush(); };
    document.addEventListener('visibilitychange', onHide);
    return () => { if (timer) clearTimeout(timer); unsub(); document.removeEventListener('visibilitychange', onHide); };
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
          <button onClick={run(save)} title={canSaveInPlace ? undefined : 'This browser saves by downloading a new copy each time'}>
            {canSaveInPlace ? 'Save' : 'Save (download)'} <kbd>Ctrl+S</kbd>
          </button>
          <button onClick={run(saveAs)}>{canSaveInPlace ? 'Save As…' : 'Save As… (download)'} <kbd>Ctrl+Shift+S</kbd></button>
          <hr />
          <button onClick={run(onImportAls)}>Import Ableton Set (.als)…</button>
          <hr />
          <button onClick={run(exportSounds)}>Export My Sounds…</button>
          <button onClick={() => { setOpen(false); soundsInputRef.current?.click(); }}>Import My Sounds…</button>
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
      <input
        ref={soundsInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try { flash(`Imported ${await importUserSounds(file)} sounds into My Sounds`); }
          catch (err: any) { alert(`Could not import sounds: ${err.message || err}`); }
        }}
      />
      {status && <div className="file-status">{status}</div>}
      {(storageIssue || recovery.length > 0) && (
        <div className="file-banners">
          {storageIssue && (
            <div className="recovery-banner storage-banner" role="alert">
              {storageIssue.message}. Save your project to a file to keep it.
              <button className="btn-metronome" onClick={() => clearStorageIssue()}>Dismiss</button>
            </div>
          )}
          {recovery.map((copy) => (
            <div className="recovery-banner" key={copy.key}>
              Unsaved project “{copy.name}” from {new Date(copy.savedAt).toLocaleString()} can be recovered.
              <button className="btn-metronome" onClick={() => restore(copy)}>Restore</button>
              <button className="btn-metronome" onClick={() => discard(copy)}>Discard</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
