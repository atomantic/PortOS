import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useKeyCapture from '../../hooks/useKeyCapture.js';
import { scenePosterSrc } from '../../lib/musicVideoPreview.js';
import { formatTimecode } from '../../utils/formatters.js';
import { buildBeatGridPoints } from '../../lib/beatGrid.js';
import { TIMELINE_MAX_PX_PER_SEC, clampPxPerSec, fitPxPerSec, lyricSpans, rulerStepSec, rulerTicks, shotsWithCutAt, timelineCuts, timelineDurationSec, timelineShots, waveformPath } from '../../lib/musicVideoTimeline.js';
import { AUDIO_LAYER_ROW_H, TimelineAudioLayerPanel, TimelineAudioLayerRow, TimelineClipSoundRow, clipSoundShots } from './ShotTimelineAudioLayers.jsx';
import { TimelineEffectLibrary, TimelineEffectSpans, TimelineEffectsPanel, TimelineInShotEffects } from './ShotTimelineEffects.jsx';
import { TimelineRangeControls, TimelineRangeMarks } from './ShotTimelineRange.jsx';
import useTimelinePlayheadLoop from './useTimelinePlayheadLoop.js';
import useTimelinePointerInteractions from './useTimelinePointerInteractions.js';
import ShotTimelineToolbar from './ShotTimelineToolbar.jsx';
import useTimelineEffectSelection from './useTimelineEffectSelection.js';

// About the width of a ruler label ("12:30") at its 10px size.
const TICK_LABEL_PX = 30;
// A clip narrower than this has no room for its number, a lyric line for its words.
const NUMBER_MIN_PX = 26;
const LYRIC_TEXT_MIN_PX = 28;
// A cut's handle shows only where the shots on both sides stay tappable around it.
const CUT_MIN_CLIP_PX = 56;
// Every row is labeled in a column at the left; an effects row is tall enough to tap on a touch screen.
const ROW_CLS = 'relative border-b border-port-border';
const FX_ROW_H = 'h-7 pointer-coarse:h-12';
const RULER_ROW_H = 'h-7 pointer-coarse:h-12';
// The excerpt route accepts song times through 36,000s.
const MAX_EXCERPT_SEC = 36000;
// A ruler label: minutes and seconds, with tenths only when the labels are closer than a second apart.
const tickLabel = (t, stepSec) => {
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${stepSec < 1 ? sec.toFixed(1).padStart(4, '0') : String(Math.round(sec)).padStart(2, '0')}`;
};
// A picture path inside a CSS url("…"): only the characters that would end the string are escaped.
const round2 = (n) => Math.round(n * 100) / 100;
const roundMs = (t) => Math.round(t * 1000) / 1000;
const cssUrl = (src) => `url("${src.replace(/["\\\n]/g, (ch) => encodeURIComponent(ch))}")`;

function timelineRange(project, savedShots, range) {
  const songDuration = project.audioAnalysis?.durationSec;
  const rangeLimit = Math.min(MAX_EXCERPT_SEC, Number.isFinite(songDuration) && songDuration > 0 ? songDuration : savedShots.reduce((end, shot) => Math.max(end, shot.endSec), 0));
  const validRange = range?.start != null && range?.end != null && range.end > range.start && range.end <= rangeLimit;
  const rangeMessage = !rangeLimit ? 'Time shots on the song to select a range.'
    : range?.start == null || range?.end == null ? 'Set both range points at the playhead.'
      : !validRange ? 'Set In before Out and keep both points within the song.' : null;
  return { validRange, rangeLimit, rangeMessage };
}

