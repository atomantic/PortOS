import { Link } from 'react-router';
import AppTile from '../../AppTile';
import { MicroGlyph } from '../../micrographics';

export default function AppsGridWidget({ dashboardState }) {
  const { apps, sortedApps, activeApps, refetch } = dashboardState;
  const archivedCount = apps.length - activeApps.length;
  if (apps.length === 0) {
    return (
      <div className="@container relative bg-port-card border border-port-border rounded-xl p-8 @lg:p-12 text-center">
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
    <div className="@container space-y-2">
      <p className="text-xs text-gray-500">
        {activeApps.length} app{activeApps.length !== 1 ? 's' : ''} registered{archivedCount > 0 ? ` (${archivedCount} archived)` : ''}
      </p>
      <div className="grid grid-cols-1 @sm:grid-cols-2 @lg:grid-cols-3 @3xl:grid-cols-4 @5xl:grid-cols-5 @7xl:grid-cols-6 gap-3">
        {sortedApps.map((app) => (
          <AppTile key={app.id} app={app} onUpdate={refetch} />
        ))}
      </div>
    </div>
  );
}
