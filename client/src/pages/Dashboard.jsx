import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import AppTile from '../components/AppTile';
import * as api from '../services/api';

export default function Dashboard() {
  const [apps, setApps] = useState([]);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = async () => {
    setError(null);
    const [appsData, healthData] = await Promise.all([
      api.getApps().catch(err => { setError(err.message); return []; }),
      api.checkHealth().catch(() => null)
    ]);
    setApps(appsData);
    setHealth(healthData);
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Dashboard</h2>
          <p className="text-gray-500">
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

      {/* Quick Stats */}
      {apps.length > 0 && (
        <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Total Apps"
            value={apps.length}
            icon="📦"
          />
          <StatCard
            label="Online"
            value={apps.filter(a => a.overallStatus === 'online').length}
            icon="🟢"
          />
          <StatCard
            label="Stopped"
            value={apps.filter(a => a.overallStatus === 'stopped').length}
            icon="🟡"
          />
          <StatCard
            label="Not Started"
            value={apps.filter(a => a.overallStatus === 'not_started' || a.overallStatus === 'not_found').length}
            icon="⚪"
          />
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <span>{icon}</span>
        <span className="text-sm text-gray-500">{label}</span>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
    </div>
  );
}
