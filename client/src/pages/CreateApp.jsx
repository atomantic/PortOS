import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io } from 'socket.io-client';
import { CheckCircle, Circle, Loader, AlertCircle, Play, Wrench } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../services/api';
import IconPicker from '../components/IconPicker';
import FolderPicker from '../components/FolderPicker';

const DETECTION_STEPS = [
  { id: 'validate', label: 'Validating path' },
  { id: 'files', label: 'Scanning files' },
  { id: 'package', label: 'Reading package.json' },
  { id: 'config', label: 'Checking configs' },
  { id: 'pm2', label: 'Checking PM2' },
  { id: 'readme', label: 'Reading README' },
  { id: 'standardize', label: 'Standardizing PM2 config' }
];

export default function CreateApp() {
  const navigate = useNavigate();
  const socketRef = useRef(null);

  // Path input
  const [repoPath, setRepoPath] = useState('');

  // Detection state
  const [detecting, setDetecting] = useState(false);
  const [steps, setSteps] = useState({});
  const [detectionLog, setDetectionLog] = useState([]);
  const [showLog, setShowLog] = useState(false);

  // Form fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [uiPort, setUiPort] = useState('');
  const [apiPort, setApiPort] = useState('');
  const [startCommands, setStartCommands] = useState('');
  const [pm2Names, setPm2Names] = useState('');
  const [pm2Status, setPm2Status] = useState(null);
  const [icon, setIcon] = useState('package');

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [detected, setDetected] = useState(false);

  // Standardization state
  const [standardizing, setStandardizing] = useState(false);
  const [standardizeResult, setStandardizeResult] = useState(null);
  const [activeProvider, setActiveProvider] = useState(null);

  // Fetch active provider and default directory on mount
  useEffect(() => {
    api.getActiveProvider().then(provider => {
      if (provider) setActiveProvider(provider);
    }).catch(() => {});

    // Set default path to PortOS parent directory
    api.getDirectories().then(result => {
      if (result?.currentPath) setRepoPath(result.currentPath);
    }).catch(() => {});
  }, []);

  // Initialize socket
  useEffect(() => {
    socketRef.current = io({ path: '/socket.io' });

    socketRef.current.on('detect:step', ({ step, status, data }) => {
      setSteps(prev => ({ ...prev, [step]: { status, data } }));
      setDetectionLog(prev => [...prev, { step, status, ...data }]);

      // Update form fields as data comes in
      if (data.name) setName(data.name);
      if (data.description) setDescription(data.description);
      if (data.uiPort) setUiPort(String(data.uiPort));
      if (data.apiPort) setApiPort(String(data.apiPort));
      if (data.startCommands?.length) setStartCommands(data.startCommands.join('\n'));
      if (data.pm2ProcessNames?.length) setPm2Names(data.pm2ProcessNames.join(', '));
      if (data.pm2Status) {
        setPm2Status(data.pm2Status);
        // Also set pm2Names from found processes if available
        if (!data.pm2ProcessNames?.length && Array.isArray(data.pm2Status)) {
          setPm2Names(data.pm2Status.map(p => p.name).join(', '));
        }
      }
    });

    socketRef.current.on('detect:complete', ({ success, result, error: err }) => {
      setDetecting(false);
      if (success && result) {
        setDetected(true);
        if (result.name) setName(result.name);
        if (result.description) setDescription(result.description);
        if (result.uiPort) setUiPort(String(result.uiPort));
        if (result.apiPort) setApiPort(String(result.apiPort));
        if (result.startCommands?.length) setStartCommands(result.startCommands.join('\n'));
        if (result.pm2ProcessNames?.length) setPm2Names(result.pm2ProcessNames.join(', '));
      } else if (err) {
        setError(err);
      }
    });

    // Standardization socket events
    socketRef.current.on('standardize:step', ({ step, status, data }) => {
      // Map standardize steps to our step display
      const stepMap = { analyze: 'standardize', backup: 'standardize', apply: 'standardize' };
      const displayStep = stepMap[step] || 'standardize';
      setSteps(prev => ({ ...prev, [displayStep]: { status: status === 'done' ? 'running' : status, data } }));
      setDetectionLog(prev => [...prev, { step: `standardize:${step}`, status, ...data }]);
    });

    socketRef.current.on('standardize:complete', ({ success, result, error: err }) => {
      setStandardizing(false);
      if (success && result) {
        setStandardizeResult(result);
        setSteps(prev => ({ ...prev, standardize: { status: 'done', data: { message: 'PM2 config standardized' } } }));
        toast.success(`PM2 config standardized${result.backupBranch ? ` (backup: ${result.backupBranch})` : ''}`);
      } else {
        setSteps(prev => ({ ...prev, standardize: { status: 'error', data: { message: err || 'Standardization failed' } } }));
        if (err) toast.error(`Standardization failed: ${err}`);
      }
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  // Auto-trigger standardization after detection completes
  useEffect(() => {
    if (detected && activeProvider && repoPath && !standardizing && !standardizeResult) {
      setStandardizing(true);
      setSteps(prev => ({ ...prev, standardize: { status: 'running', data: { message: 'Analyzing configuration...' } } }));
      socketRef.current?.emit('standardize:start', { repoPath, providerId: activeProvider.id });
    }
  }, [detected, activeProvider, repoPath, standardizing, standardizeResult]);

  // Start streaming detection
  const handleImport = () => {
    if (!repoPath || detecting) return;

    setError(null);
    setDetecting(true);
    setSteps({});
    setDetectionLog([]);
    setDetected(false);
    setPm2Status(null);
    setStandardizing(false);
    setStandardizeResult(null);

    socketRef.current.emit('detect:start', { path: repoPath });
  };

  // Submit form
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const data = {
      name,
      repoPath,
      icon,
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
    if (result) navigate('/apps');
  };

  const reset = () => {
    setDetected(false);
    setSteps({});
    setDetectionLog([]);
    setName('');
    setDescription('');
    setUiPort('');
    setApiPort('');
    setStartCommands('');
    setPm2Names('');
    setPm2Status(null);
    setIcon('package');
    setError(null);
    setStandardizing(false);
    setStandardizeResult(null);
  };

  const getStepIcon = (stepId) => {
    const step = steps[stepId];
    if (!step) return <Circle size={16} className="text-gray-600" />;
    if (step.status === 'running') return <Loader size={16} className="text-port-accent animate-spin" />;
    if (step.status === 'done') return <CheckCircle size={16} className="text-port-success" />;
    if (step.status === 'error') return <AlertCircle size={16} className="text-port-error" />;
    if (step.status === 'skipped') return <Circle size={16} className="text-gray-500" />;
    return <Circle size={16} className="text-gray-600" />;
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Add App</h1>
        <p className="text-gray-500">Import an existing project or create a new one from a template</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Path Input */}
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <label className="block text-sm text-gray-400 mb-2">Project Directory</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={repoPath}
              onChange={(e) => { setRepoPath(e.target.value); reset(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleImport();
                }
              }}
              placeholder="/Users/you/projects/my-app"
              className="flex-1 px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none font-mono"
            />
            <FolderPicker
              value={repoPath}
              onChange={(path) => { setRepoPath(path); reset(); }}
            />
          </div>

          {/* Detection Progress */}
          {detecting && (
            <div className="mt-4 space-y-2">
              {DETECTION_STEPS.map(({ id, label }) => (
                <div key={id} className="flex items-center gap-2 text-sm">
                  {getStepIcon(id)}
                  <span className={steps[id]?.status === 'running' ? 'text-port-accent' :
                    steps[id]?.status === 'done' ? 'text-white' : 'text-gray-500'}>
                    {label}
                  </span>
                  {steps[id]?.data?.message && (
                    <span className="text-gray-500 text-xs ml-2">
                      {steps[id].data.message}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* PM2 Running Status */}
          {pm2Status && pm2Status.length > 0 && (
            <div className="mt-3 p-3 bg-port-warning/10 border border-port-warning/30 rounded-lg">
              <p className="text-sm text-port-warning font-medium flex items-center gap-2">
                <Play size={14} /> Already running in PM2
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {pm2Status.map(p => `${p.name} (${p.status})`).join(', ')}
              </p>
            </div>
          )}

          {/* Standardization Result */}
          {standardizeResult && (
            <div className="mt-3 p-3 bg-port-success/10 border border-port-success/30 rounded-lg">
              <p className="text-sm text-port-success font-medium flex items-center gap-2">
                <Wrench size={14} /> PM2 Config Standardized
              </p>
              {standardizeResult.backupBranch && (
                <p className="text-xs text-gray-400 mt-1">
                  Backup branch: <code className="bg-port-bg px-1 rounded">{standardizeResult.backupBranch}</code>
                </p>
              )}
              {standardizeResult.filesModified?.length > 0 && (
                <p className="text-xs text-gray-400 mt-1">
                  Modified: {standardizeResult.filesModified.join(', ')}
                </p>
              )}
            </div>
          )}

          {/* No Provider Warning */}
          {detected && !activeProvider && !standardizing && !standardizeResult && (
            <div className="mt-3 p-3 bg-port-border/50 border border-port-border rounded-lg">
              <p className="text-xs text-gray-400">
                <span className="text-port-warning">⚠</span> No LLM provider configured. PM2 standardization skipped.
              </p>
            </div>
          )}

          {/* Detection Log Toggle */}
          {detectionLog.length > 0 && (
            <button
              type="button"
              onClick={() => setShowLog(!showLog)}
              className="mt-3 text-xs text-gray-500 hover:text-gray-400"
            >
              {showLog ? 'Hide' : 'Show'} detection log ({detectionLog.length} entries)
            </button>
          )}

          {showLog && (
            <div className="mt-2 p-2 bg-port-bg rounded text-xs font-mono text-gray-400 max-h-40 overflow-auto">
              {detectionLog.map((log, i) => (
                <div key={i} className="py-0.5">
                  <span className={log.status === 'done' ? 'text-port-success' :
                    log.status === 'error' ? 'text-port-error' : 'text-gray-500'}>
                    [{log.step}]
                  </span> {log.message}
                </div>
              ))}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 mt-4">
            <button
              type="button"
              onClick={() => navigate('/templates')}
              className="flex-1 px-6 py-3 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
            >
              Create from Template
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={!repoPath || detecting}
              className="flex-1 px-6 py-3 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {detecting ? 'Detecting...' : 'Import'}
            </button>
          </div>
        </div>

        {/* App Configuration - shown after detection */}
        {detected && (
          <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <h3 className="text-lg font-semibold text-white mb-4">App Configuration</h3>

            <div className="grid grid-cols-[1fr_auto] gap-4">
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
              <div className="w-32">
                <IconPicker value={icon} onChange={setIcon} />
              </div>
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
        {detected && (
          <div className="flex justify-between items-center">
            <button
              type="button"
              onClick={reset}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Reset
            </button>
            <button
              type="submit"
              disabled={!name || submitting}
              className="px-6 py-3 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save App'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
