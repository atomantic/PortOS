import { useState } from 'react';
import { useNavigate } from 'react-router';
import toast from '../ui/Toast';
import {
  AlertCircle,
  AlertTriangle,
  XCircle,
  Brain,
  Newspaper,
  ListTodo,
  MessageSquare,
  ChevronRight,
  ChevronDown,
  X,
  Zap,
  Unlock,
  GitBranch,
  Play
} from 'lucide-react';
import * as api from '../../services/api';
import ProvenanceChip from '../ui/ProvenanceChip';
import { timeAgo } from '../../utils/formatters';

// One app's leftover branches as a single line — "4 branches · 3 NEEDS_PR · 1
// MERGED". Busiest state first so the row reads the same across refreshes.
export const formatBranchSummary = ({ leftoverCount, states }) => [
  `${leftoverCount} branch${leftoverCount === 1 ? '' : 'es'}`,
  ...Object.entries(states || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([state, count]) => `${count} ${state}`),
].join(' · ');

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
  MessageSquare,
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
  const [approvingTaskId, setApprovingTaskId] = useState(null);
  // Per-app, not one id: several apps can be queued from the same card, and a
  // single in-flight id would clear the first app's finish over a second app's
  // still-pending request and re-enable its button mid-flight.
  const [reconcileState, setReconcileState] = useState({});
  const navigate = useNavigate();

  // The insight only clears once branch-reconcile has actually RUN, so the card
  // outlives the request — the button has to say it already went out, or the
  // operator queues the same app again on every glance.
  const reconcileButton = (app) => (
    reconcileState[app.appId] === 'queuing' ? { label: 'Queuing…', disabled: true }
      : reconcileState[app.appId] === 'queued' ? { label: 'Queued', disabled: true }
        : { label: 'Run Now', disabled: false }
  );

  const handleDismiss = (type) => {
    setDismissed(prev => [...prev, type]);
  };

  const handleAction = (insight) => {
    if (insight.type === 'approval' && insight.tasks?.[0]) {
      handleApproveTask(insight.tasks[0]);
      return;
    }
    // For blocked insights, toggle expand to show individual tasks
    if (insight.type === 'blocked' && insight.tasks?.length > 0) {
      setExpanded(prev => ({ ...prev, [insight.type]: !prev[insight.type] }));
      return;
    }
    // Leftover branches: one app can be reconciled straight from the banner;
    // several have to be named first, because "Run Now" is per-app and the
    // operator can't pick one they were never shown.
    if (insight.type === 'leftover-branches' && insight.apps?.length > 0) {
      if (insight.apps.length === 1) {
        handleRunReconcile(insight.apps[0]);
        return;
      }
      setExpanded(prev => ({ ...prev, [insight.type]: !prev[insight.type] }));
      return;
    }
    if (insight.action?.route) {
      navigate(insight.action.route);
    }
  };

  const handleApproveTask = async (task) => {
    setApprovingTaskId(task.id);
    const result = await api.approveCosTask(task.id, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setApprovingTaskId(null);
    if (!result) return;
    toast.success('Task approved');
    onRefresh?.();
  };

  const handleRunReconcile = async (app) => {
    setReconcileState(prev => ({ ...prev, [app.appId]: 'queuing' }));
    const result = await api.triggerCosOnDemandTask('branch-reconcile', app.appId, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result?.success) {
      // Back to Run Now — a rejected request left nothing queued to wait on.
      setReconcileState(prev => ({ ...prev, [app.appId]: undefined }));
      return;
    }
    setReconcileState(prev => ({ ...prev, [app.appId]: 'queued' }));
    toast.success(`Queued branch-reconcile for ${app.appName}`);
  };

  const handleUnblockTask = async (taskId, taskType) => {
    const result = await api.updateCosTask(taskId, { status: 'pending', type: taskType }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (!result) return;
    toast.success('Task unblocked and moved to pending');
    // Update the parent-owned queue and insight snapshot before starting the
    // slower full refresh. That keeps both the banner and task list honest while
    // the refresh is in flight; the parent also guards the refresh from writing
    // an older pre-unblock snapshot over this state.
    onTaskUnblocked?.(taskId);
    onRefresh?.();
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
  const approvalTask = primaryInsight.type === 'approval' ? primaryInsight.tasks?.[0] : null;
  const leftoverApps = primaryInsight.type === 'leftover-branches' ? (primaryInsight.apps || []) : [];
  // One app is actionable from the card itself; several have to be listed first.
  const singleLeftoverApp = leftoverApps.length === 1 ? leftoverApps[0] : null;
  const expandsLeftoverApps = leftoverApps.length > 1;
  const expandsInPlace = hasBlockedTasks || expandsLeftoverApps;
  const primaryButton = approvalTask && approvingTaskId === approvalTask.id
    ? { label: 'Approving…', disabled: true }
    : singleLeftoverApp ? reconcileButton(singleLeftoverApp)
      : expandsLeftoverApps ? { label: isExpanded ? 'Collapse' : `View ${leftoverApps.length} Apps`, disabled: false }
        : hasBlockedTasks ? { label: isExpanded ? 'Collapse' : 'View Tasks', disabled: false }
          : { label: primaryInsight.action?.label, disabled: false };

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

          {/* Expanded per-app leftover branches — names the app, what kind of
              leftovers it holds, and runs branch-reconcile for that app alone. */}
          {expandsLeftoverApps && isExpanded && (
            <div className="mt-2 space-y-1.5">
              {leftoverApps.map(app => (
                <div
                  key={app.appId}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-black/20 rounded px-2 py-1.5"
                  title={app.branches?.length ? `Leftover branches: ${app.branches.join(', ')}` : undefined}
                >
                  <GitBranch size={11} className="shrink-0 text-gray-500" />
                  <span className="text-xs text-gray-300 truncate">{app.appName}</span>
                  <span className="text-xs text-gray-500 shrink-0">{formatBranchSummary(app)}</span>
                  <span className="flex-1 text-xs text-gray-600 truncate text-right">
                    last run {timeAgo(app.lastUserReconcileAt)}
                  </span>
                  <button
                    onClick={() => handleRunReconcile(app)}
                    disabled={reconcileButton(app).disabled}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded transition-colors shrink-0 min-h-[28px] disabled:opacity-50"
                    title={`Queue branch-reconcile for ${app.appName}`}
                  >
                    <Play size={11} />
                    {reconcileButton(app).label}
                  </button>
                </div>
              ))}
              {primaryInsight.action?.route && (
                <button
                  onClick={() => navigate(primaryInsight.action.route)}
                  className="text-xs text-gray-500 hover:text-gray-300 underline"
                >
                  Open the branch-reconcile schedule
                </button>
              )}
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
              disabled={primaryButton.disabled}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded transition-colors min-h-[32px] disabled:opacity-50"
            >
              {primaryButton.label}
              {expandsInPlace
                ? (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
                : !approvalTask && <ChevronRight size={12} />
              }
            </button>
          )}
          <button
            onClick={() => handleDismiss(primaryInsight.type)}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center p-1.5 text-gray-500 hover:text-gray-300 hover:bg-white/5 rounded transition-colors"
            title="Dismiss" aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
