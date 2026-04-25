import { Link } from 'react-router-dom';
import AppTile from '../../AppTile';

export default function AppsGridWidget({ dashboardState }) {
  const { apps, sortedApps, refetch } = dashboardState;
  if (apps.length === 0) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-8 sm:p-12 text-center">
        <div className="text-4xl mb-4">📦</div>
        <h3 className="text-xl font-semibold text-white mb-2">No apps registered</h3>
        <p className="text-gray-500 mb-6">Register your first app to get started</p>
        <Link
          to="/apps/create"
          className="inline-flex items-center justify-center px-6 py-3 min-h-10 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
        >
          Add App
        </Link>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
      {sortedApps.map((app) => (
        <AppTile key={app.id} app={app} onUpdate={refetch} />
      ))}
    </div>
  );
}
