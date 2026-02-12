import { useState, useEffect, memo } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle,
  Clock,
  Flame,
  Brain,
  AlertCircle,
  ChevronRight,
  Zap,
  Bot
} from 'lucide-react';
import * as api from '../services/api';

/**
 * CosDashboardWidget - Compact CoS status widget for the main Dashboard
 * Shows today's progress, streak status, learning health, and CoS running state
 */
const CosDashboardWidget = memo(function CosDashboardWidget() {
  const [summary, setSummary] = useState(null);
  const [learningSummary, setLearningSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      const [quickData, learningData] = await Promise.all([
        api.getCosQuickSummary().catch(() => null),
        api.getCosLearningSummary().catch(() => null)
      ]);
      setSummary(quickData);
      setLearningSummary(learningData);
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
    </div>
  );
});

export default CosDashboardWidget;
