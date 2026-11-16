import { useRef, useState } from 'react';
import { X, Zap } from 'lucide-react';
import SceneCutEffect from './SceneCutEffect.jsx';
import SceneGlitches from './SceneGlitches.jsx';
import SceneTransitions from './SceneTransitions.jsx';
import { effectTimeAt, glitchesWithMove, timelineShotEffects } from '../../lib/musicVideoTimelineEffects.js';

// An effect at least this wide shows its name.
const LABEL_MIN_PX = 48;
// A dragged effect is pulled onto a beat or lyric line within this many pixels.
const SNAP_PX = 6;
// A press on a marker becomes a drag after moving this far; short of it, it is a tap.
const DRAG_PX = 3;
// The narrowest an effect draws, so a short one can still be seen and grabbed.
const MARKER_MIN_PX = 8;

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
 * shot's effects, again to close them) with a marker at each in-shot effect,
 * as long as the effect runs, and a dot at each of its repeats; one switched
 * off is greyed.
 *
 * Tapping a marker opens its shot's effect controls (`onSelect(sceneId,
 * toggle)`: a lane tapped again closes them, a marker only ever opens them).
 * With `onEditShot(sceneId, patch)` a marker can be dragged along its shot (it
 * lands on a frame, pulled onto a nearby beat or lyric line) or nudged a frame
 * with the arrow keys; the shot's `glitches` are saved with that one moved.
 */
export function TimelineInShotEffects({ lanes, pxPerSec, shotName, selectedId = null, onSelect, onEditShot = null, snapPoints = [] }) {
  const [drag, setDrag] = useState(null);
  const pointer = useRef(null);
  const move = (shot, marker, atSec) => {
    if (Math.abs(atSec - marker.atSec) > 1e-4) onEditShot(shot.sceneId, { glitches: glitchesWithMove(shot.scene.glitches, marker.index, atSec) });
  };
  const onDown = (event, shot, marker) => {
    if (event.button != null && event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointer.current = { pointerId: event.pointerId, startX: event.clientX, shot, marker, dragging: false };
  };
  const onMove = (event) => {
    const press = pointer.current;
    if (!press || press.pointerId !== event.pointerId || !onEditShot) return;
    const dx = event.clientX - press.startX;
    if (!press.dragging && Math.abs(dx) < DRAG_PX) return;
    press.dragging = true;
    setDrag({ id: press.marker.id, ...effectTimeAt(press.shot, press.marker.t + dx / pxPerSec, snapPoints, SNAP_PX / pxPerSec) });
  };
  const onUp = (event, cancelled = false) => {
    const press = pointer.current;
    if (!press || press.pointerId !== event.pointerId) return;
    pointer.current = null;
    const landed = drag?.id === press.marker.id ? drag.atSec : null;
    setDrag(null);
    if (cancelled) return;
    if (!press.dragging) onSelect?.(press.shot.sceneId);
    else if (landed != null) move(press.shot, press.marker, landed);
  };
  const onKey = (event, shot, marker) => {
    if (event.key === 'Enter') { onSelect?.(shot.sceneId); return; }
    const dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!dir || !onEditShot) return;
    event.preventDefault();
    move(shot, marker, effectTimeAt(shot, marker.t + dir * (event.shiftKey ? 1 : 1 / 24)).atSec);
  };
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
        const shift = (atSec - marker.atSec) * pxPerSec;
        const name = shotName ? shotName(shot.scene) : `shot ${shot.number}`;
        const tone = dragged?.snapped ? 'bg-port-success' : marker.off ? 'bg-port-text-muted/50' : 'bg-port-accent';
        return [
          ...marker.repeats.map((t) => (
            <span key={`${marker.id}:${t}`} aria-hidden="true" className={`pointer-events-none absolute top-1/2 z-10 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-60 ${tone}`}
              style={{ left: t * pxPerSec + shift }} />
          )),
          <div key={marker.id} role="slider" tabIndex={0} aria-orientation="horizontal" data-effect-id={marker.id}
            aria-label={`${marker.label} in ${name}`} aria-valuemin={0} aria-valuemax={Math.round((shot.endSec - shot.startSec) * 100) / 100}
            aria-valuenow={Math.round(atSec * 100) / 100} aria-valuetext={`${atSec.toFixed(2)}s into the shot`}
            title={`${marker.label} at ${atSec.toFixed(2)}s${onEditShot ? ' · drag to move' : ''}`}
            onPointerDown={(event) => onDown(event, shot, marker)} onPointerMove={onMove}
            onPointerUp={onUp} onPointerCancel={(event) => onUp(event, true)}
            onKeyDown={(event) => onKey(event, shot, marker)}
            className={`group absolute inset-y-0 z-10 flex min-w-5 -translate-x-1.5 touch-none select-none items-center px-1.5 focus:outline-none pointer-coarse:min-w-8 pointer-coarse:-translate-x-3 pointer-coarse:px-3 ${onEditShot ? 'cursor-ew-resize' : 'cursor-pointer'}`}
            style={{ left: (shot.startSec + atSec) * pxPerSec }}>
            <span className={`h-3.5 rounded-sm ring-port-text group-hover:ring-1 group-focus-visible:ring-1 ${tone}`}
              style={{ width: Math.max(MARKER_MIN_PX, (marker.lengthSec || 0) * pxPerSec) }} />
          </div>,
        ];
      }))}
    </>
  );
}

/**
 * One shot's effects, configured under the timeline with the shot card's own
 * controls: the effect over each cut, how it hands over to the next shot, and
 * its in-shot effects. `onChange(patch)` saves the shot's fields.
 */
export function TimelineEffectsPanel({ scene, name, options, isLast, onChange, onClose }) {
  // The shot card may be open on the same shot in the drawer: its field ids stay its own.
  const fieldId = (field) => `mv-timeline-${scene.sceneId}-${field}`;
  const camera = (options.cameras || []).find((entry) => entry?.id && entry.id === scene.shotSheet?.cameraId) || null;
  return (
    <section aria-label={`Effects of ${name}`} className="space-y-2 border-t border-port-border px-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-1 text-sm font-medium text-port-text">
          <Zap size={14} aria-hidden="true" className="shrink-0 text-port-accent" /> <span className="truncate">{name}</span>
        </h3>
        <button type="button" onClick={onClose} aria-label="Close effects" title="Close effects"
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded border border-port-border text-port-text-muted hover:text-port-text pointer-fine:sm:min-h-[28px] pointer-fine:sm:min-w-[28px]">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <SceneTransitions fieldId={fieldId} scene={scene} defaults={camera?.cuts || null} onChange={onChange} isLast={isLast} disabled={!onChange} />
      <SceneCutEffect fieldId={fieldId} scene={scene} isLast={isLast} onChange={onChange} planned={options.planned?.get(scene.sceneId)} disabled={!onChange} />
      <SceneGlitches fieldId={fieldId} scene={scene} onChange={onChange} disabled={!onChange} />
    </section>
  );
}