function timelineEffectRows({ effectLanes, pxPerSec, shotName, effectsShot, selectedFx, selectEffects, selectEffect, onEditShot, snapPoints }) {
  const spanRow = (kind) => (
    <TimelineEffectSpans lanes={effectLanes.lanes} kind={kind} pxPerSec={pxPerSec} shotName={shotName}
      selectedId={effectsShot?.sceneId ?? null} onSelect={selectEffects} />
  );
  // An effect kind the video never uses keeps no row; in-shot effects always have one, to tap and add to.
  return effectLanes ? [
    effectLanes.has.transitions && { id: 'transitions', label: 'Transitions', content: spanRow('transitions') },
    effectLanes.has.cut && { id: 'cut', label: 'Cut effects', content: spanRow('cut') },
    effectLanes.has.image && { id: 'image', label: 'Image effects', content: spanRow('image') },
    { id: 'in-shot', label: 'In-shot effects', content: (
      <TimelineInShotEffects lanes={effectLanes.lanes} pxPerSec={pxPerSec} shotName={shotName} selectedId={effectsShot?.sceneId ?? null}
        selectedEffect={selectedFx} onSelect={selectEffects} onSelectEffect={selectEffect} onEditShot={onEditShot} snapPoints={snapPoints} />
    ) },
  ].filter(Boolean) : [];
}

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
 *
 * With `onMoveCut(sceneId, edge, t)` the cuts between shots can be dragged
 * (zoomed in far enough to grab one): the cut lands on a frame, pulled onto a
 * nearby beat, section edge or lyric line, and the shot across it grows or
 * shrinks to meet it; arrow keys nudge a focused cut a frame. It answers a
 * promise, and the dragged position holds until it settles. With
 * `onReorder(fromIndex, toIndex)` (song order) the open shot can be moved
 * earlier or later with the toolbar buttons, or any clip dragged onto another
 * with a mouse; a touch drag pans the view instead.
 *
 * Every row is named in a column at the left. With `effectOptions`
 * (`shotEffects`' own options: `{ layered, planned, cameras }`) the effects sit
 * under the clips, one row per kind (transitions over cuts, cut effects, image
 * effects, in-shot effects), and tapping an effect or a shot's in-shot lane
 * opens that shot's effect controls under the timeline.
 * `onEditShot(sceneId, patch)` saves them, lets an in-shot effect be dragged
 * along its shot or trimmed at either end, and adds one at the playhead from
 * the toolbar. `onPreview(t, play)` moves the player to `t` and plays (true) or
 * pauses (false) there: the toolbar's play button and the space bar use it.
 * Tapping an in-shot effect selects it and cues the player just before it,
 * without starting playback; once playing, with Loop on, playback that passes
 * it jumps back, so a style swap is seen on the next pass.
 *
 * With `onSplitShot(sceneId, atSec)` the toolbar's scissors cut the shot under
 * the playhead in two there (on a frame). The song's loudness, when analyzed,
 * draws as a waveform row at the bottom.
 *
 * Each audio layer (`project.audioLayers`: a file placed over the song, mixed
 * into the preview and the render) has a row under the song's waveform. With
 * `onAddAudioLayer(file, startSec)` the toolbar adds one at the playhead; with
 * `onEditAudioLayers(layers)` (the whole list, in order) a layer is dragged
 * along its row to move it, and tapping it opens its level, mute and remove
 * controls under the timeline.
 *
 * With `libraryEl` (a side panel the page gives) an effects library fills it,
 * whose styles add at the playhead, and a selected effect's controls take its
 * place there until closed; without it the controls show under the timeline.
 */
export default function ShotTimeline({ project, activeSceneId, songClock, onSeek, onOpenShot, shotName, posters, onMoveCut, onReorder, effectOptions, onEditShot, onPreview, onSplitShot, libraryEl, onAddAudioLayer, onEditAudioLayers, range, onRangeChange, excerpts, draftUnavailable }) {
  const { shots: savedShots, off } = useMemo(() => timelineShots(project), [project]);
  const durationSec = timelineDurationSec(project, savedShots);
  const { validRange, rangeLimit, rangeMessage } = timelineRange(project, savedShots, range);
  const setRangePoint = (edge, t) => onRangeChange({ ...range, [edge]: Math.min(rangeLimit, Math.max(0, roundMs(t))) });
  // A cut being dragged, or one let go and still saving, shows where it will land.
  const [cutDrag, setCutDrag] = useState(null);
  const cuts = useMemo(() => (onMoveCut ? timelineCuts(savedShots, durationSec) : []), [onMoveCut, savedShots, durationSec]);
  const draggedCut = cutDrag ? cuts.find((cut) => cut.id === cutDrag.id) || null : null;
  const shots = useMemo(() => shotsWithCutAt(savedShots, draggedCut, cutDrag?.t), [savedShots, draggedCut, cutDrag?.t]);
  const snapPoints = useMemo(() => [
    ...buildBeatGridPoints(project.audioAnalysis).map((point) => point.t),
    ...(project.lyricCues || []).map((cue) => cue?.startSec).filter((t) => typeof t === 'number'),
  ], [project.audioAnalysis, project.lyricCues]);
  const cues = useMemo(() => lyricSpans(project.lyricCues), [project.lyricCues]);
  const wave = useMemo(() => waveformPath(project.audioAnalysis?.features?.envelopes), [project.audioAnalysis]);
  const sections = project.audioAnalysis?.sections || [];
  const audioLayers = useMemo(() => (Array.isArray(project.audioLayers) ? project.audioLayers : []), [project.audioLayers]);
  const [audioLayerId, setAudioLayerId] = useState(null);
  const selectedLayer = audioLayers.find((layer) => layer.id === audioLayerId) || null;
  const [addingLayer, setAddingLayer] = useState(false);

  const scrollerRef = useRef(null);
  // The scroller's width decides the fit zoom; `zoom` null means "fit", so a resize keeps the whole song in view.
  const [viewWidth, setViewWidth] = useState(0);
  const [zoom, setZoom] = useState(null);
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
  live.current = { pxPerSec, shots, songClock, durationSec, range: validRange ? range : null, onPreview };
  const playhead = useTimelinePlayheadLoop({ live, scrollerRef });
  const { playheadRef, rulerRef, onScreenId, playing, previewMessage, pointMessage, loopRef, timeRef } = playhead;
  const clipSoundRow = useMemo(() => clipSoundShots(project.scenes), [project.scenes]);
  const editLayer = (id, patch) => onEditAudioLayers(audioLayers.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)));
  const removeLayer = (id) => {
    setAudioLayerId(null);
    return onEditAudioLayers(audioLayers.filter((layer) => layer.id !== id));
  };
  const addLayer = (file) => {
    if (!file || !onAddAudioLayer) return undefined;
    setAddingLayer(true);
    return Promise.resolve(onAddAudioLayer(file, Math.round(timeRef.current * 1000) / 1000))
      .then((layer) => { if (layer?.id) setAudioLayerId(layer.id); })
      .catch(() => {})
      .finally(() => setAddingLayer(false));
  };

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

  const { onRulerDown, onRulerMove, onRulerUp, onCutDown, onCutMove, onCutUp, nudgeCut, reorder,
    suppressClick, onClipDown, onClipMove, onClipUp } = useTimelinePointerInteractions({
    scrollerRef, live, timeRef, onSeek, cutDrag, setCutDrag, onMoveCut, snapPoints,
    savedShots, onReorder,
  });
  const activeIndex = savedShots.findIndex((shot) => shot.sceneId === activeSceneId);
  const effects = useTimelineEffectSelection({
    savedShots, shots, onScreenId, onPreview, playing, onEditShot, timeRef, effectOptions, durationSec, loopRef, libraryEl,
  });
  const { effectsShot, selectedFx, fxGlitch, playheadShot, addEffect, preview, selectEffects,
    selectEffect, setEffectsOfId, setSelectedFx, effectLanes } = effects;
  const nameOf = (shot) => (shotName ? shotName(shot.scene) : `Shot ${shot.number}`);
  // The range takes precedence over an armed effect loop while the preview covers it.
  const togglePlay = () => {
    if (!onPreview) return;
    const t = timeRef.current;
    if (playing) { onPreview(roundMs(t), false); return; }
    if (validRange && range.loop && !previewMessage && !pointMessage) {
      onPreview(t < range.start || t >= range.end ? range.start : roundMs(t), true, true);
      return;
    }
    const loop = loopRef.current;
    onPreview(roundMs(loop && (t < loop.start || t >= loop.end) ? loop.start : t), true);
  };
  useKeyCapture({
    enabled: !!onPreview,
    onKeyDown: (event) => {
      if (event.code !== 'Space' || event.metaKey || event.ctrlKey || event.altKey) return false;
      if (!event.repeat) togglePlay();
      return true;
    },
  });
  const effectRows = timelineEffectRows({ effectLanes, pxPerSec, shotName, effectsShot, selectedFx, selectEffects, selectEffect, onEditShot, snapPoints });
  const rowLabels = [
    ['Time', RULER_ROW_H], ...(sections.length ? [['Sections', 'h-4']] : []), ['Shots', 'h-14'],
    ...effectRows.map((row) => [row.label, FX_ROW_H]), ...(cues.length ? [['Lyrics', 'h-5']] : []), ...(wave ? [['Song', 'h-8']] : []),
    ...audioLayers.map((layer) => [layer.label || 'Audio', AUDIO_LAYER_ROW_H, `audio:${layer.id}`]),
  ];

  const stepSec = rulerStepSec(pxPerSec);
  const ticks = useMemo(() => rulerTicks(durationSec, stepSec), [durationSec, stepSec]);
  const atFit = pxPerSec <= fit * 1.001;
  const atMax = pxPerSec >= TIMELINE_MAX_PX_PER_SEC;

  return (
    <section aria-label="Timeline" className="min-w-0 rounded-lg border border-port-border bg-port-card">
      <ShotTimelineToolbar playhead={playhead} effects={effects} durationSec={durationSec} cutDrag={cutDrag} draggedCut={draggedCut}
        onTogglePlay={onPreview && togglePlay} onReorder={onReorder} activeIndex={activeIndex} savedShots={savedShots}
        onSplitShot={onSplitShot} effectOptions={effectOptions} onEditShot={onEditShot} onAddAudioLayer={onAddAudioLayer}
        addingLayer={addingLayer} addLayer={addLayer} zoomBy={zoomBy} zoomTo={zoomTo} atFit={atFit} atMax={atMax} />
      {onRangeChange && <TimelineRangeControls range={range} valid={validRange} limit={rangeLimit} rangeMessage={rangeMessage}
        previewMessage={previewMessage} pointMessage={pointMessage}
        onSetPoint={(edge) => { if (!songClock?.()?.unknownSongOffset) setRangePoint(edge, timeRef.current); }}
        onChange={onRangeChange} excerpts={excerpts} draftUnavailable={draftUnavailable} projectId={project.id} />}
      <div className="flex min-w-0 border-t border-port-border bg-port-bg">
      {/* Each row's name, beside the row; it stays put while the rows scroll. */}
      <div aria-hidden="true" className="w-[4.5rem] shrink-0 border-r border-port-border bg-port-card sm:w-24">
        {rowLabels.map(([label, height, key]) => (
          <div key={key || label} className={`${ROW_CLS} ${height} flex items-center px-1.5 text-[10px] font-medium leading-3 text-port-text-muted`}>
            {/* A layer's name is the director's (often a file name): two lines at most, broken anywhere. */}
            {key ? <span className="line-clamp-2 [overflow-wrap:anywhere]">{label}</span> : label}
          </div>
        ))}
      </div>
      <div ref={scrollerRef} data-testid="shot-timeline-scroller" className="relative min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
        {/* Clipped across: a label or handle hanging past the song's end would otherwise scroll a fitted timeline. */}
        <div className="relative overflow-x-clip" style={{ width: `${widthPx}px` }}>
          {/* The ruler scrubs (touch-none); the tracks under it pan the view. */}
          <div className="relative">
            <div ref={rulerRef} role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(durationSec)} aria-valuenow={0}
              className={`${ROW_CLS} ${RULER_ROW_H} cursor-pointer touch-none select-none`}
              onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerCancel={onRulerUp}
              onKeyDown={(event) => {
                const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (!dir) return;
                event.preventDefault();
                const t = Math.min(Math.max(0, timeRef.current + dir * (event.shiftKey ? 1 : 1 / 24)), durationSec);
                timeRef.current = t;
                onSeek?.(roundMs(t));
              }}>
              {/* A label with no room before the end is left off rather than cut in half. */}
              {ticks.filter((t) => t * pxPerSec + TICK_LABEL_PX <= widthPx).map((t) => (
                <span key={t} className="pointer-events-none absolute inset-y-0 flex items-center border-l border-port-border pl-1 text-[10px] tabular-nums text-port-text-muted" style={{ left: t * pxPerSec }}>
                  {tickLabel(t, stepSec)}
                </span>
              ))}
            </div>
            {onRangeChange && <TimelineRangeMarks range={range} valid={validRange} limit={rangeLimit} pxPerSec={pxPerSec} onChange={setRangePoint} />}
          </div>
          {sections.length > 0 && (
            <div className={`${ROW_CLS} h-4`} aria-hidden="true">
              {sections.map((section, i) => (
                <span key={`${section.startSec}-${i}`} className="absolute inset-y-0 border-l border-port-border/70 text-[10px] leading-4 text-port-text-muted"
                  style={{ left: section.startSec * pxPerSec, width: Math.max(2, (section.endSec - section.startSec) * pxPerSec) }}>
                  {/* The name stays in view while any of its section is. */}
                  <span className="sticky left-0 inline-block max-w-full truncate px-1 align-top">{section.label}</span>
                </span>
              ))}
            </div>
          )}
          <div role="group" aria-label="Shots" className={`${ROW_CLS} h-14`}>
            {shots.map((shot, index) => {
              const width = Math.max(2, (shot.endSec - shot.startSec) * pxPerSec);
              const moving = reorder?.from === index;
              const target = reorder && reorder.to === index && !moving;
              const poster = posters?.get(shot.sceneId) ?? scenePosterSrc(shot.scene, project.scenes);
              const active = shot.sceneId === activeSceneId;
              return (
                <button key={shot.sceneId} type="button" data-scene-id={shot.sceneId}
                  onClick={() => { if (!suppressClick.current) onOpenShot?.(shot.scene); }}
                  onPointerDown={(event) => onClipDown(event, index)} onPointerMove={onClipMove}
                  onPointerUp={onClipUp} onPointerCancel={(event) => onClipUp(event, true)}
                  aria-pressed={active} aria-current={shot.sceneId === onScreenId ? 'true' : undefined}
                  aria-label={`Open ${shotName ? shotName(shot.scene) : `shot ${shot.number}`}, ${formatTimecode(shot.startSec)} to ${formatTimecode(shot.endSec)}`}
                  title={`${shotName ? shotName(shot.scene) : `Shot ${shot.number}`} · ${(shot.endSec - shot.startSec).toFixed(2)}s`}
                  className={`absolute inset-y-1 overflow-hidden rounded-sm border bg-port-card bg-left bg-repeat-x text-left ${moving ? 'z-30 opacity-70' : ''} ${target ? 'ring-2 ring-port-warning' : ''} ${active ? 'z-10 border-port-accent ring-2 ring-port-accent' : shot.sceneId === onScreenId ? 'border-port-text' : shot.scene.shotSheet?.checked ? 'border-port-success' : 'border-port-border'}`}
                  style={{ left: shot.startSec * pxPerSec, width, backgroundImage: poster ? cssUrl(poster) : undefined, backgroundSize: 'auto 100%', transform: moving ? `translateX(${reorder.dx}px)` : undefined }}>
                  {width >= NUMBER_MIN_PX && (
                    <span className="port-media-overlay-strong absolute left-0.5 top-0.5 rounded px-1 text-[10px] font-medium leading-4 tabular-nums">{shot.number}</span>
                  )}
                </button>
              );
            })}
            {cuts.map((cut) => {
              const shot = shots[cut.index];
              const across = shots[cut.index + (cut.edge === 'end' ? 1 : -1)];
              // Too tight to grab without covering the clips beside it: zoom in to move this cut.
              if ([shot, across].some((side) => side && (side.endSec - side.startSec) * pxPerSec < CUT_MIN_CLIP_PX)) return null;
              const t = cut.edge === 'end' ? shot.endSec : shot.startSec;
              const dragging = cutDrag?.id === cut.id;
              const name = shotName ? shotName(shot.scene) : `shot ${shot.number}`;
              return (
                <div key={cut.id} role="slider" tabIndex={0} aria-orientation="horizontal"
                  aria-label={cut.edge === 'end' ? `Cut after ${name}` : `Start of ${name}`}
                  aria-valuemin={round2(cut.minSec)} aria-valuemax={round2(cut.maxSec)} aria-valuenow={round2(t)} aria-valuetext={formatTimecode(t)}
                  title="Drag to move this cut"
                  onPointerDown={(event) => onCutDown(event, cut)} onPointerMove={onCutMove}
                  onPointerUp={onCutUp} onPointerCancel={(event) => onCutUp(event, true)}
                  onKeyDown={(event) => nudgeCut(event, cut)}
                  className="group absolute inset-y-0 z-20 flex w-5 -translate-x-1/2 cursor-ew-resize touch-none select-none justify-center focus:outline-none pointer-coarse:w-8"
                  style={{ left: t * pxPerSec }}>
                  <span className={`my-1 w-1 rounded-full ${dragging ? (cutDrag.snapped ? 'bg-port-success' : 'bg-port-accent') : 'bg-port-text/50 group-hover:bg-port-accent group-focus-visible:bg-port-accent'}`} />
                </div>
              );
            })}
          </div>
          {effectRows.map((row) => (
            <div key={row.id} role="group" aria-label={row.label} className={`${ROW_CLS} ${FX_ROW_H}`}>{row.content}</div>
          ))}
          {cues.length > 0 && (
            <div className={`${ROW_CLS} h-5`} aria-hidden="true">
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
          {wave && (
            <svg aria-hidden="true" data-testid="shot-timeline-waveform" className={`${ROW_CLS} block h-8 text-port-accent/60`} width={durationSec * pxPerSec}
              viewBox={`0 0 ${durationSec} 1`} preserveAspectRatio="none">
              <path d={wave} fill="currentColor" />
            </svg>
          )}
          {audioLayers.map((layer) => (
            <div key={layer.id} role="group" aria-label={`Audio layer: ${layer.label || 'Audio'}`} className={`${ROW_CLS} ${AUDIO_LAYER_ROW_H}`}>
              <TimelineAudioLayerRow layer={layer} pxPerSec={pxPerSec} durationSec={durationSec} snapPoints={snapPoints}
                selected={layer.id === audioLayerId} onSelect={(id, toggle = true) => setAudioLayerId((current) => (toggle && current === id ? null : id))}
                onMove={onEditAudioLayers ? (id, startSec) => editLayer(id, { startSec }) : null} />
            </div>
          ))}
          {clipSoundRow.length > 0 && (
            <div role="group" aria-label="Clip sound" className={`${ROW_CLS} ${AUDIO_LAYER_ROW_H}`}>
              <TimelineClipSoundRow shots={clipSoundRow} pxPerSec={pxPerSec} shotName={shotName} activeSceneId={activeSceneId} onOpen={onOpenShot} />
            </div>
          )}
          <div ref={playheadRef} data-testid="shot-timeline-playhead" aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-20 w-px bg-port-error" />
        </div>
      </div>
      </div>
      {selectedLayer && onEditAudioLayers && (
        <TimelineAudioLayerPanel key={selectedLayer.id} layer={selectedLayer} playheadSec={() => timeRef.current}
          onChange={(patch) => editLayer(selectedLayer.id, patch)}
          onRemove={() => removeLayer(selectedLayer.id)} onClose={() => setAudioLayerId(null)} />
      )}
      {(() => {
        const picture = (shot) => (shot ? posters?.get(shot.sceneId) ?? scenePosterSrc(shot.scene, project.scenes) : null);
        if (effectsShot) {
          const panel = (
            <TimelineEffectsPanel scene={effectsShot.scene} name={nameOf(effectsShot)} options={effectOptions}
              isLast={project.scenes[project.scenes.length - 1]?.sceneId === effectsShot.sceneId}
              onChange={onEditShot ? (patch) => onEditShot(effectsShot.sceneId, patch) : null}
              selectedIndex={selectedFx?.sceneId === effectsShot.sceneId && fxGlitch ? selectedFx.index : null} onPreview={preview}
              picture={picture(effectsShot)} inPanel={!!libraryEl}
              onClose={() => { setEffectsOfId(null); setSelectedFx(null); }} />
          );
          return libraryEl ? createPortal(panel, libraryEl) : panel;
        }
        return libraryEl && effectOptions ? createPortal(
          <TimelineEffectLibrary onAdd={onEditShot && playheadShot ? (style) => addEffect(style) : null}
            shotName={playheadShot ? nameOf(playheadShot) : null} picture={picture(playheadShot)} />,
          libraryEl,
        ) : null;
      })()}
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
