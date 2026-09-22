import { memo } from 'react';
import { Link } from 'react-router';
import {
  Clock,
  ChevronRight,
  CheckCircle,
  Timer,
  TrendingUp,
  TrendingDown,
  Sparkles
} from 'lucide-react';
import * as api from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';

/**
 * UpcomingTasksWidget - Shows a preview of upcoming scheduled tasks
 * Helps users understand what the CoS will work on next
 */
const UpcomingTasksWidget = memo(function UpcomingTasksWidget() {
  const { data: upcoming, loading, error } = useAutoRefetch(
    () => api.getCosUpcomingTasks(6, { silent: true }),
    60000
  );

  // Don't render during the initial load.
  if (loading) {
    return null;
  }

  if (!upcoming?.length) {
    // A genuine calculation failure (#7527 — the server now rejects rather
    // than returning a misleadingly "complete" empty array) with no prior
    // good result to fall back to. Say so instead of silently disappearing,
    // which used to be indistinguishable from "nothing is scheduled".
    if (error) {
      return (
        <div className="@container bg-port-card border border-port-border rounded-xl p-4 @md:p-6" role="status">
          <div className="flex items-center gap-3">
            <Clock className="w-6 h-6 text-gray-500" aria-hidden="true" />
            <div>
              <h3 className="text-lg font-semibold text-white">Upcoming Tasks</h3>
              <p className="text-sm text-port-warning">Schedule unavailable — retrying…</p>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  // Separate ready tasks from scheduled ones
  const readyTasks = upcoming.filter(t => t.status === 'ready');
  const scheduledTasks = upcoming.filter(t => t.status === 'scheduled');

  // Get interval type label
  const getIntervalLabel = (intervalType) => {
    const labels = {
      'on-demand': 'On Demand',
      cron: 'Scheduled'
    };
    return labels[intervalType] || intervalType;
  };

  // Get icon for task based on type
  const getTaskIcon = (taskType) => {
    const icons = {
      'security': '🔒',
      'ui-bugs': '🐛',
      'mobile-responsive': '📱',
      'ux': '🎨',
      'code-quality': '✨',
      'console-errors': '🔧',
      'performance': '⚡',
      'cos-enhancement': '🤖',
      'test-coverage': '🧪',
      'documentation': '📝',
      'feature-ideas': '💡',
      'plan-feature': '🗺️',
      'plan-task': '✅',
      'claim-issue': '🎯',
      'claim-work': '🎯',
      'accessibility': '♿',
      'dependency-updates': '📦',
      'do-replan': '📋'
    };
    return icons[taskType] || '📋';
  };

  return (
    <div className="@container bg-port-card border border-port-border rounded-xl p-4 @md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="text-2xl" aria-hidden="true">
            <Clock className="w-6 h-6 text-port-accent" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Upcoming Tasks</h3>
            <p className="text-sm text-gray-500">
              {readyTasks.length > 0 ? (
                <span className="text-port-success">{readyTasks.length} ready now</span>
              ) : (
                <span>Next: {scheduledTasks[0]?.eligibleInFormatted || 'none scheduled'}</span>
              )}
            </p>
          </div>
        </div>
        <Link
          to="/cos/schedule"
          className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors min-h-[40px] px-2"
        >
          <span className="hidden @xs:inline">Schedule</span>
          <ChevronRight size={16} />
        </Link>
      </div>

      {/* Task List */}
      <div className="space-y-2">
        {/* Ready Tasks */}
        {readyTasks.slice(0, 3).map((task, index) => (
          <div
            key={`${task.taskType}-ready-${index}`}
            className="flex items-center gap-3 p-2 rounded-lg bg-port-success/10 border border-port-success/20"
          >
            <span className="text-lg shrink-0" aria-hidden="true">
              {getTaskIcon(task.taskType)}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-white truncate">
                  {task.description}
                </span>
                {task.learningAdjusted && (
                  <span
                    className={`flex items-center gap-0.5 text-xs ${
                      task.adjustmentMultiplier < 1 ? 'text-port-success' : 'text-port-warning'
                    }`}
                    title={`Learning adjusted: ${task.successRate}% success rate`}
                  >
                    {task.adjustmentMultiplier < 1 ? (
                      <TrendingUp size={10} />
                    ) : (
                      <TrendingDown size={10} />
                    )}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <CheckCircle size={10} className="text-port-success" />
                  Ready
                </span>
                <span>|</span>
                <span>{getIntervalLabel(task.intervalType)}</span>
                {task.runCount > 0 && (
                  <>
                    <span>|</span>
                    <span>{task.lastRunFormatted}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}

        {/* Scheduled Tasks */}
        {scheduledTasks.slice(0, readyTasks.length > 0 ? 2 : 4).map((task, index) => (
          <div
            key={`${task.taskType}-scheduled-${index}`}
            className="flex items-center gap-3 p-2 rounded-lg bg-port-bg/50"
          >
            <span className="text-lg shrink-0 opacity-60" aria-hidden="true">
              {getTaskIcon(task.taskType)}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-300 truncate">
                  {task.description}
                </span>
                {task.learningAdjusted && (
                  <span
                    className={`flex items-center gap-0.5 text-xs ${
                      task.adjustmentMultiplier < 1 ? 'text-port-success' : 'text-port-warning'
                    }`}
                    title={`Learning adjusted: ${task.successRate}% success rate`}
                  >
                    {task.adjustmentMultiplier < 1 ? (
                      <TrendingUp size={10} />
                    ) : (
                      <TrendingDown size={10} />
                    )}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <Timer size={10} />
                  {task.eligibleInFormatted}
                </span>
                <span>|</span>
                <span>{getIntervalLabel(task.intervalType)}</span>
                {task.successRate !== null && (
                  <>
                    <span>|</span>
                    <span className={task.successRate >= 70 ? 'text-port-success' : task.successRate >= 40 ? 'text-port-warning' : 'text-port-error'}>
                      {task.successRate}%
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Summary */}
      {upcoming.length > 5 && (
        <div className="mt-3 pt-3 border-t border-port-border text-xs text-gray-500 text-center">
          <Link to="/cos/schedule" className="hover:text-port-accent transition-colors">
            +{upcoming.length - 5} more scheduled tasks
          </Link>
        </div>
      )}

      {/* Learning indicator */}
      {upcoming.some(t => t.learningAdjusted) && (
        <div className="mt-3 pt-3 border-t border-port-border flex items-center gap-2 text-xs text-purple-400">
          <Sparkles size={12} />
          <span>Schedule adjusted based on task performance</span>
        </div>
      )}

      {/* A later fetch failed but a prior good result is still on screen —
          say so rather than silently going stale (#7527). */}
      {error && (
        <div className="mt-3 pt-3 border-t border-port-border text-xs text-port-warning text-center" role="status">
          Showing last known schedule — live data unavailable
        </div>
      )}
    </div>
  );
});

export default UpcomingTasksWidget;
