import { GitMerge } from 'lucide-react';
import { badge, statusDot, getTaskStatusGroup } from './scheduleConstants';
import IntervalBadge from './IntervalBadge';

// Shared task identity row — status dot, monospace name, pipeline badge, and
// interval badge. Used by both the schedule card and the config drawer so the
// header stays consistent in one place.
export default function TaskHeader({ taskType, config }) {
  const group = getTaskStatusGroup(config);
  const stages = config.taskMetadata?.pipeline?.stages;
  return (
    <div className="flex items-start gap-2">
      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${statusDot(group)}`} title={group} aria-hidden="true" />
      <span className="font-mono text-sm text-white break-all leading-tight flex-1 min-w-0">{taskType}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        {stages?.length > 0 && (
          <span className={badge('purple')} title={stages.map(s => s.name).join(' → ')}>
            <GitMerge size={11} className="inline mr-0.5" />
            {stages.length}
          </span>
        )}
        <IntervalBadge type={config.type} cronExpression={config.cronExpression} />
      </div>
    </div>
  );
}
