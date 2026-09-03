import { GitBranch, GitMerge, Users } from 'lucide-react';
import { badge, statusDot, getTaskStatusGroup, pipelineStages } from './scheduleConstants';
import IntervalBadge from './IntervalBadge';

// Shared task identity row — status dot, monospace name, pipeline + swarm
// badges, and interval badge. Used by both the schedule card and the config
// drawer so the header stays consistent in one place.
export default function TaskHeader({ taskType, config }) {
  const group = getTaskStatusGroup(config);
  const stages = pipelineStages(config);
  const invocation = config.invocation;
  const automationOnly = invocation?.userInvokable === false;
  // Swarm (`/do:next --swarm`) is on when the global default carries a size ≥2.
  // Per-app overrides aren't reflected in this global header (the per-app row
  // shows its own override select).
  const swarmCount = config.taskMetadata?.swarmCount;
  const swarmOn = Number.isInteger(swarmCount) && swarmCount >= 2;
  const branchesPerAgent = config.taskMetadata?.branchesPerAgent;
  const branchBatchOn = taskType === 'branch-reconcile' && Number.isInteger(branchesPerAgent) && branchesPerAgent > 0;
  return (
    <div className="space-y-1.5 min-w-0">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(group)}`} title={group} aria-hidden="true" />
          <span className="font-mono text-sm text-white truncate leading-tight" title={taskType}>{taskType}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          {automationOnly && (
            <span
              className={`${badge('warning')} whitespace-nowrap`}
              title={invocation.description || 'Runs as part of another automation and is not directly invokable.'}
            >
              {invocation.label || 'Automation-only'}
            </span>
          )}
          {swarmOn && (
            <span className={`${badge('cyan')} whitespace-nowrap`} title={`Swarm mode — claims & ships up to ${swarmCount} independent issues in parallel per run`}>
              <Users size={11} className="inline mr-0.5" />
              ×{swarmCount}
            </span>
          )}
          {branchBatchOn && (
            <span className={`${badge('cyan')} whitespace-nowrap`} title={`Branch-reconcile batch — up to ${branchesPerAgent} branch(es) per coordinator run`}>
              <GitBranch size={11} className="inline mr-0.5" />
              ×{branchesPerAgent}
            </span>
          )}
          {stages?.length > 0 && (
            <span className={`${badge('purple')} whitespace-nowrap`} title={stages.map(s => s.name).join(' → ')}>
              <GitMerge size={11} className="inline mr-0.5" />
              {stages.length}
            </span>
          )}
          <IntervalBadge type={config.type} cronExpression={config.cronExpression} perpetual={config.perpetual} />
        </div>
      </div>
      {config.description && (
        <p className="text-xs text-gray-400 line-clamp-2" title={config.description}>{config.description}</p>
      )}
      {automationOnly && invocation.description && (
        <p className="text-xs text-port-warning/80">{invocation.description}</p>
      )}
    </div>
  );
}
