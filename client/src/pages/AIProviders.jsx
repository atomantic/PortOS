import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import * as api from '../services/api';
import socket from '../services/socket';

export default function AIProviders() {
  const [providers, setProviders] = useState([]);
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

  useEffect(() => {
    if (!activeRun) return;

    const handleData = (data) => {
      setRunOutput(prev => prev + data);
    };

    const handleComplete = (metadata) => {
      setActiveRun(null);
      loadRuns();
    };

    socket.on(`run:${activeRun}:data`, handleData);
    socket.on(`run:${activeRun}:complete`, handleComplete);

    return () => {
      socket.off(`run:${activeRun}:data`, handleData);
      socket.off(`run:${activeRun}:complete`, handleComplete);
    };
  }, [activeRun]);

  const loadData = async () => {
    setLoading(true);
    const [providersData, appsData, runsData] = await Promise.all([
      api.getProviders().catch(() => ({ providers: [], activeProvider: null })),
      api.getApps().catch(() => []),
      api.getRuns(20).catch(() => ({ runs: [] }))
    ]);
    setProviders(providersData.providers || []);
    setActiveProviderId(providersData.activeProvider);
    setApps(appsData);
    setRuns(runsData.runs || []);
    setLoading(false);
  };

  const loadRuns = async () => {
    const runsData = await api.getRuns(20).catch(() => ({ runs: [] }));
    setRuns(runsData.runs || []);
  };

  const handleSetActive = async (id) => {
    await api.setActiveProvider(id);
    setActiveProviderId(id);
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
    // Gemini CLI doesn't require model specification
    if (provider.type === 'cli' && provider.command === 'gemini') {
      return false;
    }
    // All other providers support refresh (API and CLI)
    return true;
  };

  const handleRefreshModels = async (id) => {
    setRefreshing(prev => ({ ...prev, [id]: true }));
    try {
      const result = await api.refreshProviderModels(id);
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading providers...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
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
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        provider.type === 'cli' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
                      }`}>
                        {provider.type.toUpperCase()}
                      </span>
                      {!provider.enabled && (
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">
                          DISABLED
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-gray-400 space-y-0.5">
                      {provider.type === 'cli' && (
                        <p>Command: <code className="text-gray-300">{provider.command} {provider.args?.join(' ')}</code></p>
                      )}
                      {provider.type === 'api' && (
                        <p>Endpoint: <code className="text-gray-300">{provider.endpoint}</code></p>
                      )}
                      {provider.models?.length > 0 && (
                        <p>Models: {provider.models.slice(0, 3).join(', ')}{provider.models.length > 3 ? ` +${provider.models.length - 3}` : ''}</p>
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
                    className="px-4 py-1.5 text-sm bg-port-success/20 text-port-success hover:bg-port-success/30 rounded transition-colors disabled:opacity-50 flex-shrink-0"
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
                <option key={p.id} value={p.id}>{p.name}</option>
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
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:border-port-accent focus:outline-none"
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

          {runOutput && (
            <div className="bg-port-bg border border-port-border rounded-lg p-3 max-h-64 overflow-auto">
              <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">{runOutput}</pre>
            </div>
          )}
        </div>
      )}

      {/* Provider List */}
      <div className="grid gap-4">
        {providers.map(provider => (
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
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    provider.type === 'cli' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
                  }`}>
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
                </div>

                <div className="mt-2 text-sm text-gray-400 space-y-1">
                  {provider.type === 'cli' && (
                    <p className="break-words">Command: <code className="text-gray-300 break-all">{provider.command} {provider.args?.join(' ')}</code></p>
                  )}
                  {provider.type === 'api' && (
                    <p className="break-words">Endpoint: <code className="text-gray-300 break-all">{provider.endpoint}</code></p>
                  )}
                  {provider.models?.length > 0 && (
                    <p>Models: {provider.models.slice(0, 3).join(', ')}{provider.models.length > 3 ? ` +${provider.models.length - 3}` : ''}</p>
                  )}
                  {provider.defaultModel && (
                    <p className="break-words">Default: <code className="text-gray-300 break-all">{provider.defaultModel}</code></p>
                  )}
                  {(provider.lightModel || provider.mediumModel || provider.heavyModel) && (
                    <p className="text-xs">
                      Tiers:
                      {provider.lightModel && <span className="ml-1 text-green-400">{provider.lightModel}</span>}
                      {provider.mediumModel && <span className="ml-1 text-yellow-400">{provider.mediumModel}</span>}
                      {provider.heavyModel && <span className="ml-1 text-red-400">{provider.heavyModel}</span>}
                    </p>
                  )}
                  {provider.fallbackProvider && (
                    <p className="text-xs">
                      Fallback: <span className="text-port-accent">{providers.find(p => p.id === provider.fallbackProvider)?.name || provider.fallbackProvider}</span>
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
          <div className="text-center py-12 text-gray-500">
            No providers configured. Add a provider to get started.
          </div>
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
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 sm:mt-0 ${
                    run.success === true ? 'bg-port-success' :
                    run.success === false ? 'bg-port-error' :
                    'bg-port-warning animate-pulse'
                  }`} />
                  <div className="min-w-0">
                    <p className="text-sm text-white break-words">{run.prompt}</p>
                    <p className="text-xs text-gray-500 break-words">
                      {run.providerName} • {run.workspaceName || 'No workspace'} • {new Date(run.startTime).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="text-sm text-gray-400 flex-shrink-0 pl-5 sm:pl-0">
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
  );
}

function ProviderForm({ provider, onClose, onSave, allProviders = [] }) {
  const [formData, setFormData] = useState({
    name: provider?.name || '',
    type: provider?.type || 'cli',
    command: provider?.command || '',
    args: provider?.args?.join(' ') || '',
    endpoint: provider?.endpoint || '',
    apiKey: provider?.apiKey || '',
    models: provider?.models || [],
    defaultModel: provider?.defaultModel || '',
    lightModel: provider?.lightModel || '',
    mediumModel: provider?.mediumModel || '',
    heavyModel: provider?.heavyModel || '',
    fallbackProvider: provider?.fallbackProvider || '',
    timeout: provider?.timeout || 300000,
    enabled: provider?.enabled !== false,
    envVars: provider?.envVars || {},
    secretEnvVars: provider?.secretEnvVars || []
  });

  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [newEnvSecret, setNewEnvSecret] = useState(false);

  const availableModels = formData.models || [];

  // Filter out current provider from fallback options (treat undefined enabled as enabled)
  const fallbackOptions = allProviders.filter(p => p.id !== provider?.id && p.enabled !== false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    const data = {
      ...formData,
      args: formData.args ? formData.args.split(' ').filter(Boolean) : [],
      timeout: parseInt(formData.timeout)
    };

    if (provider) {
      await api.updateProvider(provider.id, data);
    } else {
      await api.createProvider(data);
    }

    onSave();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h2 className="text-xl font-bold text-white mb-4">
          {provider ? 'Edit Provider' : 'Add Provider'}
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Name *</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              required
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Type *</label>
            <select
              value={formData.type}
              onChange={(e) => setFormData(prev => ({ ...prev, type: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
            >
              <option value="cli">CLI</option>
              <option value="api">API</option>
            </select>
          </div>

          {formData.type === 'cli' && (
            <>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Command *</label>
                <input
                  type="text"
                  value={formData.command}
                  onChange={(e) => setFormData(prev => ({ ...prev, command: e.target.value }))}
                  placeholder="claude"
                  required={formData.type === 'cli'}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Arguments (space-separated)</label>
                <input
                  type="text"
                  value={formData.args}
                  onChange={(e) => setFormData(prev => ({ ...prev, args: e.target.value }))}
                  placeholder="--print -p"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                />
              </div>
            </>
          )}

          {formData.type === 'api' && (
            <>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Endpoint *</label>
                <input
                  type="url"
                  value={formData.endpoint}
                  onChange={(e) => setFormData(prev => ({ ...prev, endpoint: e.target.value }))}
                  placeholder="http://localhost:1234/v1"
                  required={formData.type === 'api'}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">API Key</label>
                <input
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                  placeholder="Optional"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Available Models
              {formData.type === 'api' && <span className="text-xs text-gray-500 ml-2">(Use Refresh button after saving)</span>}
            </label>
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
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white resize-none focus:border-port-accent focus:outline-none"
            />
            <p className="text-xs text-gray-500 mt-1">
              Comma-separated list of available models. For API providers, use Refresh to auto-populate.
            </p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Default Model</label>
            {availableModels.length > 0 ? (
              <select
                value={formData.defaultModel}
                onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              >
                <option value="">None</option>
                {availableModels.map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={formData.defaultModel}
                onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
                placeholder="claude-sonnet-4-20250514"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              />
            )}
            <p className="text-xs text-gray-500 mt-1">
              {availableModels.length > 0
                ? 'Model to use when no tier is specified'
                : 'Save and test provider to fetch available models'}
            </p>
          </div>

          {/* Model Tiers */}
          <div className="border-t border-port-border pt-4 mt-4">
            <h4 className="text-sm font-medium text-gray-300 mb-3">Model Tiers</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-1"></span>
                  Light (fast)
                </label>
                {availableModels.length > 0 ? (
                  <select
                    value={formData.lightModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, lightModel: e.target.value }))}
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
                  >
                    <option value="">None</option>
                    {availableModels.map(model => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.lightModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, lightModel: e.target.value }))}
                    placeholder="haiku"
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
                  />
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-yellow-500 mr-1"></span>
                  Medium (balanced)
                </label>
                {availableModels.length > 0 ? (
                  <select
                    value={formData.mediumModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, mediumModel: e.target.value }))}
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
                  >
                    <option value="">None</option>
                    {availableModels.map(model => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.mediumModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, mediumModel: e.target.value }))}
                    placeholder="sonnet"
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
                  />
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1"></span>
                  Heavy (powerful)
                </label>
                {availableModels.length > 0 ? (
                  <select
                    value={formData.heavyModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, heavyModel: e.target.value }))}
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
                  >
                    <option value="">None</option>
                    {availableModels.map(model => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.heavyModel}
                    onChange={(e) => setFormData(prev => ({ ...prev, heavyModel: e.target.value }))}
                    placeholder="opus"
                    className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
                  />
                )}
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {availableModels.length > 0
                ? 'Used for intelligent model selection based on task requirements'
                : 'Save provider, then use Test or Refresh to fetch available models'}
            </p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Timeout (ms)</label>
            <input
              type="number"
              value={formData.timeout}
              onChange={(e) => setFormData(prev => ({ ...prev, timeout: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
            />
          </div>

          {/* Fallback Provider */}
          <div className="border-t border-port-border pt-4 mt-4">
            <label className="block text-sm text-gray-400 mb-1">Fallback Provider</label>
            <select
              value={formData.fallbackProvider}
              onChange={(e) => setFormData(prev => ({ ...prev, fallbackProvider: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
            >
              <option value="">None (use system default)</option>
              {fallbackOptions.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              If this provider hits a usage limit or becomes unavailable, tasks will automatically use the fallback provider.
            </p>
          </div>

          {/* Environment Variables */}
          <div className="border-t border-port-border pt-4 mt-4">
            <h4 className="text-sm font-medium text-gray-300 mb-3">Environment Variables</h4>
            {Object.entries(formData.envVars).length > 0 && (
              <div className="space-y-2 mb-3">
                {Object.entries(formData.envVars).map(([key, value]) => {
                  const isSecret = formData.secretEnvVars.includes(key);
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <code className="text-xs text-gray-300 bg-port-bg px-2 py-1.5 rounded border border-port-border flex-shrink-0">{key}</code>
                      <input
                        type={isSecret ? 'password' : 'text'}
                        value={value}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          envVars: { ...prev.envVars, [key]: e.target.value }
                        }))}
                        className="flex-1 min-w-0 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setFormData(prev => ({
                          ...prev,
                          secretEnvVars: isSecret
                            ? prev.secretEnvVars.filter(k => k !== key)
                            : [...prev.secretEnvVars, key]
                        }))}
                        className={`px-2 py-1.5 text-xs rounded transition-colors flex-shrink-0 ${
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
                        className="px-2 py-1.5 text-xs text-port-error hover:bg-port-error/20 rounded transition-colors flex-shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={newEnvKey}
                onChange={(e) => setNewEnvKey(e.target.value.toUpperCase())}
                placeholder="KEY"
                className="w-1/3 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-none font-mono"
              />
              <input
                type={newEnvSecret ? 'password' : 'text'}
                value={newEnvValue}
                onChange={(e) => setNewEnvValue(e.target.value)}
                placeholder="value"
                className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:border-port-accent focus:outline-none"
              />
              <label className="flex items-center gap-1 text-xs text-gray-400 flex-shrink-0 cursor-pointer" title="Mark as secret (value will be masked on provider list)">
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
                className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50 flex-shrink-0"
              >
                Add
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Environment variables passed to the CLI process (e.g., CLAUDE_CODE_USE_BEDROCK=1, AWS_PROFILE).
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
      </div>
    </div>
  );
}
