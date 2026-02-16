import { useState, useEffect, memo } from 'react';
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

/**
 * CosDashboardWidget - Compact CoS status widget for the main Dashboard
 * Shows today's progress, streak status, learning health, CoS running state, and recent tasks
 */
const CosDashboardWidget = memo(function CosDashboardWidget() {
  const [summary, setSummary] = useState(null);
  const [learningSummary, setLearningSummary] = useState(null);
  const [recentTasks, setRecentTasks] = useState(null);
  const [activityCalendar, setActivityCalendar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tasksExpanded, setTasksExpanded] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      const silent = { silent: true };
      const [quickData, learningData, tasksData, calendarData] = await Promise.all([
        api.getCosQuickSummary(silent).catch(() => null),
        api.getCosLearningSummary(silent).catch(() => null),
        api.getCosRecentTasks(5, silent).catch(() => null),
        api.getCosActivityCalendar(8, silent).catch(() => null)
      ]);
      setSummary(quickData);
      setLearningSummary(learningData);
      setRecentTasks(tasksData);
      setActivityCalendar(calendarData);
      setLoading(false);
    };

    loadData();
    // Refresh every 30 seconds
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

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
                      <span>{task.completedRelative}</span>
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
                  title={`${task.description.substring(0, 50)}... (${task.completedRelative})`}
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
                    rounded-sm transition-colors cursor-default
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
          <div className="w-2 h-2 rounded-sm bg-port-border/20" />
          <div className="w-2 h-2 rounded-sm bg-emerald-900/50" />
          <div className="w-2 h-2 rounded-sm bg-emerald-500/70" />
          <div className="w-2 h-2 rounded-sm bg-emerald-400" />
          <span className="ml-1 hidden sm:inline">More</span>
        </div>
      </div>
    </div>
  );
}

export default CosDashboardWidget;
