import { GitMerge, Users } from 'lucide-react';
import { badge, statusDot, getTaskStatusGroup } from './scheduleConstants';
import IntervalBadge from './IntervalBadge';

// Shared task identity row — status dot, monospace name, pipeline + swarm
// badges, and interval badge. Used by both the schedule card and the config
// drawer so the header stays consistent in one place.
export default function TaskHeader({ taskType, config }) {
  const group = getTaskStatusGroup(config);
  const stages = config.taskMetadata?.pipeline?.stages;
  // Swarm (`/do:next --swarm`) is on when the global default carries a size ≥2.
  // Per-app overrides aren't reflected in this global header (the per-app row
  // shows its own override select).
  const swarmCount = config.taskMetadata?.swarmCount;
  const swarmOn = Number.isInteger(swarmCount) && swarmCount >= 2;
  return (
    <div className="flex items-start gap-2">
      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${statusDot(group)}`} title={group} aria-hidden="true" />
      <span className="font-mono text-sm text-white break-all leading-tight flex-1 min-w-0">{taskType}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        {swarmOn && (
          <span className={badge('cyan')} title={`Swarm mode — claims & ships up to ${swarmCount} independent issues in parallel per run`}>
            <Users size={11} className="inline mr-0.5" />
            ×{swarmCount}
          </span>
        )}
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
