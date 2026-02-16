import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import AppTile from '../components/AppTile';
import BrailleSpinner from '../components/BrailleSpinner';
import CosDashboardWidget from '../components/CosDashboardWidget';
import GoalProgressWidget from '../components/GoalProgressWidget';
import * as api from '../services/api';
import socket from '../services/socket';

export default function Dashboard() {
  const [apps, setApps] = useState([]);
  const [health, setHealth] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    setError(null);
    const [appsData, healthData, usageData] = await Promise.all([
      api.getApps().catch(err => { setError(err.message); return []; }),
      api.checkHealth().catch(() => null),
      api.getUsage().catch(() => null)
    ]);
    setApps(appsData);
    setHealth(healthData);
    setUsage(usageData);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();

    // Listen for apps changes via WebSocket instead of polling
    const handleAppsChanged = () => {
      fetchData();
    };
    socket.on('apps:changed', handleAppsChanged);

    return () => {
      socket.off('apps:changed', handleAppsChanged);
    };
  }, [fetchData]);

  // Sort apps: active first, archived last
  const sortedApps = useMemo(() =>
    [...apps].sort((a, b) => (a.archived ? 1 : 0) - (b.archived ? 1 : 0)),
    [apps]
  );

  // Memoize derived stats to prevent recalculation on every render (exclude archived)
  const activeApps = useMemo(() => apps.filter(a => !a.archived), [apps]);
  const appStats = useMemo(() => ({
    total: activeApps.length,
    online: activeApps.filter(a => a.overallStatus === 'online').length,
    stopped: activeApps.filter(a => a.overallStatus === 'stopped').length,
    notStarted: activeApps.filter(a => a.overallStatus === 'not_started' || a.overallStatus === 'not_found').length
  }), [activeApps]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading dashboard" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Dashboard</h2>
          <p className="text-gray-500 text-sm sm:text-base">
            {activeApps.length} app{activeApps.length !== 1 ? 's' : ''} registered{apps.length !== activeApps.length ? ` (${apps.length - activeApps.length} archived)` : ''}
          </p>
        </div>
        {health && (
          <div className="text-sm text-gray-500">
            Server: <span className="text-port-success">Online</span>
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 bg-port-error/20 border border-port-error rounded-lg text-port-error">
          {error}
        </div>
      )}

      {/* CoS Status Widget */}
      <div className="mb-6">
        <CosDashboardWidget />
      </div>

      {/* Goal Progress Widget */}
      <div className="mb-6">
        <GoalProgressWidget />
      </div>

      {/* App Grid */}
      {apps.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-xl p-8 sm:p-12 text-center">
          <div className="text-4xl mb-4">📦</div>
          <h3 className="text-xl font-semibold text-white mb-2">No apps registered</h3>
          <p className="text-gray-500 mb-6">
            Register your first app to get started
          </p>
          <Link
            to="/apps/create"
            className="inline-flex items-center justify-center px-6 py-3 min-h-10 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
          >
            Add App
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sortedApps.map(app => (
            <AppTile key={app.id} app={app} onUpdate={fetchData} />
          ))}
        </div>
      )}

      {/* Activity Streak */}
      {usage && (usage.currentStreak > 0 || usage.longestStreak > 0) && (
        <div className="mt-6 sm:mt-8 bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
            <div className="flex items-center gap-3">
              <div className="text-3xl sm:text-4xl" aria-hidden="true">
                {usage.currentStreak >= 7 ? '🔥' : usage.currentStreak >= 3 ? '⚡' : '✨'}
              </div>
              <div>
                <div className="text-xl sm:text-2xl font-bold text-white">
                  {usage.currentStreak} day{usage.currentStreak !== 1 ? 's' : ''}
                </div>
                <div className="text-xs sm:text-sm text-gray-500">Current streak</div>
              </div>
            </div>
            {usage.longestStreak > usage.currentStreak && (
              <div className="sm:ml-auto text-left sm:text-right">
                <div className="text-base sm:text-lg font-semibold text-port-accent">
                  {usage.longestStreak} days
                </div>
                <div className="text-xs text-gray-500">Longest streak</div>
              </div>
            )}
            {usage.currentStreak === usage.longestStreak && usage.currentStreak > 0 && (
              <div className="sm:ml-auto px-3 py-1.5 bg-port-success/20 text-port-success text-xs sm:text-sm rounded-full w-fit">
                Personal best!
              </div>
            )}
          </div>
          {/* Mini streak visualization */}
          <div className="mt-4 flex gap-1.5 sm:gap-1">
            {usage.last7Days?.map((day) => (
              <div
                key={day.date}
                className={`flex-1 h-3 sm:h-2 rounded-full ${
                  day.sessions > 0 ? 'bg-port-success' : 'bg-port-border'
                }`}
                title={`${day.label}: ${day.sessions} sessions`}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-gray-500">
            <span>7 days ago</span>
            <span>Today</span>
          </div>
        </div>
      )}

      {/* Quick Stats */}
      {apps.length > 0 && (
        <div className="mt-6 sm:mt-8 grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
          <StatCard
            label="Total Apps"
            value={appStats.total}
            icon="📦"
          />
          <StatCard
            label="Online"
            value={appStats.online}
            icon="🟢"
          />
          <StatCard
            label="Stopped"
            value={appStats.stopped}
            icon="🟡"
          />
          <StatCard
            label="Not Started"
            value={appStats.notStarted}
            icon="⚪"
          />
        </div>
      )}

      {/* Hourly Activity Heatmap */}
      {usage?.hourlyActivity && (
        <HourlyActivityHeatmap hourlyActivity={usage.hourlyActivity} />
      )}
    </div>
  );
}

function StatCard({ label, value, icon }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3 sm:p-4" role="group" aria-label={`${label}: ${value}`}>
      <div className="flex items-center gap-2 mb-1">
        <span aria-hidden="true" className="text-base sm:text-lg">{icon}</span>
        <span className="text-xs sm:text-sm text-gray-500">{label}</span>
      </div>
      <div className="text-xl sm:text-2xl font-bold text-white">{value}</div>
    </div>
  );
}

