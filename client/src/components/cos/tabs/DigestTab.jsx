import { useState, useEffect } from 'react';
import {
  Calendar,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Clock,
  CheckCircle,
  XCircle,
  Lightbulb,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  BarChart2,
  Trophy,
  Minus
} from 'lucide-react';
import * as api from '../../../services/api';

export default function DigestTab() {
  const [currentDigest, setCurrentDigest] = useState(null);
  const [weekProgress, setWeekProgress] = useState(null);
  const [digestList, setDigestList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedWeek, setSelectedWeek] = useState(null);
  const [expandedSections, setExpandedSections] = useState({
    accomplishments: true,
    byTaskType: false,
    issues: true,
    insights: true
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [digest, progress, list] = await Promise.all([
      api.getCosWeeklyDigest().catch(() => null),
      api.getCosWeekProgress().catch(() => null),
      api.listCosWeeklyDigests().catch(() => ({ digests: [] }))
    ]);
    setCurrentDigest(digest);
    setWeekProgress(progress);
    setDigestList(list.digests || []);
    setLoading(false);
  };

  const loadWeek = async (weekId) => {
    setLoading(true);
    setSelectedWeek(weekId);
    const digest = await api.getCosWeeklyDigest(weekId).catch(() => null);
    setCurrentDigest(digest);
    setLoading(false);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    const digest = await api.generateCosDigest().catch(() => null);
    if (digest) {
      setCurrentDigest(digest);
      await loadData();
    }
    setGenerating(false);
  };

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const formatChange = (value, suffix = '%') => {
    if (value === null || value === undefined) return null;
    const isPositive = value > 0;
    const isNegative = value < 0;
    return (
      <span className={`flex items-center gap-1 ${
        isPositive ? 'text-port-success' : isNegative ? 'text-port-error' : 'text-gray-500'
      }`}>
        {isPositive ? <TrendingUp size={12} /> : isNegative ? <TrendingDown size={12} /> : <Minus size={12} />}
        {isPositive ? '+' : ''}{value}{suffix}
      </span>
    );
  };

  const getInsightIcon = (type) => {
    switch (type) {
      case 'success': return <CheckCircle size={14} className="text-port-success" />;
      case 'warning': return <AlertTriangle size={14} className="text-port-warning" />;
      case 'action': return <AlertTriangle size={14} className="text-port-error" />;
      default: return <Lightbulb size={14} className="text-port-accent" />;
    }
  };

  const getInsightBg = (type) => {
    switch (type) {
      case 'success': return 'bg-port-success/10 border-port-success/30';
      case 'warning': return 'bg-port-warning/10 border-port-warning/30';
      case 'action': return 'bg-port-error/10 border-port-error/30';
      default: return 'bg-port-accent/10 border-port-accent/30';
    }
  };

  if (loading && !currentDigest) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 animate-spin text-port-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with Week Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Calendar className="w-5 h-5 text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Weekly Digest</h3>
          {digestList.length > 0 && (
            <select
              value={selectedWeek || currentDigest?.weekId || ''}
              onChange={(e) => loadWeek(e.target.value)}
              className="bg-port-card border border-port-border rounded px-2 py-1 text-sm text-gray-300"
            >
              {digestList.map(d => (
                <option key={d.weekId} value={d.weekId}>
                  {d.weekId} ({d.totalTasks} tasks)
                </option>
              ))}
            </select>
          )}
        </div>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
          {generating ? 'Generating...' : 'Refresh Digest'}
        </button>
      </div>

      {/* Current Week Progress (live data) */}
      {weekProgress && !selectedWeek && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-gray-400 flex items-center gap-2">
              <BarChart2 size={14} className="text-cyan-400" />
              Live Week Progress
            </h4>
            <span className="text-xs text-gray-500">
              {weekProgress.daysRemaining} days remaining
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-white">{weekProgress.current.totalTasks}</div>
              <div className="text-xs text-gray-500">Tasks Done</div>
            </div>
            <div className="text-center">
              <div className={`text-2xl font-bold ${
                weekProgress.current.successRate >= 80 ? 'text-port-success' :
                weekProgress.current.successRate >= 50 ? 'text-port-warning' : 'text-port-error'
              }`}>
                {weekProgress.current.successRate}%
              </div>
              <div className="text-xs text-gray-500">Success Rate</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-cyan-400">{weekProgress.current.totalWorkTime}</div>
              <div className="text-xs text-gray-500">Work Time</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-400">{weekProgress.projected.tasks}</div>
              <div className="text-xs text-gray-500">Projected Total</div>
            </div>
          </div>

          {weekProgress.current.runningAgents > 0 && (
            <div className="text-xs text-port-success flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-port-success animate-pulse" />
              {weekProgress.current.runningAgents} agent(s) currently working
            </div>
          )}
        </div>
      )}

      {!currentDigest ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <Calendar className="w-12 h-12 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400">No digest data available yet.</p>
          <p className="text-gray-500 text-sm mt-1">Complete some tasks and generate a digest to see your weekly summary.</p>
        </div>
      ) : (
        <>
          {/* Summary Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle size={14} className="text-port-success" />
                <span className="text-xs text-gray-500">Completed</span>
              </div>
              <div className="text-2xl font-bold text-white">{currentDigest.summary.totalTasks}</div>
              <div className="text-xs text-gray-500">
                {currentDigest.summary.succeededTasks} success / {currentDigest.summary.failedTasks} failed
              </div>
              {currentDigest.weekOverWeek?.tasksChange !== null && (
                <div className="mt-1 text-xs">
                  {formatChange(currentDigest.weekOverWeek.tasksChange)}
                </div>
              )}
            </div>

            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp size={14} className="text-port-accent" />
                <span className="text-xs text-gray-500">Success Rate</span>
              </div>
              <div className={`text-2xl font-bold ${
                currentDigest.summary.successRate >= 80 ? 'text-port-success' :
                currentDigest.summary.successRate >= 50 ? 'text-port-warning' : 'text-port-error'
              }`}>
                {currentDigest.summary.successRate}%
              </div>
              {currentDigest.weekOverWeek?.successRateChange !== null && (
                <div className="mt-2 text-xs">
                  {formatChange(currentDigest.weekOverWeek.successRateChange, ' pts')}
                </div>
              )}
            </div>

            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <Clock size={14} className="text-cyan-400" />
                <span className="text-xs text-gray-500">Work Time</span>
              </div>
              <div className="text-2xl font-bold text-cyan-400">{currentDigest.summary.totalWorkTime}</div>
              {currentDigest.weekOverWeek?.workTimeChange !== null && (
                <div className="mt-2 text-xs">
                  {formatChange(currentDigest.weekOverWeek.workTimeChange)}
                </div>
              )}
            </div>

            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <XCircle size={14} className="text-port-error" />
                <span className="text-xs text-gray-500">Issues</span>
              </div>
              <div className="text-2xl font-bold text-port-error">{currentDigest.issues?.length || 0}</div>
              <div className="text-xs text-gray-500">error patterns</div>
            </div>
          </div>

          {/* Insights */}
          {currentDigest.insights?.length > 0 && (
            <div>
              <button
                onClick={() => toggleSection('insights')}
                className="flex items-center gap-2 w-full text-left mb-3"
              >
                {expandedSections.insights ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <Lightbulb size={16} className="text-yellow-400" />
                <span className="font-medium text-white">Insights</span>
                <span className="text-xs text-gray-500">({currentDigest.insights.length})</span>
              </button>
              {expandedSections.insights && (
                <div className="space-y-2">
                  {currentDigest.insights.map((insight, idx) => (
                    <div
                      key={idx}
                      className={`border rounded-lg p-3 ${getInsightBg(insight.type)}`}
                    >
                      <div className="flex items-start gap-2">
                        {getInsightIcon(insight.type)}
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

          {/* Top Accomplishments */}
          {currentDigest.accomplishments?.length > 0 && (
            <div>
              <button
                onClick={() => toggleSection('accomplishments')}
                className="flex items-center gap-2 w-full text-left mb-3"
              >
                {expandedSections.accomplishments ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <Trophy size={16} className="text-yellow-400" />
                <span className="font-medium text-white">Top Accomplishments</span>
                <span className="text-xs text-gray-500">({currentDigest.accomplishments.length})</span>
              </button>
              {expandedSections.accomplishments && (
                <div className="bg-port-card border border-port-border rounded-lg divide-y divide-port-border">
                  {currentDigest.accomplishments.map((item, idx) => (
                    <div key={idx} className="p-3 flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white truncate">{item.description}</div>
                        <div className="text-xs text-gray-500 mt-1">
                          <span className="px-1.5 py-0.5 bg-port-bg rounded">{item.taskType}</span>
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 whitespace-nowrap">
                        {Math.round(item.duration / 60000)}m
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* By Task Type */}
          {currentDigest.byTaskType?.length > 0 && (
            <div>
              <button
                onClick={() => toggleSection('byTaskType')}
                className="flex items-center gap-2 w-full text-left mb-3"
              >
                {expandedSections.byTaskType ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <BarChart2 size={16} className="text-purple-400" />
                <span className="font-medium text-white">By Task Type</span>
                <span className="text-xs text-gray-500">({currentDigest.byTaskType.length} types)</span>
              </button>
              {expandedSections.byTaskType && (
                <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-port-bg">
                      <tr>
                        <th className="text-left p-2 text-gray-500 font-medium">Type</th>
                        <th className="text-right p-2 text-gray-500 font-medium">Done</th>
                        <th className="text-right p-2 text-gray-500 font-medium">Rate</th>
                        <th className="text-right p-2 text-gray-500 font-medium hidden sm:table-cell">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentDigest.byTaskType.map((item, idx) => (
                        <tr key={idx} className="border-t border-port-border">
                          <td className="p-2 text-gray-300 truncate max-w-[150px]">{item.type}</td>
                          <td className="p-2 text-right text-white font-mono">{item.completed}</td>
                          <td className={`p-2 text-right font-mono ${
                            item.successRate >= 80 ? 'text-port-success' :
                            item.successRate >= 50 ? 'text-port-warning' : 'text-port-error'
                          }`}>
                            {item.successRate}%
                          </td>
                          <td className="p-2 text-right text-gray-500 font-mono hidden sm:table-cell">
                            {Math.round(item.totalDurationMs / 60000)}m
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Issues */}
          {currentDigest.issues?.length > 0 && (
            <div>
              <button
                onClick={() => toggleSection('issues')}
                className="flex items-center gap-2 w-full text-left mb-3"
              >
                {expandedSections.issues ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <AlertTriangle size={16} className="text-port-error" />
                <span className="font-medium text-white">Error Patterns</span>
                <span className="text-xs text-gray-500">({currentDigest.issues.length})</span>
              </button>
              {expandedSections.issues && (
                <div className="space-y-2">
                  {currentDigest.issues.map((issue, idx) => (
                    <div
                      key={idx}
                      className="bg-port-error/10 border border-port-error/30 rounded-lg p-3"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-port-error font-medium">{issue.error}</span>
                        <span className="text-xs text-gray-500">{issue.count}x</span>
                      </div>
                      {issue.tasks?.length > 0 && (
                        <div className="text-xs text-gray-500">
                          Affected: {issue.tasks.map(t => t.description || t.id).join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Meta info */}
          <div className="text-xs text-gray-600 text-center pt-4 border-t border-port-border">
            Week: {currentDigest.weekId}
            ({new Date(currentDigest.weekStart).toLocaleDateString()} - {new Date(currentDigest.weekEnd).toLocaleDateString()})
            {currentDigest.previousWeekId && (
              <span className="ml-2">| Compared to {currentDigest.previousWeekId}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
