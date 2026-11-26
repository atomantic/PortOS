import { useRef, useState } from 'react';
import { ChevronLeft, X, Zap } from 'lucide-react';
import EffectThumb from './EffectThumb.jsx';
import SceneCutEffect from './SceneCutEffect.jsx';
import SceneGlitches from './SceneGlitches.jsx';
import SceneTransitions from './SceneTransitions.jsx';
import { MUSIC_VIDEO_TRANSITIONS, MUSIC_VIDEO_TRANSITION_LABELS } from '../../../../server/lib/musicVideo/musicVideoTransitions.js';
import { effectTimeAt, effectTrimAt, glitchesWithEdit, timelineShotEffects } from '../../lib/musicVideoTimelineEffects.js';

// An effect at least this wide shows its name.
const LABEL_MIN_PX = 48;
// A dragged effect is pulled onto a beat or lyric line within this many pixels.
const SNAP_PX = 6;
// A press on a marker becomes a drag after moving this far; short of it, it is a tap.
const DRAG_PX = 3;
// The narrowest an effect draws, so a short one can still be seen and grabbed.
const MARKER_MIN_PX = 8;
// An effect at least this wide shows its two ends as handles to drag.
const TRIM_MIN_PX = 20;

/**
 * Each timeline shot's effects by kind (`timelineShotEffects`), and which of
 * the span kinds the video uses at all, so an unused kind's row can stay out.
 */
export function timelineEffectLanes(shots, options) {
  const lanes = shots.map((shot) => ({ shot, effects: timelineShotEffects(shot, options) }));
  return {
    lanes,
    has: {
      transitions: lanes.some(({ effects }) => effects.transitions.length > 0),
      cut: lanes.some(({ effects }) => effects.cut),
      image: lanes.some(({ effects }) => effects.image),
    },
  };
}

/** A span kind's items on the song's clock: `{ key, sceneId, startSec, endSec, label, name }` (`endSec` null: a moment). */
function spanItems(lanes, kind, shotName) {
  return lanes.flatMap(({ shot, effects }) => {
    const name = shotName ? shotName(shot.scene) : `Shot ${shot.number}`;
    if (kind === 'transitions') {
      return effects.transitions.map((fx) => {
        const cut = fx.side === 'in' ? shot.startSec : shot.endSec;
        // A wipe runs from the cut into the incoming shot; a glitch sits on the cut itself.
        return { key: `${shot.sceneId}:${fx.side}`, sceneId: shot.sceneId, startSec: cut, endSec: fx.lengthSec ? cut + fx.lengthSec : null,
          label: fx.label, name: `${fx.label} ${fx.side === 'in' ? 'into' : 'out of'} ${name}` };
      });
    }
    const fx = effects[kind];
    return fx ? [{ key: `${shot.sceneId}:${kind}`, sceneId: shot.sceneId, startSec: fx.startSec, endSec: fx.endSec, label: fx.label,
      name: `${fx.label} ${kind === 'cut' ? 'from' : 'over'} ${name}` }] : [];
  });
}

/**
 * One row of effects that each cover a stretch of the song (`kind`:
 * `transitions`, the effects over cuts; `cut`, how a shot hands over to the
 * next; `image`, a still's image effect), each a button that opens its shot's
 * effect controls (`onSelect(sceneId)`).
 */
export function TimelineEffectSpans({ lanes, kind, pxPerSec, shotName, selectedId = null, onSelect }) {
  return spanItems(lanes, kind, shotName).map((item) => {
    const width = Math.max(MARKER_MIN_PX, item.endSec == null ? 0 : (item.endSec - item.startSec) * pxPerSec);
    // A moment (a glitch on a cut) is centered on it.
    const left = item.endSec == null ? item.startSec * pxPerSec - width / 2 : item.startSec * pxPerSec;
    const selected = item.sceneId === selectedId;
    return (
      <button key={item.key} type="button" onClick={() => onSelect?.(item.sceneId)} aria-pressed={selected} aria-label={item.name} title={item.name}
        className={`absolute inset-y-0.5 z-10 flex items-center overflow-hidden rounded-sm border bg-port-accent/25 px-0.5 text-left text-[10px] leading-none text-port-text pointer-coarse:min-h-11 ${selected ? 'border-port-accent' : 'border-port-accent/40 hover:border-port-accent'}`}
        style={{ left, width }}>
        {width >= LABEL_MIN_PX && <span className="truncate" aria-hidden="true">{item.label}</span>}
      </button>
    );
  });
}

