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

    const result = await actionFn(app.id);

    if (result?.selfRestart) {
      api.handleSelfRestart();
      return;
    }

    setLoading(null);
    onUpdate?.();
  };

  const isOnline = app.overallStatus === 'online';

  return (
    <article className={`border rounded-lg p-3 transition-colors ${
      app.archived
        ? 'bg-port-card/50 border-port-border/50 opacity-60'
        : 'bg-port-card border-port-border hover:border-port-accent/50'
    }`} aria-labelledby={`app-title-${app.id}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-8 h-8 rounded flex-shrink-0 flex items-center justify-center ${
            app.archived ? 'bg-port-border/50 text-gray-500' : 'bg-port-border text-port-accent'
          }`} aria-hidden="true">
            <AppIcon icon={app.icon || 'package'} size={18} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 id={`app-title-${app.id}`} className={`text-sm font-semibold truncate ${app.archived ? 'text-gray-500' : 'text-white'}`}>{app.name}</h3>
              {app.archived && (
                <span className="px-1 py-0.5 bg-gray-600/30 text-gray-500 text-[10px] rounded flex-shrink-0">Arc</span>
              )}
            </div>
            <p className="text-xs text-gray-500">{app.type}</p>
          </div>
        </div>
        <StatusBadge status={app.overallStatus} size="sm" />
      </div>

      {/* Ports */}
      <div className="mb-2 flex flex-wrap gap-1">
        {app.uiPort && (
          <span className="text-[10px] bg-port-border px-1.5 py-0.5 rounded text-gray-300">
            UI:{app.uiPort}
          </span>
        )}
        {app.apiPort && (
          <span className="text-[10px] bg-port-border px-1.5 py-0.5 rounded text-gray-300">
            API:{app.apiPort}
          </span>
        )}
      </div>

      {/* Path */}
      <p className="text-[10px] text-gray-500 truncate mb-2" title={app.repoPath}>
        {app.repoPath}
      </p>

      {/* Actions */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Actions for ${app.name}`}>
        {appUrl && isOnline && (
          <a
            href={appUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2.5 py-1 text-xs rounded bg-port-accent hover:bg-port-accent/80 text-white transition-colors inline-flex items-center"
            aria-label={`Open ${app.name} UI in new tab`}
          >
            Open
          </a>
        )}

        {!isOnline && (
          <button
            onClick={() => handleAction('start')}
            disabled={loading === 'start'}
            className="px-2.5 py-1 text-xs rounded bg-port-success hover:bg-port-success/80 text-white transition-colors disabled:opacity-50"
            aria-label={`Start ${app.name}`}
            aria-busy={loading === 'start'}
          >
            {loading === 'start' ? '...' : 'Start'}
          </button>
        )}

        {isOnline && (
          <>
            <button
              onClick={() => handleAction('restart')}
              disabled={loading === 'restart'}
              className="px-2.5 py-1 text-xs rounded bg-port-warning hover:bg-port-warning/80 text-white transition-colors disabled:opacity-50"
              aria-label={`Restart ${app.name}`}
              aria-busy={loading === 'restart'}
            >
              {loading === 'restart' ? '...' : 'Restart'}
            </button>
            <button
              onClick={() => handleAction('stop')}
              disabled={loading === 'stop'}
              className="px-2.5 py-1 text-xs rounded bg-port-error hover:bg-port-error/80 text-white transition-colors disabled:opacity-50"
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
