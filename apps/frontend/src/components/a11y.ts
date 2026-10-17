import type { KeyboardEvent } from 'react';

// Enter on a focused container (not on a control inside it) does what a click does
export const onEnter = (act: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' && e.target === e.currentTarget) act();
};
