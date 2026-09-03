import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { io } from 'socket.io-client';
import { CheckCircle, Circle, Loader, AlertCircle, Play, Wrench } from 'lucide-react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import IconPicker from '../components/IconPicker';
import FolderPicker from '../components/FolderPicker';
import Banner from '../components/ui/Banner';
import { NON_PM2_TYPES, isStandardizable, getAppTypeLabel } from '../components/apps/constants';

const DETECTION_STEPS_PM2 = [
  { id: 'validate', label: 'Validating path' },
  { id: 'files', label: 'Scanning files' },
  { id: 'package', label: 'Reading package.json' },
  { id: 'config', label: 'Checking configs' },
  { id: 'pm2', label: 'Checking PM2' },
  { id: 'readme', label: 'Reading README' },
  { id: 'icon', label: 'Detecting app icon' }
];

const DETECTION_STEPS_NON_PM2 = [
  { id: 'validate', label: 'Validating path' },
  { id: 'files', label: 'Scanning files' },
  { id: 'package', label: 'Reading project config' },
  { id: 'config', label: 'Checking configs' },
  { id: 'readme', label: 'Reading README' },
  { id: 'icon', label: 'Detecting app icon' }
];

// The steps `runStandardizeFlow` emits. Standardization is its own flow, not a
// detection step — see handleStandardize for why it stays out of that sequence.
const STANDARDIZE_STEPS = [
  { id: 'analyze', label: 'Analyzing configuration' },
  { id: 'backup', label: 'Creating git backup' },
  { id: 'apply', label: 'Writing ecosystem.config.cjs' }
];

const stepIconFor = (step) => {
  if (!step) return <Circle size={16} className="text-gray-600" />;
  if (step.status === 'running') return <Loader size={16} className="text-port-accent animate-spin" />;
  if (step.status === 'done') return <CheckCircle size={16} className="text-port-success" />;
  if (step.status === 'error') return <AlertCircle size={16} className="text-port-error" />;
  if (step.status === 'skipped') return <Circle size={16} className="text-gray-500" />;
  return <Circle size={16} className="text-gray-600" />;
};

