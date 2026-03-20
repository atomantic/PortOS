import AppIcon from '../AppIcon';
import StatusBadge from '../StatusBadge';

export default function PeerAppsList({ apps, peerAddress }) {
  if (!apps || apps.length === 0) return null;

  return (
    <div className="mt-3 border-t border-port-border pt-3">
      <div className="text-xs text-gray-500 mb-1.5">Apps ({apps.length})</div>
      <div className="space-y-1">
        {apps.map(app => (
          <div key={app.id} className="flex items-center gap-2 text-xs">
            <AppIcon icon={app.icon || 'package'} size={14} className="text-gray-400 shrink-0" />
            {app.uiPort && app.overallStatus === 'online' ? (
              <a
                href={`http://${peerAddress}:${app.uiPort}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-port-accent hover:underline truncate"
                title={`Open ${app.name} on ${peerAddress}:${app.uiPort}`}
              >
                {app.name}
              </a>
            ) : (
              <span className="text-gray-300 truncate">{app.name}</span>
            )}
            {app.apiPort && (
              <span className="text-gray-600 font-mono shrink-0">:{app.apiPort}</span>
            )}
            <StatusBadge status={app.overallStatus || 'unknown'} size="sm" />
          </div>
        ))}
      </div>
    </div>
  );
}
