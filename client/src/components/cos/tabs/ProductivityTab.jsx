import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Flame,
  RefreshCw,
  TrendingUp,
  Clock,
  Calendar,
  Trophy,
  Target,
  Zap,
  CheckCircle,
  AlertTriangle,
  BarChart2,
  ChevronDown,
  ChevronRight,
  Award
} from 'lucide-react';
import * as api from '../../../services/api';
import DailyTrendsChart from '../DailyTrendsChart';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FULL_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function ProductivityTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    streaks: true,
    patterns: true,
    insights: true,
    milestones: false
  });

  const loadData = useCallback(async (autoRecalculate = false) => {
    setLoading(true);
    const productivity = await api.getCosProductivity().catch(() => null);
    if (!productivity?.totals?.totalTasks && autoRecalculate) {
      // No productivity.json yet — build it from agent history
      await api.recalculateCosProductivity().catch(() => null);
      const refreshed = await api.getCosProductivity().catch(() => null);
      setData(refreshed);
    } else {
      setData(productivity);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData(true);
  }, [loadData]);

  const handleRecalculate = useCallback(async () => {
    setRecalculating(true);
    await api.recalculateCosProductivity().catch(() => null);
    await loadData();
    setRecalculating(false);
  }, [loadData]);

  const toggleSection = useCallback((section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  }, []);

  const formatHour = useCallback((hour) => {
    const h = parseInt(hour, 10);
    if (h === 0) return '12AM';
    if (h === 12) return '12PM';
    return h < 12 ? `${h}AM` : `${h - 12}PM`;
  }, []);

  const getSuccessRateColor = useCallback((rate) => {
    if (rate >= 80) return 'text-port-success';
    if (rate >= 60) return 'text-port-warning';
    return 'text-port-error';
  }, []);

  const getSuccessRateBg = useCallback((rate) => {
    if (rate >= 80) return 'bg-port-success';
    if (rate >= 60) return 'bg-port-warning';
    return 'bg-port-error';
  }, []);

  // Sort hourly patterns by hour
  const sortedHourlyPatterns = useMemo(() => {
    if (!data?.hourlyPatterns) return [];
    return Object.entries(data.hourlyPatterns)
      .map(([hour, p]) => ({ hour: parseInt(hour, 10), ...p }))
      .sort((a, b) => a.hour - b.hour);
  }, [data?.hourlyPatterns]);

  // Sort daily patterns by day
  const sortedDailyPatterns = useMemo(() => {
    if (!data?.dailyPatterns) return [];
    return Object.entries(data.dailyPatterns)
      .map(([day, p]) => ({ day: parseInt(day, 10), dayName: DAY_NAMES[parseInt(day, 10)], ...p }))
      .sort((a, b) => a.day - b.day);
  }, [data?.dailyPatterns]);

  const hasData = data?.totals?.totalTasks > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 animate-spin text-port-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Flame className="w-5 h-5 text-orange-400" />
          <h3 className="text-lg font-semibold text-white">Productivity & Streaks</h3>
        </div>
        <button
          onClick={handleRecalculate}
          disabled={recalculating}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors disabled:opacity-50 min-h-[40px]"
        >
          <RefreshCw size={14} className={recalculating ? 'animate-spin' : ''} />
          {recalculating ? 'Calculating...' : 'Refresh'}
        </button>
      </div>

      {!hasData ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <Flame className="w-12 h-12 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400">No productivity data yet.</p>
          <p className="text-gray-500 text-sm mt-1">
            Complete some tasks to start tracking your work patterns and building streaks!
          </p>
        </div>
      ) : (
        <>
          {/* Streak Stats */}
          <div>
            <button
              onClick={() => toggleSection('streaks')}
              className="flex items-center gap-2 w-full text-left mb-3"
            >
              {expandedSections.streaks ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <Flame size={16} className="text-orange-400" />
              <span className="font-medium text-white">Work Streaks</span>
            </button>
            {expandedSections.streaks && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {/* Current Daily Streak */}
                <div className="bg-gradient-to-br from-orange-500/20 to-red-500/20 border border-orange-500/30 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Flame size={14} className="text-orange-400" />
                    <span className="text-xs text-gray-400">Current Streak</span>
                  </div>
                  <div className="text-3xl font-bold text-white">
                    {data.streaks?.currentDaily || 0}
                  </div>
                  <div className="text-xs text-gray-500">
                    {data.streaks?.currentDaily === 1 ? 'day' : 'days'}
                  </div>
                  {data.streaks?.currentDaily >= 3 && (
                    <div className="mt-2 text-xs text-orange-400 flex items-center gap-1">
                      <Zap size={10} />
                      On fire!
                    </div>
                  )}
                </div>

                {/* Longest Daily Streak */}
                <div className="bg-port-card border border-port-border rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Trophy size={14} className="text-yellow-400" />
                    <span className="text-xs text-gray-400">Best Streak</span>
                  </div>
                  <div className="text-3xl font-bold text-yellow-400">
                    {data.streaks?.longestDaily || 0}
                  </div>
                  <div className="text-xs text-gray-500">days</div>
                </div>

                {/* Weekly Streak */}
                <div className="bg-port-card border border-port-border rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Calendar size={14} className="text-cyan-400" />
                    <span className="text-xs text-gray-400">Weekly Streak</span>
                  </div>
                  <div className="text-3xl font-bold text-cyan-400">
                    {data.streaks?.currentWeekly || 0}
                  </div>
                  <div className="text-xs text-gray-500">weeks</div>
                </div>

                {/* Active Days */}
                <div className="bg-port-card border border-port-border rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Target size={14} className="text-port-accent" />
                    <span className="text-xs text-gray-400">Total Active</span>
                  </div>
                  <div className="text-3xl font-bold text-white">
                    {data.totals?.activeDays || 0}
                  </div>
                  <div className="text-xs text-gray-500">days worked</div>
                </div>
              </div>
            )}
          </div>

          {/* Daily Task Trends Chart */}
          <DailyTrendsChart days={30} initialExpanded={true} />

          {/* AI Insights */}
          {data.insights?.length > 0 && (
            <div>
              <button
                onClick={() => toggleSection('insights')}
                className="flex items-center gap-2 w-full text-left mb-3"
              >
                {expandedSections.insights ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <Zap size={16} className="text-yellow-400" />
                <span className="font-medium text-white">Insights</span>
                <span className="text-xs text-gray-500">({data.insights.length})</span>
              </button>
              {expandedSections.insights && (
                <div className="space-y-2">
                  {data.insights.map((insight, idx) => (
                    <div
                      key={idx}
                      className={`border rounded-lg p-3 ${
                        insight.type === 'success' ? 'bg-port-success/10 border-port-success/30' :
                        insight.type === 'warning' ? 'bg-port-warning/10 border-port-warning/30' :
                        insight.type === 'optimization' ? 'bg-green-500/10 border-green-500/30' :
                        'bg-port-accent/10 border-port-accent/30'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {insight.type === 'success' && <CheckCircle size={14} className="text-port-success mt-0.5" />}
                        {insight.type === 'warning' && <AlertTriangle size={14} className="text-port-warning mt-0.5" />}
                        {insight.type === 'optimization' && <TrendingUp size={14} className="text-green-400 mt-0.5" />}
                        {insight.type === 'info' && <Target size={14} className="text-port-accent mt-0.5" />}
                        <div>
                          <div className="font-medium text-sm text-white">{insight.title}</div>
                          <div className="text-sm text-gray-400">{insight.message}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Patterns */}
          <div>
            <button
              onClick={() => toggleSection('patterns')}
              className="flex items-center gap-2 w-full text-left mb-3"
            >
              {expandedSections.patterns ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <BarChart2 size={16} className="text-purple-400" />
              <span className="font-medium text-white">Work Patterns</span>
            </button>
            {expandedSections.patterns && (
              <div className="grid gap-4 lg:grid-cols-2">
                {/* Best Hours */}
                <div className="bg-port-card border border-port-border rounded-lg p-4">
                  <h4 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                    <Clock size={14} className="text-cyan-400" />
                    Hourly Performance
                  </h4>
                  {sortedHourlyPatterns.length > 0 ? (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {sortedHourlyPatterns.map((p) => (
                        <div key={p.hour} className="flex items-center justify-between text-sm">
                          <span className="text-gray-400 w-12">{formatHour(p.hour)}</span>
                          <div className="flex-1 mx-2">
                            <div className="h-2 bg-port-border rounded-full overflow-hidden">
                              <div
                                className={`h-full ${getSuccessRateBg(p.successRate)}`}
                                style={{ width: `${p.successRate}%` }}
                              />
                            </div>
                          </div>
                          <span className={`font-mono w-10 text-right ${getSuccessRateColor(p.successRate)}`}>
                            {p.successRate}%
                          </span>
                          <span className="text-gray-500 w-8 text-right text-xs">
                            {p.tasks}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">No hourly data yet</p>
                  )}
                </div>

                {/* Best Days */}
                <div className="bg-port-card border border-port-border rounded-lg p-4">
                  <h4 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                    <Calendar size={14} className="text-purple-400" />
                    Daily Performance
                  </h4>
                  {sortedDailyPatterns.length > 0 ? (
                    <div className="space-y-2">
                      {sortedDailyPatterns.map((p) => (
                        <div key={p.day} className="flex items-center justify-between text-sm">
                          <span className="text-gray-400 w-8">{p.dayName}</span>
                          <div className="flex-1 mx-2">
                            <div className="h-2 bg-port-border rounded-full overflow-hidden">
                              <div
                                className={`h-full ${getSuccessRateBg(p.successRate)}`}
                                style={{ width: `${p.successRate}%` }}
                              />
                            </div>
                          </div>
                          <span className={`font-mono w-10 text-right ${getSuccessRateColor(p.successRate)}`}>
                            {p.successRate}%
                          </span>
                          <span className="text-gray-500 w-8 text-right text-xs">
                            {p.tasks}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">No daily data yet</p>
                  )}
                </div>

                {/* Best Hour/Day Highlight */}
                {(data.bestHour || data.bestDay) && (
                  <div className="lg:col-span-2 bg-gradient-to-r from-purple-500/10 to-cyan-500/10 border border-purple-500/30 rounded-lg p-4">
                    <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                      <Award size={14} className="text-yellow-400" />
                      Optimal Work Times
                    </h4>
                    <div className="grid grid-cols-2 gap-4">
                      {data.bestHour && (
                        <div>
                          <div className="text-xs text-gray-500">Best Hour</div>
                          <div className="text-lg font-semibold text-cyan-400">
                            {formatHour(data.bestHour.hour)}
                          </div>
                          <div className="text-xs text-gray-400">
                            {data.bestHour.successRate}% success ({data.bestHour.tasks} tasks)
                          </div>
                        </div>
                      )}
                      {data.bestDay && (
                        <div>
                          <div className="text-xs text-gray-500">Best Day</div>
                          <div className="text-lg font-semibold text-purple-400">
                            {FULL_DAY_NAMES[data.bestDay.day]}
                          </div>
                          <div className="text-xs text-gray-400">
                            {data.bestDay.successRate}% success ({data.bestDay.tasks} tasks)
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Milestones */}
          {data.milestones?.length > 0 && (
            <div>
              <button
                onClick={() => toggleSection('milestones')}
                className="flex items-center gap-2 w-full text-left mb-3"
              >
                {expandedSections.milestones ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <Trophy size={16} className="text-yellow-400" />
                <span className="font-medium text-white">Milestones</span>
                <span className="text-xs text-gray-500">({data.milestones.length})</span>
              </button>
              {expandedSections.milestones && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {data.milestones.map((m, idx) => (
                    <div
                      key={idx}
                      className="bg-port-card border border-yellow-500/30 rounded-lg p-3 text-center"
                    >
                      <Trophy size={20} className="text-yellow-400 mx-auto mb-1" />
                      <div className="text-sm font-medium text-white">{m.description}</div>
                      {m.achievedAt && (
                        <div className="text-xs text-gray-500 mt-1">
                          {new Date(m.achievedAt).toLocaleDateString()}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Summary Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-white">{data.totals?.totalTasks || 0}</div>
              <div className="text-xs text-gray-500">Total Tasks</div>
            </div>
            <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
              <div className={`text-2xl font-bold ${getSuccessRateColor(data.totals?.successRate || 0)}`}>
                {data.totals?.successRate || 0}%
              </div>
              <div className="text-xs text-gray-500">Success Rate</div>
            </div>
            <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-white">{data.totals?.activeDays || 0}</div>
              <div className="text-xs text-gray-500">Active Days</div>
            </div>
            <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-white">{data.totals?.activeWeeks || 0}</div>
              <div className="text-xs text-gray-500">Active Weeks</div>
            </div>
          </div>

          {/* Last Updated */}
          {data.lastUpdated && (
            <div className="text-xs text-gray-600 text-center pt-4 border-t border-port-border">
              Last updated: {new Date(data.lastUpdated).toLocaleString()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
