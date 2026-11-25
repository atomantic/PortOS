import { useState, useEffect, useCallback, useRef } from 'react';
import { MESSAGE_SELECTOR_DEFAULTS, resolveComposeSelectors } from '../../../../server/lib/messageSelectorDefaults.js';
import { RefreshCw, AlertCircle, CheckCircle2, Settings, Globe, Mail, MailOpen, Trash2, TestTube } from 'lucide-react';
import toast from '../ui/Toast';
import { FormField } from '../ui/FormField';
import SettingsLoadError from '../ui/SettingsLoadError';
import QueueInvestigationButton from '../ui/QueueInvestigationButton';
import { formatCount, formatDateTime } from '../../utils/formatters';
import { buildSelectorTestFailureTask } from '../../lib/selectorTestFailureTask';
import {
  getMessageSelectors,
  launchMessageBrowser,
  syncMessageAccount,
  updateMessageSelectors,
  testMessageSelectors,
  getMessageTokenStatus,
  testMessageToken,
  clearMessageToken,
} from '../../services/apiMessages.js';
import socket from '../../services/socket';
import { useAccountSyncStatus } from '../../hooks/useAccountSyncStatus';
import { accountSupportsSyncMode } from '../../lib/messageSyncModes';

// Human-facing summary per `testSelectors()` status — kept out of JSX so the
// failure-task builder and the toast can share the same wording.
const TEST_STATUS_TEXT = {
  ok: 'All selectors matched on the live page',
  'no-browser': 'No browser tab available — is portos-browser running?',
  'auth-required': 'Login required — open the browser and sign in first',
  'no-selectors': 'No selectors configured for this provider',
  partial: 'Some selectors matched zero elements on the live page',
};

const EMPTY_OVERRIDES = Object.freeze({});

function SelectorFields({ values, onChange }) {
  return Object.entries(values).map(([key, value]) => onChange ? (
    <FormField key={key} className="flex items-center gap-2" labelClassName="text-xs text-gray-500 w-32 shrink-0" label={key}>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(key, event.target.value)}
        className="min-w-0 flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white font-mono focus:outline-none focus:border-port-accent"
      />
    </FormField>
  ) : (
    <div key={key} className="flex text-xs">
      <span className="text-gray-500 w-32 shrink-0">{key}</span>
      <span className="text-gray-400 font-mono break-all">{value}</span>
    </div>
  ));
}

