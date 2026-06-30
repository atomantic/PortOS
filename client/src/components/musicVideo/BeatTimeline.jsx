import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildBeatGridPoints, computeSceneSpans, snapTimeToGrid } from '../../lib/beatGrid.js';

// Beat-quantized timeline arranger for a music-video project's scene board
// (#1854). Renders a beat-grid overlay (section bands, beat/downbeat ticks)
// from the project's cached `audioAnalysis`, plus draggable scene blocks
// whose left/right edges (in/out) and body (reposition) snap to the grid.
// On drag release, `onCommit(sceneId, { startSec, endSec, beatAligned })`
// persists the result via the existing scene PATCH endpoint — the server's
// `beatSnapClips` (server/services/musicVideo/render.js) honors a
// `beatAligned` scene's saved boundaries exactly at render time instead of
// re-deriving them from the live beat grid.

const PX_PER_SEC = 80;
const MIN_SCENE_SEC = 0.3;
const SNAP_TOLERANCE_SEC = 0.15;

export default function BeatTimeline({ audioAnalysis, scenes, onCommit }) {
  const gridPoints = useMemo(() => buildBeatGridPoints(audioAnalysis), [audioAnalysis]);
  const baseSpans = useMemo(
    () => computeSceneSpans(scenes, audioAnalysis?.durationSec),
    [scenes, audioAnalysis?.durationSec],
  );

  // In-flight drag preview, keyed by sceneId — overrides the matching base
  // span while dragging so the block tracks the pointer without round-
  // tripping through the parent's `scenes` prop on every pixel of movement.
  const [liveSpan, setLiveSpan] = useState(null);
  const dragRef = useRef(null);

  const spans = baseSpans.map((span) => (
    liveSpan && liveSpan.sceneId === span.sceneId ? { ...span, ...liveSpan } : span
  ));

  const totalDurationSec = Math.max(audioAnalysis?.durationSec || 0, ...spans.map((s) => s.endSec), 1);
  const widthPx = Math.ceil(totalDurationSec * PX_PER_SEC) + 40;

  const onPointerMove = useCallback((e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaSec = (e.clientX - drag.startClientX) / PX_PER_SEC;
    let nextStart = drag.startSpan.startSec;
    let nextEnd = drag.startSpan.endSec;
    if (drag.kind === 'move') {
      const duration = drag.startSpan.endSec - drag.startSpan.startSec;
      nextStart = Math.max(0, drag.startSpan.startSec + deltaSec);
      nextEnd = nextStart + duration;
    } else if (drag.kind === 'left') {
      nextStart = Math.max(0, Math.min(drag.startSpan.endSec - MIN_SCENE_SEC, drag.startSpan.startSec + deltaSec));
    } else if (drag.kind === 'right') {
      nextEnd = Math.max(drag.startSpan.startSec + MIN_SCENE_SEC, drag.startSpan.endSec + deltaSec);
    }
    let snapped = false;
    if (drag.kind === 'move') {
      const snap = snapTimeToGrid(nextStart, gridPoints, SNAP_TOLERANCE_SEC);
      if (snap) { nextEnd = snap.t + (nextEnd - nextStart); nextStart = snap.t; snapped = true; }
    } else {
      const snapStart = drag.kind === 'left' ? snapTimeToGrid(nextStart, gridPoints, SNAP_TOLERANCE_SEC) : null;
      const snapEnd = drag.kind === 'right' ? snapTimeToGrid(nextEnd, gridPoints, SNAP_TOLERANCE_SEC) : null;
      if (snapStart) { nextStart = snapStart.t; snapped = true; }
      if (snapEnd) { nextEnd = snapEnd.t; snapped = true; }
    }
    setLiveSpan({
      sceneId: drag.sceneId,
      startSec: Number(nextStart.toFixed(3)),
      endSec: Number(nextEnd.toFixed(3)),
      snapped,
    });
  }, [gridPoints]);

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    setLiveSpan((current) => {
      if (drag && current && current.sceneId === drag.sceneId) {
        onCommit?.(drag.sceneId, { startSec: current.startSec, endSec: current.endSec, beatAligned: current.snapped });
      }
      return null;
    });
  }, [onCommit, onPointerMove]);

  // Drop any window listeners left from an in-flight drag if the timeline
  // unmounts mid-gesture (e.g. switching projects while dragging).
  useEffect(() => () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove, onPointerUp]);

  const beginDrag = (e, sceneId, kind, span) => {
    e.preventDefault();
    dragRef.current = { sceneId, kind, startClientX: e.clientX, startSpan: { startSec: span.startSec, endSec: span.endSec } };
    setLiveSpan({ sceneId, startSec: span.startSec, endSec: span.endSec, snapped: false });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  if (!audioAnalysis || !scenes || scenes.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-port-text-muted">
        <span>Beat-quantized timeline — drag a scene's edges to snap to beats, or its body to reposition</span>
        {audioAnalysis.bpm && <span>{audioAnalysis.bpm} BPM</span>}
      </div>
      <div className="overflow-x-auto border border-port-border rounded-lg bg-port-bg">
        <div className="relative h-28" style={{ width: `${widthPx}px`, touchAction: 'none' }}>
          {(audioAnalysis.sections || []).map((section, i) => (
            <div key={`sec-${i}`}
              className="absolute top-0 h-6 border-r border-port-border/60 overflow-hidden"
              style={{ left: section.startSec * PX_PER_SEC, width: Math.max(2, (section.endSec - section.startSec) * PX_PER_SEC) }}
              title={section.label}>
              <span className="absolute top-0.5 left-1 text-[10px] text-port-text-muted truncate max-w-full">{section.label}</span>
            </div>
          ))}
          {(audioAnalysis.beats || []).map((t, i) => (
            <div key={`b-${i}`} className="absolute top-7 bottom-0 w-px bg-port-border" style={{ left: t * PX_PER_SEC }} />
          ))}
          {(audioAnalysis.downbeats || []).map((t, i) => (
            <div key={`db-${i}`} className="absolute top-6 bottom-0 w-px bg-port-accent/60" style={{ left: t * PX_PER_SEC }} />
          ))}
          {spans.map((span, i) => {
            const scene = scenes.find((s) => s.sceneId === span.sceneId);
            const dragging = liveSpan?.sceneId === span.sceneId;
            const snappedNow = dragging && liveSpan.snapped;
            return (
              <div key={span.sceneId}
                className={`absolute top-14 h-12 rounded border bg-port-card/90 select-none ${snappedNow ? 'border-port-success' : 'border-port-accent'}`}
                style={{ left: span.startSec * PX_PER_SEC, width: Math.max(6, (span.endSec - span.startSec) * PX_PER_SEC) }}>
                <div role="presentation"
                  className="absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-port-accent/40"
                  onPointerDown={(e) => beginDrag(e, span.sceneId, 'left', span)} />
                <div role="presentation"
                  className="absolute inset-0 flex items-center justify-center text-[10px] px-2 cursor-grab truncate"
                  onPointerDown={(e) => beginDrag(e, span.sceneId, 'move', span)}
                  title={scene?.prompt || `Scene #${(scene?.order ?? i) + 1}`}>
                  #{(scene?.order ?? i) + 1}
                  {scene?.beatAligned && !dragging && <span className="ml-1 text-port-success">●</span>}
                </div>
                <div role="presentation"
                  className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-port-accent/40"
                  onPointerDown={(e) => beginDrag(e, span.sceneId, 'right', span)} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
