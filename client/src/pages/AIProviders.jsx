import { useState, useEffect, useCallback } from 'react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import socket from '../services/socket';
import { filterSelectableModels, filterGenerationModels, isEmbeddingModel, mergeModelLists, localBackendForProvider, modelOptionLabel, providerTypeClass, isTuiProvider, isApiProvider, isProcessProvider, isOllamaBackedProvider, isClaudeCodePlanCli, isGrokBuildCli, isLocalEndpoint, effectiveModelContextWindow } from '../utils/providers';
import useLocalModels from '../hooks/useLocalModels';
import EmptyState from '../components/EmptyState';
import {
  formatDurationMs,
  formatContextLength,
  parseTimeoutMs,
  TIMEOUT_INPUT_MIN_MS,
  TIMEOUT_INPUT_MAX_MS,
  TIMEOUT_INPUT_STEP_MS,
  formatDateTime,
} from '../utils/formatters';
import SettingsTabsHeader from '../components/settings/SettingsTabsHeader';
import CodeReviewDefaultsPanel from '../components/providers/CodeReviewDefaultsPanel';
import Modal from '../components/ui/Modal';
import { FormField } from '../components/ui/FormField';

// Privacy disclosure for the Grok Build CLI/TUI: its harness uploads the entire
// working repo to xAI (GCP) as it works unless the user opts out. Shown both on
// the provider card and in the create/edit form (before enabling) — see
// isGrokBuildCli for which providers match.
function GrokUploadWarning({ className = '' }) {
  return (
    <div className={`text-xs rounded-md border border-port-warning/40 bg-port-warning/10 text-port-warning px-2.5 py-2 leading-relaxed ${className}`}>
      ⚠️ The Grok harness uploads your <span className="font-semibold">entire working repo</span> to
      xAI (GCP) as it works. To keep your code local, add the following to{' '}
      <code className="font-mono">~/.grok/config.toml</code> before enabling this provider:
      <pre className="mt-1.5 whitespace-pre rounded bg-port-bg/60 px-2 py-1.5 font-mono text-[11px] text-port-warning">{`[harness]
disable_codebase_upload = true`}</pre>
    </div>
  );
}

