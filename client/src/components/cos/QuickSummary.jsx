import { useState, useEffect } from 'react';
import {
  CheckCircle,
  Clock,
  Flame,
  Calendar,
  ListTodo,
  Zap,
  AlertCircle,
  Timer,
  TrendingUp,
  TrendingDown,
  Minus
} from 'lucide-react';
import * as api from '../../services/api';

/**
 * QuickSummary - At-a-glance dashboard widget for CoS status
 * Shows today's progress, streak status, next job, and pending work
 */
export default function QuickSummary() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadSummary = async () => {
      const data = await api.getCosQuickSummary().catch(() => null);
      setSummary(data);
      setLoading(false);
    };

    loadSummary();
    // Refresh every 30 seconds
    const interval = setInterval(loadSummary, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading || !summary) {
    return null;
  }

  const { today, streak, nextJob, queue, velocity } = summary;

  // Only show if there's meaningful data to display
  const hasActivity = today.completed > 0 || today.running > 0 || streak.current > 0 || queue.total > 0;
  if (!hasActivity && !nextJob) {
    return null;
  }

  // Velocity indicator helper
  const getVelocityDisplay = () => {
    if (!velocity?.percentage || velocity.historicalDays < 3) return null;

    const { percentage, label } = velocity;
    let icon = Minus;
    let color = 'text-gray-400';
    let bgColor = 'bg-gray-500/10';

    if (label === 'exceptional') {
      icon = TrendingUp;
      color = 'text-emerald-400';
      bgColor = 'bg-emerald-500/20';
    } else if (label === 'above-average') {
      icon = TrendingUp;
      color = 'text-port-success';
      bgColor = 'bg-port-success/15';
    } else if (label === 'on-track') {
      icon = Minus;
      color = 'text-port-accent';
      bgColor = 'bg-port-accent/15';
    } else if (label === 'slow' || label === 'light') {
      icon = TrendingDown;
      color = 'text-port-warning';
      bgColor = 'bg-port-warning/15';
    }

    return { icon, color, bgColor, percentage };
  };

  const velocityDisplay = getVelocityDisplay();

  // Format time until next job
  const formatTimeUntil = (isoDate) => {
    if (!isoDate) return null;
    const now = Date.now();
    const due = new Date(isoDate).getTime();
    const diffMs = due - now;

    if (diffMs <= 0) return 'now';

    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
  };

  return (
    <div className="bg-gradient-to-r from-port-card to-port-bg border border-port-border rounded-lg p-3 mb-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {/* Today's Stats */}
        {(today.completed > 0 || today.running > 0) && (
          <div className="flex items-center gap-1.5">
            <CheckCircle size={14} className="text-port-success" />
            <span className="text-gray-400">Today:</span>
            <span className="font-medium text-white">
              {today.succeeded}{today.failed > 0 && <span className="text-port-error">/{today.failed}</span>}
            </span>
            {today.running > 0 && (
              <span className="text-port-accent animate-pulse">
                +{today.running} running
              </span>
            )}
            {today.timeWorked && today.timeWorked !== '0s' && (
              <span className="text-gray-500 text-xs">({today.timeWorked})</span>
            )}
          </div>
        )}

        {/* Streak */}
        {streak.current > 0 && (
          <div className="flex items-center gap-1.5">
            <Flame size={14} className={streak.current >= 3 ? 'text-orange-400' : 'text-gray-400'} />
            <span className="text-gray-400">Streak:</span>
            <span className={`font-medium ${streak.current >= 3 ? 'text-orange-400' : 'text-white'}`}>
              {streak.current} day{streak.current !== 1 ? 's' : ''}
            </span>
            {streak.current >= 3 && (
              <Zap size={12} className="text-yellow-400" />
            )}
          </div>
        )}

        {/* Velocity */}
        {velocityDisplay && (
          <div className="flex items-center gap-1.5">
            <velocityDisplay.icon size={14} className={velocityDisplay.color} />
            <span className="text-gray-400">Pace:</span>
            <span className={`font-medium ${velocityDisplay.color} px-1.5 py-0.5 rounded ${velocityDisplay.bgColor}`}>
              {velocityDisplay.percentage}%
            </span>
            <span className="text-gray-500 text-xs">vs avg</span>
          </div>
        )}

        {/* Pending Work */}
        {queue.total > 0 && (
          <div className="flex items-center gap-1.5">
            <ListTodo size={14} className="text-port-warning" />
            <span className="text-gray-400">Pending:</span>
            <span className="font-medium text-white">
              {queue.pendingUserTasks > 0 && (
                <span>{queue.pendingUserTasks} task{queue.pendingUserTasks !== 1 ? 's' : ''}</span>
              )}
              {queue.pendingUserTasks > 0 && queue.pendingApprovals > 0 && ', '}
              {queue.pendingApprovals > 0 && (
                <span className="text-port-warning">{queue.pendingApprovals} approval{queue.pendingApprovals !== 1 ? 's' : ''}</span>
              )}
            </span>
          </div>
        )}

        {/* Next Job */}
        {nextJob && (
          <div className="flex items-center gap-1.5">
            <Timer size={14} className={nextJob.isDue ? 'text-port-accent animate-pulse' : 'text-gray-400'} />
            <span className="text-gray-400">Next:</span>
            <span className={`font-medium truncate max-w-[120px] ${nextJob.isDue ? 'text-port-accent' : 'text-white'}`} title={nextJob.jobName}>
              {nextJob.jobName?.replace(/^(self-improvement|app-improvement)-/, '').replace(/-/g, ' ')}
            </span>
            <span className="text-gray-500 text-xs">
              {nextJob.isDue ? 'due' : formatTimeUntil(nextJob.nextDueAt)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
