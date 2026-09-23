import { Link } from 'react-router';
import AppTile from '../../AppTile';
import { MicroGlyph } from '../../micrographics';

export default function AppsGridWidget({ dashboardState }) {
  const { apps, sortedApps, activeApps, refetch } = dashboardState;
  const archivedCount = apps.length - activeApps.length;
  if (apps.length === 0) {
    return (
      <div className="relative bg-port-card border border-port-border rounded-xl p-4 text-center">
        <div className="flex justify-center mb-4 text-port-accent/70">
          <MicroGlyph variant="reticle" size={48} state="accent" />
        </div>
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
    <div className="@container min-w-0 space-y-2">
      <p className="text-xs text-gray-500">
        {activeApps.length} app{activeApps.length !== 1 ? 's' : ''} registered{archivedCount > 0 ? ` (${archivedCount} archived)` : ''}
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
        {sortedApps.map((app) => (
          <AppTile key={app.id} app={app} onUpdate={refetch} />
        ))}
      </div>
    </div>
  );
}
