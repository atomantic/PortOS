import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Brain,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Clock,
  AlertTriangle,
  CheckCircle,
  XCircle,
  SkipForward,
  Zap,
  BarChart2,
  Timer,
  Target,
  ChevronDown,
  ChevronRight,
  Database
} from 'lucide-react';
import * as api from '../../../services/api';

export default function LearningTab() {
  const [learning, setLearning] = useState(null);
  const [performance, setPerformance] = useState(null);
  const [skipped, setSkipped] = useState(null);
  const [durations, setDurations] = useState(null);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    taskTypes: true,
    skipped: true,
    durations: false,
    models: true,
    errors: false
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    const [learningData, performanceData, skippedData, durationsData] = await Promise.all([
      api.getCosLearning().catch(() => null),
      api.getCosLearningPerformance().catch(() => null),
      api.getCosLearningSkipped().catch(() => null),
      api.getCosLearningDurations().catch(() => null)
    ]);
    setLearning(learningData);
    setPerformance(performanceData);
    setSkipped(skippedData);
    setDurations(durationsData);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleBackfill = useCallback(async () => {
    setBackfilling(true);
    const result = await api.backfillCosLearning().catch(() => null);
    if (result?.success) {
      await loadData();
    }
    setBackfilling(false);
  }, [loadData]);

  const toggleSection = useCallback((section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  }, []);

  // Memoize helper functions to prevent re-creation on each render
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

  const formatDuration = useCallback((ms) => {
    if (!ms) return '—';
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }, []);

  // Memoize sorted durations to avoid re-sorting on each render
  const sortedDurations = useMemo(() => {
    if (!durations) return [];
    return Object.entries(durations)
      .filter(([key]) => key !== '_overall')
      .sort((a, b) => b[1].avgDurationMs - a[1].avgDurationMs);
  }, [durations]);

  const hasData = learning?.totals?.completed > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Brain className="w-5 h-5 text-purple-400" />
          <h3 className="text-lg font-semibold text-white">Learning Analytics</h3>
        </div>
        <div className="flex gap-2">
          {!hasData && !loading && (
            <button
              onClick={handleBackfill}
              disabled={backfilling}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 rounded-lg transition-colors disabled:opacity-50"
            >
              <Database size={14} />
              {backfilling ? 'Backfilling...' : 'Backfill History'}
            </button>
          )}
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-port-accent" />
        </div>
      ) : !hasData ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <Brain className="w-12 h-12 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400">No learning data available yet.</p>
          <p className="text-gray-500 text-sm mt-1">
            Complete some tasks to see performance analytics, or click &quot;Backfill History&quot; to import existing data.
          </p>
        </div>
      ) : (
        <>
          {/* Overview Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <Target size={14} className="text-port-accent" />
                <span className="text-xs text-gray-500">Tasks Analyzed</span>
              </div>
              <div className="text-2xl font-bold text-white">{learning.totals.completed}</div>
              <div className="text-xs text-gray-500">
                {learning.totals.succeeded} success / {learning.totals.failed} failed
              </div>
            </div>

            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp size={14} className={getSuccessRateColor(learning.totals.successRate)} />
                <span className="text-xs text-gray-500">Success Rate</span>
              </div>
              <div className={`text-2xl font-bold ${getSuccessRateColor(learning.totals.successRate)}`}>
                {learning.totals.successRate}%
              </div>
              <div className="w-full bg-port-border rounded-full h-1.5 mt-2">
                <div
                  className={`h-1.5 rounded-full ${getSuccessRateBg(learning.totals.successRate)}`}
                  style={{ width: `${learning.totals.successRate}%` }}
                />
              </div>
            </div>

            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <Clock size={14} className="text-cyan-400" />
                <span className="text-xs text-gray-500">Avg Duration</span>
              </div>
              <div className="text-2xl font-bold text-cyan-400">{learning.totals.avgDurationMin}m</div>
              <div className="text-xs text-gray-500">per task</div>
            </div>

            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <SkipForward size={14} className={skipped?.skippedCount > 0 ? 'text-port-warning' : 'text-gray-500'} />
                <span className="text-xs text-gray-500">Skipped Types</span>
              </div>
              <div className={`text-2xl font-bold ${skipped?.skippedCount > 0 ? 'text-port-warning' : 'text-gray-500'}`}>
                {skipped?.skippedCount || 0}
              </div>
              <div className="text-xs text-gray-500">due to low success</div>
            </div>
          </div>

          {/* Recommendations */}
          {learning.recommendations?.length > 0 && (
            <div className="bg-gradient-to-r from-purple-500/10 to-blue-500/10 border border-purple-500/30 rounded-lg p-4">
              <h4 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
                <Zap size={14} className="text-yellow-400" />
                AI Recommendations
              </h4>
              <div className="space-y-2">
                {learning.recommendations.map((rec, idx) => (
                  <div
                    key={idx}
                    className={`text-sm p-2 rounded flex items-start gap-2 ${
                      rec.type === 'warning' ? 'bg-yellow-500/10 text-yellow-400' :
                      rec.type === 'action' ? 'bg-red-500/10 text-red-400' :
                      rec.type === 'optimization' ? 'bg-green-500/10 text-green-400' :
                      rec.type === 'suggestion' ? 'bg-blue-500/10 text-blue-400' :
                      'bg-gray-500/10 text-gray-400'
                    }`}
                  >
                    {rec.type === 'warning' && <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
                    {rec.type === 'action' && <XCircle size={14} className="mt-0.5 shrink-0" />}
                    {rec.type === 'optimization' && <CheckCircle size={14} className="mt-0.5 shrink-0" />}
                    {rec.type === 'suggestion' && <Zap size={14} className="mt-0.5 shrink-0" />}
                    {rec.type === 'info' && <Target size={14} className="mt-0.5 shrink-0" />}
                    <span>{rec.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Task Type Performance */}
          <div>
            <button
              onClick={() => toggleSection('taskTypes')}
              className="flex items-center gap-2 w-full text-left mb-3"
            >
              {expandedSections.taskTypes ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <BarChart2 size={16} className="text-port-accent" />
              <span className="font-medium text-white">Task Type Performance</span>
              <span className="text-xs text-gray-500">
                ({performance?.topPerformers?.length || 0} top, {performance?.needsAttention?.length || 0} need attention)
              </span>
            </button>
            {expandedSections.taskTypes && (
              <div className="space-y-4">
                {/* Top Performers */}
                {performance?.topPerformers?.length > 0 && (
                  <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                    <div className="px-4 py-2 bg-port-success/10 border-b border-port-border">
                      <span className="text-sm font-medium text-port-success flex items-center gap-2">
                        <TrendingUp size={14} />
                        Top Performers (80%+ success)
                      </span>
                    </div>
                    <div className="divide-y divide-port-border">
                      {performance.topPerformers.map((item, idx) => (
                        <div key={idx} className="p-3 flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-white truncate">{item.taskType}</div>
                            <div className="text-xs text-gray-500">
                              {item.completed} tasks • {item.avgDurationMin}m avg
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="w-24 bg-port-border rounded-full h-2">
                              <div
                                className="h-2 rounded-full bg-port-success"
                                style={{ width: `${item.successRate}%` }}
                              />
                            </div>
                            <span className="text-sm font-mono text-port-success w-12 text-right">
                              {item.successRate}%
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Needs Attention */}
                {performance?.needsAttention?.length > 0 && (
                  <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                    <div className="px-4 py-2 bg-port-error/10 border-b border-port-border">
                      <span className="text-sm font-medium text-port-error flex items-center gap-2">
                        <TrendingDown size={14} />
                        Needs Attention (&lt;50% success)
                      </span>
                    </div>
                    <div className="divide-y divide-port-border">
                      {performance.needsAttention.map((item, idx) => (
                        <div key={idx} className="p-3 flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-white truncate">{item.taskType}</div>
                            <div className="text-xs text-gray-500">
                              {item.completed} tasks • {item.avgDurationMin}m avg
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="w-24 bg-port-border rounded-full h-2">
                              <div
                                className="h-2 rounded-full bg-port-error"
                                style={{ width: `${item.successRate}%` }}
                              />
                            </div>
                            <span className="text-sm font-mono text-port-error w-12 text-right">
                              {item.successRate}%
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {performance?.topPerformers?.length === 0 && performance?.needsAttention?.length === 0 && (
                  <div className="text-center py-4 text-gray-500 text-sm">
                    Need at least 3 completed tasks per type to show performance data
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Skipped Task Types */}
          {skipped?.skippedCount > 0 && (
            <div>
              <button
                onClick={() => toggleSection('skipped')}
                className="flex items-center gap-2 w-full text-left mb-3"
              >
                {expandedSections.skipped ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <SkipForward size={16} className="text-port-warning" />
                <span className="font-medium text-white">Skipped Task Types</span>
                <span className="text-xs text-port-warning">({skipped.skippedCount})</span>
              </button>
              {expandedSections.skipped && (
                <div className="bg-port-warning/10 border border-port-warning/30 rounded-lg p-4">
                  <p className="text-sm text-gray-400 mb-3">
                    These task types have been automatically skipped due to very low success rates (&lt;30% with 5+ attempts).
                  </p>
                  <div className="space-y-2">
                    {skipped.skippedTypes.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between p-2 bg-port-bg rounded">
                        <div>
                          <span className="text-sm text-white">{item.taskType}</span>
                          <span className="text-xs text-gray-500 ml-2">
                            ({item.completed} attempts)
                          </span>
                        </div>
                        <span className="text-sm text-port-error font-mono">{item.successRate}%</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 mt-3">
                    Fix underlying issues to re-enable these task types
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Duration Estimates */}
          {durations && Object.keys(durations).length > 1 && (
            <div>
              <button
                onClick={() => toggleSection('durations')}
                className="flex items-center gap-2 w-full text-left mb-3"
              >
                {expandedSections.durations ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <Timer size={16} className="text-cyan-400" />
                <span className="font-medium text-white">Duration Estimates</span>
                <span className="text-xs text-gray-500">
                  ({Object.keys(durations).length - 1} task types)
                </span>
              </button>
              {expandedSections.durations && (
                <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-port-bg">
                      <tr>
                        <th className="text-left p-3 text-gray-500 font-medium">Task Type</th>
                        <th className="text-right p-3 text-gray-500 font-medium">Avg Duration</th>
                        <th className="text-right p-3 text-gray-500 font-medium hidden sm:table-cell">Samples</th>
                        <th className="text-right p-3 text-gray-500 font-medium hidden sm:table-cell">Success</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDurations.map(([taskType, data], idx) => (
                        <tr key={idx} className="border-t border-port-border">
                          <td className="p-3 text-gray-300 truncate max-w-[200px]">{taskType}</td>
                          <td className="p-3 text-right text-cyan-400 font-mono">
                            {formatDuration(data.avgDurationMs)}
                          </td>
                          <td className="p-3 text-right text-gray-500 hidden sm:table-cell">
                            {data.completed}
                          </td>
                          <td className={`p-3 text-right font-mono hidden sm:table-cell ${getSuccessRateColor(data.successRate)}`}>
                            {data.successRate}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Model Performance */}
          {learning.insights?.modelEffectiveness?.length > 0 && (
            <div>
              <button
                onClick={() => toggleSection('models')}
                className="flex items-center gap-2 w-full text-left mb-3"
              >
                {expandedSections.models ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <Zap size={16} className="text-yellow-400" />
                <span className="font-medium text-white">Model Performance</span>
                <span className="text-xs text-gray-500">
                  ({learning.insights.modelEffectiveness.length} tiers)
                </span>
              </button>
              {expandedSections.models && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {learning.insights.modelEffectiveness.map((model, idx) => {
                    const tierLabels = {
                      'light': { label: 'Haiku', desc: 'Fast, simple tasks' },
                      'medium': { label: 'Sonnet', desc: 'Balanced performance' },
                      'heavy': { label: 'Opus', desc: 'Complex tasks' },
                      'user-specified': { label: 'User Selected', desc: 'Manual override' }
                    };
                    const info = tierLabels[model.tier] || { label: model.tier, desc: '' };

                    return (
                      <div key={idx} className="bg-port-card border border-port-border rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium text-white">{info.label}</span>
                          <span className={`text-lg font-bold ${getSuccessRateColor(model.successRate)}`}>
                            {model.successRate}%
                          </span>
                        </div>
                        <div className="w-full bg-port-border rounded-full h-2 mb-2">
                          <div
                            className={`h-2 rounded-full ${getSuccessRateBg(model.successRate)}`}
                            style={{ width: `${model.successRate}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-xs text-gray-500">
                          <span>{info.desc}</span>
                          <span>{model.completed} tasks • {model.avgDurationMin}m avg</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Error Patterns */}
          {learning.insights?.commonErrors?.length > 0 && (
            <div>
              <button
                onClick={() => toggleSection('errors')}
                className="flex items-center gap-2 w-full text-left mb-3"
              >
                {expandedSections.errors ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <AlertTriangle size={16} className="text-port-error" />
                <span className="font-medium text-white">Error Patterns</span>
                <span className="text-xs text-gray-500">
                  ({learning.insights.commonErrors.length} categories)
                </span>
              </button>
              {expandedSections.errors && (
                <div className="bg-port-card border border-port-border rounded-lg divide-y divide-port-border">
                  {learning.insights.commonErrors.map((error, idx) => (
                    <div key={idx} className="p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-port-error font-medium">{error.category}</span>
                        <span className="text-xs text-gray-500">{error.count} occurrences</span>
                      </div>
                      {error.affectedTypes?.length > 0 && (
                        <div className="text-xs text-gray-500">
                          Affects: {error.affectedTypes.join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Last Updated */}
          {learning.lastUpdated && (
            <div className="text-xs text-gray-600 text-center pt-4 border-t border-port-border">
              Learning data last updated: {new Date(learning.lastUpdated).toLocaleString()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