/**
 * The in-shot effects row: under each clip a lane (tap it to configure that
 * shot's effects, again to close them) with each in-shot effect as a bar as
 * long as it plays, and a dot at each of its repeats; one switched off is greyed.
 *
 * Tapping an effect selects it (`onSelectEffect(sceneId, index)`). With
 * `onEditShot(sceneId, patch)` its middle drags it along its shot and its two
 * ends drag to change when it starts or stops (each lands on a frame, pulled
 * onto a nearby beat or lyric line); arrow keys do the same a frame at a time.
 * The shot's `glitches` are saved with that one changed.
 */
export function TimelineInShotEffects({ lanes, pxPerSec, shotName, selectedId = null, selectedEffect = null, onSelect, onSelectEffect, onEditShot = null, snapPoints = [] }) {
  const [drag, setDrag] = useState(null);
  const pointer = useRef(null);
  const save = (shot, marker, next) => {
    const patch = {};
    if (Math.abs(next.atSec - marker.atSec) > 1e-4) patch.atSec = next.atSec;
    if (next.lengthSec != null && Math.abs(next.lengthSec - marker.playSec) > 1e-4) patch.lengthSec = next.lengthSec;
    if (Object.keys(patch).length) onEditShot(shot.sceneId, { glitches: glitchesWithEdit(shot.scene.glitches, marker.index, patch) });
  };
  const landing = (shot, marker, mode, t, snap = true) => (mode === 'move'
    ? { ...effectTimeAt(shot, t, snap ? snapPoints : [], snap ? SNAP_PX / pxPerSec : 0), lengthSec: null }
    : effectTrimAt(shot, marker, mode, t, snap ? snapPoints : [], snap ? SNAP_PX / pxPerSec : 0));
  const onDown = (event, shot, marker, mode) => {
    if (event.button != null && event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointer.current = { pointerId: event.pointerId, startX: event.clientX, shot, marker, mode, dragging: false };
  };
  const onMove = (event) => {
    const press = pointer.current;
    if (!press || press.pointerId !== event.pointerId || !onEditShot) return;
    const dx = event.clientX - press.startX;
    if (!press.dragging && Math.abs(dx) < DRAG_PX) return;
    press.dragging = true;
    const { marker, mode } = press;
    const from = mode === 'end' ? marker.t + marker.playSec : marker.t;
    setDrag({ id: marker.id, mode, ...landing(press.shot, marker, mode, from + dx / pxPerSec) });
  };
  const onUp = (event, cancelled = false) => {
    const press = pointer.current;
    if (!press || press.pointerId !== event.pointerId) return;
    pointer.current = null;
    const landed = drag?.id === press.marker.id ? drag : null;
    setDrag(null);
    if (cancelled) return;
    if (!press.dragging) onSelectEffect?.(press.shot.sceneId, press.marker.index);
    else if (landed) save(press.shot, press.marker, landed);
  };
  const onKey = (event, shot, marker, mode) => {
    if (event.key === 'Enter') { onSelectEffect?.(shot.sceneId, marker.index); return; }
    const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!dir || !onEditShot) return;
    event.preventDefault();
    const from = mode === 'end' ? marker.t + marker.playSec : marker.t;
    save(shot, marker, landing(shot, marker, mode, from + dir * (event.shiftKey ? 1 : 1 / 24), false));
  };
  const handleCls = 'absolute inset-y-1 z-20 w-2 touch-none select-none cursor-ew-resize bg-port-text/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-port-text pointer-coarse:w-4';
  return (
    <>
      {lanes.map(({ shot, effects }) => {
        const name = shotName ? shotName(shot.scene) : `Shot ${shot.number}`;
        const labels = effects.markers.map((marker) => marker.label);
        return (
          <button key={shot.sceneId} type="button" onClick={() => onSelect?.(shot.sceneId, true)} aria-pressed={shot.sceneId === selectedId}
            aria-label={`In-shot effects of ${name}: ${labels.length ? labels.join(', ') : 'none'}`} title={labels.length ? labels.join(' · ') : 'No in-shot effects'}
            className={`absolute inset-y-0.5 rounded-sm border pointer-coarse:min-h-11 ${shot.sceneId === selectedId ? 'border-port-accent' : 'border-transparent hover:border-port-border'}`}
            style={{ left: shot.startSec * pxPerSec, width: Math.max(2, (shot.endSec - shot.startSec) * pxPerSec) }} />
        );
      })}
      {lanes.flatMap(({ shot, effects }) => effects.markers.flatMap((marker) => {
        const dragged = drag?.id === marker.id ? drag : null;
        const atSec = dragged ? dragged.atSec : marker.atSec;
        const playSec = dragged?.lengthSec ?? marker.playSec;
        const shift = (atSec - marker.atSec) * pxPerSec;
        const name = shotName ? shotName(shot.scene) : `shot ${shot.number}`;
        const selected = selectedEffect?.sceneId === shot.sceneId && selectedEffect.index === marker.index;
        const tone = dragged?.snapped ? 'bg-port-success' : marker.off ? 'bg-port-text-muted/50' : 'bg-port-accent';
        const left = (shot.startSec + atSec) * pxPerSec;
        const width = Math.max(MARKER_MIN_PX, playSec * pxPerSec);
        const span = Math.round((shot.endSec - shot.startSec) * 100) / 100;
        const edges = onEditShot && width >= TRIM_MIN_PX;
        return [
          ...marker.repeats.map((t) => (
            <span key={`${marker.id}:${t}`} aria-hidden="true" className={`pointer-events-none absolute top-1/2 z-10 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-60 ${tone}`}
              style={{ left: t * pxPerSec + shift }} />
          )),
          <div key={marker.id} role="slider" tabIndex={0} aria-orientation="horizontal" data-effect-id={marker.id}
            aria-label={`${marker.label} in ${name}`} aria-valuemin={0} aria-valuemax={span}
            aria-valuenow={Math.round(atSec * 100) / 100} aria-valuetext={`${atSec.toFixed(2)}s into the shot, ${playSec.toFixed(2)}s long`}
            title={`${marker.label} at ${atSec.toFixed(2)}s for ${playSec.toFixed(2)}s${onEditShot ? ' · drag to move' : ''}`}
            onPointerDown={(event) => onDown(event, shot, marker, 'move')} onPointerMove={onMove}
            onPointerUp={onUp} onPointerCancel={(event) => onUp(event, true)}
            onKeyDown={(event) => onKey(event, shot, marker, 'move')}
            className={`absolute inset-y-1 z-10 touch-none select-none overflow-hidden rounded-sm text-[10px] leading-none text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-port-text pointer-coarse:min-h-11 ${tone} ${selected ? 'ring-2 ring-port-text' : ''} ${onEditShot ? 'cursor-grab' : 'cursor-pointer'}`}
            style={{ left, width }}>
            {width >= LABEL_MIN_PX + 16 && <span aria-hidden="true" className="block truncate px-2.5 pt-1.5 pointer-coarse:pt-4">{marker.label}</span>}
          </div>,
          ...(edges ? ['start', 'end'].map((edge) => (
            <div key={`${marker.id}:${edge}`} role="slider" tabIndex={0} aria-orientation="horizontal"
              aria-label={`${edge === 'start' ? 'Start' : 'End'} of ${marker.label} in ${name}`}
              aria-valuemin={0} aria-valuemax={span} aria-valuenow={Math.round((edge === 'start' ? atSec : atSec + playSec) * 100) / 100}
              title={edge === 'start' ? 'Drag to start it earlier or later' : 'Drag to make it longer or shorter'}
              onPointerDown={(event) => onDown(event, shot, marker, edge)} onPointerMove={onMove}
              onPointerUp={onUp} onPointerCancel={(event) => onUp(event, true)}
              onKeyDown={(event) => onKey(event, shot, marker, edge)}
              className={`${handleCls} ${edge === 'start' ? 'rounded-l-sm' : 'rounded-r-sm -translate-x-full'}`}
              style={{ left: edge === 'start' ? left : left + width }} />
          )) : []),
        ];
      }))}
    </>
  );
}

