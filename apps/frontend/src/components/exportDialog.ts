// Whether the Export dialog is open (the File menu opens it; the dialog
// closes itself), for React through useSyncExternalStore
let open = false;
const listeners = new Set<() => void>();
export const subscribeExportDialog = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getExportDialogOpen = () => open;
export function setExportDialogOpen(on: boolean) {
  if (open === on) return;
  open = on;
  listeners.forEach((fn) => fn());
}
