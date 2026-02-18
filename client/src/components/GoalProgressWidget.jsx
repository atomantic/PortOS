import { memo } from 'react';
import { Link } from 'react-router-dom';
import {
  Target,
  ChevronRight,
  TrendingUp,
  AlertTriangle
} from 'lucide-react';
import * as api from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';

/**
 * GoalProgressWidget - Shows progress toward user goals on the dashboard
 * Maps completed CoS tasks to goal categories from COS-GOALS.md
 */
const GoalProgressWidget = memo(function GoalProgressWidget() {
  const { data: progress, loading } = useAutoRefetch(
    () => api.getCosGoalProgressSummary({ silent: true }).catch(() => null),
    60000
  );

  // Don't render while loading or if no goals
  if (loading || !progress?.goals?.length) {
    return null;
  }

  const { goals, summary } = progress;

  // Color mappings for engagement levels
  const getColorClasses = (color, engagement) => {
    const intensityMap = {
      high: { emerald: 'bg-emerald-500', purple: 'bg-purple-500', blue: 'bg-blue-500', pink: 'bg-pink-500', green: 'bg-green-500', gray: 'bg-gray-500' },
      medium: { emerald: 'bg-emerald-500/60', purple: 'bg-purple-500/60', blue: 'bg-blue-500/60', pink: 'bg-pink-500/60', green: 'bg-green-500/60', gray: 'bg-gray-500/60' },
      low: { emerald: 'bg-emerald-500/30', purple: 'bg-purple-500/30', blue: 'bg-blue-500/30', pink: 'bg-pink-500/30', green: 'bg-green-500/30', gray: 'bg-gray-500/30' }
    };
    return intensityMap[engagement]?.[color] || 'bg-gray-500/30';
  };

  const getTextColorClass = (color) => {
    const colorMap = {
      emerald: 'text-emerald-400',
      purple: 'text-purple-400',
      blue: 'text-blue-400',
      pink: 'text-pink-400',
      green: 'text-green-400',
      gray: 'text-gray-400'
    };
    return colorMap[color] || 'text-gray-400';
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="text-2xl" aria-hidden="true">
            <Target className="w-6 h-6 text-port-accent" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Goal Progress</h3>
            <p className="text-sm text-gray-500">
              {summary.totalTasks} tasks toward {summary.totalGoals} goals
            </p>
          </div>
        </div>
        <Link
          to="/cos/tasks"
          className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors min-h-[40px] px-2"
        >
          <span className="hidden sm:inline">View Tasks</span>
          <ChevronRight size={16} />
        </Link>
      </div>

      {/* Goal Progress Bars */}
      <div className="space-y-3">
        {goals.map((goal) => (
          <div key={goal.name} className="group">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="text-base" aria-hidden="true">{goal.icon}</span>
                <span className="text-sm font-medium text-gray-300">{goal.name}</span>
              </div>
              <div className="flex items-center gap-2">
                {goal.successRate !== null && (
                  <span className={`text-xs ${goal.successRate >= 80 ? 'text-port-success' : goal.successRate >= 50 ? 'text-port-warning' : 'text-port-error'}`}>
                    {goal.successRate}%
                  </span>
                )}
                <span className="text-xs text-gray-500">
                  {goal.tasks} task{goal.tasks !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
            {/* Progress bar */}
            <div className="h-2 bg-port-border rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${getColorClasses(goal.color, goal.engagement)}`}
                style={{
                  width: `${Math.min(100, Math.max(5, (goal.tasks / Math.max(...goals.map(g => g.tasks), 1)) * 100))}%`
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Insights Row */}
      {(summary.mostActive || summary.leastActive) && (
        <div className="mt-4 pt-4 border-t border-port-border">
          <div className="flex flex-wrap gap-3 text-xs">
            {summary.mostActive && (
              <div className="flex items-center gap-1.5 text-port-success">
                <TrendingUp size={12} />
                <span>Most active: {summary.mostActive}</span>
              </div>
            )}
            {summary.leastActive && (
              <div className="flex items-center gap-1.5 text-port-warning">
                <AlertTriangle size={12} />
                <span>Needs attention: {summary.leastActive}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Overall Success Rate */}
      {summary.overallSuccessRate !== null && (
        <div className="mt-3 text-center">
          <span className="text-xs text-gray-500">
            Overall success rate:{' '}
            <span className={`font-medium ${
              summary.overallSuccessRate >= 80 ? 'text-port-success' :
              summary.overallSuccessRate >= 50 ? 'text-port-warning' : 'text-port-error'
            }`}>
              {summary.overallSuccessRate}%
            </span>
          </span>
        </div>
      )}
    </div>
  );
});

export default GoalProgressWidget;
