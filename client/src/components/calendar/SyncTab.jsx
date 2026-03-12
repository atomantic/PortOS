import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertCircle, Trash2, TestTube } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';
import socket from '../../services/socket';

export default function SyncTab({ accounts, onRefresh }) {
  const [syncing, setSyncing] = useState({});
  const [tokenStatus, setTokenStatus] = useState(null);
  const [tokenLoading, setTokenLoading] = useState(true);

  const fetchTokenStatus = useCallback(async () => {
    const data = await api.getCalendarTokenStatus().catch(() => null);
    setTokenStatus(data);
    setTokenLoading(false);
  }, []);

  useEffect(() => {
    fetchTokenStatus();

    const onSyncStarted = ({ accountId }) => {
      setSyncing(prev => ({ ...prev, [accountId]: 'syncing' }));
    };
    const onSyncCompleted = ({ accountId, newEvents }) => {
      setSyncing(prev => ({ ...prev, [accountId]: null }));
      toast.success(`Calendar sync complete: ${newEvents ?? 0} events`);
      onRefresh();
    };
    const onSyncFailed = ({ accountId, error }) => {
      setSyncing(prev => ({ ...prev, [accountId]: null }));
      toast.error(`Calendar sync failed: ${error ?? 'unknown error'}`);
    };

    socket.on('calendar:sync:started', onSyncStarted);
    socket.on('calendar:sync:completed', onSyncCompleted);
    socket.on('calendar:sync:failed', onSyncFailed);

    return () => {
      socket.off('calendar:sync:started', onSyncStarted);
      socket.off('calendar:sync:completed', onSyncCompleted);
      socket.off('calendar:sync:failed', onSyncFailed);
    };
  }, [fetchTokenStatus, onRefresh]);

  const handleSync = async (accountId) => {
    setSyncing(prev => ({ ...prev, [accountId]: 'syncing' }));
    await api.syncCalendarAccount(accountId).catch(() => {
      setSyncing(prev => ({ ...prev, [accountId]: null }));
    });
  };

  const handleTestToken = async (provider) => {
    const result = await api.testCalendarToken(provider).catch(() => null);
    if (result?.token) {
      toast.success(`${provider} token is valid`);
    } else {
      toast.error(`${provider} token is invalid or expired`);
    }
    fetchTokenStatus();
  };

  const handleClearToken = async (provider) => {
    await api.clearCalendarToken(provider).catch(() => null);
    toast.success(`${provider} token cleared`);
    fetchTokenStatus();
  };

  return (
    <div className="space-y-6">
      {/* Sync Status */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Sync Status</h2>
        {accounts.length === 0 && (
          <p className="text-gray-500 text-sm">No accounts configured. Add one in the Config tab.</p>
        )}
        <div className="space-y-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center justify-between p-4 bg-port-card rounded-lg border border-port-border"
            >
              <div>
                <div className="text-sm font-medium text-white">{account.name}</div>
                <div className="text-xs text-gray-500">
                  {account.lastSyncAt
                    ? `Last sync: ${new Date(account.lastSyncAt).toLocaleString()}`
                    : 'Never synced'}
                  {account.lastSyncStatus && ` (${account.lastSyncStatus})`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {syncing[account.id] === 'auth-required' && (
                  <span className="flex items-center gap-1 text-xs text-port-warning">
                    <AlertCircle size={14} /> Auth required
                  </span>
                )}
                {syncing[account.id] === 'syncing' ? (
                  <RefreshCw size={16} className="text-port-accent animate-spin" />
                ) : (
                  <button
                    onClick={() => handleSync(account.id)}
                    disabled={!account.enabled}
                    className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/10 text-port-accent rounded text-sm hover:bg-port-accent/20 transition-colors disabled:opacity-50"
                    title="Sync calendar events"
                  >
                    <RefreshCw size={14} /> Sync
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Token Debug */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Token Debug</h2>
        <p className="text-sm text-gray-500 mb-3">
          Calendar API tokens extracted from browser sessions. These are shared with the Messages module.
        </p>
        {tokenLoading ? (
          <RefreshCw size={16} className="text-port-accent animate-spin" />
        ) : !tokenStatus ? (
          <p className="text-sm text-gray-500">Could not load token status</p>
        ) : (
          <div className="space-y-2">
            {(tokenStatus.providers || []).map((status) => (
              <div
                key={status.provider}
                className="flex items-center justify-between p-4 bg-port-card rounded-lg border border-port-border"
              >
                <div>
                  <div className="text-sm font-medium text-white capitalize">{status.provider}</div>
                  <div className="text-xs text-gray-500">
                    {status.hasToken ? (
                      <span className="text-port-success">Token present</span>
                    ) : (
                      <span className="text-gray-500">No token</span>
                    )}
                    {status.expiresAt && (
                      <span className="ml-2">
                        Expires: {new Date(status.expiresAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTestToken(status.provider)}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white bg-port-border rounded transition-colors"
                    title="Test token"
                  >
                    <TestTube size={12} /> Test
                  </button>
                  {status.hasToken && (
                    <button
                      onClick={() => handleClearToken(status.provider)}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-port-error bg-port-border rounded transition-colors"
                      title="Clear token"
                    >
                      <Trash2 size={12} /> Clear
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
