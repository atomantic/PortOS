import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, FilePlus2, Maximize2, Pause, Play, Repeat, Scissors, Zap, ZoomIn, ZoomOut } from 'lucide-react';
import useKeyCapture from '../../hooks/useKeyCapture.js';
import { scenePosterSrc } from '../../lib/musicVideoPreview.js';
import { formatTimecode } from '../../utils/formatters.js';
import { buildBeatGridPoints } from '../../lib/beatGrid.js';
import {
  TIMELINE_MAX_PX_PER_SEC, TIMELINE_ZOOM_STEP, clampPxPerSec, fitPxPerSec, lyricSpans, rulerStepSec, rulerTicks, shotsWithCutAt, snapCutTime,
  timelineCuts, timelineDurationSec, timelineShotAt, timelineShots, timelineSplitAt, waveformPath,
} from '../../lib/musicVideoTimeline.js';
import { effectNaturalSec, effectTimeAt } from '../../lib/musicVideoTimelineEffects.js';
import { MUSIC_VIDEO_SHOT_GLITCH_LIMIT } from '../../lib/musicVideoTransitions.js';
import { NEW_GLITCH_STYLE } from './SceneGlitches.jsx';
import FilePickerButton from '../ui/FilePickerButton.jsx';
import { AUDIO_LAYER_ACCEPT, AUDIO_LAYER_ROW_H, TimelineAudioLayerPanel, TimelineAudioLayerRow, TimelineClipSoundRow, clipSoundShots } from './ShotTimelineAudioLayers.jsx';
import { TimelineEffectLibrary, TimelineEffectSpans, TimelineEffectsPanel, TimelineInShotEffects, timelineEffectLanes } from './ShotTimelineEffects.jsx';

