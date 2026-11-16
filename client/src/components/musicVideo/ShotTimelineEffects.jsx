import { useMemo, useRef, useState } from 'react';
import { X, Zap } from 'lucide-react';
import SceneCutEffect from './SceneCutEffect.jsx';
import SceneGlitches from './SceneGlitches.jsx';
import SceneTransitions from './SceneTransitions.jsx';
import { effectTimeAt, glitchesWithMove, timelineShotEffects } from '../../lib/musicVideoTimelineEffects.js';

// A lane narrower than this has no room for its cut effects' names.
const LABEL_MIN_PX = 120;
// A dragged effect is pulled onto a beat or lyric line within this many pixels.
const SNAP_PX = 6;
// A press on a marker becomes a drag after moving this far; short of it, it is a tap.
const DRAG_PX = 3;
// The narrowest an effect draws, so a short one can still be seen and grabbed.
const MARKER_MIN_PX = 8;

/**
 * The timeline's effects track: under each clip, a lane naming the effects
 * over its cuts (start at the left, end at the right; a still's image effect
 * tints the whole lane) with a marker at each in-shot effect, as long as the
 * effect runs, and a dot at each of its repeats.
 *
 * Tap a lane or a marker to configure that shot's effects (`onSelect(sceneId)`).
 * With `onEditShot(sceneId, patch)` a marker can be dragged along its shot (it
 * lands on a frame, pulled onto a nearby beat or lyric line) or nudged a frame
 * with the arrow keys; the shot's `glitches` are saved with that one moved.
 */
export function TimelineEffectsTrack({ shots, pxPerSec, options, shotName, selectedId = null, onSelect, onEditShot = null, snapPoints = [] }) {
  const lanes = useMemo(() => shots.map((shot) => ({ shot, effects: timelineShotEffects(shot, options) })), [shots, options]);
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
    <div role="group" aria-label="Effects" className="relative h-7 border-t border-port-border pointer-coarse:h-12">
      {lanes.map(({ shot, effects }) => {
        const width = Math.max(2, (shot.endSec - shot.startSec) * pxPerSec);
        const name = shotName ? shotName(shot.scene) : `Shot ${shot.number}`;
        const mid = [...(effects.image ? [effects.image] : []), ...effects.markers.map((marker) => marker.label)];
        const parts = [
          effects.start.length ? `start ${effects.start.join(', ')}` : null,
          mid.length ? `mid-shot ${mid.join(', ')}` : null,
          effects.end.length ? `end ${effects.end.join(', ')}` : null,
        ].filter(Boolean);
        const roomy = width >= LABEL_MIN_PX;
        return (
          <button key={shot.sceneId} type="button" onClick={() => onSelect?.(shot.sceneId)} aria-pressed={shot.sceneId === selectedId}
            aria-label={`Effects of ${name}: ${parts.length ? parts.join('; ') : 'none'}`} title={parts.length ? parts.join(' · ') : 'No effects'}
            className={`absolute inset-y-0.5 flex items-center justify-between overflow-hidden rounded-sm border text-[10px] leading-none pointer-coarse:min-h-11 ${effects.image ? 'bg-port-accent/15' : ''} ${shot.sceneId === selectedId ? 'border-port-accent' : 'border-transparent hover:border-port-border'}`}
            style={{ left: shot.startSec * pxPerSec, width }}>
            {[['start', 'justify-start'], ['end', 'justify-end']].map(([slot, side]) => (
              <span key={slot} aria-hidden="true" className={`flex min-w-0 items-center gap-0.5 text-port-accent ${side} ${effects[slot].length ? 'max-w-[45%]' : ''}`}>
                {effects[slot].length > 0 && (roomy
                  ? <><Zap size={10} className="shrink-0" /><span className="truncate">{effects[slot][0]}</span></>
                  : <span className="h-3 w-0.5 rounded-full bg-port-accent" />)}
              </span>
            ))}
          </button>
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
    </div>
  );
}

/**
 * One shot's effects, configured under the timeline with the shot card's own
 * controls: the effect over each cut, how it hands over to the next shot, and
 * its in-shot effects. `onChange(patch)` saves the shot's fields.
 */
export function TimelineEffectsPanel({ scene, name, options, isLast, onChange, onClose }) {
  // The shot card may be open on the same shot beside this panel: its field ids stay its own.
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
