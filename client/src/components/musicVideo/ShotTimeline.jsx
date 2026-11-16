import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { scenePosterSrc } from '../../lib/musicVideoPreview.js';
import { formatTimecode } from '../../utils/formatters.js';
import {
  TIMELINE_MAX_PX_PER_SEC, TIMELINE_ZOOM_STEP, clampPxPerSec, fitPxPerSec, lyricSpans, rulerStepSec, rulerTicks, timelineDurationSec, timelineShotAt, timelineShots,
} from '../../lib/musicVideoTimeline.js';

const zoomButtonCls = 'flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded border border-port-border bg-port-bg text-port-text hover:border-port-accent disabled:opacity-40 pointer-fine:sm:min-h-[28px] pointer-fine:sm:min-w-[28px]';
// How far inside the right edge the playhead may run before the view follows it.
const FOLLOW_MARGIN_PX = 24;
// A clip narrower than this has no room for its number, a lyric line for its words.
const NUMBER_MIN_PX = 26;
const LYRIC_TEXT_MIN_PX = 28;
// A ruler label: minutes and seconds, with tenths only when the labels are closer than a second apart.
const tickLabel = (t, stepSec) => {
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${stepSec < 1 ? sec.toFixed(1).padStart(4, '0') : String(Math.round(sec)).padStart(2, '0')}`;
};
// A picture path inside a CSS url("…"): only the characters that would end the string are escaped.
const cssUrl = (src) => `url("${src.replace(/["\\\n]/g, (ch) => encodeURIComponent(ch))}")`;

/**
 * The shots on a timeline, the way an editing application lays them out: a
 * time ruler, a track of clips (each shot's picture as a filmstrip, as wide as
 * it runs), the lyric lines under them, and a playhead that follows the
 * preview player.
 *
 * `songClock()` answers `{ t, playing } | null`, the player's time on the song;
 * it is read every frame and the playhead is moved without a render, so
 * playback costs this component nothing. `onSeek(t)` moves the player (tap or
 * drag the ruler); `onOpenShot(scene)` opens a clip. `shotName(scene)` names a
 * shot; `posters` (a Map by scene id) overrides a shot's picture.
 *
 * Zoom runs from the whole song in view to a frame per 10 px: the buttons, or
 * a pinch on a trackpad (Ctrl/⌘ + wheel), zoom around the playhead when it is
 * in view, else around the pointer or the middle.
 */
