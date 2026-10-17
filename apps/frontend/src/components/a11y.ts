import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

// Focus on one of these means the key is for the control, not for a shortcut
const CONTROLS = 'input, select, textarea, button, a[href], summary, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="button"], [data-keyboard-capture]';

export const isControl = (target: EventTarget | null) => target instanceof Element && !!target.closest(CONTROLS);

// Enter on a focused container (not on a control inside it) does what a click does
export const onEnter = (act: () => void) => (e: ReactKeyboardEvent) => {
  if (e.key === 'Enter' && e.target === e.currentTarget) act();
};

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A dialog keeps Tab inside itself while it is open, closes on Escape (when
// it can close), and gives focus back to whatever had it before it opened.
export function useDialogFocus<T extends HTMLElement>(onClose?: () => void, open = true, returnTo?: () => HTMLElement | null) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  const back = useRef(returnTo);
  useEffect(() => { close.current = onClose; back.current = returnTo; });
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (dialog.querySelector<HTMLElement>(TABBABLE) ?? dialog).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && close.current) { e.preventDefault(); close.current(); return; }
      if (e.key !== 'Tab') return;
      const stops = [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.offsetParent !== null);
      if (!stops.length) { e.preventDefault(); return; }
      const first = stops[0], last = stops[stops.length - 1];
      if (!dialog.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      (before?.isConnected ? before : back.current?.())?.focus();
    };
  }, [open]);
  return ref;
}
