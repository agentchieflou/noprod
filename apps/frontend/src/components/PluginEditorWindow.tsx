import { useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import PluginEditorCanvas from './PluginEditorCanvas';
import { getPluginEditor, hidePluginEditor, subscribePluginEditor } from '../native/pluginEditor';

// The plug-in editor the Audio Core has open (#44 B6), streamed into a
// floating window over the DAW. Drag it by its title bar. It closes when
// the editor goes away in the Audio Core (its plug-in removed, another
// editor opened) or when closed here.
export default function PluginEditorWindow() {
  const editor = useSyncExternalStore(subscribePluginEditor, getPluginEditor);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);

  if (!editor) return null;

  const close = () => {
    editor.close();
    hidePluginEditor(editor.editorId);
  };

  return (
    <div className="plugin-editor-window" role="dialog" aria-label={`${editor.name} editor`}
      style={{ transform: `translate(calc(-50% + ${offset.x}px), ${offset.y}px)` }}>
      <div className="plugin-editor-titlebar"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, from: offset };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setOffset({ x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y });
        }}
        onPointerUp={() => { drag.current = null; }}>
        <span className="plugin-editor-title">{editor.name}</span>
        <button className="btn-icon" title="Close editor" onClick={close}><X size={14} /></button>
      </div>
      <PluginEditorCanvas
        key={editor.editorId}
        className="plugin-editor-canvas"
        url={editor.url}
        editorId={editor.editorId}
        width={editor.width}
        height={editor.height}
        style={{ width: editor.width / editor.scale }}
        onClosed={() => hidePluginEditor(editor.editorId)}
      />
    </div>
  );
}
