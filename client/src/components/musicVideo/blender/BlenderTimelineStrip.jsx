import { useEffect, useMemo, useRef } from 'react';
import { BLENDER_SHOT_STAGES, blenderShotStage, blenderShotTiming } from '../../../lib/musicVideoBlender.js';
import { formatCount, formatDurationSec } from '../../../utils/formatters.js';

const STAGE_FILL = {
  final: 'bg-port-success/70',
  preview: 'bg-port-accent/60',
  stale: 'bg-port-warning/70',
  rendering: 'bg-port-accent animate-pulse',
  failed: 'bg-port-error/70',
  // A shot with nothing rendered is still a shot: it has to read against the strip's dark ground.
  none: 'bg-port-text-muted/35',
};
const STAGE_LABELS = Object.fromEntries(BLENDER_SHOT_STAGES);

/**
 * The film across the song: section bands on top, every shot below at its
 * true position and length, coloured by how far it is rendered, with the
 * player's position marked. One tab stop (the selected shot); Left/Right step
 * shots, Home/End jump to the ends. The legend names each colour in words.
 */
export default function BlenderTimelineStrip({ state, sections = [], durationSec, selectedId, onSelect, playheadSec = null }) {
  const shots = state.manifest?.shots || [];
  // The playhead moves several times a second; the stages only change with the state.
  const stages = useMemo(() => (state.manifest?.shots || []).map((shot) => blenderShotStage(state, shot.id)), [state]);
  const buttons = useRef(new Map());
  // The shot a key step asked for. The selection is a URL change, which React commits as a
  // transition: a held arrow key fires again before it lands, so each step counts from here, not
  // from the selection last drawn. Focus follows once the selection catches up.
  const stepTarget = useRef(null);
  useEffect(() => {
    if (stepTarget.current !== selectedId) return;
    stepTarget.current = null;
    buttons.current.get(selectedId)?.focus();
  }, [selectedId]);

  if (!shots.length || !(durationSec > 0)) return null;
  const percent = (sec) => `${Math.max(0, Math.min(100, (sec / durationSec) * 100))}%`;
  const selectedIndex = shots.findIndex((shot) => shot.id === selectedId);
  const tabStopId = selectedIndex === -1 ? shots[0].id : selectedId;
  const onKeyDown = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const pending = shots.findIndex((shot) => shot.id === stepTarget.current);
    const from = pending === -1 ? selectedIndex : pending;
    const moves = { ArrowRight: from + 1, ArrowLeft: from === -1 ? 0 : from - 1, Home: 0, End: shots.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const shot = shots[Math.max(0, Math.min(shots.length - 1, moves[event.key]))];
    if (shot.id === (stepTarget.current ?? selectedId)) return;
    stepTarget.current = shot.id;
    onSelect(shot.id);
  };

  return (
    <div className="min-w-0 space-y-1">
      <div className="relative">
        {sections.length > 0 && (
          <div aria-hidden="true" className="relative h-4 overflow-hidden rounded-t border border-b-0 border-port-border text-[10px] leading-4 text-port-text-muted">
            {sections.map((section, index) => (
              <span
                // Analysis sections carry no id; their start time is their identity.
                key={`${section.startSec}-${section.label || index}`}
                className={`absolute inset-y-0 truncate border-l border-port-border px-1 ${index % 2 ? 'bg-port-bg' : 'bg-port-card'}`}
                style={{ left: percent(section.startSec), width: percent(Math.max(0, section.endSec - section.startSec)) }}
              >
                {section.label}
              </span>
            ))}
          </div>
        )}
        <div
          role="toolbar"
          aria-label="Shots across the song"
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          // A step still pending when focus leaves must not steer the next one.
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) stepTarget.current = null; }}
          className={`relative box-content h-8 overflow-hidden border border-port-border bg-port-bg pointer-coarse:h-11 ${sections.length ? 'rounded-b' : 'rounded'}`}
        >
          {shots.map((shot, index) => {
            const selected = shot.id === selectedId;
            return (
              <button
                key={shot.id}
                type="button"
                ref={(node) => { if (node) buttons.current.set(shot.id, node); else buttons.current.delete(shot.id); }}
                tabIndex={shot.id === tabStopId ? 0 : -1}
                aria-pressed={selected}
                aria-label={`${shot.id}${shot.label ? ` ${shot.label}` : ''}, ${blenderShotTiming(shot)}, ${STAGE_LABELS[stages[index]].toLowerCase()}`}
                title={`${shot.id}${shot.label ? ` · ${shot.label}` : ''} · ${blenderShotTiming(shot)} · ${STAGE_LABELS[stages[index]]}`}
                onClick={() => { stepTarget.current = null; onSelect(shot.id); }}
                className={`absolute inset-y-0 min-w-[3px] border-l border-port-bg focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent ${STAGE_FILL[stages[index]]} ${selected ? 'z-10 ring-2 ring-inset ring-port-text' : 'hover:brightness-125'}`}
                style={{ left: percent(shot.start), width: percent(shot.end - shot.start) }}
              />
            );
          })}
        </div>
        {Number.isFinite(playheadSec) && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-20 w-px bg-port-text" style={{ left: percent(playheadSec) }} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-port-text-muted">
        <span>{formatCount(shots.length)} {shots.length === 1 ? 'shot' : 'shots'} · {formatDurationSec(durationSec)}</span>
        {BLENDER_SHOT_STAGES.map(([stage, label]) => {
          const count = stages.filter((entry) => entry === stage).length;
          return count ? (
            <span key={stage} className="inline-flex items-center gap-1">
              <span aria-hidden="true" className={`h-2 w-2 rounded-sm ${STAGE_FILL[stage].replace(' animate-pulse', '')}`} />
              {label} {formatCount(count)}
            </span>
          ) : null;
        })}
        <span className="max-sm:hidden">Left and Right step shots while the strip has focus.</span>
      </div>
    </div>
  );
}
