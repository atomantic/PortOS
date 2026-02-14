import { useState, memo } from 'react';
import StatusBadge from './StatusBadge';
import AppIcon from './AppIcon';
import * as api from '../services/api';

// Construct app URL using current hostname (works with Tailscale)
function getAppUrl(app) {
  if (app.uiUrl) return app.uiUrl;
  if (app.uiPort) {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}:${app.uiPort}`;
  }
  return null;
}

// Memoized component to prevent re-renders when parent polls for updates
const AppTile = memo(function AppTile({ app, onUpdate }) {
  const [loading, setLoading] = useState(null);
  const appUrl = getAppUrl(app);

  const handleAction = async (action) => {
    setLoading(action);
    const actionFn = {
      start: api.startApp,
      stop: api.stopApp,
      restart: api.restartApp
    }[action];

    await actionFn(app.id);
    setLoading(null);
    onUpdate?.();
  };

  const isOnline = app.overallStatus === 'online';

  return (
    <article className={`border rounded-xl p-5 transition-colors ${
      app.archived
        ? 'bg-port-card/50 border-port-border/50 opacity-60'
        : 'bg-port-card border-port-border hover:border-port-accent/50'
    }`} aria-labelledby={`app-title-${app.id}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${
            app.archived ? 'bg-port-border/50 text-gray-500' : 'bg-port-border text-port-accent'
          }`} aria-hidden="true">
            <AppIcon icon={app.icon || 'package'} size={28} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 id={`app-title-${app.id}`} className={`font-semibold ${app.archived ? 'text-gray-500' : 'text-white'}`}>{app.name}</h3>
              {app.archived && (
                <span className="px-1.5 py-0.5 bg-gray-600/30 text-gray-500 text-xs rounded">Archived</span>
              )}
            </div>
            <p className="text-sm text-gray-500">{app.type}</p>
          </div>
        </div>
        <StatusBadge status={app.overallStatus} size="sm" />
      </div>

      {/* Ports */}
      <div className="mb-4 flex flex-wrap gap-2">
        {app.uiPort && (
          <span className="text-xs bg-port-border px-2 py-1 rounded text-gray-300">
            UI: {app.uiPort}
          </span>
        )}
        {app.apiPort && (
          <span className="text-xs bg-port-border px-2 py-1 rounded text-gray-300">
            API: {app.apiPort}
          </span>
        )}
      </div>

      {/* Path */}
      <p className="text-xs text-gray-500 truncate mb-4" title={app.repoPath}>
        {app.repoPath}
      </p>

      {/* Actions - min-h-10 ensures 40px touch target on mobile */}
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Actions for ${app.name}`}>
        {/* Open UI */}
        {appUrl && isOnline && (
          <a
            href={appUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 min-h-10 text-sm rounded-lg bg-port-accent hover:bg-port-accent/80 text-white transition-colors inline-flex items-center"
            aria-label={`Open ${app.name} UI in new tab`}
          >
            Open UI
          </a>
        )}

        {/* Start button for non-online states (stopped, not_started, not_found, etc) */}
        {!isOnline && (
          <button
            onClick={() => handleAction('start')}
            disabled={loading === 'start'}
            className="px-4 py-2 min-h-10 text-sm rounded-lg bg-port-success hover:bg-port-success/80 text-white transition-colors disabled:opacity-50"
            aria-label={`Start ${app.name}`}
            aria-busy={loading === 'start'}
          >
            {loading === 'start' ? '...' : 'Start'}
          </button>
        )}

        {/* Restart/Stop buttons for online apps */}
        {isOnline && (
          <>
            <button
              onClick={() => handleAction('restart')}
              disabled={loading === 'restart'}
              className="px-4 py-2 min-h-10 text-sm rounded-lg bg-port-warning hover:bg-port-warning/80 text-white transition-colors disabled:opacity-50"
              aria-label={`Restart ${app.name}`}
              aria-busy={loading === 'restart'}
            >
              {loading === 'restart' ? '...' : 'Restart'}
            </button>
            <button
              onClick={() => handleAction('stop')}
              disabled={loading === 'stop'}
              className="px-4 py-2 min-h-10 text-sm rounded-lg bg-port-error hover:bg-port-error/80 text-white transition-colors disabled:opacity-50"
              aria-label={`Stop ${app.name}`}
              aria-busy={loading === 'stop'}
            >
              {loading === 'stop' ? '...' : 'Stop'}
            </button>
          </>
        )}
      </div>
    </article>
  );
});

export default AppTile;
