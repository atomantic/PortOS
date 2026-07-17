import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from '../ui/Toast';
import {
  AlertCircle,
  AlertTriangle,
  XCircle,
  Brain,
  Newspaper,
  ListTodo,
  ChevronRight,
  ChevronDown,
  X,
  Zap,
  Unlock
} from 'lucide-react';
import * as api from '../../services/api';
import ProvenanceChip from '../ui/ProvenanceChip';

// The chip answers "why am I seeing this?" the same way the taste-identity and
// health surfaces do — but the honesty distinction the feature exists to enforce
// means the level must match how each insight was actually derived. Most insight
// types are direct counts read off records (N tasks awaiting approval, N blocked,
// N health issues) → data-backed. Only the two that lean on success-rate
// statistics — auto-skipped task types and the peak-productivity-hour suggestion
// — are genuinely modeled → inferred.
const INFERRED_INSIGHT_TYPES = new Set(['learning', 'peak-time']);

const DATA_BACKED_PROVENANCE = {
  level: 'data-backed',
  explainer:
    'Surfaced by your Chief of Staff from a live count of your own records — pending approvals, blocked tasks, health issues, your queue — then prioritized. The underlying number is read straight off your data, not modeled.',
  whatWouldChange:
    'Clearing the underlying items — approving, unblocking, resolving — updates or removes this on the next evaluation.',
};

const INFERRED_PROVENANCE = {
  level: 'inferred',
  explainer:
    'Surfaced by your Chief of Staff from statistical patterns in your task history — success rates by task type and time of day — not a value you set or a direct count.',
  whatWouldChange:
    'As more task runs accumulate and those success rates shift, this recommendation is recomputed or drops away.',
};

export const insightProvenance = (type) =>
  INFERRED_INSIGHT_TYPES.has(type) ? INFERRED_PROVENANCE : DATA_BACKED_PROVENANCE;

const ICON_MAP = {
  AlertCircle,
  AlertTriangle,
  XCircle,
  Brain,
  Newspaper,
  ListTodo,
  Zap
};

const PRIORITY_STYLES = {
  critical: {
    bg: 'bg-gradient-to-r from-port-error/20 to-port-error/5',
    border: 'border-port-error/50',
    iconColor: 'text-port-error',
    pulse: true
  },
  high: {
    bg: 'bg-gradient-to-r from-port-warning/20 to-port-warning/5',
    border: 'border-port-warning/50',
    iconColor: 'text-port-warning',
    pulse: false
  },
  medium: {
    bg: 'bg-gradient-to-r from-port-accent/15 to-port-accent/5',
    border: 'border-port-accent/30',
    iconColor: 'text-port-accent',
    pulse: false
  },
  low: {
    bg: 'bg-port-card',
    border: 'border-port-border',
    iconColor: 'text-gray-400',
    pulse: false
  },
  info: {
    bg: 'bg-port-card/50',
    border: 'border-port-border/50',
    iconColor: 'text-gray-500',
    pulse: false
  }
};

// `ChiefOfStaff.fetchData` now owns the actionable-insights fetch and passes the
// result down as `insights`, so this banner is presentational — it holds only
// dismiss/expand UI state. Every parent trigger that refetches CoS data (task
// mutations, socket-driven changes, health checks, the 30s poll) refreshes the
// banner for free, and the unblock path calls `onRefresh` up instead of owning
// its own poll. `insights` is null until the first parent fetch resolves; the
// parent preserves the last-good array across transient fetch failures.
export default function ActionableInsightsBanner({ insights, onTaskUnblocked, onRefresh }) {
  const [dismissed, setDismissed] = useState([]);
  const [expanded, setExpanded] = useState({});
  const navigate = useNavigate();

  const handleDismiss = (type) => {
    setDismissed(prev => [...prev, type]);
  };

  const handleAction = (insight) => {
    // For blocked insights, toggle expand to show individual tasks
    if (insight.type === 'blocked' && insight.tasks?.length > 0) {
      setExpanded(prev => ({ ...prev, [insight.type]: !prev[insight.type] }));
      return;
    }
    if (insight.action?.route) {
      navigate(insight.action.route);
    }
  };

  const handleUnblockTask = async (taskId, taskType) => {
    const result = await api.updateCosTask(taskId, { status: 'pending', type: taskType }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    toast.success('Task unblocked and moved to pending');
    // Ask the parent to refetch — its fetchData re-pulls insights so the
    // unblocked task drops out of the banner — and optimistically splice the
    // task list for instant feedback.
    onRefresh?.();
    onTaskUnblocked?.(taskId);
  };

  if (!insights) {
    return null;
  }

  const visibleInsights = insights.filter(i => !dismissed.includes(i.type));

  if (visibleInsights.length === 0) {
    return null;
  }

  const primaryInsight = visibleInsights[0];
  const remainingCount = visibleInsights.length - 1;

  const styles = PRIORITY_STYLES[primaryInsight.priority] || PRIORITY_STYLES.info;
  const Icon = ICON_MAP[primaryInsight.icon] || AlertCircle;
  const isExpanded = expanded[primaryInsight.type];
  const hasBlockedTasks = primaryInsight.type === 'blocked' && primaryInsight.tasks?.length > 0;

  return (
    <div className={`${styles.bg} border ${styles.border} rounded-lg p-3 mb-4 transition-all`}>
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`shrink-0 mt-0.5 ${styles.iconColor} ${styles.pulse ? 'animate-pulse' : ''}`}>
          <Icon size={18} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-white text-sm">
              {primaryInsight.title}
            </span>
            {primaryInsight.priority === 'critical' && (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-port-error/30 text-port-error rounded uppercase">
                Urgent
              </span>
            )}
            <ProvenanceChip {...insightProvenance(primaryInsight.type)} />
          </div>
          {primaryInsight.description && !isExpanded && (
            <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">
              {primaryInsight.description}
            </p>
          )}

          {/* Expanded blocked tasks list */}
          {hasBlockedTasks && isExpanded && (
            <div className="mt-2 space-y-1.5">
              {primaryInsight.tasks.map(task => (
                <div key={task.id} className="flex items-center gap-2 bg-black/20 rounded px-2 py-1.5">
                  <span className="flex-1 text-xs text-gray-300 truncate" title={task.description}>
                    {task.description}
                  </span>
                  <button
                    onClick={() => handleUnblockTask(task.id, task.taskType)}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-port-success/20 hover:bg-port-success/30 text-port-success rounded transition-colors shrink-0 min-h-[28px]"
                    title="Unblock and move to pending"
                  >
                    <Unlock size={11} />
                    Unblock
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Additional insights indicator */}
          {remainingCount > 0 && (
            <div className="flex items-center gap-1 mt-1.5 text-xs text-gray-500">
              <Zap size={10} />
              <span>+{remainingCount} more action{remainingCount > 1 ? 's' : ''} available</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {primaryInsight.action && (
            <button
              onClick={() => handleAction(primaryInsight)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded transition-colors min-h-[32px]"
            >
              {hasBlockedTasks ? (isExpanded ? 'Collapse' : 'View Tasks') : primaryInsight.action.label}
              {hasBlockedTasks
                ? (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
                : <ChevronRight size={12} />
              }
            </button>
          )}
          <button
            onClick={() => handleDismiss(primaryInsight.type)}
            className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-white/5 rounded transition-colors min-w-[32px] min-h-[32px] flex items-center justify-center"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