export default function ShotTimeline({ project, activeSceneId = null, songClock = null, onSeek, onOpenShot, shotName, posters = null }) {
  const { shots, off } = useMemo(() => timelineShots(project), [project]);
  const durationSec = timelineDurationSec(project, shots);
  const cues = useMemo(() => lyricSpans(project.lyricCues), [project.lyricCues]);
  const sections = project.audioAnalysis?.sections || [];

  const scrollerRef = useRef(null);
  const playheadRef = useRef(null);
  const readoutRef = useRef(null);
  const rulerRef = useRef(null);
  // The scroller's width decides the fit zoom; `zoom` null means "fit", so a resize keeps the whole song in view.
  const [viewWidth, setViewWidth] = useState(0);
  const [zoom, setZoom] = useState(null);
  const [onScreenId, setOnScreenId] = useState(null);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    setViewWidth(scroller.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setViewWidth(scroller.clientWidth));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  const fit = fitPxPerSec(viewWidth || 320, durationSec);
  const pxPerSec = zoom == null ? fit : clampPxPerSec(zoom, fit);
  const widthPx = Math.max(viewWidth, Math.ceil(durationSec * pxPerSec));

  // What the frame loop reads: kept in a ref so the loop is started once.
  const live = useRef({});
  live.current = { pxPerSec, shots, songClock, durationSec };
  const timeRef = useRef(0);

  // A zoom keeps one moment of the song under the same point of the view.
  const zoomAnchor = useRef(null);
  const zoomTo = useCallback((next, anchorClientX = null) => {
    const scroller = scrollerRef.current;
    const { pxPerSec: px } = live.current;
    if (scroller) {
      const playheadX = timeRef.current * px - scroller.scrollLeft;
      const playheadInView = playheadX >= 0 && playheadX <= scroller.clientWidth;
      const offset = anchorClientX != null ? anchorClientX - scroller.getBoundingClientRect().left
        : playheadInView ? playheadX : scroller.clientWidth / 2;
      zoomAnchor.current = { t: (scroller.scrollLeft + offset) / px, offset };
    }
    setZoom(next);
  }, []);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    if (anchor && scrollerRef.current) scrollerRef.current.scrollLeft = Math.max(0, anchor.t * pxPerSec - anchor.offset);
  }, [pxPerSec]);
  const zoomBy = (factor, anchorClientX) => {
    const next = clampPxPerSec(live.current.pxPerSec * factor, fit);
    // Back at the fit zoom the timeline tracks the view's width again.
    zoomTo(next <= fit * 1.001 ? null : next, anchorClientX);
  };
  const zoomByRef = useRef(zoomBy);
  zoomByRef.current = zoomBy;
  // A trackpad pinch arrives as Ctrl + wheel; the listener is native because React's wheel is passive.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    const onWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomByRef.current(Math.exp(-event.deltaY * 0.01), event.clientX);
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, []);

  // The playhead follows the player's clock frame by frame, outside React.
  useEffect(() => {
    let handle;
    let drawn = { t: null, px: null };
    const tick = () => {
      const { pxPerSec: px, shots: list, songClock: clock, durationSec: total } = live.current;
      const reading = clock?.() || null;
      const t = Math.min(Math.max(0, reading?.t ?? timeRef.current), total);
      const moved = t !== drawn.t;
      if (moved || px !== drawn.px) {
        timeRef.current = t;
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${t * px}px)`;
        if (moved && readoutRef.current) readoutRef.current.textContent = formatTimecode(t);
        if (moved && rulerRef.current) {
          rulerRef.current.setAttribute('aria-valuenow', String(Math.round(t)));
          rulerRef.current.setAttribute('aria-valuetext', formatTimecode(t));
        }
        const scroller = scrollerRef.current;
        // The view follows the playhead as it plays, and jumps to it when a seek lands out of view.
        if (moved && scroller && drawn.t != null) {
          const x = t * px - scroller.scrollLeft;
          if (x < 0 || x > scroller.clientWidth - FOLLOW_MARGIN_PX) scroller.scrollLeft = Math.max(0, t * px - scroller.clientWidth * 0.1);
        }
        drawn = { t, px };
        const shot = timelineShotAt(list, t);
        const id = shot && t < shot.endSec ? shot.sceneId : null;
        setOnScreenId((current) => (current === id ? current : id));
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, []);

  // Tap or drag the ruler to move the player; a drag seeks at most once a frame.
  const scrub = useRef(null);
  const seekAt = (clientX) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const x = clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft;
    const t = Math.min(Math.max(0, x / live.current.pxPerSec), live.current.durationSec);
    timeRef.current = t;
    onSeek?.(Math.round(t * 1000) / 1000);
  };
  const onRulerDown = (event) => {
    if (event.button != null && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrub.current = { pointerId: event.pointerId, pending: null, frame: null };
    seekAt(event.clientX);
  };
  const onRulerMove = (event) => {
    const drag = scrub.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.pending = event.clientX;
    if (drag.frame != null) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = null;
      if (scrub.current === drag && drag.pending != null) seekAt(drag.pending);
    });
  };
  const onRulerUp = (event) => {
    const drag = scrub.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.frame != null) cancelAnimationFrame(drag.frame);
    scrub.current = null;
  };
  useEffect(() => () => { if (scrub.current?.frame != null) cancelAnimationFrame(scrub.current.frame); }, []);

  const stepSec = rulerStepSec(pxPerSec);
  const ticks = useMemo(() => rulerTicks(durationSec, stepSec), [durationSec, stepSec]);
  const atFit = pxPerSec <= fit * 1.001;
  const atMax = pxPerSec >= TIMELINE_MAX_PX_PER_SEC;

  return (
    <section aria-label="Timeline" className="min-w-0 rounded-lg border border-port-border bg-port-card">
      <div className="flex min-w-0 items-center gap-2 px-2 py-1">
        <output ref={readoutRef} aria-label="Playhead time" className="text-sm font-medium tabular-nums text-port-text">{formatTimecode(0)}</output>
        <span className="text-xs tabular-nums text-port-text-muted">/ {formatTimecode(durationSec)}</span>
        <div role="group" aria-label="Zoom" className="ml-auto flex items-center gap-1">
          <button type="button" className={zoomButtonCls} onClick={() => zoomBy(1 / TIMELINE_ZOOM_STEP)} disabled={atFit} aria-label="Zoom out" title="Zoom out">
            <ZoomOut size={14} aria-hidden="true" />
          </button>
          <button type="button" className={zoomButtonCls} onClick={() => zoomTo(null)} disabled={atFit} aria-label="Fit the whole song" title="Fit the whole song">
            <Maximize2 size={14} aria-hidden="true" />
          </button>
          <button type="button" className={zoomButtonCls} onClick={() => zoomBy(TIMELINE_ZOOM_STEP)} disabled={atMax} aria-label="Zoom in" title="Zoom in">
            <ZoomIn size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div ref={scrollerRef} data-testid="shot-timeline-scroller" className="relative overflow-x-auto overscroll-x-contain border-t border-port-border bg-port-bg">
        <div className="relative" style={{ width: `${widthPx}px` }}>
          {/* The ruler scrubs (touch-none); the tracks under it pan the view. */}
          <div ref={rulerRef} role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(durationSec)} aria-valuenow={0}
            className="relative h-7 cursor-pointer touch-none select-none border-b border-port-border"
            onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerCancel={onRulerUp}
            onKeyDown={(event) => {
              const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!dir) return;
              event.preventDefault();
              const t = Math.min(Math.max(0, timeRef.current + dir * (event.shiftKey ? 1 : 1 / 24)), durationSec);
              timeRef.current = t;
              onSeek?.(Math.round(t * 1000) / 1000);
            }}>
            {ticks.map((t) => (
              <span key={t} className="pointer-events-none absolute inset-y-0 border-l border-port-border pl-1 text-[10px] leading-7 tabular-nums text-port-text-muted" style={{ left: t * pxPerSec }}>
                {tickLabel(t, stepSec)}
              </span>
            ))}
          </div>
          {sections.length > 0 && (
            <div className="relative h-4 border-b border-port-border" aria-hidden="true">
              {sections.map((section, i) => (
                <span key={`${section.startSec}-${i}`} className="absolute inset-y-0 border-l border-port-border/70 text-[10px] leading-4 text-port-text-muted"
                  style={{ left: section.startSec * pxPerSec, width: Math.max(2, (section.endSec - section.startSec) * pxPerSec) }}>
                  {/* The name stays in view while any of its section is. */}
                  <span className="sticky left-0 inline-block max-w-full truncate px-1 align-top">{section.label}</span>
                </span>
              ))}
            </div>
          )}
          <div role="group" aria-label="Shots" className="relative h-14">
            {shots.map((shot) => {
              const width = Math.max(2, (shot.endSec - shot.startSec) * pxPerSec);
              const poster = posters?.get(shot.sceneId) ?? scenePosterSrc(shot.scene, project.scenes);
              const active = shot.sceneId === activeSceneId;
              return (
                <button key={shot.sceneId} type="button" data-scene-id={shot.sceneId}
                  onClick={() => onOpenShot?.(shot.scene)}
                  aria-pressed={active} aria-current={shot.sceneId === onScreenId ? 'true' : undefined}
                  aria-label={`Open ${shotName ? shotName(shot.scene) : `shot ${shot.number}`}, ${formatTimecode(shot.startSec)} to ${formatTimecode(shot.endSec)}`}
                  title={`${shotName ? shotName(shot.scene) : `Shot ${shot.number}`} · ${(shot.endSec - shot.startSec).toFixed(2)}s`}
                  className={`absolute inset-y-1 overflow-hidden rounded-sm border bg-port-card bg-left bg-repeat-x text-left ${active ? 'z-10 border-port-accent ring-2 ring-port-accent' : shot.sceneId === onScreenId ? 'border-port-text' : shot.scene.shotSheet?.checked ? 'border-port-success' : 'border-port-border'}`}
                  style={{ left: shot.startSec * pxPerSec, width, backgroundImage: poster ? cssUrl(poster) : undefined, backgroundSize: 'auto 100%' }}>
                  {width >= NUMBER_MIN_PX && (
                    <span className="port-media-overlay-strong absolute left-0.5 top-0.5 rounded px-1 text-[10px] font-medium leading-4 tabular-nums">{shot.number}</span>
                  )}
                </button>
              );
            })}
          </div>
          {cues.length > 0 && (
            <div className="relative h-5 border-t border-port-border" aria-hidden="true">
              {cues.map((cue) => {
                const width = Math.max(2, (cue.endSec - cue.startSec) * pxPerSec);
                return (
                  <span key={cue.id} title={cue.text}
                    className="absolute inset-y-0.5 overflow-hidden truncate rounded-sm border border-port-warning/40 bg-port-warning/15 px-1 text-[10px] leading-4 text-port-text"
                    style={{ left: cue.startSec * pxPerSec, width }}>
                    {width >= LYRIC_TEXT_MIN_PX ? cue.text : null}
                  </span>
                );
              })}
            </div>
          )}
          <div ref={playheadRef} data-testid="shot-timeline-playhead" aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-20 w-px bg-port-error" />
        </div>
      </div>
      {off.length > 0 && (
        <div role="group" aria-label="Shots off the timeline" className="flex min-w-0 flex-wrap items-center gap-1 border-t border-port-border px-2 py-1 text-xs">
          <span className="text-port-text-muted">Off the song's clock</span>
          {off.map((scene, i) => (
            <button key={scene.sceneId} type="button" onClick={() => onOpenShot?.(scene)} aria-pressed={scene.sceneId === activeSceneId}
              className={`min-h-[44px] rounded border px-2 pointer-fine:sm:min-h-[28px] ${scene.sceneId === activeSceneId ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text'}`}>
              {shotName ? shotName(scene) : `Shot ${i + 1}`}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