export default function SyncTab({ accounts, onRefresh, accountsUnavailable = false }) {
  const [rawSelectors, setRawSelectors] = useState({});
  // null = loading, 'ready', or 'error'. After a failed read the rows show built-in
  // defaults, not the saved selectors, so editing is shut until a read succeeds.
  const [selectorsState, setSelectorsState] = useState(null);
  const [editingSelector, setEditingSelector] = useState(null);
  const [selectorForm, setSelectorForm] = useState(EMPTY_OVERRIDES);
  const [savingSelectors, setSavingSelectors] = useState(false);
  const [testResults, setTestResults] = useState({});
  // accountId -> { current, total } from `messages:sync:progress`; cleared when a cycle starts or settles.
  const [progress, setProgress] = useState({});

  const selectorsRequestRef = useRef(0);
  const selectorsLoadedRef = useRef(false);
  const fetchSelectors = useCallback(async () => {
    const requestId = ++selectorsRequestRef.current;
    const data = await getMessageSelectors({ silent: true }).catch(() => null);
    if (requestId !== selectorsRequestRef.current) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      // Once a read has succeeded, the shown values are saved ones (plus this tab's own
      // confirmed writes), so a failed refresh does not shut editing.
      if (!selectorsLoadedRef.current) {
        setSelectorsState('error');
        setEditingSelector(null);
      }
      return;
    }
    selectorsLoadedRef.current = true;
    setRawSelectors(data);
    setSelectorsState('ready');
  }, []);

  const [tokenStatus, setTokenStatus] = useState(null);
  const [tokenLoading, setTokenLoading] = useState(true);
  const [clearingTokens, setClearingTokens] = useState({});

  const fetchTokenStatus = useCallback(async () => {
    const data = await getMessageTokenStatus({ silent: true }).catch(() => null);
    setTokenStatus(data);
    setTokenLoading(false);
  }, []);

  const clearProgress = useCallback((accountId) => {
    setProgress(prev => { const next = { ...prev }; delete next[accountId]; return next; });
  }, []);

  const { syncing, sync } = useAccountSyncStatus({
    eventPrefix: 'messages',
    label: 'Sync',
    successText: ({ newMessages }) => `Sync complete: ${newMessages ?? 0} new messages`,
    onRefresh,
    onStart: clearProgress,
    onTerminal: clearProgress,
  });

  useEffect(() => { fetchSelectors(); }, [fetchSelectors]);
  useEffect(() => { fetchTokenStatus(); }, [fetchTokenStatus]);

  useEffect(() => {
    const onSyncProgress = ({ accountId, current, total }) => {
      setProgress(prev => ({ ...prev, [accountId]: { current, total } }));
    };
    socket.on('messages:sync:progress', onSyncProgress);
    return () => socket.off('messages:sync:progress', onSyncProgress);
  }, []);

  const handleLaunch = async (accountId) => {
    const result = await launchMessageBrowser(accountId).catch(() => null);
    if (result?.success) toast.success('Browser tab opened — log in if needed, then sync');
  };

  const handleSync = (accountId, mode) =>
    sync(accountId, () => syncMessageAccount(accountId, mode, { silent: true }));

  const handleSaveSelectors = async (provider) => {
    if (selectorsState !== 'ready' || savingSelectors) return;
    setSavingSelectors(true);
    const result = await updateMessageSelectors(provider, selectorForm)
      .catch(() => null)
      .finally(() => setSavingSelectors(false));
    if (!result) return;
    setRawSelectors((prev) => ({ ...prev, [provider]: result }));
    toast.success(`${provider} selectors updated`);
    setEditingSelector(null);
    fetchSelectors();
  };

  const handleTestSelectors = async (provider) => {
    setTestResults(prev => ({ ...prev, [provider]: { status: 'testing' } }));
    const result = await testMessageSelectors(provider).catch((err) => ({
      status: 'error',
      error: err?.message || 'Test request failed',
    }));
    setTestResults(prev => ({ ...prev, [provider]: result }));
    const summary = TEST_STATUS_TEXT[result.status] || result.error || 'Selector test failed';
    if (result.status === 'ok') toast.success(summary);
    else toast.error(summary);
  };

  const handleTestToken = async (provider) => {
    const result = await testMessageToken(provider).catch(() => null);
    if (result?.api?.success === true) {
      toast.success(`${provider} token is valid`);
    } else {
      const { status, error } = result?.api ?? {};
      const details = [status && `HTTP ${status}`, error].filter(Boolean).join(' — ');
      toast.error(details
        ? `${provider} token test failed: ${details}`
        : `${provider} token is invalid or expired`);
    }
    fetchTokenStatus();
  };

  const handleClearToken = async (provider) => {
    if (clearingTokens[provider]) return;
    setClearingTokens(prev => ({ ...prev, [provider]: true }));
    const cleared = await clearMessageToken(provider).then(() => true).catch(() => false);
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
        {!accountsUnavailable && accounts.length === 0 && (
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
                    ? `Last sync: ${formatDateTime(account.lastSyncAt)}`
                    : 'Never synced'}
                  {account.lastSyncStatus && ` (${account.lastSyncStatus})`}
                </div>
                {!accountSupportsSyncMode(account, 'unread') && (
                  <div className="text-xs text-gray-500">
                    Unread-only sync isn&apos;t available — read state can&apos;t be read from this provider yet
                  </div>
                )}
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
                  <div className="flex items-center gap-2">
                    <RefreshCw size={16} className="text-port-accent animate-spin" />
                    {progress[account.id] && (
                      <span className="text-xs text-gray-500">
                        {progress[account.id].total > 0
                          ? `Syncing ${formatCount(progress[account.id].current)}/${formatCount(progress[account.id].total)}…`
                          : 'Syncing…'}
                      </span>
                    )}
                  </div>
                ) : (
                  <>
                    {accountSupportsSyncMode(account, 'unread') && (
                      <button
                        onClick={() => handleSync(account.id, 'unread')}
                        disabled={!account.enabled}
                        className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/10 text-port-accent rounded text-sm hover:bg-port-accent/20 transition-colors disabled:opacity-50"
                        title="Sync unread messages only"
                      >
                        <MailOpen size={14} /> Sync Unread
                      </button>
                    )}
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
          Selectors for Outlook and Teams. Test checks the open inbox or chat list. Edit these values if the provider changes its page.
        </p>
        <div className="space-y-4">
          {selectorsState === 'error' && (
            <SettingsLoadError onRetry={fetchSelectors}>
              Failed to load saved selectors. The values shown are the built-in defaults, so editing is disabled.
            </SettingsLoadError>
          )}
          {Object.entries(MESSAGE_SELECTOR_DEFAULTS).map(([provider, defaults]) => {
            const saved = rawSelectors[provider] ?? EMPTY_OVERRIDES;
            const editing = editingSelector === provider;
            const overrides = editing ? selectorForm : saved;
            const list = { ...defaults.list, ...Object.fromEntries(
              Object.entries(overrides).filter(([key]) => !Object.hasOwn(defaults.compose, key))
            ) };
            const compose = editing
              ? Object.fromEntries(Object.entries(defaults.compose).map(([key, value]) => [key, overrides[key] ?? value]))
              : resolveComposeSelectors(provider, saved);
            const updateField = editing ? (key, value) => setSelectorForm(form => ({ ...form, [key]: value })) : undefined;

            return (
              <div key={provider} className="p-4 bg-port-card rounded-lg border border-port-border">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-white capitalize">{provider}</h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTestSelectors(provider)}
                      disabled={testResults[provider]?.status === 'testing' || (editing && (savingSelectors || selectorForm !== saved))}
                      className="text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                    >
                      {testResults[provider]?.status === 'testing' ? 'Testing…' : 'Test'}
                    </button>
                    <button
                      onClick={() => {
                        setEditingSelector(editing ? null : provider);
                        setSelectorForm(saved);
                      }}
                      aria-label="Edit selectors"
                      disabled={selectorsState !== 'ready' || savingSelectors}
                      className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                    >
                      <Settings size={14} />
                    </button>
                  </div>
                </div>
                <fieldset disabled={editing && savingSelectors} className="space-y-2">
                  <SelectorFields values={list} onChange={updateField} />
                  <details className="border-t border-port-border pt-2">
                    <summary className="cursor-pointer text-xs text-gray-400 hover:text-white">Browser compose selectors</summary>
                    <div className="mt-2 space-y-2">
                      {editing && <p className="text-xs text-gray-500">Clear a compose field to use its built-in default.</p>}
                      <SelectorFields values={compose} onChange={updateField} />
                    </div>
                  </details>
                  {editing && (
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => handleSaveSelectors(provider)}
                        className="px-3 py-1 bg-port-accent text-white rounded text-xs hover:bg-port-accent/80"
                      >
                        {savingSelectors ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => setEditingSelector(null)}
                        className="px-3 py-1 bg-port-border text-gray-300 rounded text-xs hover:bg-port-border/80"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </fieldset>
                {testResults[provider] && testResults[provider].status !== 'testing' && (
                  <div className={`mt-3 p-2 rounded border text-xs ${
                    testResults[provider].status === 'ok'
                      ? 'border-port-success/30 bg-port-success/10 text-port-success'
                      : 'border-port-error/30 bg-port-error/10 text-port-error'
                  }`}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex items-center gap-1">
                        {testResults[provider].status === 'ok' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                        {TEST_STATUS_TEXT[testResults[provider].status] || testResults[provider].error || 'Selector test failed'}
                      </span>
                      {testResults[provider].status !== 'ok' && (
                        <QueueInvestigationButton
                          task={buildSelectorTestFailureTask({ provider, ...testResults[provider] })}
                        />
                      )}
                    </div>
                    {testResults[provider].results && Object.keys(testResults[provider].results).length > 0 && (
                      <ul className="mt-1 space-y-0.5 font-mono text-gray-400">
                        {Object.entries(testResults[provider].results).map(([key, r]) => (
                          <li key={key} className={r.matches > 0 ? '' : 'text-port-error'}>
                            {key}: {r.matches} match{r.matches === 1 ? '' : 'es'}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Token Debug (after selectors so selector controls keep their DOM order) */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">Token Debug</h2>
        <p className="text-sm text-gray-500 mb-3">
          API tokens extracted from Outlook and Teams browser sessions.
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
                    {status.cached ? (
                      <span className={status.valid ? 'text-port-success' : 'text-port-warning'}>
                        {status.valid ? 'Token present' : 'Token expired'}
                      </span>
                    ) : (
                      <span className="text-gray-500">No token</span>
                    )}
                    {status.cached && status.expires && status.expires !== 'unknown' && (
                      <span className="ml-2">Expires: {formatDateTime(status.expires)}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTestToken(status.provider)}
                    aria-label={`Test ${status.provider} token`}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white bg-port-border rounded transition-colors"
                    title="Test token"
                  >
                    <TestTube size={12} /> Test token
                  </button>
                  {status.cached && (
                    <button
                      onClick={() => handleClearToken(status.provider)}
                      disabled={clearingTokens[status.provider]}
                      aria-label={`Clear ${status.provider} token`}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-port-error bg-port-border rounded transition-colors disabled:opacity-50"
                      title="Clear token"
                    >
                      <Trash2 size={12} /> Clear token
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
