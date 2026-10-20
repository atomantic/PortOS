import { useState, useId, memo } from 'react';
import { Link } from 'react-router';
import {
  CheckCircle,
  Clock,
  Brain,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Bot,
  XCircle,
  History,
  Activity
} from 'lucide-react';
import * as api from '../services/api';
import { useSocketResource } from '../hooks/useSocketResource';
import { useTimeTick } from '../hooks/useTimeTick';
import { sameJsonShape } from '../lib/sameJsonShape';
import { timeAgo, formatWeekdayDate, formatCount } from '../utils/formatters';

/**
 * The snapshot minus its volatile, unrendered fields. `status.lastEvaluation`
 * is stamped on every daemon evaluation; `task.completedRelative` is the
 * server's relative-time label, which the widget replaces with a client-side
 * `timeAgo(task.completedAt)` refreshed by its own minute tick.
 */
const comparableSnapshot = (snapshot) => {
  if (!snapshot) return snapshot;
  const { summary, recentTasks } = snapshot;
  return {
    ...snapshot,
    summary: summary && {
      ...summary,
      status: summary.status && { ...summary.status, lastEvaluation: undefined },
    },
    recentTasks: recentTasks && {
      ...recentTasks,
      tasks: recentTasks.tasks?.map(({ completedRelative: _volatile, ...task }) => task),
    },
  };
};

const RESOURCE_EVENTS = ['cos:day:changed', 'cos:tasks:changed', 'cos:agent:spawned', 'cos:agent:updated', 'cos:agent:completed', 'cos:agents:changed', 'cos:status', 'cos:status:paused', 'cos:status:resumed', 'cos:learning:changed'];

/**
 * CosDashboardWidget - Compact CoS status widget for the main Dashboard
 * Shows today's progress, learning health, CoS running state, and recent tasks
 */
