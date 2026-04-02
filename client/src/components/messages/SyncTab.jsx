import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertCircle, Settings, Globe, Mail, MailOpen } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import socket from '../../services/socket';

// Default selectors for supported providers — ensures editor cards always render,
// even on fresh installs before selectors.json exists.
const DEFAULT_SELECTORS = {
  outlook: { messageRow: "[role='listbox'] [role='option']" },
  teams: { messageItem: "[role='listitem']" },
};

export default function SyncTab({ accounts, onRefresh }) {
  const [syncing, setSyncing] = useState({});
  const [rawSelectors, setRawSelectors] = useState({});
  const [editingSelector, setEditingSelector] = useState(null);
  const [selectorForm, setSelectorForm] = useState({});

  // Merge fetched selectors with defaults so every supported provider always appears
  const selectors = Object.fromEntries(
    Object.entries(DEFAULT_SELECTORS).map(([provider, defaults]) => [
      provider,
      { ...defaults, ...(rawSelectors[provider] || {}) },
    ])
  );

  const fetchSelectors = useCallback(async () => {
    const data = await api.getMessageSelectors().catch(() => ({}));
    setRawSelectors(data || {});
  }, []);

  useEffect(() => {
    fetchSelectors();

    const onSyncStarted = ({ accountId }) => {
      setSyncing(prev => ({ ...prev, [accountId]: 'syncing' }));
    };
    const onSyncCompleted = ({ accountId, newMessages, status }) => {
      if (status && status !== 'success') return; // non-success handled by specific event (e.g. sync:auth-required)
      setSyncing(prev => ({ ...prev, [accountId]: null }));
      toast.success(`Sync complete: ${newMessages} new messages`);
      onRefresh();
    };
    const onAuthRequired = ({ accountId }) => {
      setSyncing(prev => ({ ...prev, [accountId]: 'auth-required' }));
      toast('Login required -- open Browser page to authenticate', { icon: '\uD83D\uDD10' });
    };
    const onSyncFailed = ({ accountId, error }) => {
      setSyncing(prev => ({ ...prev, [accountId]: null }));
      toast.error(`Sync failed: ${error ?? 'unknown error'}`);
    };

    socket.on('messages:sync:started', onSyncStarted);
    socket.on('messages:sync:completed', onSyncCompleted);
    socket.on('messages:sync:auth-required', onAuthRequired);
    socket.on('messages:sync:failed', onSyncFailed);

    return () => {
      socket.off('messages:sync:started', onSyncStarted);
      socket.off('messages:sync:completed', onSyncCompleted);
      socket.off('messages:sync:auth-required', onAuthRequired);
      socket.off('messages:sync:failed', onSyncFailed);
    };
  }, [fetchSelectors, onRefresh]);

  const handleLaunch = async (accountId) => {
    const result = await api.launchMessageBrowser(accountId).catch(() => null);
    if (result?.success) toast.success('Browser tab opened — log in if needed, then sync');
  };

  const handleSync = async (accountId, mode = 'unread') => {
    setSyncing(prev => ({ ...prev, [accountId]: 'syncing' }));
    await api.syncMessageAccount(accountId, mode).catch(() => {
      setSyncing(prev => ({ ...prev, [accountId]: null }));
    });
  };

  const handleSaveSelectors = async (provider) => {
    const result = await api.updateMessageSelectors(provider, selectorForm).catch(() => null);
    if (!result) return;
    toast.success(`${provider} selectors updated`);
    setEditingSelector(null);
    fetchSelectors();
  };

  const handleTestSelectors = async (provider) => {
    const result = await api.testMessageSelectors(provider).catch(() => null);
    if (result) toast.success(`Selector test: ${result.status}`);
  };

  return (
    <div className="space-y-6">
      {/* Sync Status */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Sync Status</h2>
        {accounts.length === 0 && (
          <p className="text-gray-500 text-sm">No accounts configured. Add one in the Accounts tab.</p>
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
                {account.provider === 'playwright' && (
                  <button
                    onClick={() => handleLaunch(account.id)}
                    className="flex items-center gap-1 px-3 py-1.5 bg-port-border text-gray-300 rounded text-sm hover:bg-port-border/80 transition-colors"
                    title="Open in CDP browser for login"
                  >
                    <Globe size={14} /> Launch
                  </button>
                )}
                {syncing[account.id] === 'syncing' ? (
                  <RefreshCw size={16} className="text-port-accent animate-spin" />
                ) : (
                  <>
                    <button
                      onClick={() => handleSync(account.id, 'unread')}
                      disabled={!account.enabled}
                      className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/10 text-port-accent rounded text-sm hover:bg-port-accent/20 transition-colors disabled:opacity-50"
                      title="Sync unread messages only"
                    >
                      <MailOpen size={14} /> Sync Unread
                    </button>
                    <button
                      onClick={() => handleSync(account.id, 'full')}
                      disabled={!account.enabled}
                      className="flex items-center gap-1 px-3 py-1.5 bg-port-border text-gray-300 rounded text-sm hover:bg-port-border/80 transition-colors disabled:opacity-50"
                      title="Sync all visible messages"
                    >
                      <Mail size={14} /> Full Sync
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Selector Configuration */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">DOM Selectors</h2>
        <p className="text-sm text-gray-500 mb-3">
          Playwright selectors for scraping Outlook and Teams. Edit if the DOM structure changes.
        </p>
        {Object.entries(selectors).map(([provider, sels]) => (
          <div key={provider} className="mb-4 p-4 bg-port-card rounded-lg border border-port-border">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-white capitalize">{provider}</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleTestSelectors(provider)}
                  className="text-xs text-gray-400 hover:text-white transition-colors"
                >
                  Test
                </button>
                <button
                  onClick={() => {
                    setEditingSelector(editingSelector === provider ? null : provider);
                    setSelectorForm(sels);
                  }}
                  className="text-xs text-gray-400 hover:text-white transition-colors"
                >
                  <Settings size={14} />
                </button>
              </div>
            </div>
            {editingSelector === provider ? (
              <div className="space-y-2">
                {Object.entries(selectorForm).map(([key, val]) => (
                  <div key={key} className="flex items-center gap-2">
                    <label className="text-xs text-gray-500 w-32 shrink-0">{key}</label>
                    <input
                      type="text"
                      value={val}
                      onChange={(e) => setSelectorForm(f => ({ ...f, [key]: e.target.value }))}
                      className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white font-mono focus:outline-none focus:border-port-accent"
                    />
                  </div>
                ))}
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => handleSaveSelectors(provider)}
                    className="px-3 py-1 bg-port-accent text-white rounded text-xs hover:bg-port-accent/80"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingSelector(null)}
                    className="px-3 py-1 bg-port-border text-gray-300 rounded text-xs hover:bg-port-border/80"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                {Object.entries(sels).map(([key, val]) => (
                  <div key={key} className="flex text-xs">
                    <span className="text-gray-500 w-32 shrink-0">{key}</span>
                    <span className="text-gray-400 font-mono truncate">{val}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
