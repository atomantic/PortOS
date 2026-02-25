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
    <div className="space-y-4">
      {/* ROW 1: Today's Activity | System Health */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Today's Activity */}
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity size={12} className="text-port-accent" />
              <h3 className="text-sm font-semibold text-white">Today's Activity</h3>
            </div>
            <button
              onClick={loadTodayActivity}
              className="text-gray-500 hover:text-white transition-colors"
            >
              <RefreshCw size={12} className={loadingActivity ? 'animate-spin' : ''} />
            </button>
          </div>

          {loadingActivity ? (
            <div className="text-center py-4 text-gray-500">Loading activity...</div>
          ) : !todayActivity ? (
            <div className="text-center py-4 text-gray-500">Could not load activity data</div>
          ) : todayActivity.stats.completed === 0 ? (
            <div className="text-center py-4 text-gray-500">
              No tasks completed today yet. CoS will start working when tasks are available.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-port-bg/50 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle size={12} className="text-port-success" />
                  <span className="text-xs text-gray-500">Completed</span>
                </div>
                <div className="text-xl font-bold text-white">{todayActivity.stats.completed}</div>
                <div className="text-xs text-gray-500">
                  {todayActivity.stats.succeeded} success / {todayActivity.stats.failed} failed
                </div>
              </div>

              <div className="bg-port-bg/50 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <TrendingUp size={12} className="text-port-accent" />
                  <span className="text-xs text-gray-500">Success Rate</span>
                </div>
                <div className={`text-xl font-bold ${
                  todayActivity.stats.successRate >= 80 ? 'text-port-success' :
                  todayActivity.stats.successRate >= 50 ? 'text-port-warning' : 'text-port-error'
                }`}>
                  {todayActivity.stats.successRate}%
                </div>
                <div className="text-xs text-gray-500">today</div>
              </div>

              <div className="bg-port-bg/50 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Clock size={12} className="text-cyan-400" />
                  <span className="text-xs text-gray-500">Time Worked</span>
                </div>
                <div className="text-xl font-bold text-cyan-400">{todayActivity.time.combined}</div>
                <div className="text-xs text-gray-500">
                  {todayActivity.stats.running > 0 && `${todayActivity.stats.running} active`}
                </div>
              </div>

              <div className="bg-port-bg/50 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Trophy size={12} className="text-yellow-400" />
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
          )}
        </div>

        {/* System Health */}
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-white">System Health</h3>
              {health?.lastCheck && (
                <p className="text-xs text-gray-500">
                  Last check: {new Date(health.lastCheck).toLocaleString()}
                </p>
              )}
            </div>
            <button
              onClick={onCheck}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
            >
              <RefreshCw size={12} />
              Run Check
            </button>
          </div>

          {!health?.issues || health.issues.length === 0 ? (
            <div className="bg-port-success/10 border border-port-success/30 rounded-lg p-4 text-center">
              <CheckCircle className="w-8 h-8 text-port-success mx-auto mb-2" />
              <p className="text-port-success font-medium text-sm">All Systems Healthy</p>
              <p className="text-gray-500 text-xs mt-1">No issues detected</p>
            </div>
          ) : (
            <div className="space-y-2">
              {health.issues.map((issue, idx) => (
                <div
                  key={idx}
                  className={`border rounded-lg p-3 ${
                    issue.type === 'error'
                      ? 'bg-port-error/10 border-port-error/30'
                      : 'bg-yellow-500/10 border-yellow-500/30'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <AlertCircle size={14} className={issue.type === 'error' ? 'text-port-error' : 'text-yellow-500'} />
                    <span className={`text-xs font-medium uppercase ${
                      issue.type === 'error' ? 'text-port-error' : 'text-yellow-500'
                    }`}>
                      {issue.category}
                    </span>
                  </div>
                  <p className="text-white text-sm">{issue.message}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ROW 2: Provider Status | Recent Accomplishments */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <ProviderStatusCard />
        </div>

        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <h4 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
            <Trophy size={12} className="text-yellow-400" />
            Recent Accomplishments
          </h4>
          {todayActivity?.accomplishments?.length > 0 ? (
            <div className="space-y-2">
              {todayActivity.accomplishments.map((item, idx) => (
                <div key={idx} className="flex items-start justify-between text-sm p-2 bg-port-bg/50 rounded">
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
          ) : (
            <div className="text-center py-4 text-gray-500 text-sm">
              No accomplishments yet today
            </div>
          )}
        </div>
      </div>

      {/* ROW 3: Task Learning header + stats (full width) */}
      <div className="bg-port-card border border-port-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Brain size={12} className="text-purple-400" />
            <h3 className="text-sm font-semibold text-white">Task Learning</h3>
          </div>
          <div className="flex gap-2">
            {learning?.totals?.completed === 0 && (
              <button
                onClick={handleBackfill}
                disabled={backfilling}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 rounded-lg transition-colors disabled:opacity-50"
              >
                <Database size={12} />
                {backfilling ? 'Backfilling...' : 'Backfill History'}
              </button>
            )}
            <button
              onClick={loadLearning}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
            >
              <RefreshCw size={12} className={loadingLearning ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {loadingLearning ? (
          <div className="text-center py-6 text-gray-500">Loading learning data...</div>
        ) : !learning ? (
          <div className="text-center py-6 text-gray-500">No learning data available yet</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="bg-port-bg/50 rounded-lg p-3">
              <div className="text-xl font-bold text-white">{learning.totals?.completed || 0}</div>
              <div className="text-xs text-gray-500">Tasks Tracked</div>
            </div>
            <div className="bg-port-bg/50 rounded-lg p-3">
              <div className="text-xl font-bold text-port-success">{learning.totals?.successRate || 0}%</div>
              <div className="text-xs text-gray-500">Success Rate</div>
            </div>
            <div className="bg-port-bg/50 rounded-lg p-3">
              <div className="text-xl font-bold text-cyan-400">{learning.totals?.avgDurationMin || 0}m</div>
              <div className="text-xs text-gray-500">Avg Duration</div>
            </div>
            <div className="bg-port-bg/50 rounded-lg p-3">
              <div className="text-xl font-bold text-port-error">{learning.totals?.failed || 0}</div>
              <div className="text-xs text-gray-500">Failed Tasks</div>
            </div>
          </div>
        )}
      </div>

      {/* ROW 4: Learning details (Best Performing + Model | Needs Improvement + Errors + Recommendations) */}
      {learning && !loadingLearning && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left column: Best Performing + Model Performance */}
          <div className="space-y-4">
            {learning.insights?.bestPerforming?.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-xl p-4">
                <h4 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                  <TrendingUp size={12} className="text-green-400" />
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

            {learning.insights?.modelEffectiveness?.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-xl p-4">
                <h4 className="text-sm font-medium text-gray-400 mb-3">Model Performance</h4>
                <div className="space-y-2">
                  {learning.insights.modelEffectiveness.map((model, idx) => (
                    <div key={idx} className="flex items-center justify-between text-sm p-2 bg-port-bg/50 rounded">
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
          </div>

          {/* Right column: Needs Improvement + Common Errors + Recommendations */}
          <div className="space-y-4">
            {learning.insights?.worstPerforming?.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-xl p-4">
                <h4 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                  <AlertCircle size={12} className="text-red-400" />
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

            {learning.insights?.commonErrors?.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-xl p-4">
                <h4 className="text-sm font-medium text-gray-400 mb-3">Common Error Patterns</h4>
                <div className="space-y-2">
                  {learning.insights.commonErrors.map((error, idx) => (
                    <div key={idx} className="flex items-center justify-between text-sm p-2 bg-port-bg/50 rounded">
                      <span className="text-red-400">{error.category}</span>
                      <span className="text-gray-500">{error.count} occurrences</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {learning.recommendations?.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-xl p-4">
                <h4 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                  <Zap size={12} className="text-yellow-400" />
                  Recommendations
                </h4>
                <div className="space-y-2">
                  {learning.recommendations.map((rec, idx) => (
                    <div
                      key={idx}
                      className={`text-sm p-2.5 rounded-lg border ${
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
              </div>
            )}
          </div>
        </div>
      )}

      {/* Last Updated */}
      {learning?.lastUpdated && (
        <p className="text-xs text-gray-600 text-center">
          Learning data updated: {new Date(learning.lastUpdated).toLocaleString()}
        </p>
      )}
    </div>
  );
}
