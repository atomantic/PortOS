import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildBeatGridPoints, computeDragSpan, computeSceneSpans, shouldMarkBeatAligned } from '../../lib/beatGrid.js';
import { formatTimecode } from '../../utils/formatters.js';
import { resolveNarrativeEvents } from '../../lib/musicVideoNarrativeEvents.js';

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

// Timed lyric lines (#8964) render as a read-only strip under the scene
// blocks, so the director can see which words each cut spans. A cue with no
// explicit end runs to the next cue (capped) — the same reading the planner uses.
const OPEN_CUE_MAX_SEC = 8;
function lyricSpans(cues) {
  const timed = (Array.isArray(cues) ? cues : [])
    .filter((c) => typeof c?.startSec === 'number' && c.text)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  return timed.map((c, i) => {
    const next = timed[i + 1];
    const openEnd = Math.min(c.startSec + OPEN_CUE_MAX_SEC, next ? next.startSec : Infinity);
    return { id: c.id || `cue-${i}`, text: c.text, startSec: c.startSec, endSec: typeof c.endSec === 'number' && c.endSec > c.startSec ? c.endSec : openEnd };
  });
}

export default function BeatTimeline({ audioAnalysis, scenes, lyricCues, narrativeEvents = [], onSeek, onCommit }) {
  const narrative = useMemo(() => resolveNarrativeEvents({ audioAnalysis, lyricCues, composition: { narrativeEvents } }, []), [audioAnalysis, lyricCues, narrativeEvents]);
  const eventLane = useMemo(() => {
    const ends = [];
    const events = narrative.events.map((event) => {
      const left = event.startSec * PX_PER_SEC;
      const width = Math.max(44, (event.endSec - event.startSec) * PX_PER_SEC);
      let row = ends.findIndex((end) => end + 4 <= left);
      if (row < 0) row = ends.length;
      ends[row] = left + width;
      return { ...event, left, width, row };
    });
    return { events, rows: ends.length };
  }, [narrative]);
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
  const scrollRef = useRef(null);

  const spans = baseSpans.map((span) => (
    liveSpan && liveSpan.sceneId === span.sceneId ? { ...span, ...liveSpan } : span
  ));

  const totalDurationSec = Math.max(audioAnalysis?.durationSec || 0, ...spans.map((s) => s.endSec), 1);
  const widthPx = Math.ceil(totalDurationSec * PX_PER_SEC) + 40;
  const waveform = Array.isArray(audioAnalysis?.waveform) ? audioAnalysis.waveform : [];
  const cueSpans = useMemo(() => lyricSpans(lyricCues), [lyricCues]);
  const timeMarks = useMemo(() => {
    const interval = totalDurationSec > 180 ? 30 : totalDurationSec > 60 ? 15 : 5;
    return Array.from({ length: Math.floor(totalDurationSec / interval) + 1 }, (_, i) => i * interval);
  }, [totalDurationSec]);

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

  const jumpToOverviewTime = (e) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const timeSec = Math.max(0, Math.min(totalDurationSec, ((e.clientX - rect.left) / rect.width) * totalDurationSec));
    scroller.scrollTo({ left: Math.max(0, timeSec * PX_PER_SEC - scroller.clientWidth / 2), behavior: 'smooth' });
  };

  if (!audioAnalysis || !scenes || scenes.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-1 text-xs text-port-text-muted">
        <span>
          Music timeline — waveform, sections, and 4/4 beat-grid assumption.
          Drag a scene&apos;s right edge to trim, or its body to reposition.
        </span>
        <span className="whitespace-nowrap">
          {audioAnalysis.bpm ? `${audioAnalysis.bpm} BPM` : 'Waveform only · no beat grid'}
          {audioAnalysis.tempoSource === 'windowed' && audioAnalysis.tempoWindow && (
            <> · detected near {formatTimecode(audioAnalysis.tempoWindow.startSec)}–{formatTimecode(audioAnalysis.tempoWindow.endSec)}</>
          )}
          {audioAnalysis.tempoSource === 'manual' && <> · director-set</>}
        </span>
      </div>

      <button
        type="button"
        className="relative block h-16 w-full overflow-hidden rounded-lg border border-port-border bg-port-bg text-left"
        onClick={jumpToOverviewTime}
        title="Song overview — click to center the detailed timeline"
      >
        <svg
          viewBox="0 0 1000 64"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label={`Audio waveform overview with ${(audioAnalysis.beats || []).length} beats and ${(audioAnalysis.downbeats || []).length} downbeats`}
        >
          {(audioAnalysis.sections || []).map((section, i) => (
            <rect
              key={`overview-sec-${i}`}
              x={(section.startSec / totalDurationSec) * 1000}
              y="0"
              width={Math.max(1, ((section.endSec - section.startSec) / totalDurationSec) * 1000)}
              height="64"
              className="fill-port-accent/10"
              opacity={0.25 + 0.45 * (section.energy ?? 0.5)}
            />
          ))}
          {waveform.map((level, i) => {
            const x = waveform.length === 1 ? 0 : (i / (waveform.length - 1)) * 1000;
            const halfHeight = 2 + level * 23;
            return (
              <line
                key={`overview-wave-${i}`}
                x1={x}
                x2={x}
                y1={32 - halfHeight}
                y2={32 + halfHeight}
                className="stroke-port-text-muted/70"
                strokeWidth={Math.max(1, 1000 / Math.max(waveform.length, 1))}
              />
            );
          })}
          {(audioAnalysis.beats || []).map((t, i) => (
            <line key={`overview-beat-${i}`} x1={(t / totalDurationSec) * 1000} x2={(t / totalDurationSec) * 1000}
              y1="42" y2="64" className="stroke-port-border" strokeWidth="1" />
          ))}
          {(audioAnalysis.downbeats || []).map((t, i) => (
            <line key={`overview-downbeat-${i}`} x1={(t / totalDurationSec) * 1000} x2={(t / totalDurationSec) * 1000}
              y1="34" y2="64" className="stroke-port-accent" strokeWidth="2" />
          ))}
          {spans.map((span) => (
            <line key={`overview-scene-${span.sceneId}`} x1={(span.startSec / totalDurationSec) * 1000}
              x2={(span.startSec / totalDurationSec) * 1000} y1="0" y2="12"
              className="stroke-port-success/80" strokeWidth="1.5" />
          ))}
        </svg>
        {waveform.length === 0 && (
          <span className="absolute inset-0 flex items-center justify-center text-xs text-port-text-muted">
            Re-run Analyze to add the waveform to this cached project
          </span>
        )}
        <span className="absolute bottom-0.5 left-1 text-[10px] text-port-text-muted">0:00</span>
        <span className="absolute bottom-0.5 right-1 text-[10px] text-port-text-muted">{formatTimecode(totalDurationSec)}</span>
      </button>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-port-text-muted" aria-label="Timeline legend">
        <span><i className="mr-1 inline-block h-2 w-3 bg-port-text-muted/60" />waveform energy</span>
        <span><i className="mr-1 inline-block h-3 w-px bg-port-border" />beat</span>
        <span><i className="mr-1 inline-block h-3 w-0.5 bg-port-accent" />downbeat</span>
        <span><i className="mr-1 inline-block h-2 w-3 bg-port-success/40" />scene start</span>
        {cueSpans.length > 0 && <span><i className="mr-1 inline-block h-2 w-3 bg-port-warning/30" />lyric line</span>}
      </div>

      <div ref={scrollRef} className="overflow-x-auto border border-port-border rounded-lg bg-port-bg">
        <div className="relative" style={{ width: `${widthPx}px`, height: eventLane.rows ? 179 + eventLane.rows * 26 : cueSpans.length ? 176 : 144, touchAction: 'none' }}>
          {(audioAnalysis.sections || []).map((section, i) => (
            <div key={`sec-${i}`}
              className="absolute top-0 h-6 border-r border-port-border/60 overflow-hidden"
              style={{ left: section.startSec * PX_PER_SEC, width: Math.max(2, (section.endSec - section.startSec) * PX_PER_SEC) }}
              title={section.label}>
              <span className="absolute top-0.5 left-1 text-[10px] text-port-text-muted truncate max-w-full">{section.label}</span>
            </div>
          ))}
          {waveform.map((level, i) => {
            const x = waveform.length === 1 ? 0 : (i / (waveform.length - 1)) * totalDurationSec * PX_PER_SEC;
            const height = Math.max(1, level * 42);
            return (
              <div
                key={`wave-${i}`}
                className="pointer-events-none absolute bg-port-text-muted/45"
                style={{
                  left: x,
                  top: 50 - height / 2,
                  width: Math.max(1, (totalDurationSec * PX_PER_SEC) / Math.max(waveform.length, 1)),
                  height,
                }}
              />
            );
          })}
          {(audioAnalysis.beats || []).map((t, i) => (
            <div key={`b-${i}`} className="absolute top-7 bottom-0 w-px bg-port-border" style={{ left: t * PX_PER_SEC }} />
          ))}
          {(audioAnalysis.downbeats || []).map((t, i) => (
            <div key={`db-${i}`} className="absolute top-6 bottom-0 w-px bg-port-accent/60" style={{ left: t * PX_PER_SEC }} />
          ))}
          {timeMarks.map((t) => (
            <div key={`time-${t}`} className="pointer-events-none absolute top-[74px] text-[9px] text-port-text-muted"
              style={{ left: t * PX_PER_SEC }}>
              <span className="-translate-x-1/2 inline-block">{formatTimecode(t)}</span>
            </div>
          ))}
          {spans.map((span, i) => {
            const scene = scenes.find((s) => s.sceneId === span.sceneId);
            const dragging = liveSpan?.sceneId === span.sceneId;
            const snappedNow = dragging && liveSpan.snapped;
            return (
              <div key={span.sceneId}
                className={`absolute top-[92px] h-11 rounded border bg-port-card/90 select-none ${snappedNow ? 'border-port-success' : 'border-port-accent'}`}
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
          {cueSpans.map((cue) => (
            <div key={cue.id}
              className="pointer-events-none absolute top-[142px] h-6 overflow-hidden rounded border border-port-warning/40 bg-port-warning/15 px-1 text-[10px] leading-6 text-port-text truncate"
              style={{ left: cue.startSec * PX_PER_SEC, width: Math.max(4, (cue.endSec - cue.startSec) * PX_PER_SEC) }}
              title={cue.text}>
              {cue.text}
            </div>
          ))}
          {eventLane.events.map((event) => <button key={event.id} type="button"
            className="absolute h-5 overflow-hidden rounded border border-port-accent bg-port-card px-1 text-left text-[10px] text-port-text"
            style={{ left: event.left, top: 175 + event.row * 26, width: event.width }}
            title={`${event.kind}: ${event.narrativeFunction} · ${event.mediumRationale}`}
            aria-label={`Seek event ${event.name} at frame ${event.startFrame}`} onClick={() => onSeek?.(event.startSec)}>
            {event.name} · {event.kind}
          </button>)}
        </div>
      </div>
      {narrative.events.length > 0 && <p className="text-xs text-port-text-muted">Narrative event lane · click an event to seek its resolved song frame.</p>}
      {narrative.unresolved.length > 0 && <p role="status" className="text-xs text-port-warning">Rebind {narrative.unresolved.length} unresolved narrative events in Make.</p>}
    </div>
  );
}