export default function AIProviders() {
  const [providers, setProviders] = useState([]);
  const [statuses, setStatuses] = useState({}); // runtime availability by providerId (separate from the `enabled` toggle)
  const [recovering, setRecovering] = useState({});
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [refreshing, setRefreshing] = useState({});
  const [runs, setRuns] = useState([]);
  const [showRunPanel, setShowRunPanel] = useState(false);
  const [runPrompt, setRunPrompt] = useState('');
  const [selectedWorkspace, setSelectedWorkspace] = useState('');
  const [apps, setApps] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [runOutput, setRunOutput] = useState('');
  const [showSamples, setShowSamples] = useState(false);
  const [sampleProviders, setSampleProviders] = useState([]);
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [addingSample, setAddingSample] = useState({});

  useEffect(() => {
    loadData();
  }, []);

  const loadRuns = useCallback(async () => {
    const runsData = await api.getRuns(20).catch(() => ({ runs: [] }));
    setRuns(runsData.runs || []);
  }, []);

  useEffect(() => {
    if (!activeRun) return;

    const handleData = (data) => {
      setRunOutput(prev => prev + data);
    };

    const handleComplete = (_metadata) => {
      setActiveRun(null);
      loadRuns();
    };

    socket.on(`run:${activeRun}:data`, handleData);
    socket.on(`run:${activeRun}:complete`, handleComplete);

    return () => {
      socket.off(`run:${activeRun}:data`, handleData);
      socket.off(`run:${activeRun}:complete`, handleComplete);
    };
  }, [activeRun, loadRuns]);

  const loadData = async () => {
    setLoading(true);
    const [providersData, appsData, runsData, statusData] = await Promise.all([
      api.getProviders().catch(() => ({ providers: [], activeProvider: null })),
      api.getApps().catch(() => []),
      api.getRuns(20).catch(() => ({ runs: [] })),
      api.getProviderStatuses().catch(() => ({ providers: {} }))
    ]);
    setProviders(providersData.providers || []);
    setActiveProviderId(providersData.activeProvider);
    setApps(appsData);
    setRuns(runsData.runs || []);
    setStatuses(statusData.providers || {});
    setLoading(false);
  };

  // Refresh just the runtime availability map (cheap) so a bench badge appears
  // when a provider fails elsewhere and clears itself once its recovery window
  // passes (the server expires `estimatedRecovery` on read), without a full reload.
  const refreshStatuses = useCallback(async () => {
    const statusData = await api.getProviderStatuses().catch(() => null);
    if (statusData?.providers) setStatuses(statusData.providers);
  }, []);

  useEffect(() => {
    const id = setInterval(refreshStatuses, 20000);
    return () => clearInterval(id);
  }, [refreshStatuses]);

  // Clear a provider's bench (runtime unavailability) so the next call retries it.
  // Note: if the underlying cause persists (e.g. an invalid model id), the very
  // next failure re-benches it — recovery is "try again now", not "fix the cause".
  const handleRecover = async (id) => {
    setRecovering(prev => ({ ...prev, [id]: true }));
    const result = await api.recoverProvider(id, { silent: true }).catch(() => null);
    if (result) {
      setStatuses(prev => ({ ...prev, [id]: { ...prev[id], available: true, reason: 'ok', message: 'Provider available', timeUntilRecovery: null } }));
      toast.success('Provider marked available — it will be retried on the next call');
    } else {
      toast.error('Could not clear the provider status');
    }
    setRecovering(prev => ({ ...prev, [id]: false }));
  };

  const handleSetActive = async (id) => {
    if (!id) return;
    const result = await api.setActiveProvider(id).catch(() => null);
    if (result) setActiveProviderId(id);
  };

  const handleTest = async (id) => {
    setTestResults(prev => ({ ...prev, [id]: { testing: true } }));
    const result = await api.testProvider(id).catch(err => ({ success: false, error: err.message }));
    setTestResults(prev => ({ ...prev, [id]: result }));
  };

  const handleDelete = async (id) => {
    await api.deleteProvider(id);
    loadData();
  };

  const handleToggleEnabled = async (provider) => {
    await api.updateProvider(provider.id, { enabled: !provider.enabled });
    loadData();
  };

  const supportsModelRefresh = (provider) => {
    // Claude Ollama (ollama-backed claude CLI/TUI) refreshes its model list from
    // the local Ollama daemon — including the TUI variant, which the server now
    // refreshes via the type==='tui' && ollamaBacked branch. Check this before
    // the generic TUI gate so the TUI variant's Refresh Models button shows.
    if (isOllamaBackedProvider(provider)) {
      return true;
    }
    if (isTuiProvider(provider)) {
      return false;
    }
    // Antigravity/Gemini/Grok Build CLIs use their own local model configuration
    // (no PortOS model list to refresh — same as the configured-default sentinel).
    if (provider.type === 'cli' && (provider.command === 'agy' || provider.command === 'gemini' || provider.command === 'grok')) {
      return false;
    }
    // All other providers support refresh (API and CLI)
    return true;
  };

  const handleRefreshModels = async (id) => {
    setRefreshing(prev => ({ ...prev, [id]: true }));
    try {
      const result = await api.refreshProviderModels(id, { silent: true });
      if (result) {
        toast.success(`Models refreshed for ${result.name}`);
        loadData();
      } else {
        toast.error('Failed to refresh models - provider may not support this feature');
      }
    } catch (error) {
      toast.error(`Error refreshing models: ${error.message}`);
    } finally {
      setRefreshing(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleExecuteRun = async () => {
    if (!runPrompt.trim() || !activeProviderId) return;

    setRunOutput('');
    const workspace = apps.find(a => a.id === selectedWorkspace);

    const result = await api.createRun({
      providerId: activeProviderId,
      prompt: runPrompt,
      workspacePath: workspace?.repoPath,
      workspaceName: workspace?.name
    }).catch(err => ({ error: err.message }));

    if (result.error) {
      setRunOutput(`Error: ${result.error}`);
      return;
    }

    setActiveRun(result.runId);
  };

  const handleStopRun = async () => {
    if (activeRun) {
      await api.stopRun(activeRun);
      setActiveRun(null);
    }
  };

  const handleLoadSamples = async () => {
    setLoadingSamples(true);
    setShowSamples(true);
    const result = await api.getSampleProviders().catch(() => ({ providers: [] }));
    setSampleProviders(result.providers || []);
    setLoadingSamples(false);
  };

  const handleAddSample = async (provider) => {
    setAddingSample(prev => ({ ...prev, [provider.id]: true }));
    await api.createProvider(provider);
    setSampleProviders(prev => prev.filter(p => p.id !== provider.id));
    setAddingSample(prev => ({ ...prev, [provider.id]: false }));
    loadData();
    toast.success(`Added ${provider.name}`);
  };

  const handleAddAllSamples = async () => {
    for (const provider of sampleProviders) {
      await api.createProvider(provider);
    }
    setSampleProviders([]);
    loadData();
    toast.success(`Added ${sampleProviders.length} providers`);
  };

  const selectedRunProvider = providers.find(p => p.id === activeProviderId);
  const runProviderIsTui = isTuiProvider(selectedRunProvider);

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 p-4 border-b border-port-border">
          <h1 className="text-2xl font-bold text-white">Settings</h1>
        </div>
        <SettingsTabsHeader activeTab="providers" />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-gray-400">Loading providers...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-4 border-b border-port-border">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
      </div>

      <SettingsTabsHeader activeTab="providers" />

      <div className="flex-1 overflow-auto p-4 space-y-6">
      <CodeReviewDefaultsPanel />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">AI Providers</h1>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowRunPanel(!showRunPanel)}
            className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors text-sm sm:text-base"
          >
            {showRunPanel ? 'Hide Runner' : 'Run Prompt'}
          </button>
          <button
            onClick={handleLoadSamples}
            className="px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors text-sm sm:text-base"
          >
            {loadingSamples ? 'Loading...' : 'Load Samples'}
          </button>
          <button
            onClick={() => { setEditingProvider(null); setShowForm(true); }}
            className="px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors text-sm sm:text-base"
          >
            Add Provider
          </button>
        </div>
      </div>

      {/* Sample Providers Panel */}
      {showSamples && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Sample Providers</h2>
            <div className="flex gap-2">
              {sampleProviders.length > 1 && (
                <button
                  onClick={handleAddAllSamples}
                  className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded transition-colors"
                >
                  Add All ({sampleProviders.length})
                </button>
              )}
              <button
                onClick={() => setShowSamples(false)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>

          {loadingSamples ? (
            <div className="text-center py-6 text-gray-400">Loading sample providers...</div>
          ) : sampleProviders.length === 0 ? (
            <div className="text-center py-6 text-gray-500">
              All sample providers are already in your configuration.
            </div>
          ) : (
            <div className="grid gap-3">
              {sampleProviders.map(provider => (
                <div
                  key={provider.id}
                  className="bg-port-bg border border-port-border rounded-lg p-3 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-white">{provider.name}</h3>
                      <span className={`text-xs px-2 py-0.5 rounded ${providerTypeClass(provider.type)}`}>
                        {provider.type.toUpperCase()}
                      </span>
                      {!provider.enabled && (
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">
                          DISABLED
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-gray-400 space-y-0.5">
                      {isProcessProvider(provider) && (
                        <p>Command: <code className="text-gray-300">{provider.command} {provider.args?.join(' ')}</code></p>
                      )}
                      {isApiProvider(provider) && (
                        <p>Endpoint: <code className="text-gray-300">{provider.endpoint}</code></p>
                      )}
                      {isApiProvider(provider) && !isLocalEndpoint(provider.endpoint) && (
                        <p className="text-port-warning">Needs an API key — after adding, use Edit to paste it</p>
                      )}
                      {filterSelectableModels(provider.models).length > 0 && (
                        <p>Models: {filterSelectableModels(provider.models).slice(0, 3).join(', ')}{filterSelectableModels(provider.models).length > 3 ? ` +${filterSelectableModels(provider.models).length - 3}` : ''}</p>
                      )}
                      {provider.envVars && Object.keys(provider.envVars).length > 0 && (
                        <div className="mt-0.5">
                          <span>Env:</span>
                          {Object.entries(provider.envVars).map(([k, v]) => (
                            <div key={k}>
                              <code className="ml-1 text-orange-400">
                                {k}={provider.secretEnvVars?.includes(k) ? '***' : v}
                              </code>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleAddSample(provider)}
                    disabled={addingSample[provider.id]}
                    className="px-4 py-1.5 text-sm bg-port-success/20 text-port-success hover:bg-port-success/30 rounded transition-colors disabled:opacity-50 shrink-0"
                  >
                    {addingSample[provider.id] ? 'Adding...' : 'Add'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Run Panel */}
      {showRunPanel && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-4">
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
            <select
              value={activeProviderId || ''}
              onChange={(e) => handleSetActive(e.target.value)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white w-full sm:w-auto"
            >
              <option value="">Select Provider</option>
              {providers.filter(p => p.enabled).map(p => (
                <option key={p.id} value={p.id}>{p.name}{isTuiProvider(p) ? ' (CoS TUI)' : ''}</option>
              ))}
            </select>

            <select
              value={selectedWorkspace}
              onChange={(e) => setSelectedWorkspace(e.target.value)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white w-full sm:w-auto"
            >
              <option value="">No workspace</option>
              {apps.map(app => (
                <option key={app.id} value={app.id}>{app.name}</option>
              ))}
            </select>
          </div>

          <textarea
            value={runPrompt}
            onChange={(e) => setRunPrompt(e.target.value)}
            placeholder="Enter your prompt..."
            rows={3}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:border-port-accent focus:outline-hidden"
          />

          <div className="flex justify-between items-center">
            <button
              onClick={handleExecuteRun}
              disabled={!runPrompt.trim() || !activeProviderId || activeRun}
              className="px-6 py-2 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {activeRun ? 'Running...' : 'Execute'}
            </button>

            {activeRun && (
              <button
                onClick={handleStopRun}
                className="px-4 py-2 bg-port-error hover:bg-port-error/80 text-white rounded-lg transition-colors"
              >
                Stop
              </button>
            )}
          </div>

          {runProviderIsTui && (
            <div className="text-xs text-port-accent bg-port-accent/10 border border-port-accent/20 rounded-lg px-3 py-2">
              TUI providers spawn a PTY-backed run that streams output here and is stoppable from the run list.
            </div>
          )}

          {runOutput && (
            <div className="bg-port-bg border border-port-border rounded-lg p-3 max-h-64 overflow-auto">
              <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">{runOutput}</pre>
            </div>
          )}
        </div>
      )}

      {/* Provider List */}
      <div className="grid gap-4">
        {(() => {
          const idx = providers.findIndex(p => p.id === activeProviderId);
          if (idx <= 0) return providers;
          return [providers[idx], ...providers.slice(0, idx), ...providers.slice(idx + 1)];
        })().map(provider => (
          <div
            key={provider.id}
            className={`bg-port-card border rounded-xl p-4 ${
              provider.id === activeProviderId ? 'border-port-accent' : 'border-port-border'
            }`}
          >
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-white">{provider.name}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded ${providerTypeClass(provider.type)}`}>
                    {provider.type.toUpperCase()}
                  </span>
                  {provider.id === activeProviderId && (
                    <span className="text-xs px-2 py-0.5 rounded bg-port-accent/20 text-port-accent">
                      DEFAULT
                    </span>
                  )}
                  {!provider.enabled && (
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">
                      DISABLED
                    </span>
                  )}
                  {/* Runtime availability is independent of the `enabled` toggle: an
                      enabled provider can still be benched after a failure (usage
                      limit, model-not-found, auth) and skipped in favor of a fallback. */}
                  {provider.enabled && statuses[provider.id]?.available === false && (
                    <span
                      className="text-xs px-2 py-0.5 rounded bg-port-error/20 text-port-error"
                      title={statuses[provider.id]?.message || ''}
                    >
                      UNAVAILABLE{statuses[provider.id]?.reason ? ` · ${statuses[provider.id].reason}` : ''}
                    </span>
                  )}
                </div>

                {provider.enabled && statuses[provider.id]?.available === false && (
                  <div className="mt-2 text-xs rounded border border-port-error/40 bg-port-error/10 px-3 py-2 text-port-error space-y-1">
                    <p className="break-words">
                      <span className="font-semibold">Benched ({statuses[provider.id]?.reason || 'unknown'})</span>
                      {statuses[provider.id]?.timeUntilRecovery ? ` — auto-retries in ${statuses[provider.id].timeUntilRecovery}` : ''}
                      . Calls route to the fallback until then.
                    </p>
                    {statuses[provider.id]?.message && (
                      <p className="break-words text-port-error/80">Why: {statuses[provider.id].message}</p>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRecover(provider.id)}
                      disabled={recovering[provider.id]}
                      className="mt-1 px-2 py-0.5 rounded bg-port-error/20 hover:bg-port-error/30 disabled:opacity-50 text-port-error"
                    >
                      {recovering[provider.id] ? 'Clearing…' : 'Recover now'}
                    </button>
                  </div>
                )}

                <div className="mt-2 text-sm text-gray-400 space-y-1">
                  {isProcessProvider(provider) && (
                    <p className="break-words">Command: <code className="text-gray-300 break-all">{provider.command} {provider.args?.join(' ')}</code></p>
                  )}
                  {isApiProvider(provider) && (
                    <p className="break-words">Endpoint: <code className="text-gray-300 break-all">{provider.endpoint}</code></p>
                  )}
                  {/* API-type providers auth solely via the stored apiKey (sent as a
                      Bearer header) — surface its state here so "where does the key
                      go?" is answered from the card, not by spelunking the form. */}
                  {isApiProvider(provider) && (
                    provider.hasApiKey ? (
                      <p className="text-xs">API key: <span className="text-port-success">set</span></p>
                    ) : isLocalEndpoint(provider.endpoint) ? (
                      <p className="text-xs">API key: <span className="text-gray-500">none (local endpoint)</span></p>
                    ) : (
                      <p className="text-xs">API key: <span className="text-port-warning">not set — Edit this provider to paste one</span></p>
                    )
                  )}
                  {provider.models?.length > 0 && (
                    <p>Models: {provider.models.slice(0, 3).join(', ')}{provider.models.length > 3 ? ` +${provider.models.length - 3}` : ''}</p>
                  )}
                  {provider.defaultModel && (
                    <p className="break-words">Default: <code className="text-gray-300 break-all">{provider.defaultModel}</code></p>
                  )}
                  {(() => {
                    const windowLabel = formatContextLength(effectiveModelContextWindow(provider, provider.defaultModel));
                    return windowLabel ? (
                      <p className="text-xs">
                        Context: <span className="text-gray-300">{windowLabel}</span>
                        {provider.contextWindow ? <span className="text-gray-500"> override</span> : null}
                      </p>
                    ) : null;
                  })()}
                  {(provider.lightModel || provider.mediumModel || provider.heavyModel) && (
                    <p className="text-xs">
                      Tiers:
                      {provider.lightModel && <span className="ml-1 text-port-success">{provider.lightModel}</span>}
                      {provider.mediumModel && <span className="ml-1 text-port-warning">{provider.mediumModel}</span>}
                      {provider.heavyModel && <span className="ml-1 text-port-error">{provider.heavyModel}</span>}
                    </p>
                  )}
                  {provider.headlessArgs?.length > 0 && (
                    <p className="text-xs break-words">
                      Headless: <code className="text-gray-300 break-all">{provider.headlessArgs.join(' ')}</code>
                    </p>
                  )}
                  {isTuiProvider(provider) && (
                    <p className="text-xs break-words">
                      TUI: paste delay <span className="text-gray-300">{provider.tuiPromptDelayMs || 2500}ms</span>, idle complete <span className="text-gray-300">{provider.tuiIdleTimeoutMs || 180000}ms</span>
                    </p>
                  )}
                  {provider.fallbackProvider && (
                    <p className="text-xs">
                      Fallback: <span className="text-port-accent">{providers.find(p => p.id === provider.fallbackProvider)?.name || provider.fallbackProvider}</span>
                      {provider.fallbackModel && <span className="ml-1 text-gray-300">({provider.fallbackModel})</span>}
                    </p>
                  )}
                  {provider.envVars && Object.keys(provider.envVars).length > 0 && (
                    <div className="text-xs mt-1">
                      <span className="text-gray-400">Env:</span>
                      {Object.entries(provider.envVars).map(([k, v]) => (
                        <div key={k}>
                          <code className="ml-1 text-orange-400">
                            {k}={provider.secretEnvVars?.includes(k) ? '***' : v}
                          </code>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {isClaudeCodePlanCli(provider) && (
                  <div className="mt-2 text-xs rounded-md border border-port-warning/40 bg-port-warning/10 text-port-warning px-2.5 py-2 leading-relaxed">
                    ⚠️ Starting <span className="font-semibold">June 15, 2026</span>, Anthropic clocks
                    this headless Claude Code usage under <span className="font-semibold">API billing</span> —
                    it will consume extra API credits instead of your Claude Code plan. Avoid this
                    provider; use the interactive <span className="font-semibold">Claude Code TUI</span> provider,
                    which stays on the plan.
                  </div>
                )}

                {isGrokBuildCli(provider) && <GrokUploadWarning className="mt-2" />}

                {testResults[provider.id] && !testResults[provider.id].testing && (
                  <div className={`mt-2 text-sm ${testResults[provider.id].success ? 'text-port-success' : 'text-port-error'}`}>
                    {testResults[provider.id].success
                      ? `✓ Available${testResults[provider.id].version ? ` (${testResults[provider.id].version})` : ''}`
                      : `✗ ${testResults[provider.id].error}`
                    }
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => handleTest(provider.id)}
                  disabled={testResults[provider.id]?.testing}
                  className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50"
                >
                  {testResults[provider.id]?.testing ? 'Testing...' : 'Test'}
                </button>

                {supportsModelRefresh(provider) && (
                  <button
                    onClick={() => handleRefreshModels(provider.id)}
                    disabled={refreshing[provider.id]}
                    className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Refresh available models"
                  >
                    {refreshing[provider.id] ? 'Refreshing...' : 'Refresh Models'}
                  </button>
                )}

                <button
                  onClick={() => handleToggleEnabled(provider)}
                  className={`px-3 py-1.5 text-sm rounded transition-colors ${
                    provider.enabled
                      ? 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30'
                      : 'bg-port-success/20 text-port-success hover:bg-port-success/30'
                  }`}
                >
                  {provider.enabled ? 'Disable' : 'Enable'}
                </button>

                {provider.id !== activeProviderId && provider.enabled && (
                  <button
                    onClick={() => handleSetActive(provider.id)}
                    className="px-3 py-1.5 text-sm bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded transition-colors"
                  >
                    Set Default
                  </button>
                )}

                <button
                  onClick={() => { setEditingProvider(provider); setShowForm(true); }}
                  className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors"
                >
                  Edit
                </button>

                <button
                  onClick={() => handleDelete(provider.id)}
                  className="px-3 py-1.5 text-sm bg-port-error/20 text-port-error hover:bg-port-error/30 rounded transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        {providers.length === 0 && (
          <EmptyState
            title="No providers configured"
            message="Configure at least one API provider to enable autonomous CoS, voice, and AI-assisted features across PortOS."
            actionLabel="Add Provider"
            onAction={() => { setEditingProvider(null); setShowForm(true); }}
          />
        )}
      </div>

      {/* Recent Runs */}
      {runs.length > 0 && (
        <div className="mt-8">
          <h2 className="text-xl font-bold text-white mb-4">Recent Runs</h2>
          <div className="space-y-2">
            {runs.map(run => (
              <div
                key={run.id}
                className="bg-port-card border border-port-border rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div className="flex items-start sm:items-center gap-3 min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 sm:mt-0 ${
                    run.success === true ? 'bg-port-success' :
                    run.success === false ? 'bg-port-error' :
                    'bg-port-warning animate-pulse'
                  }`} />
                  <div className="min-w-0">
                    <p className="text-sm text-white break-words">{run.prompt}</p>
                    <p className="text-xs text-gray-500 break-words">
                      {run.providerName} • {run.workspaceName || 'No workspace'} • {formatDateTime(run.startTime)}
                    </p>
                  </div>
                </div>
                <div className="text-sm text-gray-400 shrink-0 pl-5 sm:pl-0">
                  {run.duration ? `${(run.duration / 1000).toFixed(1)}s` : 'Running...'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Provider Form Modal */}
      {showForm && (
        <ProviderForm
          provider={editingProvider}
          allProviders={providers}
          onClose={() => { setShowForm(false); setEditingProvider(null); }}
          onSave={() => { setShowForm(false); setEditingProvider(null); loadData(); }}
        />
      )}
      </div>
    </div>
  );
}

function ProviderForm({ provider, onClose, onSave, allProviders = [] }) {
  const [formData, setFormData] = useState({
    name: provider?.name || '',
    type: provider?.type || 'cli',
    command: provider?.command || '',
    args: provider?.args?.join(' ') || '',
    endpoint: provider?.endpoint || '',
    apiKey: '',
    allowCustomEndpoint: provider?.allowCustomEndpoint === true,
    models: provider?.models || [],
    defaultModel: provider?.defaultModel || '',
    lightModel: provider?.lightModel || '',
    mediumModel: provider?.mediumModel || '',
    heavyModel: provider?.heavyModel || '',
    fallbackProvider: provider?.fallbackProvider || '',
    fallbackModel: provider?.fallbackModel || '',
    numCtx: provider?.numCtx ?? '',
    contextWindow: provider?.contextWindow ?? '',
    timeout: provider?.timeout || 300000,
    enabled: provider?.enabled !== false,
    envVars: provider?.envVars || {},
    secretEnvVars: provider?.secretEnvVars || [],
    headlessArgs: provider?.headlessArgs?.join(' ') || '',
    tuiPromptDelayMs: provider?.tuiPromptDelayMs || 2500,
    tuiIdleTimeoutMs: provider?.tuiIdleTimeoutMs || 180000
  });

  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [newEnvSecret, setNewEnvSecret] = useState(false);

  // Live installed Ollama/LM Studio models, folded into the model pickers so a
  // local provider shows what's actually installed — not just the stale `models`
  // list stored on the provider record (the "Command R+ / Gemma missing" bug).
  const localModels = useLocalModels();
  const liveModelsFor = (p) => {
    const backend = localBackendForProvider(p);
    return backend ? localModels[backend] : [];
  };

  // Generation pickers (default + light/medium/heavy tiers) — drop embedding-only
  // models (and internal sentinels) so an embedding can't be chosen as a model
  // that runs prompts, consistent with the fallback picker below.
  const availableModels = filterGenerationModels(mergeModelLists(formData.models, liveModelsFor(formData)));

  // Filter out current provider from fallback options (treat undefined enabled as enabled)
  const fallbackOptions = allProviders.filter(p => p.id !== provider?.id && p.enabled !== false);

  // The fallback model is a model OF the selected fallback provider, so its
  // option list comes from that provider's `models` — merged with the live
  // installed list for local backends, and embedding-only models dropped (a
  // fallback runs prompts, so `nomic-embed-text` must never be selectable here).
  const selectedFallbackProvider = allProviders.find(p => p.id === formData.fallbackProvider);
  const fallbackModelOptions = filterGenerationModels(
    mergeModelLists(selectedFallbackProvider?.models, liveModelsFor(selectedFallbackProvider)),
  );
  const plannedContextLabel = formatContextLength(
    effectiveModelContextWindow(formData, formData.defaultModel)
  );
  const parseOptionalIntField = (value) => {
    const input = String(value ?? '').trim();
    if (!input) return null;
    return /^\d+$/.test(input) ? Number(input) : value;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const tuiPromptDelay = parseInt(formData.tuiPromptDelayMs, 10);
    const tuiIdleTimeout = parseInt(formData.tuiIdleTimeoutMs, 10);
    // Three cases for the timeout field on submit:
    //   1. valid integer within bounds → send the parsed number
    //   2. blank/whitespace → omit so the server keeps the current value
    //      (Number('') is 0, which would 400 against the min-1000 rule)
    //   3. non-empty but invalid (e.g. '1e3', '500', 'abc') → send the
    //      RAW STRING. Number() would accept '1e3' as 1000, silently
    //      saving an exponent form the client/runner reject as invalid;
    //      the server's digit-only preprocess will leave the string
    //      alone and z.number() will produce a clear validation error.
    const parsedTimeout = parseTimeoutMs(formData.timeout);
    const timeoutInput = String(formData.timeout ?? '').trim();
    const data = {
      ...formData,
      args: formData.args ? formData.args.split(' ').filter(Boolean) : [],
      headlessArgs: formData.headlessArgs ? formData.headlessArgs.split(' ').filter(Boolean) : [],
      contextWindow: parseOptionalIntField(formData.contextWindow),
      numCtx: formData.type === 'api' ? parseOptionalIntField(formData.numCtx) : null,
    };
    // The generation/fallback pickers filter out embedding-only models, so a
    // stored embedding (from an older config) would be hidden in the UI yet
    // still spread into `data` and silently persisted on an unrelated edit.
    // Clear any embedding value that slipped through so the saved record matches
    // what the picker allows.
    for (const field of ['defaultModel', 'lightModel', 'mediumModel', 'heavyModel', 'fallbackModel']) {
      if (isEmbeddingModel(data[field])) data[field] = '';
    }
    if (parsedTimeout != null) {
      data.timeout = parsedTimeout;
    } else if (timeoutInput === '') {
      delete data.timeout;
    } else {
      data.timeout = formData.timeout;
    }
    if (formData.type === 'tui') {
      if (Number.isFinite(tuiPromptDelay)) data.tuiPromptDelayMs = tuiPromptDelay;
      else delete data.tuiPromptDelayMs;
      if (Number.isFinite(tuiIdleTimeout)) data.tuiIdleTimeoutMs = tuiIdleTimeout;
      else delete data.tuiIdleTimeoutMs;
    } else {
      delete data.tuiPromptDelayMs;
      delete data.tuiIdleTimeoutMs;
    }

    // Only send apiKey if user entered a new value (avoid overwriting existing key with empty string)
    if (!data.apiKey && provider) {
      delete data.apiKey;
    }

    if (provider) {
      await api.updateProvider(provider.id, data);
    } else {
      await api.createProvider(data);
    }

    onSave();
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      backdropClassName="bg-black/50"
      panelClassName="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 max-h-[90vh] overflow-y-auto"
      ariaLabelledBy="provider-form-title"
    >
      <h2 id="provider-form-title" className="text-xl font-bold text-white mb-4">
        {provider ? 'Edit Provider' : 'Add Provider'}
      </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <FormField label="Name *">
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              required
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
          </FormField>

          <FormField label="Type *">
            <select
              value={formData.type}
              onChange={(e) => setFormData(prev => ({ ...prev, type: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            >
              <option value="cli">CLI</option>
              <option value="tui">TUI</option>
              <option value="api">API</option>
            </select>
          </FormField>

          {(formData.type === 'cli' || formData.type === 'tui') && (
            <>
              <FormField label="Command *">
                <input
                  type="text"
                  value={formData.command}
                  onChange={(e) => setFormData(prev => ({ ...prev, command: e.target.value }))}
                  placeholder={formData.type === 'tui' ? 'codex' : 'claude'}
                  required={formData.type === 'cli' || formData.type === 'tui'}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
              </FormField>

              <FormField label="Arguments (space-separated)">
                <input
                  type="text"
                  value={formData.args}
                  onChange={(e) => setFormData(prev => ({ ...prev, args: e.target.value }))}
                  placeholder={formData.type === 'tui' ? '--dangerously-skip-permissions' : '--print -p'}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
              </FormField>

              {formData.type === 'cli' && (
                <FormField label="Headless Args (for simple prompt tasks)">
                  <input
                    type="text"
                    value={formData.headlessArgs}
                    onChange={(e) => setFormData(prev => ({ ...prev, headlessArgs: e.target.value }))}
                    placeholder='--no-session-persistence --disable-slash-commands --tools ""'
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Extra CLI flags for lightweight prompt-in/text-out mode (brain classifier, etc.)
                  </p>
                </FormField>
              )}

              {formData.type === 'tui' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField label="Prompt Paste Delay (ms)">
                    <input
                      type="number"
                      min="250"
                      max="60000"
                      value={formData.tuiPromptDelayMs}
                      onChange={(e) => setFormData(prev => ({ ...prev, tuiPromptDelayMs: e.target.value }))}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    />
                  </FormField>
                  <FormField label="Idle Complete (ms)">
                    <input
                      type="number"
                      min="10000"
                      max="1800000"
                      value={formData.tuiIdleTimeoutMs}
                      onChange={(e) => setFormData(prev => ({ ...prev, tuiIdleTimeoutMs: e.target.value }))}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    />
                  </FormField>
                  <p className="sm:col-span-2 text-xs text-gray-500">
                    TUI providers open an attachable shell session, paste the agent prompt, parse terminal output, and complete after the terminal is idle.
                  </p>
                </div>
              )}
            </>
          )}

          {formData.type === 'api' && (
            <>
              <FormField label="Endpoint *">
                <input
                  type="url"
                  value={formData.endpoint}
                  onChange={(e) => setFormData(prev => ({ ...prev, endpoint: e.target.value }))}
                  placeholder="http://localhost:1234/v1"
                  required={formData.type === 'api'}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
              </FormField>

              <FormField label="API Key">
                <input
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                  placeholder={provider?.hasApiKey
                    ? 'Key set — leave blank to keep'
                    : isLocalEndpoint(formData.endpoint)
                      ? 'Not needed for local endpoints'
                      : 'Paste the key from your provider dashboard'}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
                <p className="text-xs text-gray-500 mt-1">
                  This field is the only place API providers read a key from — it's stored on this
                  provider and sent as an <code>Authorization: Bearer</code> header on every request.
                  No environment variable is involved. Hosted APIs (Cerebras, Grok, NVIDIA, …) require
                  one; local backends (Ollama, LM Studio) don't.
                </p>
              </FormField>

              <FormField label="Custom endpoint">
                <label htmlFor="allowCustomEndpoint" className="flex items-start gap-2 cursor-pointer">
                  <input
                    id="allowCustomEndpoint"
                    type="checkbox"
                    checked={formData.allowCustomEndpoint}
                    onChange={(e) => setFormData(prev => ({ ...prev, allowCustomEndpoint: e.target.checked }))}
                    className="mt-1"
                  />
                  <span className="text-sm text-gray-300">
                    Allow sending the API key to this custom (non-local, non-allowlisted) endpoint.
                    Loopback/LAN and known providers (OpenAI, Anthropic, OpenRouter, …) are always allowed;
                    cloud-metadata hosts are always blocked. Leave off unless you trust this host.
                  </span>
                </label>
              </FormField>
            </>
          )}

          <FormField label={<>
              Available Models
              {formData.type === 'api' && <span className="text-xs text-gray-500 ml-2">(Use Refresh button after saving)</span>}
            </>}>
            <textarea
              value={(formData.models || []).join(', ')}
              onChange={(e) => {
                const models = e.target.value
                  .split(',')
                  .map(m => m.trim())
                  .filter(Boolean);
                setFormData(prev => ({ ...prev, models }));
              }}
              placeholder="model-1, model-2, model-3"
              rows={2}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:border-port-accent focus:outline-hidden"
            />
            <p className="text-xs text-gray-500 mt-1">
              Comma-separated list of available models. For API providers, use Refresh to auto-populate.
            </p>
          </FormField>

          <FormField label="Default Model">
            {availableModels.length > 0 ? (
              <select
                value={formData.defaultModel}
                onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              >
                <option value="">None</option>
                {availableModels.map(model => (
                  <option key={model} value={model}>{modelOptionLabel(model, localModels.ctxById)}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={formData.defaultModel}
                onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
                placeholder="claude-sonnet-4-20250514"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
            )}
            <p className="text-xs text-gray-500 mt-1">
              {availableModels.length > 0
                ? 'Model to use when no tier is specified'
                : 'Save and test provider to fetch available models'}
            </p>
          </FormField>

          {/* Model Tiers */}
          <div className="border-t border-port-border pt-4 mt-4">
            <h4 className="text-sm font-medium text-gray-300 mb-3">Model Tiers</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <FormField labelClassName="block text-xs text-gray-400 mb-1" label={<>
                  <span className="inline-block w-2 h-2 rounded-full bg-port-success mr-1"></span>
                  Light (fast)
                </>}>
                {availableModels.length > 0 ? (
                  <select
                    value={formData.lightModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, lightModel: e.target.value }))}
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                  >
                    <option value="">None</option>
                    {availableModels.map(model => (
                      <option key={model} value={model}>{modelOptionLabel(model, localModels.ctxById)}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.lightModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, lightModel: e.target.value }))}
                    placeholder="haiku"
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                  />
                )}
              </FormField>
              <FormField labelClassName="block text-xs text-gray-400 mb-1" label={<>
                  <span className="inline-block w-2 h-2 rounded-full bg-port-warning mr-1"></span>
                  Medium (balanced)
                </>}>
                {availableModels.length > 0 ? (
                  <select
                    value={formData.mediumModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, mediumModel: e.target.value }))}
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                  >
                    <option value="">None</option>
                    {availableModels.map(model => (
                      <option key={model} value={model}>{modelOptionLabel(model, localModels.ctxById)}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.mediumModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, mediumModel: e.target.value }))}
                    placeholder="sonnet"
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                  />
                )}
              </FormField>
              <FormField labelClassName="block text-xs text-gray-400 mb-1" label={<>
                  <span className="inline-block w-2 h-2 rounded-full bg-port-error mr-1"></span>
                  Heavy (powerful)
                </>}>
                {availableModels.length > 0 ? (
                  <select
                    value={formData.heavyModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, heavyModel: e.target.value }))}
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                  >
                    <option value="">None</option>
                    {availableModels.map(model => (
                      <option key={model} value={model}>{modelOptionLabel(model, localModels.ctxById)}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.heavyModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, heavyModel: e.target.value }))}
                    placeholder="opus"
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
                  />
                )}
              </FormField>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {availableModels.length > 0
                ? 'Used for intelligent model selection based on task requirements'
                : 'Save provider, then use Test or Refresh to fetch available models'}
            </p>
          </div>

          <FormField label="Timeout (ms)">
            <input
              type="number"
              inputMode="numeric"
              min={TIMEOUT_INPUT_MIN_MS}
              max={TIMEOUT_INPUT_MAX_MS}
              step={TIMEOUT_INPUT_STEP_MS}
              value={formData.timeout}
              onChange={(e) => setFormData(prev => ({ ...prev, timeout: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
            <p className="text-xs text-gray-500 mt-1">
              {(() => {
                // Same parser the submit path uses, so the displayed
                // duration always matches what would be saved. parseTimeoutMs
                // returns null for out-of-range/invalid → fall back to the
                // generic cap message.
                const ms = parseTimeoutMs(formData.timeout);
                return ms != null
                  ? `≈ ${formatDurationMs(ms)} per run`
                  : `Per-call cap. Server max: ${TIMEOUT_INPUT_MAX_MS.toLocaleString()} ms (${formatDurationMs(TIMEOUT_INPUT_MAX_MS)}).`;
              })()}
            </p>
          </FormField>

          <div className="border-t border-port-border pt-4 mt-4">
            <h4 className="text-sm font-medium text-gray-300 mb-3">Context Window</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="Planning Window">
                <input
                  type="number"
                  inputMode="numeric"
                  min="512"
                  max="2097152"
                  value={formData.contextWindow}
                  onChange={(e) => setFormData(prev => ({ ...prev, contextWindow: e.target.value }))}
                  placeholder="Auto from model"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {plannedContextLabel ? `Budgeter uses ${plannedContextLabel}` : 'Leave blank to use model/provider defaults'}
                </p>
              </FormField>

              {formData.type === 'api' && (
                <FormField label="Local num_ctx">
                  <input
                    type="number"
                    inputMode="numeric"
                    min="512"
                    max="1048576"
                    value={formData.numCtx}
                    onChange={(e) => setFormData(prev => ({ ...prev, numCtx: e.target.value }))}
                    placeholder="Ollama request size"
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Sent to compatible local backends; used for planning when no model window is known.
                  </p>
                </FormField>
              )}
            </div>
          </div>

          {/* Fallback Provider */}
          <div className="border-t border-port-border pt-4 mt-4">
            <FormField label="Fallback Provider">
            <select
              value={formData.fallbackProvider}
              onChange={(e) => setFormData(prev => ({
                ...prev,
                fallbackProvider: e.target.value,
                // The model belongs to the fallback provider; clear it when the
                // provider changes so a stale model from the previous pick
                // doesn't carry over.
                fallbackModel: ''
              }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            >
              <option value="">None (use system default)</option>
              {fallbackOptions.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              If this provider hits a usage limit or becomes unavailable, tasks will automatically use the fallback provider.
            </p>
            </FormField>

            {formData.fallbackProvider && (
              <FormField label="Fallback Model" className="mt-3">
                {fallbackModelOptions.length > 0 ? (
                  <select
                    value={formData.fallbackModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, fallbackModel: e.target.value }))}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  >
                    <option value="">Use fallback provider's default</option>
                    {fallbackModelOptions.map(model => (
                      <option key={model} value={model}>{modelOptionLabel(model, localModels.ctxById)}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.fallbackModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, fallbackModel: e.target.value }))}
                    placeholder="Use fallback provider's default"
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  />
                )}
                <p className="text-xs text-gray-500 mt-1">
                  Model to run on the fallback provider. Leave blank to use that provider's default model.
                </p>
              </FormField>
            )}
          </div>

          {/* Environment Variables — consumed only when spawning CLI/TUI child
              processes; API runs never read them (auth is the API Key field).
              For API type the add-row is hidden so a key can't be "set" here by
              mistake, but existing entries stay editable/removable. */}
          <div className="border-t border-port-border pt-4 mt-4">
            <h4 className="text-sm font-medium text-gray-300 mb-3">Environment Variables</h4>
            {formData.type === 'api' && Object.entries(formData.envVars).length > 0 && (
              <p className="text-xs text-port-warning mb-2">
                API providers ignore environment variables — these entries have no effect.
                Put the key in the API Key field above.
              </p>
            )}
            {Object.entries(formData.envVars).length > 0 && (
              <div className="space-y-2 mb-3">
                {Object.entries(formData.envVars).map(([key, value]) => {
                  const isSecret = formData.secretEnvVars.includes(key);
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <code className="text-xs text-gray-300 bg-port-bg px-2 py-1.5 rounded border border-port-border shrink-0">{key}</code>
                      <input
                        type={isSecret ? 'password' : 'text'}
                        value={value}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          envVars: { ...prev.envVars, [key]: e.target.value }
                        }))}
                        className="flex-1 min-w-0 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-hidden"
                      />
                      <button
                        type="button"
                        onClick={() => setFormData(prev => ({
                          ...prev,
                          secretEnvVars: isSecret
                            ? prev.secretEnvVars.filter(k => k !== key)
                            : [...prev.secretEnvVars, key]
                        }))}
                        className={`px-2 py-1.5 text-xs rounded transition-colors shrink-0 ${
                          isSecret
                            ? 'text-port-warning bg-port-warning/20 hover:bg-port-warning/30'
                            : 'text-gray-400 hover:bg-port-border/50'
                        }`}
                        title={isSecret ? 'Secret (click to unmask)' : 'Not secret (click to mask)'}
                      >
                        {isSecret ? '🔒' : '🔓'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormData(prev => {
                          const { [key]: _, ...rest } = prev.envVars;
                          return {
                            ...prev,
                            envVars: rest,
                            secretEnvVars: prev.secretEnvVars.filter(k => k !== key)
                          };
                        })}
                        className="px-2 py-1.5 text-xs text-port-error hover:bg-port-error/20 rounded transition-colors shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {formData.type !== 'api' && (
            <div className="flex gap-2">
              <input
                type="text"
                value={newEnvKey}
                onChange={(e) => setNewEnvKey(e.target.value.toUpperCase())}
                placeholder="KEY"
                className="w-1/3 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-hidden font-mono"
              />
              <input
                type={newEnvSecret ? 'password' : 'text'}
                value={newEnvValue}
                onChange={(e) => setNewEnvValue(e.target.value)}
                placeholder="value"
                className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-hidden"
              />
              <label className="flex items-center gap-1 text-xs text-gray-400 shrink-0 cursor-pointer" title="Mark as secret (value will be masked on provider list)">
                <input
                  type="checkbox"
                  checked={newEnvSecret}
                  onChange={(e) => setNewEnvSecret(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-port-border bg-port-bg"
                />
                Secret
              </label>
              <button
                type="button"
                onClick={() => {
                  if (newEnvKey.trim()) {
                    setFormData(prev => ({
                      ...prev,
                      envVars: { ...prev.envVars, [newEnvKey.trim()]: newEnvValue },
                      secretEnvVars: newEnvSecret
                        ? [...prev.secretEnvVars, newEnvKey.trim()]
                        : prev.secretEnvVars
                    }));
                    setNewEnvKey('');
                    setNewEnvValue('');
                    setNewEnvSecret(false);
                  }
                }}
                disabled={!newEnvKey.trim()}
                className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50 shrink-0"
              >
                Add
              </button>
            </div>
            )}
            <p className="text-xs text-gray-500 mt-2">
              {formData.type === 'api'
                ? 'Not used by API providers — auth goes in the API Key field above. Env vars only apply to CLI/TUI process providers.'
                : 'Environment variables passed to the CLI process (e.g., CLAUDE_CODE_USE_BEDROCK=1, AWS_PROFILE).'}
            </p>
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={formData.enabled}
              onChange={(e) => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
              className="w-4 h-4 rounded border-port-border bg-port-bg"
            />
            <span className="text-sm text-gray-400">Enabled</span>
          </label>

          {isGrokBuildCli({ type: formData.type, command: formData.command }) && <GrokUploadWarning />}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-6 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
            >
              {provider ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
    </Modal>
  );
}
