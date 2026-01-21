import { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, TrendingUp, Brain, Zap, Database, Clock, Trophy, Activity } from 'lucide-react';
import * as api from '../../../services/api';
import ProviderStatusCard from './ProviderStatusCard';

export default function HealthTab({ health, onCheck }) {
  const [learning, setLearning] = useState(null);
  const [loadingLearning, setLoadingLearning] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [todayActivity, setTodayActivity] = useState(null);
  const [loadingActivity, setLoadingActivity] = useState(true);

  useEffect(() => {
    loadLearning();
    loadTodayActivity();
  }, []);

  const loadTodayActivity = async () => {
    setLoadingActivity(true);
    const data = await api.getCosTodayActivity().catch(() => null);
    setTodayActivity(data);
    setLoadingActivity(false);
  };

  const loadLearning = async () => {
    setLoadingLearning(true);
    const data = await api.getCosLearning().catch(() => null);
    setLearning(data);
    setLoadingLearning(false);
  };

  const handleBackfill = async () => {
    setBackfilling(true);
    const result = await api.backfillCosLearning().catch(() => null);
    if (result?.success) {
      await loadLearning();
    }
    setBackfilling(false);
  };

  return (
    <div className="space-y-6">
      {/* Today's Activity Section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-port-accent" />
            <h3 className="text-lg font-semibold text-white">Today's Activity</h3>
          </div>
          <button
            onClick={loadTodayActivity}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <RefreshCw size={14} className={loadingActivity ? 'animate-spin' : ''} />
          </button>
        </div>

        {loadingActivity ? (
          <div className="text-center py-4 text-gray-500">Loading activity...</div>
        ) : !todayActivity ? (
          <div className="text-center py-4 text-gray-500">Could not load activity data</div>
        ) : (
          <div className="space-y-4">
            {/* Stats Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle size={14} className="text-port-success" />
                  <span className="text-xs text-gray-500">Completed</span>
                </div>
                <div className="text-2xl font-bold text-white">{todayActivity.stats.completed}</div>
                <div className="text-xs text-gray-500">
                  {todayActivity.stats.succeeded} success / {todayActivity.stats.failed} failed
                </div>
              </div>

              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <TrendingUp size={14} className="text-port-accent" />
                  <span className="text-xs text-gray-500">Success Rate</span>
                </div>
                <div className={`text-2xl font-bold ${
                  todayActivity.stats.successRate >= 80 ? 'text-port-success' :
                  todayActivity.stats.successRate >= 50 ? 'text-port-warning' : 'text-port-error'
                }`}>
                  {todayActivity.stats.successRate}%
                </div>
                <div className="text-xs text-gray-500">today</div>
              </div>

              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Clock size={14} className="text-cyan-400" />
                  <span className="text-xs text-gray-500">Time Worked</span>
                </div>
                <div className="text-2xl font-bold text-cyan-400">{todayActivity.time.combined}</div>
                <div className="text-xs text-gray-500">
                  {todayActivity.stats.running > 0 && `${todayActivity.stats.running} active`}
                </div>
              </div>

              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Trophy size={14} className="text-yellow-400" />
                  <span className="text-xs text-gray-500">Status</span>
                </div>
                <div className={`text-lg font-bold ${
                  todayActivity.isPaused ? 'text-port-warning' :
                  todayActivity.isRunning ? 'text-port-success' : 'text-gray-500'
                }`}>
                  {todayActivity.isPaused ? 'Paused' :
                   todayActivity.isRunning ? 'Active' : 'Stopped'}
                </div>
                <div className="text-xs text-gray-500">
                  {todayActivity.stats.running > 0 ? `${todayActivity.stats.running} running` : 'idle'}
                </div>
              </div>
            </div>

            {/* Recent Accomplishments */}
            {todayActivity.accomplishments.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                  <Trophy size={14} className="text-yellow-400" />
                  Recent Accomplishments
                </h4>
                <div className="space-y-2">
                  {todayActivity.accomplishments.map((item, idx) => (
                    <div key={idx} className="flex items-start justify-between text-sm p-2 bg-port-bg rounded">
                      <div className="flex-1 min-w-0">
                        <span className="text-gray-300 block truncate">{item.description}</span>
                        <span className="text-xs text-gray-500">{item.taskType}</span>
                      </div>
                      <span className="text-xs text-gray-500 ml-2 whitespace-nowrap">
                        {Math.round(item.duration / 60000)}m
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {todayActivity.stats.completed === 0 && (
              <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
                No tasks completed today yet. CoS will start working when tasks are available.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Provider Status Section */}
      <ProviderStatusCard />

      {/* System Health Section */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">System Health</h3>
          {health?.lastCheck && (
            <p className="text-sm text-gray-500">
              Last check: {new Date(health.lastCheck).toLocaleString()}
            </p>
          )}
        </div>
        <button
          onClick={onCheck}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
        >
          <RefreshCw size={14} />
          Run Check
        </button>
      </div>

      {!health?.issues || health.issues.length === 0 ? (
        <div className="bg-port-success/10 border border-port-success/30 rounded-lg p-6 text-center">
          <CheckCircle className="w-12 h-12 text-port-success mx-auto mb-3" />
          <p className="text-port-success font-medium">All Systems Healthy</p>
          <p className="text-gray-500 text-sm mt-1">No issues detected</p>
        </div>
      ) : (
        <div className="space-y-2">
          {health.issues.map((issue, idx) => (
            <div
              key={idx}
              className={`border rounded-lg p-4 ${
                issue.type === 'error'
                  ? 'bg-port-error/10 border-port-error/30'
                  : 'bg-yellow-500/10 border-yellow-500/30'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle size={16} className={issue.type === 'error' ? 'text-port-error' : 'text-yellow-500'} />
                <span className={`text-sm font-medium uppercase ${
                  issue.type === 'error' ? 'text-port-error' : 'text-yellow-500'
                }`}>
                  {issue.category}
                </span>
              </div>
              <p className="text-white">{issue.message}</p>
            </div>
          ))}
        </div>
      )}

      {/* Task Learning Section */}
      <div className="pt-6 border-t border-port-border">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Brain className="w-5 h-5 text-purple-400" />
            <h3 className="text-lg font-semibold text-white">Task Learning</h3>
          </div>
          <div className="flex gap-2">
            {learning?.totals?.completed === 0 && (
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
              onClick={loadLearning}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
            >
              <RefreshCw size={14} className={loadingLearning ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {loadingLearning ? (
          <div className="text-center py-8 text-gray-500">Loading learning data...</div>
        ) : !learning ? (
          <div className="text-center py-8 text-gray-500">No learning data available yet</div>
        ) : (
          <div className="space-y-4">
            {/* Overall Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="text-2xl font-bold text-white">{learning.totals?.completed || 0}</div>
                <div className="text-xs text-gray-500">Tasks Tracked</div>
              </div>
              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="text-2xl font-bold text-port-success">{learning.totals?.successRate || 0}%</div>
                <div className="text-xs text-gray-500">Success Rate</div>
              </div>
              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="text-2xl font-bold text-cyan-400">{learning.totals?.avgDurationMin || 0}m</div>
                <div className="text-xs text-gray-500">Avg Duration</div>
              </div>
              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="text-2xl font-bold text-port-error">{learning.totals?.failed || 0}</div>
                <div className="text-xs text-gray-500">Failed Tasks</div>
              </div>
            </div>

            {/* Recommendations */}
            {learning.recommendations?.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-gray-400 flex items-center gap-2">
                  <Zap size={14} className="text-yellow-400" />
                  Recommendations
                </h4>
                {learning.recommendations.map((rec, idx) => (
                  <div
                    key={idx}
                    className={`text-sm p-3 rounded-lg border ${
                      rec.type === 'warning' ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400' :
                      rec.type === 'action' ? 'bg-red-500/10 border-red-500/30 text-red-400' :
                      rec.type === 'optimization' ? 'bg-green-500/10 border-green-500/30 text-green-400' :
                      rec.type === 'suggestion' ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' :
                      'bg-gray-500/10 border-gray-500/30 text-gray-400'
                    }`}
                  >
                    {rec.message}
                  </div>
                ))}
              </div>
            )}

            {/* Best/Worst Performing Task Types */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {learning.insights?.bestPerforming?.length > 0 && (
                <div className="bg-port-card border border-port-border rounded-lg p-4">
                  <h4 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                    <TrendingUp size={14} className="text-green-400" />
                    Best Performing
                  </h4>
                  <div className="space-y-2">
                    {learning.insights.bestPerforming.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between text-sm">
                        <span className="text-gray-300 truncate">{item.type}</span>
                        <span className="text-green-400 font-mono">{item.successRate}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {learning.insights?.worstPerforming?.length > 0 && (
                <div className="bg-port-card border border-port-border rounded-lg p-4">
                  <h4 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                    <AlertCircle size={14} className="text-red-400" />
                    Needs Improvement
                  </h4>
                  <div className="space-y-2">
                    {learning.insights.worstPerforming.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between text-sm">
                        <span className="text-gray-300 truncate">{item.type}</span>
                        <span className="text-red-400 font-mono">{item.successRate}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Model Effectiveness */}
            {learning.insights?.modelEffectiveness?.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-400 mb-3">Model Performance</h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {learning.insights.modelEffectiveness.map((model, idx) => (
                    <div key={idx} className="flex items-center justify-between text-sm p-2 bg-port-bg rounded">
                      <span className="text-gray-300 capitalize">{model.tier}</span>
                      <div className="flex items-center gap-2">
                        <span className={`font-mono ${model.successRate >= 80 ? 'text-green-400' : model.successRate >= 60 ? 'text-yellow-400' : 'text-red-400'}`}>
                          {model.successRate}%
                        </span>
                        <span className="text-gray-500 text-xs">({model.completed})</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Common Errors */}
            {learning.insights?.commonErrors?.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-400 mb-3">Common Error Patterns</h4>
                <div className="space-y-2">
                  {learning.insights.commonErrors.map((error, idx) => (
                    <div key={idx} className="flex items-center justify-between text-sm p-2 bg-port-bg rounded">
                      <span className="text-red-400">{error.category}</span>
                      <span className="text-gray-500">{error.count} occurrences</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Last Updated */}
            {learning.lastUpdated && (
              <p className="text-xs text-gray-600 text-center">
                Learning data updated: {new Date(learning.lastUpdated).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
