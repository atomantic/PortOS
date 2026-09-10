import { GitBranch, GitMerge, ListOrdered, Users } from 'lucide-react';
import { taskLabels, badge, statusDot, getTaskStatusGroup, pipelineStages } from './scheduleConstants';
import IntervalBadge from './IntervalBadge';

// Shared task identity row — status dot, monospace name, pipeline + swarm
// badges, and interval badge. Used by both the schedule card and the config
// drawer so the header stays consistent in one place.
export default function TaskHeader({ taskType, config, orderStep }) {
  const group = getTaskStatusGroup(config);
  const stages = pipelineStages(config);
  const invocation = config.invocation;
  const automationOnly = invocation?.userInvokable === false;
  // Swarm (`/do:next --swarm`) is on when the global default carries a size ≥2.
  // Per-app overrides aren't reflected in this global header (the per-app row
  // shows its own override select).
  const swarmCount = config.taskMetadata?.swarmCount;
  const swarmOn = Number.isInteger(swarmCount) && swarmCount >= 2;
  // Advisory predecessors, named by task type. `orderStep` is passed in rather
  // than read off the config: it is ranked across the whole schedule, which a
  // single task config cannot know.
  const suggestedAfter = Array.isArray(config.suggestedAfter) ? config.suggestedAfter : [];
  const branchesPerAgent = config.taskMetadata?.branchesPerAgent;
  const branchBatchOn = taskType === 'branch-reconcile' && Number.isInteger(branchesPerAgent) && branchesPerAgent > 0;
  return (
    <div className="space-y-1.5 min-w-0">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot(group)}`} title={group} aria-hidden="true" />
          <span className="font-mono text-sm text-white truncate leading-tight" title={taskType}>{config.displayName || taskType}</span>
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
          {/* Where this task falls in the advisory order — only for tasks that
              actually participate in it, so an unordered task isn't mislabeled
              as "the first thing to run". */}
          {Number.isInteger(orderStep) && (
            <span
              className={`${badge('gray')} whitespace-nowrap`}
              title={suggestedAfter.length > 0
                ? `Suggested order step ${orderStep} — run ${suggestedAfter.join(', ')} first (advisory, never enforced)`
                : `Suggested order step ${orderStep} — nothing is suggested before this one`}
            >
              <ListOrdered size={11} className="inline mr-0.5" />
              {orderStep}
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
          <IntervalBadge type={config.type} cronExpression={config.cronExpression} perpetual={config.perpetual} autoStart={config.autoStart} />
        </div>
      </div>
      {config.description && (
        <p className="text-xs text-gray-400 line-clamp-2" title={config.description}>{config.description}</p>
      )}
      {/* The chips name real scheduled task types; `runGuidance` below is the why. */}
      {suggestedAfter.length > 0 && (
        <p className="text-xs text-gray-400 flex flex-wrap items-center gap-1">
          <span className="text-gray-500">Run first:</span>
          {suggestedAfter.map(dep => (
            <span key={dep} className={`${badge('gray')} font-mono`} title={`${dep} is a scheduled task — running it before ${taskType} is suggested, not required`}>{dep}</span>
          ))}
        </p>
      )}
      {config.runGuidance && <p className="text-xs text-gray-500 line-clamp-2" title={config.runGuidance}>{config.runGuidance}</p>}
      {taskLabels(config).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {taskLabels(config).map(label => <span key={label} className={badge('gray')}>{label}</span>)}
        </div>
      )}
      {automationOnly && invocation.description && (
        <p className="text-xs text-port-warning/80">{invocation.description}</p>
      )}
    </div>
  );
}