// About the width of a ruler label ("12:30") at its 10px size.
const TICK_LABEL_PX = 30;
const zoomButtonCls = 'flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded border border-port-border bg-port-bg text-port-text hover:border-port-accent disabled:opacity-40 pointer-fine:sm:min-h-[28px] pointer-fine:sm:min-w-[28px]';
// How far inside the right edge the playhead may run before the view follows it.
const FOLLOW_MARGIN_PX = 24;
// A clip narrower than this has no room for its number, a lyric line for its words.
const NUMBER_MIN_PX = 26;
const LYRIC_TEXT_MIN_PX = 28;
// A cut's handle shows only where the shots on both sides stay tappable around it.
const CUT_MIN_CLIP_PX = 56;
// A dragged cut is pulled onto a beat, section edge or lyric line within this many pixels.
const CUT_SNAP_PX = 6;
// A mouse press on a clip becomes a reorder drag after moving this far.
const REORDER_DRAG_PX = 6;
// Every row is labeled in a column at the left; an effects row is tall enough to tap on a touch screen.
const ROW_CLS = 'relative border-b border-port-border';
const FX_ROW_H = 'h-7 pointer-coarse:h-12';
// The selected effect plays from this long before it to this long after it.
const LOOP_LEAD_SEC = 0.75;
// After a loop jump, how long the player gets to land before its clock is trusted again.
const LOOP_SETTLE_MS = 400;
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
export default function ShotTimeline({ project, activeSceneId = null, songClock = null, onSeek, onOpenShot, shotName, posters = null, onMoveCut = null, onReorder = null, effectOptions = null, onEditShot = null, onPreview = null, onSplitShot = null, libraryEl = null, onAddAudioLayer = null, onEditAudioLayers = null }) {
  const { shots: savedShots, off } = useMemo(() => timelineShots(project), [project]);
  const durationSec = timelineDurationSec(project, savedShots);
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
  const playheadRef = useRef(null);
  const readoutRef = useRef(null);
  const rulerRef = useRef(null);
  // The scroller's width decides the fit zoom; `zoom` null means "fit", so a resize keeps the whole song in view.
  const [viewWidth, setViewWidth] = useState(0);
  const [zoom, setZoom] = useState(null);
  const [onScreenId, setOnScreenId] = useState(null);
  const [playing, setPlaying] = useState(false);
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
  // The loop the frame loop enforces: playback that runs past the selected effect jumps back before it.
  const loopRef = useRef(null);
  const loopJump = useRef(-Infinity); // never jumped; 0 would read as a jump at clock zero and mute the first loop-back for LOOP_SETTLE_MS
  const timeRef = useRef(0);
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

  // The playhead follows the player's clock frame by frame, outside React.
  useEffect(() => {
    let handle;
    let drawn = { t: null, px: null };
    const tick = () => {
      const { pxPerSec: px, shots: list, songClock: clock, durationSec: total } = live.current;
      const reading = clock?.() || null;
      const t = Math.min(Math.max(0, reading?.t ?? timeRef.current), total);
      const isPlaying = !!reading?.playing;
      setPlaying((current) => (current === isPlaying ? current : isPlaying));
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
        const loop = loopRef.current;
        // One jump per pass: the player takes a few frames to land, and its clock still reads past the end meanwhile.
        if (loop && reading?.playing && t >= loop.end && performance.now() - loopJump.current > LOOP_SETTLE_MS) {
          loopJump.current = performance.now();
          loop.jump(loop.start);
        }
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

  // Drag a cut: the pointer is captured by its handle, and the save starts when it is let go.
  const cutPointer = useRef(null);
  const commitCut = (cut, t) => {
    if (Math.abs(t - cut.t) < 1e-4) { setCutDrag(null); return; }
    setCutDrag({ id: cut.id, t, snapped: false, saving: true });
    onSeek?.(t);
    Promise.resolve(onMoveCut(cut.sceneId, cut.edge, t)).catch(() => {}).finally(() => {
      setCutDrag((current) => (current?.id === cut.id && current.saving ? null : current));
    });
  };
  const onCutDown = (event, cut) => {
    if ((event.button != null && event.button !== 0) || cutDrag?.saving) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    cutPointer.current = { pointerId: event.pointerId, startX: event.clientX, cut };
    setCutDrag({ id: cut.id, t: cut.t, snapped: false });
  };
  const onCutMove = (event) => {
    const drag = cutPointer.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { pxPerSec: px } = live.current;
    const next = snapCutTime(drag.cut.t + (event.clientX - drag.startX) / px, drag.cut, snapPoints, CUT_SNAP_PX / px);
    setCutDrag({ id: drag.cut.id, ...next });
  };
  const onCutUp = (event, cancelled = false) => {
    const drag = cutPointer.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    cutPointer.current = null;
    if (cancelled || !cutDrag || cutDrag.id !== drag.cut.id) { setCutDrag(null); return; }
    commitCut(drag.cut, cutDrag.t);
  };
  const nudgeCut = (event, cut) => {
    const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!dir || cutDrag?.saving) return;
    event.preventDefault();
    commitCut(cut, snapCutTime(cut.t + dir * (event.shiftKey ? 1 : 1 / 24), cut).t);
  };

  // Drag a clip onto another with a mouse to move it there; a press that never moves is a tap.
  const [reorder, setReorder] = useState(null);
  const reorderPointer = useRef(null);
  const suppressClick = useRef(false);
  const indexAt = (clientX) => {
    const scroller = scrollerRef.current;
    const t = (clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft) / live.current.pxPerSec;
    const at = savedShots.findIndex((shot) => t < shot.endSec);
    return at < 0 ? savedShots.length - 1 : at;
  };
  const onClipDown = (event, index) => {
    if (!onReorder || event.pointerType !== 'mouse' || event.button !== 0) return;
    reorderPointer.current = { pointerId: event.pointerId, startX: event.clientX, index, dragging: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onClipMove = (event) => {
    const drag = reorderPointer.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.dragging && Math.abs(dx) < REORDER_DRAG_PX) return;
    drag.dragging = true;
    setReorder({ from: drag.index, to: indexAt(event.clientX), dx });
  };
  const onClipUp = (event, cancelled = false) => {
    const drag = reorderPointer.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    reorderPointer.current = null;
    setReorder(null);
    if (!drag.dragging) return;
    // The click that follows a drag's release is not a tap on the clip.
    suppressClick.current = true;
    requestAnimationFrame(() => { suppressClick.current = false; });
    const to = indexAt(event.clientX);
    if (!cancelled && to !== drag.index) onReorder(drag.index, to);
  };
  const activeIndex = savedShots.findIndex((shot) => shot.sceneId === activeSceneId);

  // The shot whose effects are being configured under the timeline, and the in-shot effect selected in it.
  const [effectsOfId, setEffectsOfId] = useState(null);
  const [selectedFx, setSelectedFx] = useState(null);
  const [loopOn, setLoopOn] = useState(true);
  const effectsShot = effectOptions ? savedShots.find((shot) => shot.sceneId === effectsOfId) || null : null;
  const playheadShot = savedShots.find((shot) => shot.sceneId === onScreenId) || null;
  const playheadGlitches = Array.isArray(playheadShot?.scene.glitches) ? playheadShot.scene.glitches : [];
  // Move the player to `t` without changing whether it plays.
  const cue = (t) => onPreview?.(roundMs(Math.max(0, t)), playing);
  // A new in-shot effect at the playhead, selected and cued.
  const addEffect = (style = NEW_GLITCH_STYLE) => {
    const t = timeRef.current;
    const shot = timelineShotAt(savedShots, t);
    if (!shot || t >= shot.endSec || !onEditShot) return;
    const glitches = Array.isArray(shot.scene.glitches) ? shot.scene.glitches : [];
    if (glitches.length >= MUSIC_VIDEO_SHOT_GLITCH_LIMIT) return;
    const { atSec } = effectTimeAt(shot, t);
    onEditShot(shot.sceneId, { glitches: [...glitches, { atSec, style }] });
    setEffectsOfId(shot.sceneId);
    setSelectedFx({ sceneId: shot.sceneId, index: glitches.length });
    cue(shot.startSec + atSec - LOOP_LEAD_SEC);
  };
  const nameOf = (shot) => (shotName ? shotName(shot.scene) : `Shot ${shot.number}`);
  const effectLanes = useMemo(() => (effectOptions ? timelineEffectLanes(shots, effectOptions) : null), [shots, effectOptions]);
  const selectEffects = (sceneId, toggle) => {
    setSelectedFx(null);
    setEffectsOfId((current) => (toggle && current === sceneId ? null : sceneId));
  };
  // The selected effect's stretch of the song with a little either side, the loop the preview plays.
  const fxShot = selectedFx ? savedShots.find((shot) => shot.sceneId === selectedFx.sceneId) : null;
  const fxGlitch = fxShot?.scene.glitches?.[selectedFx.index] || null;
  const loopRange = fxGlitch && Number.isFinite(fxGlitch.atSec) ? (() => {
    const start = fxShot.startSec + fxGlitch.atSec;
    const last = start + (fxGlitch.count > 1 && fxGlitch.everySec ? (fxGlitch.count - 1) * fxGlitch.everySec : 0);
    const end = Math.min(fxShot.endSec, last + (fxGlitch.lengthSec || effectNaturalSec(fxGlitch.style)));
    return { start: Math.max(0, start - LOOP_LEAD_SEC), end: Math.min(durationSec, end + LOOP_LEAD_SEC) };
  })() : null;
  loopRef.current = loopOn && loopRange && onPreview ? { ...loopRange, jump: (t) => onPreview(roundMs(t), true) } : null;
  const preview = () => { if (loopRange) cue(loopRange.start); };
  // Play or pause where the playhead is; with a selected effect looping, play starts its loop when the playhead is outside it.
  const togglePlay = () => {
    if (!onPreview) return;
    const t = timeRef.current;
    if (playing) { onPreview(roundMs(t), false); return; }
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
  const selectEffect = (sceneId, index) => {
    setEffectsOfId(sceneId);
    setSelectedFx({ sceneId, index });
    const shot = savedShots.find((entry) => entry.sceneId === sceneId);
    const at = shot?.scene.glitches?.[index]?.atSec;
    if (Number.isFinite(at)) cue(shot.startSec + at - LOOP_LEAD_SEC);
  };
  // The side panel starts at its top whenever it changes between the library and a shot's settings.
  const panelKey = effectsShot ? `${effectsShot.sceneId}:${selectedFx?.index ?? ''}` : '';
  useEffect(() => { if (libraryEl) libraryEl.scrollTop = 0; }, [libraryEl, panelKey]);
  const spanRow = (kind) => (
    <TimelineEffectSpans lanes={effectLanes.lanes} kind={kind} pxPerSec={pxPerSec} shotName={shotName}
      selectedId={effectsShot?.sceneId ?? null} onSelect={selectEffects} />
  );
  // An effect kind the video never uses keeps no row; in-shot effects always have one, to tap and add to.
  const effectRows = effectLanes ? [
    effectLanes.has.transitions && { id: 'transitions', label: 'Transitions', content: spanRow('transitions') },
    effectLanes.has.cut && { id: 'cut', label: 'Cut effects', content: spanRow('cut') },
    effectLanes.has.image && { id: 'image', label: 'Image effects', content: spanRow('image') },
    { id: 'in-shot', label: 'In-shot effects', content: (
      <TimelineInShotEffects lanes={effectLanes.lanes} pxPerSec={pxPerSec} shotName={shotName} selectedId={effectsShot?.sceneId ?? null}
        selectedEffect={selectedFx} onSelect={selectEffects} onSelectEffect={selectEffect} onEditShot={onEditShot} snapPoints={snapPoints} />
    ) },
  ].filter(Boolean) : [];
  const rowLabels = [
    ['Time', 'h-7'], ...(sections.length ? [['Sections', 'h-4']] : []), ['Shots', 'h-14'],
    ...effectRows.map((row) => [row.label, FX_ROW_H]), ...(cues.length ? [['Lyrics', 'h-5']] : []), ...(wave ? [['Song', 'h-8']] : []),
    ...audioLayers.map((layer) => [layer.label || 'Audio', AUDIO_LAYER_ROW_H, `audio:${layer.id}`]),
  ];

  const stepSec = rulerStepSec(pxPerSec);
  const ticks = useMemo(() => rulerTicks(durationSec, stepSec), [durationSec, stepSec]);
  const atFit = pxPerSec <= fit * 1.001;
  const atMax = pxPerSec >= TIMELINE_MAX_PX_PER_SEC;

  return (
    <section aria-label="Timeline" className="min-w-0 rounded-lg border border-port-border bg-port-card">
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1">
        {onPreview && (
          <button type="button" className={zoomButtonCls} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          </button>
        )}
        <output ref={readoutRef} aria-label="Playhead time" className="text-sm font-medium tabular-nums text-port-text">{formatTimecode(0)}</output>
        <span className="text-xs tabular-nums text-port-text-muted">/ {formatTimecode(durationSec)}</span>
        {cutDrag && draggedCut && (
          <span role="status" className={`truncate text-xs tabular-nums ${cutDrag.snapped ? 'text-port-success' : 'text-port-text-muted'}`}>
            Cut {formatTimecode(cutDrag.t)} ({cutDrag.t >= draggedCut.t ? '+' : '−'}{Math.abs(cutDrag.t - draggedCut.t).toFixed(2)}s)
          </span>
        )}
        {onReorder && activeIndex >= 0 && (
          <div role="group" aria-label="Move shot" className="flex items-center gap-1">
            <button type="button" className={zoomButtonCls} onClick={() => onReorder(activeIndex, activeIndex - 1)} disabled={activeIndex === 0}
              aria-label="Move shot earlier" title="Move shot earlier">
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <button type="button" className={zoomButtonCls} onClick={() => onReorder(activeIndex, activeIndex + 1)} disabled={activeIndex === savedShots.length - 1}
              aria-label="Move shot later" title="Move shot later">
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
        )}
        {onSplitShot && (
          <button type="button" className={zoomButtonCls} onClick={() => { const at = timelineSplitAt(savedShots, timeRef.current); if (at) onSplitShot(at.sceneId, at.atSec); }}
            disabled={!playheadShot} aria-label="Split the shot at the playhead" title="Split the shot at the playhead">
            <Scissors size={14} aria-hidden="true" />
          </button>
        )}
        {effectOptions && onEditShot && (
          <button type="button" className={zoomButtonCls} onClick={() => addEffect()}
            disabled={!playheadShot || playheadGlitches.length >= MUSIC_VIDEO_SHOT_GLITCH_LIMIT}
            aria-label="Add an effect at the playhead" title="Add an effect at the playhead">
            <Zap size={14} aria-hidden="true" />
          </button>
        )}
        {onPreview && effectOptions && (
          <button type="button" className={`${zoomButtonCls} ${loopOn && loopRange ? 'border-port-accent text-port-accent' : ''}`} onClick={() => setLoopOn((on) => !on)}
            aria-pressed={loopOn} aria-label="Loop the selected effect" title="Loop the selected effect while it plays">
            <Repeat size={14} aria-hidden="true" />
          </button>
        )}
        {onAddAudioLayer && (
          <FilePickerButton accept={AUDIO_LAYER_ACCEPT} disabled={addingLayer} className={zoomButtonCls}
            ariaLabel="Add an audio layer at the playhead" title={addingLayer ? 'Adding the audio layer…' : 'Add an audio file as a layer at the playhead'}
            onChange={(event) => addLayer(event.target.files?.[0])}>
            <FilePlus2 size={14} aria-hidden="true" />
          </FilePickerButton>
        )}
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
          <div ref={rulerRef} role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(durationSec)} aria-valuenow={0}
            className={`${ROW_CLS} h-7 cursor-pointer touch-none select-none`}
            onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp} onPointerCancel={onRulerUp}
            onKeyDown={(event) => {
              const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!dir) return;
              event.preventDefault();
              const t = Math.min(Math.max(0, timeRef.current + dir * (event.shiftKey ? 1 : 1 / 24)), durationSec);
              timeRef.current = t;
              onSeek?.(Math.round(t * 1000) / 1000);
            }}>
            {/* A label with no room before the end is left off rather than cut in half. */}
            {ticks.filter((t) => t * pxPerSec + TICK_LABEL_PX <= widthPx).map((t) => (
              <span key={t} className="pointer-events-none absolute inset-y-0 border-l border-port-border pl-1 text-[10px] leading-7 tabular-nums text-port-text-muted" style={{ left: t * pxPerSec }}>
                {tickLabel(t, stepSec)}
              </span>
            ))}
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
