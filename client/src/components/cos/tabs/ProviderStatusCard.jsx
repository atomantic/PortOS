import { useState, useEffect } from 'react';
import { AlertTriangle, CheckCircle, Clock, RefreshCw, Zap, Server } from 'lucide-react';
import * as api from '../../../services/api';
import socket from '../../../services/socket';

export default function ProviderStatusCard() {
  const [statuses, setStatuses] = useState(null);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(null);

  useEffect(() => {
    loadData();

    // Listen for real-time status changes
    const handleStatusChange = (data) => {
      setStatuses(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          providers: {
            ...prev.providers,
            [data.providerId]: {
              ...data.status,
              timeUntilRecovery: data.status.estimatedRecovery
                ? getTimeUntilRecovery(data.status.estimatedRecovery)
                : null
            }
          }
        };
      });
    };

    socket.on('provider:status:changed', handleStatusChange);

    return () => {
      socket.off('provider:status:changed', handleStatusChange);
    };
  }, []);

  const getTimeUntilRecovery = (estimatedRecovery) => {
    const now = Date.now();
    const recoveryTime = new Date(estimatedRecovery).getTime();
    const remainingMs = recoveryTime - now;

    if (remainingMs <= 0) return 'any moment';

    const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
    const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.join(' ') || '< 1m';
  };

  const loadData = async () => {
    setLoading(true);
    const [statusData, providerData] = await Promise.all([
      api.getProviderStatuses().catch(() => null),
      api.getProviders().catch(() => [])
    ]);
    setStatuses(statusData);
    setProviders(providerData);
    setLoading(false);
  };

  const handleRecover = async (providerId) => {
    setRecovering(providerId);
    await api.recoverProvider(providerId).catch(() => null);
    await loadData();
    setRecovering(null);
  };

  // Filter to only show unavailable providers
  const unavailableProviders = providers.filter(p => {
    const status = statuses?.providers?.[p.id];
    return status && !status.available;
  });

  // Count unavailable
  const unavailableCount = unavailableProviders.length;

  if (loading) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-center gap-2 text-gray-500">
          <RefreshCw size={14} className="animate-spin" />
          <span className="text-sm">Loading provider status...</span>
        </div>
      </div>
    );
  }

  // All providers healthy - show compact success state
  if (unavailableCount === 0) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server size={16} className="text-port-success" />
            <span className="text-sm text-gray-400">AI Providers</span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-port-success" />
            <span className="text-sm text-port-success">All Available</span>
            <button
              onClick={loadData}
              className="ml-2 text-gray-500 hover:text-white transition-colors"
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Some providers unavailable - show detailed status
  return (
    <div className="bg-port-card border border-port-warning/50 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle size={16} className="text-port-warning" />
          <span className="text-sm font-medium text-port-warning">
            {unavailableCount} Provider{unavailableCount > 1 ? 's' : ''} Unavailable
          </span>
        </div>
        <button
          onClick={loadData}
          className="text-gray-500 hover:text-white transition-colors"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="space-y-3">
        {unavailableProviders.map(provider => {
          const status = statuses?.providers?.[provider.id];
          const isUsageLimit = status?.reason === 'usage-limit';
          const isRateLimit = status?.reason === 'rate-limit';

          return (
            <div
              key={provider.id}
              className={`p-3 rounded-lg border ${
                isUsageLimit
                  ? 'bg-port-error/10 border-port-error/30'
                  : 'bg-port-warning/10 border-port-warning/30'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-white truncate">{provider.name}</span>
                    <span className={`px-1.5 py-0.5 text-xs rounded ${
                      isUsageLimit
                        ? 'bg-port-error/20 text-port-error'
                        : 'bg-port-warning/20 text-port-warning'
                    }`}>
                      {isUsageLimit ? 'Usage Limit' : isRateLimit ? 'Rate Limited' : status?.reason}
                    </span>
                  </div>

                  <p className="text-sm text-gray-400">{status?.message}</p>

                  {status?.timeUntilRecovery && (
                    <div className="flex items-center gap-1.5 mt-2 text-xs text-gray-500">
                      <Clock size={12} />
                      <span>Estimated recovery: {status.timeUntilRecovery}</span>
                    </div>
                  )}
                </div>

                <button
                  onClick={() => handleRecover(provider.id)}
                  disabled={recovering === provider.id}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors disabled:opacity-50"
                  title="Manually mark as recovered"
                >
                  {recovering === provider.id ? (
                    <RefreshCw size={12} className="animate-spin" />
                  ) : (
                    <Zap size={12} />
                  )}
                  <span>Recover</span>
                </button>
              </div>

              {/* Fallback info */}
              {provider.fallbackProvider && (
                <div className="mt-2 pt-2 border-t border-port-border/50 text-xs text-gray-500">
                  Fallback: <span className="text-gray-400">{provider.fallbackProvider}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-gray-500 mt-3">
        Tasks will automatically use available fallback providers when primary is unavailable.
      </p>
    </div>
  );
}
