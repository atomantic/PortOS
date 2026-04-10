import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Clock, Image, X, Info } from 'lucide-react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import socket from '../services/socket';
import { processScreenshotUploads } from '../utils/fileUpload';
import BrailleSpinner from '../components/BrailleSpinner';

export function RunnerPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [mode, setMode] = useState('ai'); // 'ai' or 'command'
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('');
  const [selectedAppId, setSelectedAppId] = useState('');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(null);
  const [commandId, setCommandId] = useState(null);
  const [apps, setApps] = useState([]);
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [timeout, setTimeout] = useState(30);
  const [allowedCommands, setAllowedCommands] = useState([]);
  const [screenshots, setScreenshots] = useState([]);
  const [continueContext, setContinueContext] = useState(null);
  const fileInputRef = useRef(null);
  const outputRef = useRef(null);
  const continueWorkspaceRef = useRef(location.state?.continueFrom?.workspacePath ?? null);

  // Get the selected app's repoPath
  const selectedApp = apps.find(a => a.id === selectedAppId);
  const workspacePath = selectedApp?.repoPath || '';

  // Handle continuation context from navigation — store continueFrom and clear location state once
  useEffect(() => {
    const continueFrom = location.state?.continueFrom;
    if (continueFrom) {
      setContinueContext(continueFrom);
      // Set provider and model from previous run if available
      if (continueFrom.providerId) {
        setSelectedProvider(continueFrom.providerId);
      }
      if (continueFrom.model) {
        setSelectedModel(continueFrom.model);
      }
      // Clear location state to prevent re-triggering on refresh
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state, navigate]);

  useEffect(() => {
    Promise.all([
      api.getApps().catch(() => []),
      api.getProviders().catch(() => ({ providers: [] })),
      api.getAllowedCommands().catch(() => [])
    ]).then(([appsData, providersRes, cmds]) => {
      // Filter out PortOS Autofixer (it's part of PortOS project)
      const filteredApps = appsData.filter(a => a.id !== 'portos-autofixer');
      setApps(filteredApps);
      // Set workspace: prefer continuation context (stored in ref), then PortOS, then first app
      setSelectedAppId(prev => {
        if (prev) return prev;
        if (continueWorkspaceRef.current) {
          const continueApp = filteredApps.find(a => a.repoPath === continueWorkspaceRef.current);
          if (continueApp) return continueApp.id;
        }
        const portosApp = filteredApps.find(a => a.name === 'PortOS');
        if (portosApp) return portosApp.id;
        return filteredApps.length > 0 ? filteredApps[0].id : prev;
      });
      const allProviders = providersRes.providers || [];
      const enabledProviders = allProviders.filter(p => p.enabled);
      setProviders(enabledProviders);
      if (enabledProviders.length > 0) {
        const active = enabledProviders.find(p => p.id === providersRes.activeProvider) || enabledProviders[0];
        setSelectedProvider(active.id);
        setSelectedModel(active.defaultModel || '');
      }
      setAllowedCommands(cmds);
    });
  }, []);

  // Subscribe to run output
  useEffect(() => {
    if (!runId) return;

    const handleData = (data) => {
      setOutput(prev => prev + data);
      if (outputRef.current) {
        outputRef.current.scrollTop = outputRef.current.scrollHeight;
      }
    };

    const handleComplete = (metadata) => {
      setRunning(false);
      setRunId(null);
      const status = metadata.success ? '✓ Completed' : `✗ Failed (${metadata.error || 'unknown error'})`;
      setOutput(prev => prev + `\n\n--- ${status} (${Math.round(metadata.duration / 1000)}s) ---\n`);
    };

    socket.on(`run:${runId}:data`, handleData);
    socket.on(`run:${runId}:complete`, handleComplete);

    return () => {
      socket.off(`run:${runId}:data`, handleData);
      socket.off(`run:${runId}:complete`, handleComplete);
    };
  }, [runId]);

  // Subscribe to command output
  useEffect(() => {
    if (!commandId) return;

    const handleData = ({ data }) => {
      setOutput(prev => prev + data);
      if (outputRef.current) {
        outputRef.current.scrollTop = outputRef.current.scrollHeight;
      }
    };

    const handleComplete = (result) => {
      setRunning(false);
      setCommandId(null);
      setOutput(prev => prev + `\n--- Command finished (exit code: ${result.exitCode}) ---\n`);
    };

    socket.on(`command:${commandId}:data`, handleData);
    socket.on(`command:${commandId}:complete`, handleComplete);

    return () => {
      socket.off(`command:${commandId}:data`, handleData);
      socket.off(`command:${commandId}:complete`, handleComplete);
    };
  }, [commandId]);

  const handleRunAI = async () => {
    if (!prompt.trim() || !selectedProvider) return;

    // Build final prompt, merging with continuation context if present
    let finalPrompt = prompt.trim();
    if (continueContext) {
      if (continueContext.success === false) {
        // Resuming a failed run - include error context
        finalPrompt = `RESUMING FAILED RUN:

--- PREVIOUS PROMPT ---
${continueContext.prompt}
${continueContext.output ? `
--- PREVIOUS OUTPUT (BEFORE FAILURE) ---
${continueContext.output}
` : ''}
--- ERROR ---
${continueContext.error || 'Unknown error'}
${continueContext.suggestedFix ? `
--- SUGGESTED FIX ---
${continueContext.suggestedFix}
` : ''}
--- NEW INSTRUCTIONS ---
${prompt.trim()}`;
      } else {
        // Continuing a successful conversation
        finalPrompt = `CONTINUATION OF PREVIOUS CONVERSATION:

--- PREVIOUS PROMPT ---
${continueContext.prompt}

--- PREVIOUS OUTPUT ---
${continueContext.output}

--- NEW INSTRUCTIONS ---
${prompt.trim()}`;
      }
    }

    setOutput('');
    setRunning(true);

    const result = await api.createRun({
      providerId: selectedProvider,
      model: selectedModel || undefined,
      prompt: finalPrompt,
      workspacePath: workspacePath || undefined,
      workspaceName: apps.find(a => a.repoPath === workspacePath)?.name,
      timeout: timeout * 60 * 1000, // Convert minutes to milliseconds
      screenshots: screenshots.map(s => s.path) // Include screenshot paths
    }).catch(err => ({ error: err.message }));

    if (result.error) {
      setOutput(`Error: ${result.error}`);
      setRunning(false);
      return;
    }

    // Clear continuation context after running
    setContinueContext(null);
    setRunId(result.runId);
  };

  const handleRunCommand = async () => {
    if (!command.trim()) return;

    setOutput('');
    setRunning(true);

    const result = await api.executeCommand(command, workspacePath || undefined)
      .catch(err => ({ error: err.message }));

    if (result.error) {
      setOutput(`Error: ${result.error}`);
      setRunning(false);
      return;
    }

    setCommandId(result.commandId);
  };

  const handleStop = async () => {
    if (runId) {
      await api.stopRun(runId);
      setRunning(false);
      setRunId(null);
    }
    if (commandId) {
      await api.stopCommand(commandId);
      setRunning(false);
      setCommandId(null);
    }
  };

  const handleFileSelect = async (e) => {
    await processScreenshotUploads(e.target.files, {
      onSuccess: (fileInfo) => setScreenshots(prev => [...prev, fileInfo]),
      onError: (msg) => toast.error(msg)
    });
    e.target.value = '';
  };

  const removeScreenshot = (id) => {
    setScreenshots(prev => prev.filter(s => s.id !== id));
  };

  const currentProvider = providers.find(p => p.id === selectedProvider);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Code</h1>

      {/* Continuation Context Banner */}
      {continueContext && (
        <div className={`${continueContext.success === false ? 'bg-port-warning/10 border-port-warning/30' : 'bg-port-success/10 border-port-success/30'} border rounded-xl p-4`} data-testid="continuation-banner">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              <Info size={18} className={continueContext.success === false ? 'text-port-warning' : 'text-port-success'} />
              <span className={`font-medium ${continueContext.success === false ? 'text-port-warning' : 'text-port-success'}`}>
                {continueContext.success === false ? 'Resuming Failed Run' : 'Continuing Previous Conversation'}
              </span>
              {continueContext.providerName && (
                <span className="text-xs text-gray-400 bg-port-card px-2 py-0.5 rounded">
                  {continueContext.providerName}
                </span>
              )}
            </div>
            <button
              onClick={() => setContinueContext(null)}
              className="p-1 text-gray-400 hover:text-white"
              title="Dismiss context"
              aria-label="Dismiss context"
            >
              <X size={16} />
            </button>
          </div>
          <div className="space-y-2 text-sm">
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Previous Prompt</div>
              <div className="text-gray-300 bg-port-card/50 rounded px-2 py-1 font-mono text-xs max-h-20 overflow-auto">
                {continueContext.prompt?.substring(0, 500)}{continueContext.prompt?.length > 500 ? '...' : ''}
              </div>
            </div>
            {continueContext.success === false && continueContext.error && (
              <div>
                <div className="text-xs text-port-error uppercase tracking-wide mb-1">Error</div>
                <div className="text-port-error/80 bg-port-error/10 rounded px-2 py-1 font-mono text-xs max-h-20 overflow-auto">
                  {continueContext.error}
                </div>
              </div>
            )}
            {continueContext.success === false && continueContext.suggestedFix && (
              <div>
                <div className="text-xs text-port-warning uppercase tracking-wide mb-1">Suggested Fix</div>
                <div className="text-gray-300 bg-port-warning/10 rounded px-2 py-1 text-xs max-h-20 overflow-auto">
                  {continueContext.suggestedFix}
                </div>
              </div>
            )}
            {continueContext.output && (
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Previous Output</div>
                <div className="text-gray-300 bg-port-card/50 rounded px-2 py-1 font-mono text-xs max-h-24 overflow-auto">
                  {continueContext.output?.substring(0, 800)}{continueContext.output?.length > 800 ? '...' : ''}
                </div>
              </div>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-3 italic">
            {continueContext.success === false
              ? 'Enter instructions to retry the task. The previous context and error will be included automatically.'
              : 'Enter your follow-up instructions below. The previous context will be included automatically.'}
          </div>
        </div>
      )}

      {/* Mode Toggle */}
      <div className="flex gap-2">
        <button
          onClick={() => setMode('ai')}
          className={`px-4 py-2 rounded-lg transition-colors ${
            mode === 'ai' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-400 hover:text-white'
          }`}
        >
          AI Assistant
        </button>
        <button
          onClick={() => setMode('command')}
          className={`px-4 py-2 rounded-lg transition-colors ${
            mode === 'command' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-400 hover:text-white'
          }`}
        >
          Shell Command
        </button>
      </div>

      {/* Configuration Row */}
      <div className="flex flex-wrap gap-3">
        {/* Workspace */}
        <select
          value={selectedAppId}
          onChange={(e) => setSelectedAppId(e.target.value)}
          className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        >
          {apps.map(app => (
            <option key={app.id} value={app.id}>{app.name}</option>
          ))}
        </select>

        {mode === 'ai' && (
          <>
            {/* Provider */}
            <select
              value={selectedProvider}
              onChange={(e) => {
                setSelectedProvider(e.target.value);
                const p = providers.find(p => p.id === e.target.value);
                setSelectedModel(p?.defaultModel || '');
              }}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            >
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>

            {/* Model */}
            {currentProvider?.models?.length > 0 && (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                {currentProvider.models.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}

            {/* Timeout */}
            <div className="flex items-center gap-2">
              <Clock size={16} className="text-gray-400" />
              <select
                value={timeout}
                onChange={(e) => setTimeout(Number(e.target.value))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value={5}>5 min</option>
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={60}>60 min</option>
              </select>
            </div>

            {/* Screenshot Upload */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 hover:text-white text-sm"
            >
              <Image size={16} />
              Add Screenshot
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
            />
          </>
        )}
      </div>

      {/* Screenshot Previews */}
      {mode === 'ai' && screenshots.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {screenshots.map(s => (
            <div key={s.id} className="relative group">
              <img
                src={s.preview}
                alt={s.filename}
                className="w-20 h-20 object-cover rounded-lg border border-port-border"
              />
              <button
                aria-label="Remove screenshot"
                onClick={() => removeScreenshot(s.id)}
                className="absolute -top-2 -right-2 w-5 h-5 bg-port-error rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input Area */}
      {mode === 'ai' ? (
        <div className="flex flex-col sm:flex-row gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what you want the AI to do..."
            rows={3}
            className="flex-1 px-3 sm:px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden resize-none text-sm sm:text-base"
          />
          {running ? (
            <button
              onClick={handleStop}
              className="px-6 py-3 bg-port-error hover:bg-port-error/80 text-white rounded-lg transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleRunAI}
              disabled={!prompt.trim() || !selectedProvider}
              className="px-6 py-3 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              Run
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !running && handleRunCommand()}
              placeholder="Enter command (e.g., npm run build)"
              className="flex-1 px-3 sm:px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white font-mono focus:border-port-accent focus:outline-hidden text-sm sm:text-base"
            />
            {running ? (
              <button
                onClick={handleStop}
                className="px-6 py-3 bg-port-error hover:bg-port-error/80 text-white rounded-lg transition-colors"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={handleRunCommand}
                disabled={!command.trim()}
                className="px-6 py-3 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                Run
              </button>
            )}
          </div>
          <div className="text-xs text-gray-500 break-words">
            Allowed: {allowedCommands.slice(0, 10).join(', ')}{allowedCommands.length > 10 ? `, +${allowedCommands.length - 10} more` : ''}
          </div>
        </>
      )}

      {/* Output */}
      <div className="space-y-1">
        <div className="text-xs text-gray-500">Output:</div>
        <div
          ref={outputRef}
          className="bg-port-bg border border-port-border rounded-lg p-3 sm:p-4 h-64 sm:h-80 overflow-auto font-mono text-xs sm:text-sm"
        >
          {output ? (
            <pre className="text-gray-300 whitespace-pre-wrap">{output}</pre>
          ) : (
            <div className="text-gray-500">Output will appear here...</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default RunnerPage;
