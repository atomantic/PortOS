import { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, Minus, Clock } from 'lucide-react';
import { formatDurationMin } from '../../utils/formatters';

export default function ProgressSlider({ goal, onCommit }) {
  const [draft, setDraft] = useState(goal.progress ?? 0);
  const [dragging, setDragging] = useState(false);

  // Sync draft when goal changes externally (not during drag)
  useEffect(() => {
    if (!dragging) setDraft(goal.progress ?? 0);
  }, [goal.progress, dragging]);

  const commit = () => {
    setDragging(false);
    if (draft !== (goal.progress ?? 0)) onCommit(draft);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-gray-400">Progress</span>
        <span className="text-xs text-gray-300 font-mono">{draft}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={draft}
        onChange={e => { setDragging(true); setDraft(parseInt(e.target.value, 10)); }}
        onMouseUp={commit}
        onTouchEnd={commit}
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
