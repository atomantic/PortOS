import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../services/api';

export default function CreateApp() {
  const navigate = useNavigate();

  // Path input
  const [repoPath, setRepoPath] = useState('');
  const [pathValid, setPathValid] = useState(null);

  // Detection state
  const [detecting, setDetecting] = useState(false);
  const [aiDetecting, setAiDetecting] = useState(false);
  const [detected, setDetected] = useState(null);
  const [hasAiProvider, setHasAiProvider] = useState(false);

  // Form fields (populated by detection or manual entry)
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [uiPort, setUiPort] = useState('');
  const [apiPort, setApiPort] = useState('');
  const [startCommands, setStartCommands] = useState('npm run dev');
  const [pm2Names, setPm2Names] = useState('');

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Check if AI provider is available
  useEffect(() => {
    api.getActiveProvider().then(p => setHasAiProvider(!!p)).catch(() => {});
  }, []);

  // Validate path on blur
  const handlePathBlur = async () => {
    if (!repoPath) {
      setPathValid(null);
      return;
    }

    setDetecting(true);
    const result = await api.detectRepo(repoPath).catch(() => ({ valid: false }));
    setPathValid(result.valid);
    setDetecting(false);

    if (result.valid) {
      // Apply basic detection
      if (result.packageJson?.name && !name) {
        setName(result.packageJson.name);
      }
      if (result.startCommands?.length > 0 && startCommands === 'npm run dev') {
        setStartCommands(result.startCommands.join('\n'));
      }
      if (result.detectedPorts?.vite && !uiPort) {
        setUiPort(String(result.detectedPorts.vite));
      }
      if (result.detectedPorts?.main && !apiPort) {
        setApiPort(String(result.detectedPorts.main));
      }
    }
  };

  // AI-powered detection
  const handleAiDetect = async () => {
    if (!repoPath || !pathValid) return;

    setError(null);
    setAiDetecting(true);

    const result = await api.detectWithAi(repoPath).catch(err => ({
      success: false,
      error: err.message
    }));

    setAiDetecting(false);

    if (!result.success) {
      setError(result.error || 'AI detection failed');
      return;
    }

    setDetected(result);

    // Apply AI-detected values
    const d = result.detected;
    if (d.name) setName(d.name);
    if (d.description) setDescription(d.description);
    if (d.uiPort) setUiPort(String(d.uiPort));
    if (d.apiPort) setApiPort(String(d.apiPort));
    if (d.startCommands?.length > 0) setStartCommands(d.startCommands.join('\n'));
    if (d.pm2ProcessNames?.length > 0) setPm2Names(d.pm2ProcessNames.join(', '));
  };

  // Submit form
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const data = {
      name,
      repoPath,
      uiPort: uiPort ? parseInt(uiPort) : null,
      apiPort: apiPort ? parseInt(apiPort) : null,
      startCommands: startCommands.split('\n').filter(Boolean),
      pm2ProcessNames: pm2Names
        ? pm2Names.split(',').map(s => s.trim()).filter(Boolean)
        : [name.toLowerCase().replace(/[^a-z0-9]/g, '-')]
    };

    const result = await api.createApp(data).catch(err => {
      setError(err.message);
      return null;
    });

    setSubmitting(false);

    if (result) {
      navigate('/apps');
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Add App</h1>
        <p className="text-gray-500">Register an existing project with PortOS</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Path Input */}
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <label className="block text-sm text-gray-400 mb-2">Project Directory</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={repoPath}
              onChange={(e) => { setRepoPath(e.target.value); setPathValid(null); setDetected(null); }}
              onBlur={handlePathBlur}
              placeholder="/Users/you/projects/my-app"
              className="flex-1 px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none font-mono"
            />
            {hasAiProvider && pathValid && (
              <button
                type="button"
                onClick={handleAiDetect}
                disabled={aiDetecting}
                className="px-4 py-3 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                {aiDetecting ? 'Detecting...' : 'Detect with AI'}
              </button>
            )}
          </div>

          {detecting && (
            <p className="mt-2 text-sm text-gray-500">Validating path...</p>
          )}

          {pathValid === false && (
            <p className="mt-2 text-sm text-port-error">Invalid directory path</p>
          )}

          {pathValid === true && !detected && (
            <p className="mt-2 text-sm text-port-success">
              Valid project directory
              {hasAiProvider && ' — click "Detect with AI" for smart configuration'}
            </p>
          )}

          {detected && (
            <div className="mt-3 p-3 bg-port-success/10 border border-port-success/30 rounded-lg">
              <p className="text-sm text-port-success font-medium">
                AI Detection Complete ({detected.provider})
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {detected.context?.configFiles?.length > 0 && (
                  <>Config files found: {detected.context.configFiles.join(', ')}</>
                )}
              </p>
            </div>
          )}
        </div>

        {/* App Details */}
        {pathValid && (
          <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4">
            <h3 className="text-lg font-semibold text-white mb-4">App Configuration</h3>

            <div>
              <label className="block text-sm text-gray-400 mb-1">App Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Awesome App"
                required
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A brief description of the app"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">UI/Frontend Port</label>
                <input
                  type="number"
                  value={uiPort}
                  onChange={(e) => setUiPort(e.target.value)}
                  placeholder="3000"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">API/Backend Port</label>
                <input
                  type="number"
                  value={apiPort}
                  onChange={(e) => setApiPort(e.target.value)}
                  placeholder="3001"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Start Commands (one per line)</label>
              <textarea
                value={startCommands}
                onChange={(e) => setStartCommands(e.target.value)}
                placeholder="npm run dev"
                rows={2}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                Commands to start your app. Multiple lines = multiple PM2 processes.
              </p>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">PM2 Process Names (comma-separated)</label>
              <input
                type="text"
                value={pm2Names}
                onChange={(e) => setPm2Names(e.target.value)}
                placeholder="my-app-ui, my-app-api"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">
                Names for PM2 processes. Leave blank to auto-generate from app name.
              </p>
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="p-4 bg-port-error/20 border border-port-error rounded-lg text-port-error">
            {error}
          </div>
        )}

        {/* Submit */}
        {pathValid && (
          <div className="flex justify-between items-center">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name || submitting}
              className="px-6 py-3 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {submitting ? 'Registering...' : 'Register App'}
            </button>
          </div>
        )}
      </form>

      {/* No AI Provider Notice */}
      {pathValid && !hasAiProvider && (
        <div className="mt-6 p-4 bg-port-border/50 rounded-lg">
          <p className="text-sm text-gray-400">
            <strong className="text-white">Tip:</strong> Configure an AI provider in{' '}
            <a href="/ai" className="text-port-accent hover:underline">AI Providers</a>{' '}
            to enable smart auto-detection of app configuration.
          </p>
        </div>
      )}
    </div>
  );
}