/**
 * Every in-shot effect style as a tile with a live picture of it (`EffectThumb`
 * over `picture`, the shot it would land on): hovering or focusing a tile plays
 * the effect. `onPick(style)` (null disables the tiles); `selected` marks the
 * current style as pressed; `labelFor(label)` names each tile's action;
 * `dense` fits three to a row.
 */
function EffectStyleGrid({ onPick, picture, selected = null, labelFor, dense = false }) {
  const [playing, setPlaying] = useState(null);
  return (
    <ul className={`grid gap-1.5 ${dense ? 'grid-cols-3' : 'grid-cols-[repeat(auto-fill,minmax(7rem,1fr))]'}`}>
      {MUSIC_VIDEO_TRANSITIONS.map((style) => {
        const label = MUSIC_VIDEO_TRANSITION_LABELS[style];
        const on = () => setPlaying(style);
        const off = () => setPlaying((current) => (current === style ? null : current));
        return (
          <li key={style} className="min-w-0">
            <button type="button" onClick={() => onPick?.(style)} disabled={!onPick} title={label}
              aria-label={labelFor(label)} aria-pressed={selected == null ? undefined : selected === style}
              onPointerEnter={on} onPointerLeave={off} onFocus={on} onBlur={off}
              className={`w-full space-y-1 rounded border p-1 text-left ${dense ? 'text-[11px]' : 'text-xs'} text-port-text hover:border-port-accent disabled:opacity-50 ${selected === style ? 'border-port-accent bg-port-accent/15' : 'border-port-border bg-port-bg'}`}>
              <EffectThumb style={style} src={picture} playing={playing === style} />
              <span className="block break-words px-0.5 leading-tight">{label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The effects library: every in-shot effect style, each a tile that adds it at
 * the playhead to the shot on screen (`onAdd(style)`, null when nothing can
 * take one), its picture that shot's (`picture`).
 */
export function TimelineEffectLibrary({ onAdd, shotName, picture = null }) {
  return (
    <div className="space-y-2 p-2">
      <div className="px-1">
        <h3 className="text-sm font-medium text-port-text">Effects</h3>
        <p className="text-xs text-port-text-muted">{onAdd ? `Tap one to add it to ${shotName} at the playhead.` : 'Move the playhead onto a shot to add one.'}</p>
      </div>
      <EffectStyleGrid onPick={onAdd} picture={picture} labelFor={(label) => `Add ${label} at the playhead`} />
    </div>
  );
}

/**
 * The selected in-shot effect's style as the same tiles: each tap saves the
 * new style and cues the moment (`onPreview()`), so styles can be tried one
 * after another while the preview loops over it.
 */
function EffectStyleSwap({ glitch, index, onSwap, picture }) {
  return (
    <div role="group" aria-label={`Style of effect ${index + 1}`} className="space-y-1">
      <p className="text-xs text-port-text-muted">Effect {index + 1}: tap a style to swap it</p>
      <EffectStyleGrid onPick={onSwap} picture={picture} selected={glitch.style} labelFor={(label) => label} dense />
    </div>
  );
}

/**
 * One shot's effects, configured under the timeline with the shot card's own
 * controls: the effect over each cut, how it hands over to the next shot, and
 * its in-shot effects. `onChange(patch)` saves the shot's fields. With an
 * in-shot effect selected (`selectedIndex`) its style swaps lead, each swap
 * cueing it (`onPreview`), pictured on `picture`. `inPanel` (in the page's side
 * panel, in place of the library) makes Close a way back to the library.
 */
export function TimelineEffectsPanel({ scene, name, options, isLast, onChange, onClose, selectedIndex = null, onPreview = null, picture = null, inPanel = false }) {
  const glitches = Array.isArray(scene.glitches) ? scene.glitches : [];
  const selected = selectedIndex != null ? glitches[selectedIndex] : null;
  // The shot card may be open on the same shot in the drawer: its field ids stay its own.
  const fieldId = (field) => `mv-timeline-${scene.sceneId}-${field}`;
  const camera = (options.cameras || []).find((entry) => entry?.id && entry.id === scene.shotSheet?.cameraId) || null;
  return (
    <section aria-label={`Effects of ${name}`} className={`space-y-2 px-2 py-2 ${inPanel ? '' : 'border-t border-port-border'}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-1 text-sm font-medium text-port-text">
          <Zap size={14} aria-hidden="true" className="shrink-0 text-port-accent" /> <span className="truncate">{name}</span>
        </h3>
        <button type="button" onClick={onClose} aria-label={inPanel ? 'Back to the effects library' : 'Close effects'} title={inPanel ? 'Back to the effects library' : 'Close effects'}
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded border border-port-border text-port-text-muted hover:text-port-text pointer-fine:sm:min-h-[28px] pointer-fine:sm:min-w-[28px]">
          {inPanel ? <ChevronLeft size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
        </button>
      </div>
      {selected && (
        <EffectStyleSwap glitch={selected} index={selectedIndex} picture={picture}
          onSwap={onChange ? (style) => { onChange({ glitches: glitchesWithEdit(glitches, selectedIndex, { style }) }); onPreview?.(); } : null} />
      )}
      <SceneTransitions fieldId={fieldId} scene={scene} defaults={camera?.cuts || null} onChange={onChange} isLast={isLast} disabled={!onChange} />
      <SceneCutEffect fieldId={fieldId} scene={scene} isLast={isLast} onChange={onChange} planned={options.planned?.get(scene.sceneId)} disabled={!onChange} />
      <SceneGlitches fieldId={fieldId} scene={scene} onChange={onChange} disabled={!onChange} />
    </section>
  );
}
