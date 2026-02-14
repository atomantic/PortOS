import { useState, useEffect, useCallback, useMemo } from 'react';
import { TrendingUp, TrendingDown, Minus, Activity, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import * as api from '../../services/api';

/**
 * DailyTrendsChart - Visualizes daily task completion trends
 * Shows a bar chart of tasks completed per day with success rate overlay
 */
export default function DailyTrendsChart({ days = 30, initialExpanded = true }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(initialExpanded);

  const loadData = useCallback(async () => {
    setLoading(true);
    const result = await api.getCosProductivityTrends(days).catch(() => null);
    setData(result);
    setLoading(false);
  }, [days]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Find max tasks for scaling
  const maxTasks = useMemo(() => {
    if (!data?.data) return 1;
    return Math.max(...data.data.map(d => d.tasks), 1);
  }, [data]);

  const getSuccessRateColor = (rate) => {
    if (rate >= 80) return 'bg-port-success';
    if (rate >= 60) return 'bg-port-warning';
    if (rate > 0) return 'bg-port-error';
    return 'bg-port-border';
  };

  const getTrendIcon = (trend) => {
    if (trend === 'increasing' || trend === 'improving') {
      return <TrendingUp size={14} className="text-port-success" />;
    }
    if (trend === 'decreasing' || trend === 'declining') {
      return <TrendingDown size={14} className="text-port-error" />;
    }
    return <Minus size={14} className="text-gray-500" />;
  };

  const getTrendLabel = (trend) => {
    if (trend === 'increasing') return 'Volume trending up';
    if (trend === 'decreasing') return 'Volume trending down';
    if (trend === 'improving') return 'Success rate improving';
    if (trend === 'declining') return 'Success rate declining';
    return 'Stable';
  };

  if (loading) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-center justify-center py-8">
          <RefreshCw className="w-5 h-5 animate-spin text-port-accent" />
        </div>
      </div>
    );
  }

  if (!data?.data?.length) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={16} className="text-port-accent" />
          <span className="font-medium text-white">Daily Task Trends</span>
        </div>
        <p className="text-sm text-gray-500">No task history available. Complete tasks to see trends.</p>
      </div>
    );
  }

  const { summary } = data;

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-port-bg/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <Activity size={16} className="text-port-accent" />
          <span className="font-medium text-white">Daily Task Trends</span>
          <span className="text-xs text-gray-500">({summary.days} days)</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Trend indicators */}
          <div className="flex items-center gap-1">
            {getTrendIcon(summary.volumeTrend)}
            <span className="text-xs text-gray-400">{getTrendLabel(summary.volumeTrend)}</span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="p-4 pt-0">
          {/* Summary Stats */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            <div className="text-center">
              <div className="text-lg font-bold text-white">{summary.totalTasks}</div>
              <div className="text-xs text-gray-500">Total Tasks</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-port-accent">{summary.activeDays}</div>
              <div className="text-xs text-gray-500">Active Days</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-cyan-400">{summary.avgTasksPerActiveDay}</div>
              <div className="text-xs text-gray-500">Avg/Day</div>
            </div>
            <div className="text-center">
              <div className={`text-lg font-bold ${summary.avgSuccessRate >= 70 ? 'text-port-success' : summary.avgSuccessRate >= 50 ? 'text-port-warning' : 'text-port-error'}`}>
                {summary.avgSuccessRate}%
              </div>
              <div className="text-xs text-gray-500">Success</div>
            </div>
          </div>

          {/* Bar Chart */}
          <div className="relative">
            {/* Y-axis labels */}
            <div className="absolute left-0 top-0 bottom-6 w-8 flex flex-col justify-between text-xs text-gray-600">
              <span>{maxTasks}</span>
              <span>{Math.round(maxTasks / 2)}</span>
              <span>0</span>
            </div>

            {/* Chart area */}
            <div className="ml-10 overflow-x-auto">
              <div className="flex items-end gap-0.5 h-32" style={{ minWidth: `${data.data.length * 12}px` }}>
                {data.data.map((day, idx) => {
                  const barHeight = (day.tasks / maxTasks) * 100;
                  const isToday = idx === data.data.length - 1;

                  return (
                    <div
                      key={day.date}
                      className="flex-1 flex flex-col items-center group relative"
                      style={{ minWidth: '10px', maxWidth: '24px' }}
                    >
                      {/* Bar */}
                      <div
                        className={`w-full rounded-t transition-all ${day.tasks > 0 ? getSuccessRateColor(day.successRate) : 'bg-port-border/30'} ${isToday ? 'ring-1 ring-port-accent' : ''}`}
                        style={{ height: `${Math.max(barHeight, day.tasks > 0 ? 8 : 2)}%` }}
                      />

                      {/* Tooltip */}
                      <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-10">
                        <div className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs whitespace-nowrap shadow-lg">
                          <div className="text-white font-medium">{day.date}</div>
                          {day.tasks > 0 ? (
                            <>
                              <div className="text-gray-400">{day.tasks} task{day.tasks !== 1 ? 's' : ''}</div>
                              <div className={day.successRate >= 70 ? 'text-port-success' : day.successRate >= 50 ? 'text-port-warning' : 'text-port-error'}>
                                {day.successes}/{day.tasks} passed ({day.successRate}%)
                              </div>
                            </>
                          ) : (
                            <div className="text-gray-500">No tasks</div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* X-axis labels - show every 7th day */}
              <div className="flex gap-0.5 mt-1" style={{ minWidth: `${data.data.length * 12}px` }}>
                {data.data.map((day, idx) => (
                  <div
                    key={day.date}
                    className="flex-1 text-center"
                    style={{ minWidth: '10px', maxWidth: '24px' }}
                  >
                    {idx % 7 === 0 && (
                      <span className="text-xs text-gray-600">{day.dateShort}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center gap-4 mt-4 text-xs">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-port-success" />
              <span className="text-gray-500">80%+</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-port-warning" />
              <span className="text-gray-500">60-79%</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-port-error" />
              <span className="text-gray-500">&lt;60%</span>
            </div>
          </div>

          {/* Success trend indicator */}
          {summary.successTrend !== 'stable' && (
            <div className={`mt-3 p-2 rounded text-xs text-center ${summary.successTrend === 'improving' ? 'bg-port-success/10 text-port-success' : 'bg-port-error/10 text-port-error'}`}>
              {getTrendIcon(summary.successTrend)}
              <span className="ml-1">{getTrendLabel(summary.successTrend)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
