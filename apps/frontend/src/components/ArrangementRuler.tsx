import { useDAWStore } from '../store/useDAWStore';
import { PIXELS_PER_SECOND, barsUntil, beatSeconds, snapToBeat } from '../audio/timeline';

// Track a mouse drag on window until mouseup.
const drag = (onMove: (e: MouseEvent) => void, onUp?: () => void) => {
  const up = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', up);
    onUp?.();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', up);
};

interface Props {
  width: number;
  onSeek: (time: number) => void;
}

// Arrangement ruler: bar numbers (click to jump, double-click to add a
// locator), named locator flags (click to jump, drag to move, double-click to
// rename, right-click to delete), the loop brace (draw, move, resize,
// double-click to toggle) and the punch-in/out strip.
export default function ArrangementRuler({ width, onSeek }: Props) {
  const {
    bpm, isLoopEnabled, loopStart, loopEnd, setLoopRegion, toggleLoop,
    locators, addLocator, updateLocator, removeLocator,
    punchInTime, punchOutTime, isPunchEnabled, setPunchRegion
  } = useDAWStore();

  const bars = barsUntil(bpm, width / PIXELS_PER_SECOND);
  const beat = beatSeconds(bpm);
  const timeAt = (clientX: number, el: Element) => Math.max(0, (clientX - el.getBoundingClientRect().left) / PIXELS_PER_SECOND);

  // ---- loop brace
  const onLoopRowDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const row = e.currentTarget;
    const anchor = snapToBeat(timeAt(e.clientX, row), bpm);
    setLoopRegion(anchor, anchor + beat);
    if (!isLoopEnabled) toggleLoop();
    drag((me) => {
      const t = snapToBeat(timeAt(me.clientX, row), bpm);
      if (t >= anchor) setLoopRegion(anchor, Math.max(anchor + beat, t));
      else setLoopRegion(t, anchor);
    });
  };

  const onBraceDown = (e: React.MouseEvent, mode: 'move' | 'start' | 'end') => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const row = (e.currentTarget as HTMLElement).closest('.ruler-loop-row')!;
    const t0 = timeAt(e.clientX, row);
    const s0 = loopStart, e0 = loopEnd;
    drag((me) => {
      const t = timeAt(me.clientX, row);
      if (mode === 'move') {
        const delta = Math.round((t - t0) / beat) * beat;
        const ns = Math.max(0, s0 + delta);
        setLoopRegion(ns, ns + (e0 - s0));
      } else if (mode === 'start') {
        setLoopRegion(Math.min(snapToBeat(t, bpm), e0 - beat), e0);
      } else {
        setLoopRegion(s0, Math.max(snapToBeat(t, bpm), s0 + beat));
      }
    });
  };

  // ---- locators
  const onLocatorDown = (e: React.MouseEvent, loc: any) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const row = (e.currentTarget as HTMLElement).closest('.ruler-bars')!;
    const x0 = e.clientX;
    let moved = false;
    drag((me) => {
      if (!moved && Math.abs(me.clientX - x0) < 4) return;
      moved = true;
      updateLocator(loc.id, { time: snapToBeat(timeAt(me.clientX, row), bpm) });
    }, () => { if (!moved) onSeek(loc.time); });
  };

  // ---- punch strip (drag to set the punch-in/out region, snapped to beats)
  const onPunchDown = (e: React.MouseEvent) => {
    const row = e.currentTarget;
    const startT = snapToBeat(timeAt(e.clientX, row), bpm);
    setPunchRegion(startT, startT + beat);
    drag((me) => setPunchRegion(startT, Math.max(startT + beat, snapToBeat(timeAt(me.clientX, row), bpm))));
  };

  return (
    <div className="arranger-ruler" style={{ width }} onClick={(e) => e.stopPropagation()}>
      <div
        className="ruler-bars"
        title="Click to move the playhead · double-click to add a locator"
        onClick={(e) => onSeek(timeAt(e.clientX, e.currentTarget))}
        onDoubleClick={(e) => addLocator(snapToBeat(timeAt(e.clientX, e.currentTarget), bpm))}
      >
        {bars.map((b) => (
          <span key={b.index} className="ruler-bar-num" style={{ left: b.time * PIXELS_PER_SECOND }}>{b.index + 1}</span>
        ))}
        {locators.map((loc: any) => (
          <div
            key={loc.id}
            className="ruler-locator"
            style={{ left: loc.time * PIXELS_PER_SECOND }}
            title={`${loc.name} — click to jump, drag to move, double-click to rename, right-click to delete`}
            onMouseDown={(e) => onLocatorDown(e, loc)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              const name = window.prompt('Locator name', loc.name);
              if (name) updateLocator(loc.id, { name });
            }}
            onContextMenu={(e) => { e.preventDefault(); removeLocator(loc.id); }}
          >
            {loc.name}
          </div>
        ))}
      </div>

      <div className="ruler-loop-row" title="Drag to draw the loop region" onMouseDown={onLoopRowDown}>
        <div
          className={`loop-brace ${isLoopEnabled ? 'enabled' : ''}`}
          style={{ left: loopStart * PIXELS_PER_SECOND, width: Math.max(4, (loopEnd - loopStart) * PIXELS_PER_SECOND) }}
          title={`Loop ${isLoopEnabled ? 'on' : 'off'}: ${loopStart.toFixed(2)}s - ${loopEnd.toFixed(2)}s · drag to move, drag edges to resize, double-click to toggle`}
          onMouseDown={(e) => onBraceDown(e, 'move')}
          onDoubleClick={(e) => { e.stopPropagation(); toggleLoop(); }}
        >
          <div className="loop-brace-handle left" onMouseDown={(e) => onBraceDown(e, 'start')} />
          <div className="loop-brace-handle right" onMouseDown={(e) => onBraceDown(e, 'end')} />
        </div>
      </div>

      <div className="punch-strip" title="Drag to set punch-in/out region" onMouseDown={onPunchDown}>
        <div
          className={`punch-region ${isPunchEnabled ? 'enabled' : ''}`}
          style={{ left: punchInTime * PIXELS_PER_SECOND, width: Math.max(2, (punchOutTime - punchInTime) * PIXELS_PER_SECOND) }}
        />
      </div>
    </div>
  );
}
