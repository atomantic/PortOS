import { useState, useEffect } from 'react';
import * as api from '../services/api';
import socket from '../services/socket';

export default function AIProviders() {
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [runs, setRuns] = useState([]);
  const [showRunPanel, setShowRunPanel] = useState(false);
  const [runPrompt, setRunPrompt] = useState('');
  const [selectedWorkspace, setSelectedWorkspace] = useState('');
  const [apps, setApps] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [runOutput, setRunOutput] = useState('');

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

  const handleRefreshModels = async (id) => {
    await api.refreshProviderModels(id);
    loadData();
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading providers...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">AI Providers</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowRunPanel(!showRunPanel)}
            className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
          >
            {showRunPanel ? 'Hide Runner' : 'Run Prompt'}
          </button>
          <button
            onClick={() => { setEditingProvider(null); setShowForm(true); }}
            className="px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
          >
            Add Provider
          </button>
        </div>
      </div>

      {/* Run Panel */}
      {showRunPanel && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-4">
            <select
              value={activeProviderId || ''}
              onChange={(e) => handleSetActive(e.target.value)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
            >
              <option value="">Select Provider</option>
              {providers.filter(p => p.enabled).map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>

            <select
              value={selectedWorkspace}
              onChange={(e) => setSelectedWorkspace(e.target.value)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
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
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3">
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
                    <p>Command: <code className="text-gray-300">{provider.command} {provider.args?.join(' ')}</code></p>
                  )}
                  {provider.type === 'api' && (
                    <p>Endpoint: <code className="text-gray-300">{provider.endpoint}</code></p>
                  )}
                  {provider.models?.length > 0 && (
                    <p>Models: {provider.models.slice(0, 3).join(', ')}{provider.models.length > 3 ? ` +${provider.models.length - 3}` : ''}</p>
                  )}
                  {provider.defaultModel && (
                    <p>Default: <code className="text-gray-300">{provider.defaultModel}</code></p>
                  )}
                  {(provider.lightModel || provider.mediumModel || provider.heavyModel) && (
                    <p className="text-xs">
                      Tiers:
                      {provider.lightModel && <span className="ml-1 text-green-400">{provider.lightModel}</span>}
                      {provider.mediumModel && <span className="ml-1 text-yellow-400">{provider.mediumModel}</span>}
                      {provider.heavyModel && <span className="ml-1 text-red-400">{provider.heavyModel}</span>}
                    </p>
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

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleTest(provider.id)}
                  disabled={testResults[provider.id]?.testing}
                  className="px-3 py-1 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50"
                >
                  {testResults[provider.id]?.testing ? 'Testing...' : 'Test'}
                </button>

                {provider.type === 'api' && (
                  <button
                    onClick={() => handleRefreshModels(provider.id)}
                    className="px-3 py-1 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors"
                    title="Refresh models from API"
                  >
                    Refresh
                  </button>
                )}

                <button
                  onClick={() => handleToggleEnabled(provider)}
                  className={`px-3 py-1 text-sm rounded transition-colors ${
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
                    className="px-3 py-1 text-sm bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded transition-colors"
                  >
                    Set Default
                  </button>
                )}

                <button
                  onClick={() => { setEditingProvider(provider); setShowForm(true); }}
                  className="px-3 py-1 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors"
                >
                  Edit
                </button>

                <button
                  onClick={() => handleDelete(provider.id)}
                  className="px-3 py-1 text-sm bg-port-error/20 text-port-error hover:bg-port-error/30 rounded transition-colors"
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
                className="bg-port-card border border-port-border rounded-lg p-3 flex items-center justify-between"
              >
                <div className="flex items-center gap-4">
                  <span className={`w-2 h-2 rounded-full ${
                    run.success === true ? 'bg-port-success' :
                    run.success === false ? 'bg-port-error' :
                    'bg-port-warning animate-pulse'
                  }`} />
                  <div>
                    <p className="text-sm text-white">{run.prompt}</p>
                    <p className="text-xs text-gray-500">
                      {run.providerName} • {run.workspaceName || 'No workspace'} • {new Date(run.startTime).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="text-sm text-gray-400">
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
          onClose={() => { setShowForm(false); setEditingProvider(null); }}
          onSave={() => { setShowForm(false); setEditingProvider(null); loadData(); }}
        />
      )}
    </div>
  );
}

function ProviderForm({ provider, onClose, onSave }) {
  const [formData, setFormData] = useState({
    name: provider?.name || '',
    type: provider?.type || 'cli',
    command: provider?.command || '',
    args: provider?.args?.join(' ') || '',
    endpoint: provider?.endpoint || '',
    apiKey: provider?.apiKey || '',
    defaultModel: provider?.defaultModel || '',
    lightModel: provider?.lightModel || '',
    mediumModel: provider?.mediumModel || '',
    heavyModel: provider?.heavyModel || '',
    timeout: provider?.timeout || 300000,
    enabled: provider?.enabled !== false
  });

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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-port-card border border-port-border rounded-xl p-6 w-full max-w-lg">
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
            <label className="block text-sm text-gray-400 mb-1">Default Model</label>
            <input
              type="text"
              value={formData.defaultModel}
              onChange={(e) => setFormData(prev => ({ ...prev, defaultModel: e.target.value }))}
              placeholder="claude-sonnet-4-20250514"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
            />
          </div>

          {/* Model Tiers */}
          <div className="border-t border-port-border pt-4 mt-4">
            <h4 className="text-sm font-medium text-gray-300 mb-3">Model Tiers</h4>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Light (fast)</label>
                <input
                  type="text"
                  value={formData.lightModel}
                  onChange={(e) => setFormData(prev => ({ ...prev, lightModel: e.target.value }))}
                  placeholder="haiku"
                  className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Medium (balanced)</label>
                <input
                  type="text"
                  value={formData.mediumModel}
                  onChange={(e) => setFormData(prev => ({ ...prev, mediumModel: e.target.value }))}
                  placeholder="sonnet"
                  className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Heavy (powerful)</label>
                <input
                  type="text"
                  value={formData.heavyModel}
                  onChange={(e) => setFormData(prev => ({ ...prev, heavyModel: e.target.value }))}
                  placeholder="opus"
                  className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
                />
              </div>
            </div>
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
