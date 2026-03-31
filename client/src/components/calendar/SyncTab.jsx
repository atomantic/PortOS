import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertCircle, Trash2, TestTube, Calendar } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import socket from '../../services/socket';

export default function SyncTab({ accounts, onRefresh }) {
  const [syncing, setSyncing] = useState({});
  const [tokenStatus, setTokenStatus] = useState(null);
  const [tokenLoading, setTokenLoading] = useState(true);
  const [mcpProgress, setMcpProgress] = useState({});

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
      setMcpProgress(prev => { const next = {...prev}; delete next[accountId]; return next; });
      toast.success(`Calendar sync complete: ${newEvents ?? 0} events`);
      onRefresh();
    };
    const onSyncFailed = ({ accountId, error }) => {
      setSyncing(prev => ({ ...prev, [accountId]: null }));
      toast.error(`Calendar sync failed: ${error ?? 'unknown error'}`);
    };

    const onSyncProgress = ({ accountId, message }) => {
      setMcpProgress(prev => ({ ...prev, [accountId]: message }));
    };

    socket.on('calendar:sync:started', onSyncStarted);
    socket.on('calendar:sync:completed', onSyncCompleted);
    socket.on('calendar:sync:failed', onSyncFailed);
    socket.on('calendar:sync:progress', onSyncProgress);

    return () => {
      socket.off('calendar:sync:started', onSyncStarted);
      socket.off('calendar:sync:completed', onSyncCompleted);
      socket.off('calendar:sync:failed', onSyncFailed);
      socket.off('calendar:sync:progress', onSyncProgress);
    };
  }, [fetchTokenStatus, onRefresh]);

  const handleSync = async (accountId) => {
    setSyncing(prev => ({ ...prev, [accountId]: 'syncing' }));
    await api.syncCalendarAccount(accountId).catch(() => {
      setSyncing(prev => ({ ...prev, [accountId]: null }));
    });
  };

  const handleGoogleSync = async (account) => {
    setSyncing(prev => ({ ...prev, [account.id]: 'syncing' }));
    setMcpProgress(prev => ({ ...prev, [account.id]: 'Starting Google Calendar sync...' }));

    const useApi = account.syncMethod === 'google-api';
    const result = useApi
      ? await api.apiSyncGoogleCalendar(account.id).catch(() => null)
      : await api.mcpSyncGoogleCalendar(account.id).catch(() => null);

    setMcpProgress(prev => { const next = {...prev}; delete next[account.id]; return next; });
    if (!result || result.error) {
      setSyncing(prev => ({ ...prev, [account.id]: null }));
      if (result?.error?.includes('spawn Claude')) {
        toast.error('Claude CLI not found. Ensure Claude Code is installed and in your PATH.');
      } else if (result?.error?.includes('OAuth')) {
        toast.error('Google OAuth not configured. Set up in Config tab.');
      }
    }
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
                  <div className="flex items-center gap-2">
                    <RefreshCw size={16} className="text-port-accent animate-spin" />
                    {mcpProgress[account.id] && account.type === 'google-calendar' && (
                      <span className="text-xs text-gray-500">{mcpProgress[account.id]}</span>
                    )}
                  </div>
                ) : account.type === 'google-calendar' ? (
                  <button
                    onClick={() => handleGoogleSync(account)}
                    disabled={!account.enabled}
                    className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/10 text-port-accent rounded text-sm hover:bg-port-accent/20 transition-colors disabled:opacity-50"
                    title={account.syncMethod === 'google-api' ? 'Sync via Google API' : 'Sync via Claude MCP'}
                  >
                    <Calendar size={14} /> {account.syncMethod === 'google-api' ? 'Sync (API)' : 'Sync (Claude)'}
                  </button>
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
