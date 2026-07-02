import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildBeatGridPoints, computeDragSpan, computeSceneSpans, shouldMarkBeatAligned } from '../../lib/beatGrid.js';

// Beat-quantized timeline arranger for a music-video project's scene board
// (#1854). Renders a beat-grid overlay (section bands, beat/downbeat ticks)
// from the project's cached `audioAnalysis`, plus draggable scene blocks
// whose right edge (out-point) and body (reposition) snap to the grid. There
// is intentionally no left-edge/in-point handle — `beatSnapClips`
// (server/services/musicVideo/render.js) always trims a clip from its own
// frame 0, so it has no way to honor a distinct in-point; offering that
// handle would promise behavior the render can't deliver.
// On drag release, `onCommit(sceneId, { startSec, endSec, beatAligned })`
// persists the result via the existing scene PATCH endpoint — the server's
// `beatSnapClips` honors a `beatAligned` scene's saved boundaries exactly at
// render time instead of re-deriving them from the live beat grid.

const PX_PER_SEC = 80;
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
    const result = computeDragSpan({ kind: drag.kind, startSpan: drag.startSpan, deltaSec, gridPoints, toleranceSec: SNAP_TOLERANCE_SEC });
    setLiveSpan({ sceneId: drag.sceneId, ...result });
  }, [gridPoints]);

  const onPointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    setLiveSpan((current) => {
      if (drag && current && current.sceneId === drag.sceneId) {
        const beatAligned = shouldMarkBeatAligned({ kind: drag.kind, snapped: current.snapped, wasPersisted: drag.wasPersisted });
        onCommit?.(drag.sceneId, { startSec: current.startSec, endSec: current.endSec, beatAligned });
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
    dragRef.current = {
      sceneId, kind, startClientX: e.clientX,
      startSpan: { startSec: span.startSec, endSec: span.endSec },
      wasPersisted: !!span.persisted,
    };
    setLiveSpan({ sceneId, startSec: span.startSec, endSec: span.endSec, snapped: false });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  if (!audioAnalysis || !scenes || scenes.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-port-text-muted">
        <span>Beat-quantized timeline — drag a scene's right edge to trim its length, or its body to reposition</span>
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
