import { useState } from 'react';
import StatusBadge from './StatusBadge';
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

export default function AppTile({ app, onUpdate }) {
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
  const isStopped = app.overallStatus === 'stopped';

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-5 hover:border-port-accent/50 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-lg bg-port-border flex items-center justify-center text-2xl">
            {app.icon || '📦'}
          </div>
          <div>
            <h3 className="font-semibold text-white">{app.name}</h3>
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

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {/* Open UI */}
        {appUrl && isOnline && (
          <a
            href={appUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 text-sm rounded-lg bg-port-accent hover:bg-port-accent/80 text-white transition-colors"
          >
            Open UI
          </a>
        )}

        {/* Start/Stop/Restart */}
        {!isOnline && (
          <button
            onClick={() => handleAction('start')}
            disabled={loading === 'start'}
            className="px-3 py-1.5 text-sm rounded-lg bg-port-success hover:bg-port-success/80 text-white transition-colors disabled:opacity-50"
          >
            {loading === 'start' ? '...' : 'Start'}
          </button>
        )}

        {isOnline && (
          <>
            <button
              onClick={() => handleAction('restart')}
              disabled={loading === 'restart'}
              className="px-3 py-1.5 text-sm rounded-lg bg-port-warning hover:bg-port-warning/80 text-white transition-colors disabled:opacity-50"
            >
              {loading === 'restart' ? '...' : 'Restart'}
            </button>
            <button
              onClick={() => handleAction('stop')}
              disabled={loading === 'stop'}
              className="px-3 py-1.5 text-sm rounded-lg bg-port-error hover:bg-port-error/80 text-white transition-colors disabled:opacity-50"
            >
              {loading === 'stop' ? '...' : 'Stop'}
            </button>
          </>
        )}

        {isStopped && (
          <button
            onClick={() => handleAction('start')}
            disabled={loading === 'start'}
            className="px-3 py-1.5 text-sm rounded-lg bg-port-success hover:bg-port-success/80 text-white transition-colors disabled:opacity-50"
          >
            {loading === 'start' ? '...' : 'Start'}
          </button>
        )}
      </div>
    </div>
  );
}
