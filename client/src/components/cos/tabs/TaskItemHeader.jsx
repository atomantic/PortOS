import { Server, Timer, TrendingUp } from 'lucide-react';
import { formatDurationMin } from '../../../utils/formatters';
import { describeEstimateBasis } from '../../../lib/cosDurationEstimate';

// Get success rate styling based on percentage
function getSuccessRateStyle(rate) {
  if (rate >= 70) return { bg: 'bg-port-success/15', text: 'text-port-success', label: 'high' };
  if (rate >= 40) return { bg: 'bg-port-warning/15', text: 'text-port-warning', label: 'moderate' };
  return { bg: 'bg-port-error/15', text: 'text-port-error', label: 'low' };
}

export default function TaskItemHeader({ task, apps, targetInstanceId, targetInstanceName, durationEstimate, isSystem, requiresApproval, approving, handleApprove, approvalHint }) {
  return (
    <div className="flex items-center gap-2 mb-1 flex-wrap">
      <span className="text-sm font-mono text-gray-500 min-w-0 break-words">{task.id}</span>
      {task.metadata?.app && apps?.find(a => a.id === task.metadata.app)?.name && (
        <span className="px-1.5 py-0.5 text-xs bg-port-accent/20 text-port-accent rounded shrink-0" title={task.metadata.app}>
          {apps.find(a => a.id === task.metadata.app).name}
        </span>
      )}
      {targetInstanceName && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-port-accent-2/20 text-port-accent-2 rounded shrink-0"
          title={`Pinned to instance ${targetInstanceId} — only that instance runs this task`}
        >
          <Server size={10} aria-hidden="true" />
          {targetInstanceName}
        </span>
      )}
      {/* Duration estimate for pending tasks */}
      {durationEstimate && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-port-accent/10 text-port-accent/80 rounded"
          title={describeEstimateBasis(durationEstimate)}
        >
          <Timer size={10} aria-hidden="true" />
          {formatDurationMin(durationEstimate.estimatedMin, { approximate: true })}
        </span>
      )}
      {/* Success rate indicator for pending tasks */}
      {durationEstimate && durationEstimate.successRate !== undefined && durationEstimate.basis !== 'overall' && (
        (() => {
          const style = getSuccessRateStyle(durationEstimate.successRate);
          return (
            <span
              className={`flex items-center gap-1 px-1.5 py-0.5 text-xs rounded ${style.bg} ${style.text}`}
              title={`${style.label} success rate: ${durationEstimate.successRate}% of ${durationEstimate.basedOn} similar tasks succeeded`}
            >
              <TrendingUp size={10} aria-hidden="true" />
              {durationEstimate.successRate}%
            </span>
          );
        })()
      )}
      {isSystem && task.autoApproved && (
        <span className="px-2 py-0.5 rounded text-xs bg-port-success/20 text-port-success">AUTO</span>
      )}
      {requiresApproval && (
        <button
          onClick={handleApprove}
          disabled={approving}
          className="px-2 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors disabled:opacity-50"
          title={approvalHint}
          aria-label={approvalHint ? `Approve task ${task.id} — ${approvalHint}` : `Approve task ${task.id}`}
        >
          {approving ? 'APPROVING…' : 'APPROVE'}
        </button>
      )}
    </div>
  );
}
