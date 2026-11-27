import { Brain } from 'lucide-react';
import { DRILL_LABELS } from '../constants';

// Shared header: drill label + position within the session.
export default function DrillHeader({ type, isTraining, drillIndex, drillCount }) {
  return (
    <div className="flex items-center justify-between text-sm text-gray-400">
      <span className="flex items-center gap-1.5 text-rose-400">
        <Brain size={14} />
        {DRILL_LABELS[type] || type}
        {isTraining && ' — Training'}
      </span>
      <span>Drill {drillIndex + 1} of {drillCount}</span>
    </div>
  );
}
