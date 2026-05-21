import { useState, memo } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle,
  Clock,
  Flame,
  Brain,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Zap,
  Bot,
  XCircle,
  History,
  Activity
} from 'lucide-react';
import * as api from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { useTimeTick } from '../hooks/useTimeTick';
import { timeAgo } from '../utils/formatters';

/**
 * CosDashboardWidget - Compact CoS status widget for the main Dashboard
 * Shows today's progress, streak status, learning health, CoS running state, and recent tasks
 */
const CosDashboardWidget = memo(function CosDashboardWidget() {
  const { data: dashData, loading } = useAutoRefetch(async () => {
    // Let errors throw — `useAutoRefetch` preserves the last-good batch on
    // transient failures. Without this, a per-endpoint `.catch(() => null)`
    // could mix fresh and stale sections (e.g. summary=null but
    // learningSummary holding its prior value) and the widget would flicker
    // sections off-screen on every blip.
    const silent = { silent: true };
    const [summary, learningSummary, recentTasks, activityCalendar] = await Promise.all([
      api.getCosQuickSummary(silent),
      api.getCosLearningSummary(silent),
      api.getCosRecentTasks(5, silent),
      api.getCosActivityCalendar(8, silent)
    ]);
    return { summary, learningSummary, recentTasks, activityCalendar };
  }, 30000, {
    // Re-render only when one of the aggregated counts actually moves —
    // running agents, completed/failed counts, streak, queue depth, learning
    // success rate, every visible recent-task field, every per-day heatmap
    // cell, and the heatmap summary. The poll fires every 30s; without this
    // guard each tick re-renders the activity heatmap + recent tasks list
    // even when nothing changed.
    //
    // Recent-tasks comparison walks every rendered field per row (id,
    // description, taskType, app, durationFormatted, success). The relative-
    // time label is rendered client-side from `task.completedAt` via timeAgo
    // and refreshed by the useTimeTick(60000) below, so the server's
    // `task.completedRelative` string is intentionally ignored — it ships in
    // the payload but would freeze across deduped polls if we used it.
    //
    // Heatmap comparison walks every cell's (date, tasks, successRate) tuple
    // plus summary totals — per-day tasks/successRate distribution can shift
    // without changing top-level totals (e.g. a task moving from one day to
    // another in late-arriving telemetry).
    compare: (prev, next) => {
      const prevTasks = prev.recentTasks?.tasks;
      const nextTasks = next.recentTasks?.tasks;
      const prevLen = prevTasks?.length ?? 0;
      const nextLen = nextTasks?.length ?? 0;
      if (prevLen !== nextLen) return false;
      for (let i = 0; i < prevLen; i++) {
        const a = prevTasks[i];
        const b = nextTasks[i];
        if (
          a?.id !== b?.id
          || a?.success !== b?.success
          || a?.description !== b?.description
          || a?.taskType !== b?.taskType
          || a?.app !== b?.app
          || a?.durationFormatted !== b?.durationFormatted
          // completedAt is the input to timeAgo(...) below — if the server
          // corrects a task's completion time without changing other fields
          // (rare but possible) we want the relative-time label to refresh
          // immediately, not on the next minute tick.
          || a?.completedAt !== b?.completedAt
        ) return false;
      }
      // Heatmap weeks: array of arrays of {date, tasks, successRate, isToday,
      // isFuture}. Compare every cell — single boundary-cross (isToday rolls
      // from one date to the next) flips the comparator naturally because
      // (date, isToday) on the prior+next today differ.
      const prevWeeks = prev.activityCalendar?.weeks;
      const nextWeeks = next.activityCalendar?.weeks;
      const prevWeeksLen = prevWeeks?.length ?? 0;
      const nextWeeksLen = nextWeeks?.length ?? 0;
      if (prevWeeksLen !== nextWeeksLen) return false;
      for (let w = 0; w < prevWeeksLen; w++) {
        const pw = prevWeeks[w];
        const nw = nextWeeks[w];
        if ((pw?.length ?? 0) !== (nw?.length ?? 0)) return false;
        for (let d = 0; d < pw.length; d++) {
          const pd = pw[d];
          const nd = nw[d];
          if (
            pd?.date !== nd?.date
            || pd?.tasks !== nd?.tasks
            || pd?.successRate !== nd?.successRate
            || pd?.isToday !== nd?.isToday
          ) return false;
        }
      }
      return (
        prev.summary?.status?.running === next.summary?.status?.running
          && prev.summary?.status?.paused === next.summary?.status?.paused
          && prev.summary?.today?.succeeded === next.summary?.today?.succeeded
          && prev.summary?.today?.failed === next.summary?.today?.failed
          && prev.summary?.today?.running === next.summary?.today?.running
          && prev.summary?.today?.completed === next.summary?.today?.completed
          && prev.summary?.today?.timeWorked === next.summary?.today?.timeWorked
          && prev.summary?.streak?.current === next.summary?.streak?.current
          && prev.summary?.queue?.total === next.summary?.queue?.total
          && prev.summary?.queue?.pendingApprovals === next.summary?.queue?.pendingApprovals
          && prev.learningSummary?.overallSuccessRate === next.learningSummary?.overallSuccessRate
          && prev.learningSummary?.skipped === next.learningSummary?.skipped
          && prev.learningSummary?.status === next.learningSummary?.status
          && prev.learningSummary?.totalCompleted === next.learningSummary?.totalCompleted
          && prev.recentTasks?.summary?.total === next.recentTasks?.summary?.total
          && prev.recentTasks?.summary?.succeeded === next.recentTasks?.summary?.succeeded
          && prev.activityCalendar?.summary?.totalTasks === next.activityCalendar?.summary?.totalTasks
          && prev.activityCalendar?.summary?.successRate === next.activityCalendar?.summary?.successRate
          && prev.activityCalendar?.summary?.activeDays === next.activityCalendar?.summary?.activeDays
          && prev.activityCalendar?.maxTasks === next.activityCalendar?.maxTasks
          && prev.activityCalendar?.currentStreak === next.activityCalendar?.currentStreak
      );
    },
  });

  const { summary, learningSummary, recentTasks, activityCalendar } = dashData ?? {};
  const [tasksExpanded, setTasksExpanded] = useState(false);
  // Tick every minute so the client-side `timeAgo(task.completedAt)` labels
  // recompute against the latest wall-clock time across deduped polls.
  useTimeTick(60000);

  // Don't render while loading
  if (loading) {
    return null;
  }

  // Only show if CoS has meaningful data
  const hasActivity = summary && (
    summary.today?.completed > 0 ||
    summary.today?.running > 0 ||
    summary.streak?.current > 0 ||
    summary.queue?.total > 0 ||
    summary.status?.running
  );

  const hasLearningData = learningSummary?.totalCompleted > 0;

  if (!hasActivity && !hasLearningData) {
    return null;
  }

  const today = summary?.today || {};
  const streak = summary?.streak || {};
  const queue = summary?.queue || {};
  const status = summary?.status || {};

  // Determine learning health status
  const getLearningStatusColor = () => {
    if (!learningSummary) return 'text-gray-500';
    if (learningSummary.status === 'critical') return 'text-port-error';
    if (learningSummary.status === 'warning') return 'text-port-warning';
    if (learningSummary.status === 'good') return 'text-purple-400';
    return 'text-gray-500';
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="text-2xl" aria-hidden="true">
            <Bot className={`w-6 h-6 ${status.running ? 'text-port-success' : 'text-gray-500'}`} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Chief of Staff</h3>
            <p className="text-sm text-gray-500">
              {status.running
                ? status.paused ? 'Paused' : 'Active'
                : 'Stopped'}
              {today.running > 0 && (
                <span className="text-port-accent animate-pulse ml-1">
                  - {today.running} agent{today.running > 1 ? 's' : ''} running
                </span>
              )}
            </p>
          </div>
        </div>
        <Link
          to="/cos/tasks"
          className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors min-h-[40px] px-2"
        >
          <span className="hidden sm:inline">View Details</span>
          <ChevronRight size={16} />
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Today's Progress */}
        <div className="bg-port-bg/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle size={14} className="text-port-success" />
            <span className="text-xs text-gray-500">Today</span>
          </div>
          <div className="text-lg sm:text-xl font-bold text-white">
            {today.succeeded || 0}
            {today.failed > 0 && (
              <span className="text-port-error text-sm font-normal">
                /{today.failed}
              </span>
            )}
          </div>
          {today.timeWorked && today.timeWorked !== '0s' && (
            <div className="text-xs text-gray-500">{today.timeWorked}</div>
          )}
        </div>

        {/* Streak */}
        <div className="bg-port-bg/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Flame size={14} className={streak.current >= 3 ? 'text-orange-400' : 'text-gray-400'} />
            <span className="text-xs text-gray-500">Streak</span>
          </div>
          <div className={`text-lg sm:text-xl font-bold ${streak.current >= 3 ? 'text-orange-400' : 'text-white'}`}>
            {streak.current || 0}
            <span className="text-sm font-normal text-gray-500"> day{streak.current !== 1 ? 's' : ''}</span>
          </div>
          {streak.current >= 3 && (
            <div className="flex items-center gap-1 text-xs text-yellow-400">
              <Zap size={10} /> On fire!
            </div>
          )}
        </div>

        {/* Pending */}
        <div className="bg-port-bg/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Clock size={14} className={queue.total > 0 ? 'text-port-warning' : 'text-gray-400'} />
            <span className="text-xs text-gray-500">Pending</span>
          </div>
          <div className="text-lg sm:text-xl font-bold text-white">
            {queue.total || 0}
          </div>
          {queue.pendingApprovals > 0 && (
            <div className="flex items-center gap-1 text-xs text-port-warning">
              <AlertCircle size={10} /> {queue.pendingApprovals} need approval
            </div>
          )}
        </div>

        {/* Learning Health */}
        <Link
          to="/cos/learning"
          className="bg-port-bg/50 rounded-lg p-3 hover:bg-port-bg/70 transition-colors"
        >
          <div className="flex items-center gap-2 mb-1">
            <Brain size={14} className={getLearningStatusColor()} />
            <span className="text-xs text-gray-500">Learning</span>
          </div>
          <div className="text-lg sm:text-xl font-bold text-white">
            {learningSummary?.overallSuccessRate != null ? `${learningSummary.overallSuccessRate}%` : '—'}
          </div>
          {learningSummary?.skipped > 0 && (
            <div className="flex items-center gap-1 text-xs text-port-error">
              <AlertCircle size={10} /> {learningSummary.skipped} skipped
            </div>
          )}
        </Link>
      </div>

      {/* Activity Calendar - GitHub-style heatmap */}
      {activityCalendar?.weeks?.length > 0 && activityCalendar.summary.totalTasks > 0 && (
        <ActivityCalendar data={activityCalendar} />
      )}

      {/* Recent Tasks Section */}
      {recentTasks?.tasks?.length > 0 && (
        <div className="mt-4 pt-4 border-t border-port-border">
          <button
            onClick={() => setTasksExpanded(!tasksExpanded)}
            className="flex items-center justify-between w-full text-left mb-2 group"
          >
            <div className="flex items-center gap-2">
              <History size={14} className="text-gray-400" />
              <span className="text-sm font-medium text-gray-300">Recent Tasks</span>
              <span className="text-xs text-gray-500">
                ({recentTasks.summary.succeeded}/{recentTasks.summary.total} succeeded)
              </span>
            </div>
            <ChevronDown
              size={16}
              className={`text-gray-400 transition-transform ${tasksExpanded ? 'rotate-180' : ''}`}
            />
          </button>

          {tasksExpanded && (
            <div className="space-y-2">
              {recentTasks.tasks.map((task) => (
                <Link
                  key={task.id}
                  to={`/cos/agents`}
                  className="flex items-start gap-2 p-2 bg-port-bg/30 rounded-lg hover:bg-port-bg/50 transition-colors"
                >
                  {task.success ? (
                    <CheckCircle size={14} className="text-port-success mt-0.5 shrink-0" />
                  ) : (
                    <XCircle size={14} className="text-port-error mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-300 truncate">
                      {task.description}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <span className="capitalize">{task.taskType.replace(/-/g, ' ')}</span>
                      {task.app && (
                        <>
                          <span>•</span>
                          <span>{task.app}</span>
                        </>
                      )}
                      <span>•</span>
                      <span>{task.durationFormatted}</span>
                      <span>•</span>
                      {/* Compute relative time client-side from `completedAt`
                          so the useTimeTick(60000) above can refresh the
                          label without help from the server. The server's
                          `completedRelative` string ships in the payload but
                          we intentionally ignore it — it goes stale across
                          deduped polls. */}
                      <span>{timeAgo(task.completedAt)}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {!tasksExpanded && (
            <div className="flex gap-1">
              {recentTasks.tasks.slice(0, 5).map((task) => (
                <div
                  key={task.id}
                  className={`w-2 h-2 rounded-full ${task.success ? 'bg-port-success' : 'bg-port-error'}`}
                  title={`${task.description.substring(0, 50)}... (${timeAgo(task.completedAt)})`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * ActivityCalendar - Compact GitHub-style activity heatmap
 * Shows daily task completion as colored squares
 */
function ActivityCalendar({ data }) {
  // Calculate intensity level (0-4) based on tasks completed
  const getIntensityLevel = (tasks) => {
    if (tasks === 0) return 0;
    if (tasks === 1) return 1;
    const max = data.maxTasks || 1;
    const ratio = tasks / max;
    if (ratio >= 0.75) return 4;
    if (ratio >= 0.5) return 3;
    if (ratio >= 0.25) return 2;
    return 1;
  };

  // Get color class based on intensity and success rate
  const getColorClass = (day) => {
    if (day.tasks === 0 || day.isFuture) return 'bg-port-border/20';
    const intensity = getIntensityLevel(day.tasks);

    // Color based on success rate
    if (day.successRate >= 80) {
      const shades = ['', 'bg-emerald-900/50', 'bg-emerald-700/60', 'bg-emerald-500/70', 'bg-emerald-400'];
      return shades[intensity];
    } else if (day.successRate >= 50) {
      const shades = ['', 'bg-amber-900/50', 'bg-amber-700/60', 'bg-amber-500/70', 'bg-amber-400'];
      return shades[intensity];
    } else {
      const shades = ['', 'bg-red-900/50', 'bg-red-700/60', 'bg-red-500/70', 'bg-red-400'];
      return shades[intensity];
    }
  };

  const formatDate = (dateStr) => {
    const date = new Date(dateStr + 'T12:00:00');
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  return (
    <div className="mt-4 pt-4 border-t border-port-border">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-port-accent" />
          <span className="text-sm font-medium text-gray-300">Activity</span>
          {data.currentStreak > 0 && (
            <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400">
              <Flame size={10} />
              {data.currentStreak}d
            </span>
          )}
        </div>
        <Link
          to="/cos/productivity"
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-port-accent transition-colors"
        >
          {data.summary.activeDays} active days
          <ChevronRight size={12} />
        </Link>
      </div>

      {/* Calendar Grid */}
      <div className="overflow-x-auto scrollbar-hide">
        <div className="flex gap-0.5" style={{ minWidth: 'max-content' }}>
          {data.weeks.map((week, weekIdx) => (
            <div key={weekIdx} className="flex flex-col gap-0.5">
              {week.map((day) => (
                <div
                  key={day.date}
                  className={`
                    w-[9px] h-[9px] sm:w-[10px] sm:h-[10px]
                    rounded-xs transition-colors cursor-default
                    ${getColorClass(day)}
                    ${day.isToday ? 'ring-1 ring-port-accent' : ''}
                    ${day.isFuture ? 'opacity-30' : ''}
                  `}
                  title={day.isFuture ? '' : `${formatDate(day.date)}: ${day.tasks} task${day.tasks !== 1 ? 's' : ''} (${day.successRate}% success)`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Summary Row */}
      <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
        <span>
          <span className="text-white font-medium">{data.summary.totalTasks}</span> tasks,{' '}
          <span className={`font-medium ${
            data.summary.successRate >= 80 ? 'text-port-success' :
            data.summary.successRate >= 50 ? 'text-port-warning' : 'text-port-error'
          }`}>{data.summary.successRate}%</span> success
        </span>
        {/* Mini Legend */}
        <div className="flex items-center gap-0.5">
          <span className="mr-1 hidden sm:inline">Less</span>
          <div className="w-2 h-2 rounded-xs bg-port-border/20" />
          <div className="w-2 h-2 rounded-xs bg-emerald-900/50" />
          <div className="w-2 h-2 rounded-xs bg-emerald-500/70" />
          <div className="w-2 h-2 rounded-xs bg-emerald-400" />
          <span className="ml-1 hidden sm:inline">More</span>
        </div>
      </div>
    </div>
  );
}

export default CosDashboardWidget;