function HourlyActivityHeatmap({ hourlyActivity }) {
  const maxActivity = Math.max(...hourlyActivity, 1);

  // Find peak hour(s)
  const peakValue = Math.max(...hourlyActivity);
  const peakHours = hourlyActivity
    .map((val, idx) => ({ hour: idx, count: val }))
    .filter(h => h.count === peakValue && h.count > 0);

  // Calculate total sessions
  const totalSessions = hourlyActivity.reduce((sum, val) => sum + val, 0);

  // Format hour label (12-hour format)
  const formatHour = (hour) => {
    if (hour === 0) return '12a';
    if (hour === 12) return '12p';
    return hour < 12 ? `${hour}a` : `${hour - 12}p`;
  };

  // Get intensity class based on activity level
  const getIntensityClass = (count) => {
    if (count === 0) return 'bg-port-border/30';
    const intensity = count / maxActivity;
    if (intensity >= 0.8) return 'bg-port-success';
    if (intensity >= 0.5) return 'bg-port-success/70';
    if (intensity >= 0.25) return 'bg-port-success/40';
    return 'bg-port-success/20';
  };

  // Determine peak time description
  const getPeakTimeDescription = () => {
    if (peakHours.length === 0 || peakValue === 0) return null;
    if (peakHours.length === 1) {
      const hour = peakHours[0].hour;
      return `Peak: ${formatHour(hour)} (${peakValue} sessions)`;
    }
    const hours = peakHours.slice(0, 3).map(h => formatHour(h.hour)).join(', ');
    return `Peak hours: ${hours} (${peakValue} sessions each)`;
  };

  if (totalSessions === 0) return null;

  return (
    <div className="mt-8 bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <div className="text-2xl" aria-hidden="true">⏰</div>
          <div>
            <h3 className="text-lg font-semibold text-white">Activity by Hour</h3>
            <p className="text-sm text-gray-500">{totalSessions} total sessions tracked</p>
          </div>
        </div>
        {getPeakTimeDescription() && (
          <div className="text-sm text-port-success">
            {getPeakTimeDescription()}
          </div>
        )}
      </div>

      {/* Heatmap grid - 12 cols on sm+, 6 cols (2 rows) on mobile for larger touch targets */}
      <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5 sm:gap-1" role="img" aria-label="Hourly activity heatmap">
        {hourlyActivity.map((count, hour) => (
          <div
            key={hour}
            className={`aspect-square rounded-sm ${getIntensityClass(count)} transition-colors cursor-default min-w-[20px] min-h-[20px]`}
            title={`${formatHour(hour)}: ${count} session${count !== 1 ? 's' : ''}`}
            aria-label={`${formatHour(hour)}: ${count} sessions`}
          />
        ))}
      </div>

      {/* Hour labels - simplified for mobile */}
      <div className="mt-2 grid grid-cols-6 sm:grid-cols-12 gap-1.5 sm:gap-1 text-xs text-gray-500">
        {hourlyActivity.map((_, hour) => (
          <div
            key={hour}
            className="text-center"
          >
            {/* Mobile: show every 4th hour, Desktop: every 3rd hour */}
            <span className="hidden sm:inline">{hour % 3 === 0 ? formatHour(hour) : ''}</span>
            <span className="sm:hidden">{hour % 4 === 0 ? formatHour(hour) : ''}</span>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-4 flex items-center justify-end gap-2 text-xs text-gray-500">
        <span>Less</span>
        <div className="flex gap-1">
          <div className="w-4 h-4 sm:w-3 sm:h-3 rounded-sm bg-port-border/30" />
          <div className="w-4 h-4 sm:w-3 sm:h-3 rounded-sm bg-port-success/20" />
          <div className="w-4 h-4 sm:w-3 sm:h-3 rounded-sm bg-port-success/40" />
          <div className="w-4 h-4 sm:w-3 sm:h-3 rounded-sm bg-port-success/70" />
          <div className="w-4 h-4 sm:w-3 sm:h-3 rounded-sm bg-port-success" />
        </div>
        <span>More</span>
      </div>
    </div>
  );
}
