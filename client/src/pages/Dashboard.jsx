import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import AppTile from '../components/AppTile';
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

  // Memoize derived stats to prevent recalculation on every render
  const appStats = useMemo(() => ({
    total: apps.length,
    online: apps.filter(a => a.overallStatus === 'online').length,
    stopped: apps.filter(a => a.overallStatus === 'stopped').length,
    notStarted: apps.filter(a => a.overallStatus === 'not_started' || a.overallStatus === 'not_found').length
  }), [apps]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
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
            {apps.length} app{apps.length !== 1 ? 's' : ''} registered
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

      {/* App Grid */}
      {apps.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-xl p-12 text-center">
          <div className="text-4xl mb-4">📦</div>
          <h3 className="text-xl font-semibold text-white mb-2">No apps registered</h3>
          <p className="text-gray-500 mb-6">
            Register your first app to get started
          </p>
          <Link
            to="/apps/create"
            className="inline-block px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
          >
            Add App
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {apps.map(app => (
            <AppTile key={app.id} app={app} onUpdate={fetchData} />
          ))}
        </div>
      )}

      {/* Activity Streak */}
      {usage && (usage.currentStreak > 0 || usage.longestStreak > 0) && (
        <div className="mt-8 bg-port-card border border-port-border rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="text-4xl" aria-hidden="true">
                {usage.currentStreak >= 7 ? '🔥' : usage.currentStreak >= 3 ? '⚡' : '✨'}
              </div>
              <div>
                <div className="text-2xl font-bold text-white">
                  {usage.currentStreak} day{usage.currentStreak !== 1 ? 's' : ''}
                </div>
                <div className="text-sm text-gray-500">Current streak</div>
              </div>
            </div>
            {usage.longestStreak > usage.currentStreak && (
              <div className="sm:ml-auto text-right">
                <div className="text-lg font-semibold text-port-accent">
                  {usage.longestStreak} days
                </div>
                <div className="text-xs text-gray-500">Longest streak</div>
              </div>
            )}
            {usage.currentStreak === usage.longestStreak && usage.currentStreak > 0 && (
              <div className="sm:ml-auto px-3 py-1 bg-port-success/20 text-port-success text-sm rounded-full">
                Personal best!
              </div>
            )}
          </div>
          {/* Mini streak visualization */}
          <div className="mt-4 flex gap-1">
            {usage.last7Days?.map((day) => (
              <div
                key={day.date}
                className={`flex-1 h-2 rounded-full ${
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
        <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4">
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
    </div>
  );
}

function StatCard({ label, value, icon }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4" role="group" aria-label={`${label}: ${value}`}>
      <div className="flex items-center gap-2 mb-1">
        <span aria-hidden="true">{icon}</span>
        <span className="text-sm text-gray-500">{label}</span>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
    </div>
  );
}
