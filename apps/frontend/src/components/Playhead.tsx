import { useSyncExternalStore } from 'react';
import { PIXELS_PER_SECOND } from '../audio/timeline';
import { subscribePlayhead, getPlayhead } from './playhead';

// The arrangement's playhead line
export default function Playhead() {
  const position = useSyncExternalStore(subscribePlayhead, getPlayhead);
  return <div className="playhead" style={{ left: `${position * PIXELS_PER_SECOND}px` }} />;
}
