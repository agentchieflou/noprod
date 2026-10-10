// The plug-in editor the Audio Core has open, if any (#44 B6). Opened from an
// Audio Core insert (audioCore.ts) or a browser track's native device
// (trackBridge.ts); PluginEditorWindow shows it, streamed from GhostDAW's
// editor server. The Audio Core keeps one editor open at a time.

export interface OpenPluginEditor {
  editorId: string;
  slotId: string;
  name: string;
  url: string;     // the editor stream (apps/audio_core/src/editor/EditorStream.h)
  width: number;   // frame size in pixels
  height: number;
  scale: number;   // frame pixels per CSS pixel
  keyboard: boolean; // the editor takes keys while focused (lpi.gui.keyboard.v1)
  close: () => void; // asks the Audio Core to close it
}

let current: OpenPluginEditor | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const subscribePluginEditor = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getPluginEditor = () => current;

// From an EDITOR_OPENED message
export function showPluginEditor(msg: any, close: () => void) {
  current = {
    editorId: msg.editorId, slotId: msg.slotId, name: msg.name,
    url: `ws://localhost:${msg.port}`,
    width: msg.width, height: msg.height, scale: msg.scale || 1,
    keyboard: !!msg.keyboard,
    close
  };
  emit();
}

// The editor went away: closed, or replaced by another. With an id, only
// if that one is still the one showing.
export function hidePluginEditor(editorId?: string) {
  if (!current || (editorId && current.editorId !== editorId)) return;
  current = null;
  emit();
}
