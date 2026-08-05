import { useState, useEffect, useRef } from 'react';
import { TrendingUp, TrendingDown, Minus, Clock } from 'lucide-react';
import { formatDurationMin } from '../../utils/formatters';

export default function ProgressSlider({ goal, onCommit }) {
  const stored = goal.progress ?? 0;
  const [draft, setDraft] = useState(stored);
  const [dragging, setDragging] = useState(false);
  // Per-goal so the label/input pairing stays unique if two panels ever co-exist.
  const sliderId = `goal-progress-${goal.id}`;

  // Adopt the stored percentage only when it actually changes underneath us (a
  // refresh, a peer sync, an edit elsewhere in the panel). Keying on the transition
  // instead of "any render where we aren't dragging" is what lets the committed
  // value stay on screen while the save is in flight and the goal prop is still the
  // pre-commit snapshot (issue #3520) — the old gate re-ran the moment `dragging`
  // flipped false and reset the slider before the request had even been answered.
  const lastStored = useRef(stored);
  useEffect(() => {
    if (lastStored.current === stored) return;
    lastStored.current = stored;
    if (!dragging) setDraft(stored);
  }, [stored, dragging]);

  // In-flight bookkeeping lives in refs, not state: a touch release fires touchend
  // AND a synthesized mouseup in the same task, so a state flag would still read
  // stale in the second handler and send the same percentage twice.
  const inFlight = useRef(null);
  const queued = useRef(null);

  const send = async (value) => {
    inFlight.current = value;
    let saved = false;
    try {
      // Only an explicit `false` means "the server never took this" — a handler
      // that returns nothing keeps the pre-#3520 optimistic behavior.
      saved = (await onCommit(value)) !== false;
    } catch {
      // Deliberately swallowed — `request()` already toasted the failure, so this
      // stays a single-layer error UI. `try` rather than `.catch()`: a handler that
      // throws before returning a promise would otherwise latch `inFlight` on and
      // freeze the slider on an unsaved value.
    }
    inFlight.current = null;
    const next = queued.current;
    queued.current = null;
    // A percentage the user set while this one was in flight supersedes it, whether
    // it succeeded or not — dropping it would leave the slider showing a value that
    // was never sent, which is the same lie this issue is about.
    if (next !== null && next !== value) {
      send(next);
      return;
    }
    // The reset is the fix: without it the panel keeps advertising a percentage the
    // database rejected until the user closes and re-opens it. Read through the ref
    // rather than a render closure so a value that arrived while the request was in
    // flight isn't undone by a rollback to the pre-commit snapshot.
    if (!saved) setDraft(lastStored.current);
  };

  const commit = () => {
    setDragging(false);
    // What the server already has, or is about to: re-releasing on that percentage
    // (touchend + mouseup, a blur right after, a key release that changed nothing)
    // must not re-send it.
    const settled = queued.current ?? inFlight.current ?? stored;
    if (draft === settled) return;
    if (inFlight.current !== null) {
      queued.current = draft;
      return;
    }
    send(draft);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label htmlFor={sliderId} className="text-xs font-medium text-gray-400">Progress</label>
        <span className="text-xs text-gray-300 font-mono">{draft}%</span>
      </div>
      <input
        id={sliderId}
        type="range"
        min="0"
        max="100"
        value={draft}
        onChange={e => { setDragging(true); setDraft(parseInt(e.target.value, 10)); }}
        onMouseUp={commit}
        onTouchEnd={commit}
        // Arrow/Home/End keys move a range input without ever firing mouseup, so a
        // keyboard-only user could otherwise never persist a value; blur catches a
        // pointer released off the track.
        onKeyUp={commit}
        onBlur={commit}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-port-border accent-port-accent"
      />
      {goal.velocity && (
        <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-500">
          <div className="flex items-center gap-1">
            {goal.velocity.trend === 'increasing' && <TrendingUp className="w-3 h-3 text-port-success" />}
            {goal.velocity.trend === 'decreasing' && <TrendingDown className="w-3 h-3 text-red-400" />}
            {goal.velocity.trend === 'stable' && <Minus className="w-3 h-3 text-gray-400" />}
            <span>{goal.velocity.percentPerMonth}%/mo</span>
          </div>
          {goal.velocity.projectedCompletion && (
            <span className="text-gray-600">
              ETA {new Date(goal.velocity.projectedCompletion + 'T00:00:00').toLocaleDateString()}
            </span>
          )}
        </div>
      )}
      {goal.timeTracking?.totalMinutes > 0 && (
        <div className="flex items-center gap-1 mt-1 text-xs text-gray-600">
          <Clock className="w-3 h-3" />
          {formatDurationMin(goal.timeTracking.totalMinutes)}
          {' total'}
          {goal.timeTracking.weeklyAverage > 0 && ` · ${goal.timeTracking.weeklyAverage}m/wk`}
        </div>
      )}
    </div>
  );
}
