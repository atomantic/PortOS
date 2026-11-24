import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertCircle, Trash2, TestTube, Calendar, CalendarDays } from 'lucide-react';
import toast from '../ui/Toast';
import { formatDateTime } from '../../utils/formatters';
import {
  getCalendarTokenStatus,
  syncCalendarAccount,
  apiSyncGoogleCalendar,
  mcpSyncGoogleCalendar,
  testCalendarToken,
  clearCalendarToken,
} from '../../services/apiCalendar.js';
import socket from '../../services/socket';
import { useAccountSyncStatus } from '../../hooks/useAccountSyncStatus';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import EmptyState from '../EmptyState';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import ListLoadError from '../ui/ListLoadError';

export default function SyncTab({ accounts, onRefresh }) {
  const [tokenStatus, setTokenStatus] = useState(null);
  const [tokenLoading, setTokenLoading] = useState(true);
  const [tokenError, setTokenError] = useState(null);
  const [clearingTokens, setClearingTokens] = useState({});
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const [mcpProgress, setMcpProgress] = useState({});

  const fetchTokenStatus = useCallback(async () => {
    setTokenError(null);
    setTokenLoading(true);
    try {
      const data = await getCalendarTokenStatus({ silent: true });
      setTokenStatus(data);
    } catch (err) {
      setTokenError(err);
      setTokenStatus(null);
    } finally {
      setTokenLoading(false);
    }
  }, []);

  const clearProgress = useCallback((accountId) => {
    setMcpProgress(prev => { const next = { ...prev }; delete next[accountId]; return next; });
  }, []);

  const { syncing, sync } = useAccountSyncStatus({
    eventPrefix: 'calendar',
    label: 'Calendar sync',
    successText: ({ newEvents }) => `Calendar sync complete: ${newEvents ?? 0} events`,
    onRefresh,
    // Direct Google pushes carry calendarId and have no started event.
    isStandaloneCompletion: ({ calendarId }) => Boolean(calendarId),
    onStart: clearProgress,
    onTerminal: clearProgress,
  });

  useEffect(() => { fetchTokenStatus(); }, [fetchTokenStatus]);

  useEffect(() => {
    const onSyncProgress = ({ accountId, message }) => {
      setMcpProgress(prev => ({ ...prev, [accountId]: message }));
    };
    socket.on('calendar:sync:progress', onSyncProgress);
    return () => socket.off('calendar:sync:progress', onSyncProgress);
  }, []);

  const handleSync = (accountId) => sync(accountId, () => syncCalendarAccount(accountId, { silent: true }));

  const handleGoogleSync = (account) => sync(account.id, () => {
    setMcpProgress(prev => ({ ...prev, [account.id]: 'Starting Google Calendar sync...' }));
    return account.syncMethod === 'google-api'
      ? apiSyncGoogleCalendar(account.id, { silent: true })
      : mcpSyncGoogleCalendar(account.id, { silent: true });
  });

  const handleTestToken = async (provider) => {
    const result = await testCalendarToken(provider).catch(() => null);
    if (result?.token) {
      toast.success(`${provider} token is valid`);
    } else {
      toast.error(`${provider} token is invalid or expired`);
    }
    fetchTokenStatus();
  };

  const handleClearToken = async (provider) => {
    if (clearingTokens[provider]) return;
    setClearingTokens(prev => ({ ...prev, [provider]: true }));
    const cleared = await clearCalendarToken(provider).then(() => true).catch(() => false);
    setClearingTokens(prev => ({ ...prev, [provider]: false }));
    if (!cleared) return;
    toast.success(`${provider} token cleared`);
    fetchTokenStatus();
  };

  return (
    <div className="space-y-6">
      {/* Sync Status */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Sync Status</h2>
        {accounts.length === 0 && (
          <EmptyState
            icon={CalendarDays}
            title="No calendar connected"
            message="Add a calendar account to start syncing events."
            actionTo="/calendar/config"
            actionLabel="Add a calendar account"
          />
        )}
        <div className="space-y-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex flex-wrap items-center justify-between gap-3 p-4 bg-port-card rounded-lg border border-port-border"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-white truncate">{account.name}</div>
                <div className="text-xs text-gray-500 break-words">
                  {account.lastSyncAt
                    ? `Last sync: ${formatDateTime(account.lastSyncAt)}`
                    : 'Never synced'}
                  {account.lastSyncStatus && ` (${account.lastSyncStatus})`}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                {syncing[account.id] === 'auth-required' && (
                  <span className="flex items-center gap-1 text-xs text-port-warning">
                    <AlertCircle size={14} /> Auth required
                  </span>
                )}
                {syncing[account.id] === 'syncing' ? (
                  <div className="flex items-center gap-2 min-w-0">
                    <RefreshCw size={16} className="text-port-accent animate-spin shrink-0" />
                    {mcpProgress[account.id] && account.type === 'google-calendar' && (
                      <span className="text-xs text-gray-500 break-words">{mcpProgress[account.id]}</span>
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
        ) : tokenError || !tokenStatus ? (
          <ListLoadError what="token status" error={tokenError} onRetry={fetchTokenStatus} />
        ) : (
          <div className="space-y-2">
            {(tokenStatus.providers || []).map((status) => (
              <div
                key={status.provider}
                className="bg-port-card rounded-lg border border-port-border"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white capitalize truncate">{status.provider}</div>
                    <div className="text-xs text-gray-500 break-words">
                      {status.hasToken ? (
                        <span className="text-port-success">Token present</span>
                      ) : (
                        <span className="text-gray-500">No token</span>
                      )}
                      {status.expiresAt && (
                        <span className="ml-2">
                          Expires: {formatDateTime(status.expiresAt)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTestToken(status.provider)}
                      className="flex items-center gap-1 pointer-coarse:min-h-11 px-2 py-1 text-xs text-gray-400 hover:text-white bg-port-border rounded transition-colors"
                      title="Test token"
                    >
                      <TestTube size={12} /> Test
                    </button>
                    {status.hasToken && (
                      <button
                        onClick={() => requestDelete(status.provider)}
                        disabled={clearingTokens[status.provider]}
                        className="flex items-center gap-1 pointer-coarse:min-h-11 px-2 py-1 text-xs text-gray-400 hover:text-port-error bg-port-border rounded transition-colors disabled:opacity-50"
                        title="Clear token"
                      >
                        <Trash2 size={12} /> Clear
                      </button>
                    )}
                  </div>
                </div>
                {isConfirming(status.provider) && (
                  <InlineConfirmRow
                    className="mx-4 mb-3"
                    question={`Clear ${status.provider} token? This token is shared with Messages.`}
                    confirmText="Clear token"
                    confirmTitle={`Clear ${status.provider} token`}
                    cancelTitle="Cancel"
                    onConfirm={() => confirmDelete(() => handleClearToken(status.provider))}
                    onCancel={cancelDelete}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