const CosDashboardWidget = memo(function CosDashboardWidget() {
  const { data: dashData, loading } = useSocketResource(async () => {
    // Let errors throw — `useSocketResource` preserves the last-good batch on
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
  }, {
    namespace: 'cos', events: RESOURCE_EVENTS,
    // Re-render only when the snapshot actually changed. Structural equality
    // (as #11664 did for useSystemActivity) rather than a hand-written field
    // list: a rendered field the list forgot was silently frozen across
    // invalidations (#12036). The fields the server recomputes on every read
    // but this widget never renders are dropped first, so a tick of the
    // daemon's evaluation clock or a server-side relative-time label does not
    // re-render the heatmap and task list by itself.
    compare: (prev, next) => prev != null && sameJsonShape(comparableSnapshot(prev), comparableSnapshot(next)),
  });

  const { summary, learningSummary, recentTasks, activityCalendar } = dashData ?? {};
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const recentTasksId = useId();
  // Tick every minute so the client-side `timeAgo(task.completedAt)` labels
  // recompute against the latest wall-clock time across unchanged snapshots.
  useTimeTick(60000);

  // Don't render while loading
  if (loading) {
    return null;
  }

  // Only show if CoS has meaningful data
  const hasActivity = summary && (
    summary.today?.completed > 0 ||
    summary.today?.running > 0 ||
    summary.queue?.total > 0 ||
    summary.status?.running
  );

  const hasLearningData = learningSummary?.totalCompleted > 0;

  if (!hasActivity && !hasLearningData) {
    return null;
  }

  const today = summary?.today || {};
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
    <div className="@container min-w-0 bg-port-card border border-port-border rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="shrink-0 text-2xl" aria-hidden="true">
            <Bot className={`w-6 h-6 ${status.running ? 'text-port-success' : 'text-gray-500'}`} />
          </div>
          <div className="min-w-0">
            <h3 className="text-base @sm:text-lg font-semibold leading-tight text-white">Chief of Staff</h3>
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
          className="flex shrink-0 items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors min-h-[40px] px-2"
        >
          <span className="@max-xs:sr-only">View Details</span>
          <ChevronRight size={16} />
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 @sm:grid-cols-3 gap-3">
        {/* Today's Progress */}
        <div className="bg-port-bg/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle size={14} className="text-port-success" />
            <span className="text-xs text-gray-500">Today</span>
          </div>
          <div className="text-lg @sm:text-xl font-bold text-white">
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

        {/* Pending */}
        <div className="bg-port-bg/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Clock size={14} className={queue.total > 0 ? 'text-port-warning' : 'text-gray-400'} />
            <span className="text-xs text-gray-500">Pending</span>
          </div>
          <div className="text-lg @sm:text-xl font-bold text-white">
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
          <div className="text-lg @sm:text-xl font-bold text-white">
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
            type="button"
            onClick={() => setTasksExpanded(!tasksExpanded)}
            aria-expanded={tasksExpanded}
            aria-controls={recentTasksId}
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

          {/* Outcome is never colour alone: each row carries a glyph that differs
              by outcome plus a visually-hidden word, so colour-blind and
              screen-reader users get the same success/failure signal (#12035). */}
          {tasksExpanded ? (
            <div id={recentTasksId} className="space-y-2">
              {recentTasks.tasks.map((task) => (
                <Link
                  key={task.id}
                  to={`/cos/agents`}
                  className="flex items-start gap-2 p-2 bg-port-bg/30 rounded-lg hover:bg-port-bg/50 transition-colors"
                >
                  {task.success ? (
                    <CheckCircle size={14} aria-hidden="true" className="text-port-success mt-0.5 shrink-0" />
                  ) : (
                    <XCircle size={14} aria-hidden="true" className="text-port-error mt-0.5 shrink-0" />
                  )}
                  <span className="sr-only">{task.success ? 'succeeded' : 'failed'}:</span>
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
                          unchanged snapshots. */}
                      <span>{timeAgo(task.completedAt)}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <ul id={recentTasksId} className="flex gap-1 list-none p-0 m-0">
              {recentTasks.tasks.slice(0, 5).map((task) => (
                <li
                  key={task.id}
                  className="flex"
                  title={`${task.description.substring(0, 50)}... (${timeAgo(task.completedAt)})`}
                >
                  {task.success ? (
                    <CheckCircle size={12} aria-hidden="true" className="text-port-success" />
                  ) : (
                    <XCircle size={12} aria-hidden="true" className="text-port-error" />
                  )}
                  <span className="sr-only">{task.description}: {task.success ? 'succeeded' : 'failed'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
});

// Intensity 0 is never rendered through this table — an empty or future day
// short-circuits to the neutral square before the lookup.
const HEATMAP_SHADES = ['', 'bg-emerald-900/50', 'bg-emerald-700/60', 'bg-emerald-500/70', 'bg-emerald-400'];

/**
 * ActivityCalendar - Compact GitHub-style activity heatmap
 * Shows daily run volume as colored squares
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

  // Color by volume alone, GitHub-contribution style. Outcome is not in this
  // payload — the Today and Learning tiles above report it live.
  const getColorClass = (day) =>
    (day.tasks === 0 || day.isFuture) ? 'bg-port-border/20' : HEATMAP_SHADES[getIntensityLevel(day.tasks)];

  return (
    <div className="mt-4 pt-4 border-t border-port-border">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-port-accent" />
          <span className="text-sm font-medium text-gray-300">Activity</span>
        </div>
        <Link
          to="/cos/agents"
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
                    w-[9px] h-[9px] @lg:w-[10px] @lg:h-[10px]
                    rounded-xs transition-colors cursor-default
                    ${getColorClass(day)}
                    ${day.isToday ? 'ring-1 ring-port-accent' : ''}
                    ${day.isFuture ? 'opacity-30' : ''}
                  `}
                  title={day.isFuture ? '' : `${formatWeekdayDate(day.date, { weekday: 'short' })}: ${day.tasks} run${day.tasks !== 1 ? 's' : ''}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Summary Row */}
      <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
        <span>
          <span className="text-white font-medium">{formatCount(data.summary.totalTasks)}</span> runs,{' '}
          <span className="text-white font-medium">{data.summary.avgTasksPerActiveDay}</span>/active day
        </span>
        {/* Mini Legend — derived from the same table the cells use, so it
            cannot drift from the scale it claims to explain. */}
        <div className="flex items-center gap-0.5">
          <span className="mr-1 hidden @sm:inline">Less</span>
          <div className="w-2 h-2 rounded-xs bg-port-border/20" />
          {HEATMAP_SHADES.slice(1).map((shade) => (
            <div key={shade} className={`w-2 h-2 rounded-xs ${shade}`} />
          ))}
          <span className="ml-1 hidden @sm:inline">More</span>
        </div>
      </div>
    </div>
  );
}

export default CosDashboardWidget;
