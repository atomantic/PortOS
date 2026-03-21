import { memo, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, AlertTriangle, Target } from 'lucide-react';
import * as api from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { CATEGORY_CONFIG } from './goals/GoalDetailPanel';

const HORIZON_LABELS = {
  '1-year': '1Y', '3-year': '3Y', '5-year': '5Y',
  '10-year': '10Y', '20-year': '20Y', 'lifetime': 'Life'
};

const STALL_THRESHOLD_DAYS = 14;
const MIN_BAR_WIDTH_PCT = 2;

const getLastProgressDate = (goal) => {
  if (!goal.progressHistory?.length) return goal.createdAt || null;
  return goal.progressHistory.reduce((a, b) => b.timestamp > a.timestamp ? b : a).timestamp;
};

const getDaysSince = (dateStr) => {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
};

const GoalProgressWidget = memo(function GoalProgressWidget() {
  const { data: goalsData, loading } = useAutoRefetch(
    () => api.getGoals({ silent: true }).catch(() => null),
    300000
  );

  const { goals, stalledCount, avgProgress } = useMemo(() => {
    if (!goalsData?.goals?.length) return { goals: [], stalledCount: 0, avgProgress: 0 };

    const topLevel = goalsData.goals
      .filter(g => !g.parentId && g.status === 'active')
      .sort((a, b) => (b.urgency || 0) - (a.urgency || 0))
      .map(g => {
        const daysSinceUpdate = getDaysSince(getLastProgressDate(g));
        return {
          ...g,
          daysSinceUpdate,
          isStalled: daysSinceUpdate !== null && daysSinceUpdate >= STALL_THRESHOLD_DAYS
        };
      });

    return {
      goals: topLevel,
      stalledCount: topLevel.filter(g => g.isStalled).length,
      avgProgress: Math.round(topLevel.reduce((sum, g) => sum + (g.progress || 0), 0) / topLevel.length)
    };
  }, [goalsData]);

  if (loading || !goals.length) return null;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Target className="w-6 h-6 text-port-accent" aria-hidden="true" />
          <div>
            <h3 className="text-lg font-semibold text-white">Goals</h3>
            <p className="text-sm text-gray-500">
              {goals.length} active &middot; {avgProgress}% avg
            </p>
          </div>
        </div>
        <Link
          to="/goals"
          className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors min-h-[40px] px-2"
        >
          <span className="hidden sm:inline">View All</span>
          <ChevronRight size={16} />
        </Link>
      </div>

      <div className="space-y-3">
        {goals.map((goal) => {
          const cat = CATEGORY_CONFIG[goal.category] || CATEGORY_CONFIG.mastery;
          const CatIcon = cat.icon;

          return (
            <Link key={goal.id} to="/goals" className="block group">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <CatIcon size={14} className={`shrink-0 ${cat.color}`} aria-hidden="true" />
                  <span className="text-sm font-medium text-gray-300 truncate group-hover:text-white transition-colors">
                    {goal.title}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  {goal.isStalled && (
                    <AlertTriangle size={12} className="text-port-warning" title={`No progress in ${goal.daysSinceUpdate}d`} />
                  )}
                  <span className="text-xs text-gray-600">{HORIZON_LABELS[goal.horizon] || goal.horizon}</span>
                  <span className="text-xs font-medium text-gray-400">{goal.progress || 0}%</span>
                </div>
              </div>
              <div className="h-1.5 bg-port-border rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(goal.progress || 0, MIN_BAR_WIDTH_PCT)}%`, backgroundColor: cat.hex }}
                />
              </div>
            </Link>
          );
        })}
      </div>

      {stalledCount > 0 && (
        <div className="mt-4 pt-3 border-t border-port-border">
          <div className="flex items-center gap-1.5 text-xs text-port-warning">
            <AlertTriangle size={12} />
            <span>{stalledCount} goal{stalledCount !== 1 ? 's' : ''} stalled ({STALL_THRESHOLD_DAYS}+ days idle)</span>
          </div>
        </div>
      )}
    </div>
  );
});

export default GoalProgressWidget;