/** Progress rows for a step sequence — shared by detection and standardization. */
const StepRows = ({ defs, state }) => defs.map(({ id, label }) => {
  const step = state[id];
  return (
    <div key={id} className="flex items-center gap-2 text-sm">
      {stepIconFor(step)}
      <span className={step?.status === 'running' ? 'text-port-accent' :
        step?.status === 'done' ? 'text-white' : 'text-gray-500'}>
        {label}
      </span>
      {step?.data?.message && (
        <span className="text-gray-500 text-xs ml-2 truncate">{step.data.message}</span>
      )}
    </div>
  );
});

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
  const [devUiPort, setDevUiPort] = useState('');
  const [apiPort, setApiPort] = useState('');
  const [buildCommand, setBuildCommand] = useState('');
  const [updateCommand, setUpdateCommand] = useState('');
  const [startCommands, setStartCommands] = useState('');
  const [pm2Names, setPm2Names] = useState('');
  const [pm2Status, setPm2Status] = useState(null);
  const [nativeLaunch, setNativeLaunch] = useState(null);
  const [icon, setIcon] = useState('package');
  const [appIconPath, setAppIconPath] = useState(null);
  const [appType, setAppType] = useState('unknown');

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [detected, setDetected] = useState(false);

  // Standardization state
  const [standardizing, setStandardizing] = useState(false);
  const [standardizeSteps, setStandardizeSteps] = useState({});
  const [standardizeResult, setStandardizeResult] = useState(null);
  const [standardizeError, setStandardizeError] = useState(null);
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
      if (data.type) setAppType(data.type);
      if (data.name) setName(data.name);
      if (data.description) setDescription(data.description);
      if (data.uiPort) setUiPort(String(data.uiPort));
      if (data.devUiPort) setDevUiPort(String(data.devUiPort));
      if (data.apiPort) setApiPort(String(data.apiPort));
      if (data.buildCommand) setBuildCommand(data.buildCommand);
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
        if (result.type) setAppType(result.type);
        if (result.name) setName(result.name);
        if (result.description) setDescription(result.description);
        if (result.uiPort) setUiPort(String(result.uiPort));
        if (result.devUiPort) setDevUiPort(String(result.devUiPort));
        if (result.apiPort) setApiPort(String(result.apiPort));
        if (result.buildCommand) setBuildCommand(result.buildCommand);
        if (result.startCommands?.length) setStartCommands(result.startCommands.join('\n'));
        if (result.pm2ProcessNames?.length) setPm2Names(result.pm2ProcessNames.join(', '));
        setNativeLaunch(result.nativeLaunch || null);
        if (result.appIconPath) setAppIconPath(result.appIconPath);
      } else if (err) {
        setError(err);
      }
    });

    // Standardization socket events
    socketRef.current.on('standardize:step', ({ step, status, data }) => {
      setStandardizeSteps(prev => ({ ...prev, [step]: { status, data } }));
      setDetectionLog(prev => [...prev, { step: `standardize:${step}`, status, ...data }]);
    });

    socketRef.current.on('standardize:complete', ({ success, result, error: err }) => {
      setStandardizing(false);
      if (success && result) {
        setStandardizeResult(result);
        toast.success(`PM2 config standardized${result.backupBranch ? ` (backup: ${result.backupBranch})` : ''}`);
      } else {
        setStandardizeError(err || 'Standardization failed');
        if (err) toast.error(`Standardization failed: ${err}`);
      }
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const isNonPm2 = NON_PM2_TYPES.has(appType);

  const clearStandardize = () => {
    setStandardizing(false);
    setStandardizeSteps({});
    setStandardizeResult(null);
    setStandardizeError(null);
  };

  // Standardization is opt-in: the user asks for it here. It used to fire on its
  // own the moment detection finished, which wrote an `ecosystem.config.cjs` into
  // any imported directory — including apps PortOS won't run under PM2 at all —
  // before the app record was even saved.
  const handleStandardize = () => {
    if (!activeProvider) return;
    clearStandardize();
    setStandardizing(true);
    socketRef.current?.emit('standardize:start', { repoPath, providerId: activeProvider.id });
  };

  // Start streaming detection
  const handleImport = () => {
    if (!repoPath || detecting) return;

    setError(null);
    setDetecting(true);
    setSteps({});
    setDetectionLog([]);
    setDetected(false);
    setPm2Status(null);
    clearStandardize();

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
      type: appType !== 'unknown' ? appType : undefined,
      icon,
      appIconPath: appIconPath || undefined,
      uiPort: uiPort ? parseInt(uiPort, 10) : null,
      devUiPort: devUiPort ? parseInt(devUiPort, 10) : null,
      apiPort: apiPort ? parseInt(apiPort, 10) : null,
      buildCommand: buildCommand || undefined,
      updateCommand: updateCommand || undefined,
      startCommands: startCommands ? startCommands.split('\n').filter(Boolean) : [],
      pm2ProcessNames: isNonPm2
        ? []
        : pm2Names
          ? pm2Names.split(',').map(s => s.trim()).filter(Boolean)
          : [name.toLowerCase().replace(/[^a-z0-9]/g, '-')],
      nativeLaunch
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
    setAppType('unknown');
    setUiPort('');
    setDevUiPort('');
    setApiPort('');
    setBuildCommand('');
    setStartCommands('');
    setPm2Names('');
    setPm2Status(null);
    setNativeLaunch(null);
    setIcon('package');
    setAppIconPath(null);
    setError(null);
    clearStandardize();
  };

  // The status rail only has something to show once detection has started or
  // produced results — otherwise we render a hint so the column isn't a void.
  const hasRailContent = detecting || detected || detectionLog.length > 0;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Add App</h1>
        <p className="text-gray-500">Import an existing project or create a new one from a template</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
          {/* Left column — path input + configuration form */}
          <div className="space-y-6 min-w-0">
            {/* Path Input */}
            <div className="bg-port-card border border-port-border rounded-xl p-6">
              <label htmlFor="repo-path" className="block text-sm text-gray-400 mb-2">Project Directory</label>
              <div className="flex gap-2">
                <input
                  id="repo-path"
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
                  className="flex-1 min-w-0 px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden font-mono"
                />
                <FolderPicker
                  value={repoPath}
                  onChange={(path) => { setRepoPath(path); reset(); }}
                />
              </div>

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
                    <label htmlFor="app-name" className="block text-sm text-gray-400 mb-1">App Name *</label>
                    <input
                      id="app-name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="My Awesome App"
                      required
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    />
                  </div>
                  <div className="w-32">
                    <IconPicker value={icon} onChange={setIcon} />
                  </div>
                </div>

                <div>
                  <label htmlFor="app-description" className="block text-sm text-gray-400 mb-1">Description</label>
                  <input
                    id="app-description"
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="A brief description of the app"
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  />
                </div>

                {/* Port fields - only for PM2/server apps */}
                {!isNonPm2 && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label htmlFor="ui-port" className="block text-sm text-gray-400 mb-1">UI Port</label>
                      <input
                        id="ui-port"
                        type="number"
                        value={uiPort}
                        onChange={(e) => setUiPort(e.target.value)}
                        placeholder="3000"
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      />
                    </div>
                    <div>
                      <label htmlFor="dev-ui-port" className="block text-sm text-gray-400 mb-1">Dev UI Port</label>
                      <input
                        id="dev-ui-port"
                        type="number"
                        value={devUiPort}
                        onChange={(e) => setDevUiPort(e.target.value)}
                        placeholder="3001"
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      />
                    </div>
                    <div>
                      <label htmlFor="api-port" className="block text-sm text-gray-400 mb-1">API Port</label>
                      <input
                        id="api-port"
                        type="number"
                        value={apiPort}
                        onChange={(e) => setApiPort(e.target.value)}
                        placeholder="3002"
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      />
                    </div>
                  </div>
                )}

                {/* Start commands - only for PM2/server apps */}
                {!isNonPm2 && (
                  <div>
                    <label htmlFor="start-commands" className="block text-sm text-gray-400 mb-1">Start Commands (one per line)</label>
                    <textarea
                      id="start-commands"
                      value={startCommands}
                      onChange={(e) => setStartCommands(e.target.value)}
                      placeholder="npm run dev"
                      rows={2}
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden font-mono text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Commands to start your app. Multiple lines = multiple PM2 processes.
                    </p>
                  </div>
                )}

                <div>
                  <label htmlFor="update-command" className="block text-sm text-gray-400 mb-1">Update Command</label>
                  <input
                    id="update-command"
                    type="text"
                    value={updateCommand}
                    onChange={(e) => setUpdateCommand(e.target.value)}
                    placeholder="npm run update"
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden font-mono text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Optional. Updates otherwise only check out the origin default branch and restart. A <code>portos:update</code> package script is also recognized.
                  </p>
                </div>

                <div>
                  <label htmlFor="build-command" className="block text-sm text-gray-400 mb-1">Build Command</label>
                  <input
                    id="build-command"
                    type="text"
                    value={buildCommand}
                    onChange={(e) => setBuildCommand(e.target.value)}
                    placeholder={isNonPm2 ? 'xcodebuild -scheme MyApp build' : 'npm run build'}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden font-mono text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {isNonPm2 ? 'Command to build the project.' : 'Command to build the production UI. Enables the Build button.'}
                  </p>
                </div>

                {nativeLaunch && (
                  <Banner tone="info" size="md">
                    <p className="font-medium">Separate {nativeLaunch.label} action detected</p>
                    <p className="text-xs text-gray-400 mt-1">
                      Standard Launch will keep opening the web UI. A second button will run <code>{nativeLaunch.command}</code>.
                    </p>
                  </Banner>
                )}

                {/* PM2 process names - only for PM2/server apps */}
                {!isNonPm2 && (
                  <div>
                    <label htmlFor="pm2-names" className="block text-sm text-gray-400 mb-1">PM2 Process Names (comma-separated)</label>
                    <input
                      id="pm2-names"
                      type="text"
                      value={pm2Names}
                      onChange={(e) => setPm2Names(e.target.value)}
                      placeholder="my-app-ui, my-app-api"
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Names for PM2 processes. Leave blank to auto-generate from app name.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right column — detection status rail */}
          <aside className="space-y-3 lg:sticky lg:top-4 self-start">
            {/* Detection Progress */}
            {detecting && (
              <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">Detecting</h3>
                <StepRows defs={isNonPm2 ? DETECTION_STEPS_NON_PM2 : DETECTION_STEPS_PM2} state={steps} />
              </div>
            )}

            {/* App Type Badge — shown for every type the PM2 standardizer skips,
                so a Python/Go/Docker/static repo says WHY the card below is gone
                rather than silently offering nothing. */}
            {detected && !isStandardizable(appType) && (
              <Banner tone="info" size="md">
                <p className="font-medium">
                  {getAppTypeLabel(appType)} — {isNonPm2 ? 'not managed by PM2' : 'not a Node.js project'}
                </p>
              </Banner>
            )}

            {/* PM2 Running Status */}
            {pm2Status && pm2Status.length > 0 && !isNonPm2 && (
              <Banner tone="warning" size="md">
                <p className="font-medium flex items-center gap-2">
                  <Play size={14} /> Already running in PM2
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {pm2Status.map(p => `${p.name} (${p.status})`).join(', ')}
                </p>
              </Banner>
            )}

            {/* Standardize PM2 config — opt-in, because it rewrites the repo */}
            {detected && isStandardizable(appType) && !standardizeResult && (
              <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-gray-500">Optional</h3>
                <p className="text-sm text-white flex items-center gap-2">
                  <Wrench size={14} aria-hidden="true" /> Standardize PM2 config
                </p>
                <p className="text-xs text-gray-500">
                  Writes an <code className="bg-port-bg px-1 rounded">ecosystem.config.cjs</code> into this
                  project and moves its ports there (a git backup branch is created first). Only do this for
                  apps you want PortOS to run under PM2 — skip it for Docker stacks, static sites, or anything
                  you start another way. You can run it later from the Apps list.
                </p>
                {standardizing ? (
                  <div className="space-y-2">
                    <StepRows defs={STANDARDIZE_STEPS} state={standardizeSteps} />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleStandardize}
                    disabled={!activeProvider}
                    className="w-full px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors disabled:opacity-50 text-sm"
                  >
                    Standardize PM2 config
                  </button>
                )}
                {!activeProvider && (
                  <Banner tone="warning" icon={AlertCircle}>
                    Needs an LLM provider — none is configured.
                  </Banner>
                )}
                {standardizeError && (
                  <Banner tone="error" icon={AlertCircle}>{standardizeError}</Banner>
                )}
              </div>
            )}

            {/* Standardization Result */}
            {standardizeResult && (
              <Banner tone="success" size="md">
                <p className="font-medium flex items-center gap-2">
                  <Wrench size={14} aria-hidden="true" /> PM2 Config Standardized
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
              </Banner>
            )}

            {/* Detection Log */}
            {detectionLog.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowLog(!showLog)}
                  className="text-xs text-gray-500 hover:text-gray-400"
                >
                  {showLog ? 'Hide' : 'Show'} detection log ({detectionLog.length} entries)
                </button>
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
              </div>
            )}

            {/* Empty-state placeholder — keeps the rail from being a blank gap before detection runs */}
            {!hasRailContent && (
              <div className="bg-port-card/50 border border-dashed border-port-border rounded-xl p-4 text-xs text-gray-500">
                Detection progress and results appear here once you import a project.
              </div>
            )}
          </aside>
        </div>

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
