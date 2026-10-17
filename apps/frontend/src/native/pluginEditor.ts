// The plug-in editor the Audio Core has open, if any (#44 B6). Opened from an
// Audio Core insert (audioCore.ts) or a browser track's native device
// (trackBridge.ts); PluginEditorWindow shows it, streamed from GhostDAW's
// editor server. The Audio Core keeps one editor open at a time.

export interface OpenPluginEditor {
  editorId: string;
  slotId: string;
  name: string;
  url: string;     // the editor stream (apps/audio_core/src/host/editor/EditorStream.h), with the pairing token
  width: number;   // frame size in pixels
  height: number;
  scale: number;   // frame pixels per CSS pixel
  keyboard: boolean; // the editor takes keys while focused (lpi.gui.keyboard.v1)
  close: () => void; // asks the Audio Core to close it
}

import { serviceHost } from './services';
import { withPairingToken } from './pairing';

let current: OpenPluginEditor | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const subscribePluginEditor = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getPluginEditor = () => current;

// An editor stream's port is a plain unprivileged port number
export const isEditorPort = (port: unknown): port is number => Number.isInteger(port) && (port as number) >= 1024 && (port as number) <= 65535;

// From an EDITOR_OPENED message. `fromGhostDaw`: it arrived over a connected
// GhostDAW link; anything else, or a port out of range, is ignored.
export function showPluginEditor(msg: any, close: () => void, fromGhostDaw: boolean) {
  if (!fromGhostDaw || !isEditorPort(msg?.port)) {
    console.warn('Ignoring an editor the Audio Core did not open properly');
    return;
  }
  current = {
    editorId: msg.editorId, slotId: msg.slotId, name: msg.name,
    url: withPairingToken(`ws://${serviceHost('ghostdaw')}:${msg.port}`),
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
