import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import { RefreshCw, CheckCircle, AlertCircle, TrendingUp, Brain, Clock, Trophy, Activity } from 'lucide-react';
import { getCosTodayActivity } from '../../../services/apiAgents.js';
import { formatDateTime } from '../../../utils/formatters';
import ProviderStatusCard from './ProviderStatusCard';
import ListLoadError from '../../ui/ListLoadError';

export default function HealthTab({ health, healthLoading = false, healthError = null, onCheck }) {
  const [todayActivity, setTodayActivity] = useState(null);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [activityFailed, setActivityFailed] = useState(false);

  useEffect(() => {
    loadTodayActivity();
  }, []);

  const loadTodayActivity = async () => {
    setLoadingActivity(true);
    const data = await getCosTodayActivity({ silent: true }).catch(() => null);
    setActivityFailed(!data);
    if (data) setTodayActivity(data);
    setLoadingActivity(false);
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
              disabled={loadingActivity}
              aria-label="Refresh activity"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-white transition-colors"
            >
              <RefreshCw size={12} className={loadingActivity ? 'animate-spin' : ''} />
            </button>
          </div>

          {activityFailed && <ListLoadError what="activity data" onRetry={loadTodayActivity} retrying={loadingActivity} />}
          {loadingActivity && !todayActivity && <div className="text-center py-4 text-gray-500">Loading activity...</div>}
          {todayActivity && (todayActivity.stats.completed === 0 ? !activityFailed && (
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
                  <Clock size={12} className="text-port-accent" />
                  <span className="text-xs text-gray-500">Time Worked</span>
                </div>
                <div className="text-xl font-bold text-port-accent">{todayActivity.time.combined}</div>
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
          ))}
        </div>

        {/* System Health */}
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-white">System Health</h3>
              {health?.lastCheck && (
                <p className="text-xs text-gray-500">
                  Last check: {formatDateTime(health.lastCheck)}
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

          {healthError && (
            <div role="alert" className="bg-port-warning/10 border border-port-warning/30 rounded-lg p-3 mb-2 text-port-warning text-sm">
              <p className="font-medium">{health ? 'Health results stale' : 'CoS health unavailable'}</p>
              <p className="text-xs mt-1">{healthError}</p>
            </div>
          )}
          {healthLoading ? (
            <div className="text-center py-4 text-gray-500">
              <RefreshCw size={16} className="animate-spin mx-auto mb-2" />
              Loading health...
            </div>
          ) : !Array.isArray(health?.issues) ? (
            !healthError && <p className="text-port-warning text-sm">Health has not been observed. Run Check to retry.</p>
          ) : healthError && health.issues.length === 0 ? (
            <p className="text-gray-400 text-sm">The last successful check found no issues. Current health is unknown.</p>
          ) : health.issues.length === 0 ? (
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
          ) : todayActivity && !activityFailed && (
            <div className="text-center py-4 text-gray-500 text-sm">
              No accomplishments yet today
            </div>
          )}
        </div>
      </div>

      <div className="bg-port-card border border-port-border rounded-xl p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Brain size={12} className="text-port-accent-2" />
          Task Learning
        </h3>
        <p className="mt-1 text-sm text-gray-400">
          Review task performance, confidence, and recommendations in the{' '}
          <Link to="/cos/learning" className="text-port-accent underline">Learning tab</Link>.
        </p>
      </div>
    </div>
  );
}
