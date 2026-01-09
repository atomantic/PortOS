import { useState, useEffect, useRef, Fragment } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GitBranch, Plus, Minus, FileText, Clock, RefreshCw, Activity, Image, X, XCircle, Cpu, MemoryStick, Terminal, Trash2, MessageSquarePlus, Info, Save, Maximize2, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../services/api';
import socket from '../services/socket';
import { formatTime, formatRuntime } from '../utils/formatters';
import { processScreenshotUploads } from '../utils/fileUpload';

export function HistoryPage() {
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ action: '', success: '' });
  const [actions, setActions] = useState([]);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    loadData();
  }, [filter]);

  const loadData = async () => {
    setLoading(true);
    const [historyData, statsData, actionsData] = await Promise.all([
      api.getHistory({
        limit: 100,
        action: filter.action || undefined,
        success: filter.success !== '' ? filter.success === 'true' : undefined
      }).catch(() => ({ entries: [] })),
      api.getHistoryStats().catch(() => null),
      api.getHistoryActions().catch(() => [])
    ]);
    setHistory(historyData.entries || []);
    setStats(statsData);
    setActions(actionsData);
    setLoading(false);
  };

  const handleClear = async () => {
    await api.clearHistory();
    setConfirmingClear(false);
    loadData();
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    await api.deleteHistoryEntry(id);
    loadData();
  };

  const getActionIcon = (action) => {
    const icons = {
      start: '▶️',
      stop: '⏹️',
      restart: '🔄',
      command: '💻',
      scaffold: '🏗️',
      'ai-run': '🤖'
    };
    return icons[action] || '📋';
  };

  const toggleExpand = (id) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  if (loading) {
    return <div className="text-center py-8 text-gray-400">Loading history...</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Action History</h1>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-white">{stats.total}</div>
            <div className="text-sm text-gray-400">Total Actions</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-port-success">{stats.successRate}%</div>
            <div className="text-sm text-gray-400">Success Rate</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-white">{stats.last24h}</div>
            <div className="text-sm text-gray-400">Last 24h</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-white">{Object.keys(stats.byAction).length}</div>
            <div className="text-sm text-gray-400">Action Types</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 sm:items-center">
        <div className="flex flex-wrap gap-2 sm:gap-4">
          <select
            value={filter.action}
            onChange={(e) => setFilter(prev => ({ ...prev, action: e.target.value }))}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
          >
            <option value="">All Actions</option>
            {actions.map(action => (
              <option key={action} value={action}>{action}</option>
            ))}
          </select>

          <select
            value={filter.success}
            onChange={(e) => setFilter(prev => ({ ...prev, success: e.target.value }))}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
          >
            <option value="">All Results</option>
            <option value="true">Success</option>
            <option value="false">Failed</option>
          </select>
        </div>

        <div className="flex-1" />

        {confirmingClear ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">Clear all?</span>
            <button
              onClick={handleClear}
              className="px-3 py-1.5 bg-port-error/20 text-port-error hover:bg-port-error/30 rounded-lg transition-colors"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirmingClear(false)}
              className="px-3 py-1.5 text-gray-400 hover:text-white"
            >
              No
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingClear(true)}
            className="px-4 py-2 bg-port-error/20 text-port-error hover:bg-port-error/30 rounded-lg transition-colors"
          >
            Clear History
          </button>
        )}
      </div>

      {/* History List */}
      <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
        {history.length === 0 ? (
          <div className="text-center py-12 text-gray-500">No history entries</div>
        ) : (
          <div className="divide-y divide-port-border">
            {history.map(entry => (
              <div key={entry.id}>
                <div
                  className="p-3 sm:p-4 hover:bg-port-border/20 cursor-pointer group"
                  onClick={() => toggleExpand(entry.id)}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <button className="text-gray-400 hover:text-white flex-shrink-0">
                        <span className={`inline-block transition-transform ${expandedId === entry.id ? 'rotate-90' : ''}`}>▶</span>
                      </button>
                      <span className="text-xl flex-shrink-0">{getActionIcon(entry.action)}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium text-white">{entry.action}</span>
                          {entry.targetName && (
                            <span className="text-gray-400 text-sm sm:text-base">→ {entry.targetName}</span>
                          )}
                          {entry.details?.runtime && (
                            <span className="text-xs text-cyan-400 font-mono">{formatRuntime(entry.details.runtime)}</span>
                          )}
                        </div>
                        {entry.details?.command && (
                          <code className="text-xs text-gray-500 font-mono truncate block mt-1">{entry.details.command}</code>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 pl-8 sm:pl-0">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${entry.success ? 'bg-port-success' : 'bg-port-error'}`} />
                      <span className="text-sm text-gray-500 flex-shrink-0">{formatTime(entry.timestamp)}</span>
                      <button
                        onClick={(e) => handleDelete(entry.id, e)}
                        className="p-1 text-gray-500 hover:text-port-error transition-colors sm:opacity-0 sm:group-hover:opacity-100"
                        title="Delete entry"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded Details */}
                {expandedId === entry.id && (
                  <div className="px-4 pb-4 bg-port-bg border-t border-port-border">
                    <div className="pt-4 space-y-4">
                      {/* Metadata Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Timestamp</div>
                          <div className="text-gray-300">{new Date(entry.timestamp).toLocaleString()}</div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Status</div>
                          <div className={entry.success ? 'text-port-success' : 'text-port-error'}>
                            {entry.success ? 'Success' : 'Failed'}
                          </div>
                        </div>
                        {entry.details?.runtime && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Runtime</div>
                            <div className="text-cyan-400 font-mono">{formatRuntime(entry.details.runtime)}</div>
                          </div>
                        )}
                        {entry.details?.exitCode !== undefined && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Exit Code</div>
                            <div className={`font-mono ${entry.details.exitCode === 0 ? 'text-port-success' : 'text-port-error'}`}>
                              {entry.details.exitCode}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Command */}
                      {entry.details?.command && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Command</div>
                          <div className="bg-port-card border border-port-border rounded-lg p-3">
                            <code className="text-sm text-cyan-300 font-mono whitespace-pre-wrap break-all">
                              {entry.details.command}
                            </code>
                          </div>
                        </div>
                      )}

                      {/* Output */}
                      {entry.details?.output && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Output</div>
                          <div className="bg-port-card border border-port-border rounded-lg p-3 max-h-64 overflow-auto">
                            <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-all">
                              {entry.details.output}
                            </pre>
                          </div>
                        </div>
                      )}

                      {/* Error */}
                      {entry.error && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Error</div>
                          <div className="bg-port-error/10 border border-port-error/30 rounded-lg p-3">
                            <pre className="text-sm text-port-error font-mono whitespace-pre-wrap">
                              {entry.error}
                            </pre>
                          </div>
                        </div>
                      )}

                      {/* Other Details */}
                      {entry.details && Object.keys(entry.details).filter(k => !['command', 'output', 'runtime', 'exitCode'].includes(k)).length > 0 && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Additional Details</div>
                          <div className="bg-port-card border border-port-border rounded-lg p-3">
                            <pre className="text-xs text-gray-400 font-mono whitespace-pre-wrap">
                              {JSON.stringify(
                                Object.fromEntries(
                                  Object.entries(entry.details).filter(([k]) => !['command', 'output', 'runtime', 'exitCode'].includes(k))
                                ),
                                null,
                                2
                              )}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function RunsHistoryPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedDetails, setExpandedDetails] = useState({});
  const [sourceFilter, setSourceFilter] = useState('all');

  useEffect(() => {
    loadRuns();
  }, [sourceFilter]);

  const loadRuns = async () => {
    setLoading(true);
    const data = await api.getRuns(100, 0, sourceFilter).catch(() => ({ runs: [] }));
    setRuns(data.runs || []);
    setLoading(false);
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    await api.deleteRun(id);
    loadRuns();
  };

  const toggleExpand = async (id) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }

    setExpandedId(id);

    // Load full prompt and output if not already loaded
    if (!expandedDetails[id]) {
      const [prompt, output] = await Promise.all([
        api.getRunPrompt(id).catch(() => ''),
        api.getRunOutput(id).catch(() => '')
      ]);
      setExpandedDetails(prev => ({
        ...prev,
        [id]: { prompt, output }
      }));
    }
  };

  const handleContinue = (run) => {
    const details = expandedDetails[run.id] || {};
    navigate('/devtools/runner', {
      state: {
        continueFrom: {
          prompt: details.prompt || run.prompt,
          output: details.output || '',
          runId: run.id,
          providerId: run.providerId,
          providerName: run.providerName,
          model: run.model,
          workspacePath: run.workspacePath,
          workspaceName: run.workspaceName
        }
      }
    });
  };

  const handleResume = async (run, e) => {
    e.stopPropagation();
    // Fetch details if not already loaded
    let details = expandedDetails[run.id];
    if (!details) {
      const [prompt, output] = await Promise.all([
        api.getRunPrompt(run.id).catch(() => ''),
        api.getRunOutput(run.id).catch(() => '')
      ]);
      details = { prompt, output };
    }
    navigate('/devtools/runner', {
      state: {
        continueFrom: {
          prompt: details.prompt || run.prompt,
          output: details.output || '',
          runId: run.id,
          providerId: run.providerId,
          providerName: run.providerName,
          model: run.model,
          workspacePath: run.workspacePath,
          workspaceName: run.workspaceName,
          error: run.error,
          errorCategory: run.errorCategory,
          suggestedFix: run.suggestedFix,
          success: run.success
        }
      }
    });
  };

  const getExitCodeInfo = (exitCode) => {
    const codeInfo = {
      1: { label: 'Error', description: 'Generic error - check the output for details' },
      2: { label: 'Misuse', description: 'Incorrect command usage or invalid arguments' },
      126: { label: 'Not Executable', description: 'Command found but not executable' },
      127: { label: 'Not Found', description: 'Command not found - check if CLI is installed' },
      128: { label: 'Invalid Exit', description: 'Invalid exit argument' },
      130: { label: 'Interrupted', description: 'Process interrupted (Ctrl+C / SIGINT)' },
      137: { label: 'Killed', description: 'Process killed (SIGKILL) - likely out of memory' },
      143: { label: 'Terminated', description: 'Process terminated (SIGTERM) - likely hit timeout' }
    };
    return codeInfo[exitCode] || { label: 'Unknown', description: `Exit code ${exitCode}` };
  };

  if (loading) {
    return <div className="text-center py-8 text-gray-400">Loading runs history...</div>;
  }

  const failedCount = runs.filter(r => r.success === false).length;

  const handleClearFailed = async () => {
    const result = await api.deleteFailedRuns().catch(() => null);
    if (result) {
      loadRuns();
    }
  };

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-lg sm:text-2xl font-bold text-white">AI Runs History</h1>
        {failedCount > 0 && (
          <button
            onClick={handleClearFailed}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-error/20 hover:bg-port-error/30 text-port-error rounded-lg transition-colors self-end sm:self-auto"
          >
            <Trash2 size={14} />
            Clear Failed ({failedCount})
          </button>
        )}
      </div>

      {/* Source Filter */}
      <div className="flex flex-wrap gap-1.5 sm:gap-2">
        {[
          { value: 'all', label: 'All' },
          { value: 'devtools', label: 'DevTools' },
          { value: 'cos-agent', label: 'CoS' }
        ].map(filter => (
          <button
            key={filter.value}
            onClick={() => setSourceFilter(filter.value)}
            className={`px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors ${
              sourceFilter === filter.value
                ? 'bg-port-accent text-white'
                : 'bg-port-card text-gray-400 hover:text-white border border-port-border'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {/* Runs List */}
      <div className="bg-port-card border border-port-border rounded-lg sm:rounded-xl overflow-hidden">
        {runs.length === 0 ? (
          <div className="text-center py-12 text-gray-500">No AI runs yet</div>
        ) : (
          <div className="divide-y divide-port-border">
            {runs.map(run => (
              <div key={run.id}>
                <div
                  className="p-3 sm:p-4 hover:bg-port-border/20 cursor-pointer group"
                  onClick={() => toggleExpand(run.id)}
                  data-testid={`run-row-${run.id}`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <button className="text-gray-400 hover:text-white flex-shrink-0">
                        <span className={`inline-block transition-transform ${expandedId === run.id ? 'rotate-90' : ''}`}>▶</span>
                      </button>
                      <span className="text-xl flex-shrink-0">🤖</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium text-white">{run.providerName}</span>
                          <span className="text-gray-500 text-sm">{run.model}</span>
                          {run.source === 'cos-agent' && (
                            <span className="text-xs text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">
                              CoS
                            </span>
                          )}
                          {run.workspaceName && (
                            <span className="text-xs text-port-accent bg-port-accent/10 px-2 py-0.5 rounded">
                              {run.workspaceName}
                            </span>
                          )}
                          {run.duration && (
                            <span className="text-xs text-cyan-400 font-mono">{formatRuntime(run.duration)}</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500 font-mono truncate mt-1">
                          {run.prompt?.substring(0, 100)}{run.prompt?.length > 100 ? '...' : ''}
                        </div>
                        {/* Show error preview for failed runs in collapsed view */}
                        {run.success === false && expandedId !== run.id && (
                          <div className="text-xs text-port-error/80 font-mono truncate mt-1">
                            ⚠ {run.error
                              ? (() => {
                                  const firstLine = run.error.split('\n')[0] || '';
                                  return `${firstLine.substring(0, 80)}${firstLine.length > 80 ? '...' : ''}`;
                                })()
                              : run.errorCategory && run.errorCategory !== 'unknown'
                                ? `${run.errorCategory}: ${run.suggestedFix || 'See details'}`
                                : `${getExitCodeInfo(run.exitCode).label}: ${getExitCodeInfo(run.exitCode).description}`}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 pl-8 sm:pl-0">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${run.success ? 'bg-port-success' : run.success === false ? 'bg-port-error' : 'bg-port-warning'}`} />
                      <span className="text-sm text-gray-500 flex-shrink-0">{formatTime(run.startTime)}</span>
                      {run.success !== null && (
                        <button
                          onClick={(e) => handleResume(run, e)}
                          className="p-1 text-gray-500 hover:text-port-accent transition-colors sm:opacity-0 sm:group-hover:opacity-100"
                          title="Resume run"
                          data-testid={`resume-run-${run.id}`}
                        >
                          <RotateCcw size={14} />
                        </button>
                      )}
                      <button
                        onClick={(e) => handleDelete(run.id, e)}
                        className="p-1 text-gray-500 hover:text-port-error transition-colors sm:opacity-0 sm:group-hover:opacity-100"
                        title="Delete run"
                        data-testid={`delete-run-${run.id}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded Details */}
                {expandedId === run.id && (
                  <div className="px-4 pb-4 bg-port-bg border-t border-port-border">
                    <div className="pt-4 space-y-4">
                      {/* Metadata Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 text-sm">
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Started</div>
                          <div className="text-gray-300">{new Date(run.startTime).toLocaleString()}</div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Status</div>
                          <div className={run.success ? 'text-port-success' : run.success === false ? 'text-port-error' : 'text-port-warning'}>
                            {run.success ? 'Success' : run.success === false ? 'Failed' : 'Running'}
                          </div>
                        </div>
                        {run.duration && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Duration</div>
                            <div className="text-cyan-400 font-mono">{formatRuntime(run.duration)}</div>
                          </div>
                        )}
                        {run.exitCode !== undefined && run.exitCode !== null && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Exit Code</div>
                            <div className={`font-mono ${run.exitCode === 0 ? 'text-port-success' : 'text-port-error'}`}>
                              {run.exitCode}
                            </div>
                          </div>
                        )}
                        {run.outputSize && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Output Size</div>
                            <div className="text-gray-300 font-mono">{(run.outputSize / 1024).toFixed(1)} KB</div>
                          </div>
                        )}
                      </div>

                      {/* Prompt */}
                      <div>
                        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Prompt</div>
                        <div className="bg-port-card border border-port-border rounded-lg p-3 max-h-48 overflow-auto">
                          <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap break-all">
                            {expandedDetails[run.id]?.prompt || run.prompt || 'Loading...'}
                          </pre>
                        </div>
                      </div>

                      {/* Output - show for successful runs with output OR for failed runs */}
                      {(expandedDetails[run.id]?.output || run.success === false) && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Output</div>
                          <div className="bg-port-card border border-port-border rounded-lg p-3 max-h-64 overflow-auto">
                            <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-all">
                              {expandedDetails[run.id]?.output || (run.success === false ? 'Loading output...' : '')}
                            </pre>
                          </div>
                        </div>
                      )}

                      {/* Error - show for failed runs with error message OR exit code */}
                      {(run.error || (run.success === false && run.exitCode !== 0)) && (() => {
                        const exitInfo = getExitCodeInfo(run.exitCode);
                        return (
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                              Error
                              {run.exitCode !== undefined && run.exitCode !== null && run.exitCode !== 0 && (
                                <span className="text-port-error/70">(exit code: {run.exitCode})</span>
                              )}
                              {run.errorCategory && run.errorCategory !== 'unknown' ? (
                                <span className="px-1.5 py-0.5 bg-port-error/20 text-port-error/80 rounded text-xs">
                                  {run.errorCategory}
                                </span>
                              ) : run.exitCode !== 0 && exitInfo.label !== 'Unknown' && (
                                <span className="px-1.5 py-0.5 bg-port-error/20 text-port-error/80 rounded text-xs">
                                  {exitInfo.label}
                                </span>
                              )}
                            </div>
                            <div className="bg-port-error/10 border border-port-error/30 rounded-lg p-3">
                              <pre className="text-sm text-port-error font-mono whitespace-pre-wrap break-all">
                                {run.error || exitInfo.description}
                              </pre>
                            </div>
                            {/* Show additional error details if available and different from error */}
                            {run.errorDetails && run.errorDetails !== run.error && (
                              <div className="mt-2 bg-port-error/5 border border-port-error/20 rounded-lg p-3">
                                <div className="text-xs text-gray-500 mb-1">Additional Details</div>
                                <pre className="text-xs text-port-error/80 font-mono whitespace-pre-wrap break-all">
                                  {run.errorDetails}
                                </pre>
                              </div>
                            )}
                            {/* Show suggested fix if available, or fallback to exit code info */}
                            {(run.suggestedFix || (!run.error && exitInfo.description)) && (
                              <div className="mt-2 bg-port-warning/10 border border-port-warning/30 rounded-lg p-3">
                                <div className="text-xs text-port-warning mb-1 font-medium">Suggested Fix</div>
                                <div className="text-sm text-gray-300">
                                  {run.suggestedFix || 'Check the output above for specific error details. If the output is empty, the process may have been terminated before producing output.'}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Continue Button */}
                      {run.success && expandedDetails[run.id]?.output && (
                        <div className="flex justify-end pt-2">
                          <button
                            onClick={() => handleContinue(run)}
                            className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
                            data-testid="continue-conversation-btn"
                          >
                            <MessageSquarePlus size={16} />
                            Continue Conversation
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function RunnerPage() {
  const location = useLocation();
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

  // Get the selected app's repoPath
  const selectedApp = apps.find(a => a.id === selectedAppId);
  const workspacePath = selectedApp?.repoPath || '';

  // Handle continuation context from navigation
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
      // Set workspace from previous run if available
      if (continueFrom.workspacePath) {
        const app = apps.find(a => a.repoPath === continueFrom.workspacePath);
        if (app) {
          setSelectedAppId(app.id);
        }
      }
      // Clear location state to prevent re-triggering on refresh
      window.history.replaceState({}, document.title);
    }
  }, [location.state, apps]);

  useEffect(() => {
    Promise.all([
      api.getApps().catch(() => []),
      api.getProviders().catch(() => ({ providers: [] })),
      api.getAllowedCommands().catch(() => [])
    ]).then(([appsData, providersRes, cmds]) => {
      // Filter out PortOS Autofixer (it's part of PortOS project)
      const filteredApps = appsData.filter(a => a.id !== 'portos-autofixer');
      setApps(filteredApps);
      // Set PortOS as default workspace (exact name match)
      const portosApp = filteredApps.find(a => a.name === 'PortOS');
      if (portosApp) {
        setSelectedAppId(portosApp.id);
      } else if (filteredApps.length > 0) {
        setSelectedAppId(filteredApps[0].id);
      }
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
      timeout: timeout * 60 * 1000 // Convert minutes to milliseconds
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
              className="hidden"
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
                onClick={() => removeScreenshot(s.id)}
                className="absolute -top-2 -right-2 w-5 h-5 bg-port-error rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
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
            className="flex-1 px-3 sm:px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none resize-none text-sm sm:text-base"
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
              className="flex-1 px-3 sm:px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white font-mono focus:border-port-accent focus:outline-none text-sm sm:text-base"
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

export function ProcessesPage() {
  const [processes, setProcesses] = useState([]);
  const [managedProcessNames, setManagedProcessNames] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [expandedProcess, setExpandedProcess] = useState(null);
  const [logs, setLogs] = useState([]);
  const [restarting, setRestarting] = useState({});
  const [tailLines, setTailLines] = useState(500);
  const [subscribed, setSubscribed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const logsRef = useRef(null);
  const fullscreenLogsRef = useRef(null);

  useEffect(() => {
    loadProcesses();
    loadManagedProcessNames();
    const interval = setInterval(loadProcesses, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadManagedProcessNames = async () => {
    const apps = await api.getApps().catch(() => []);
    const names = new Set();
    apps.forEach(app => {
      (app.pm2ProcessNames || []).forEach(name => names.add(name));
    });
    setManagedProcessNames(names);
  };

  const isPortOSManaged = (procName) => {
    if (procName.startsWith('portos-')) return true;
    return managedProcessNames.has(procName);
  };

  useEffect(() => {
    if (!expandedProcess) {
      setLogs([]);
      setSubscribed(false);
      return;
    }

    // Subscribe to logs via socket
    socket.emit('logs:subscribe', { processName: expandedProcess, lines: tailLines });

    const handleLog = (data) => {
      if (data.processName === expandedProcess) {
        setLogs(prev => [...prev.slice(-1000), {
          line: data.line,
          type: data.type,
          timestamp: data.timestamp
        }]);
        setTimeout(() => {
          if (logsRef.current) {
            logsRef.current.scrollTop = logsRef.current.scrollHeight;
          }
          if (fullscreenLogsRef.current) {
            fullscreenLogsRef.current.scrollTop = fullscreenLogsRef.current.scrollHeight;
          }
        }, 10);
      }
    };

    const handleSubscribed = (data) => {
      if (data.processName === expandedProcess) {
        setSubscribed(true);
      }
    };

    const handleError = (data) => {
      if (data.processName === expandedProcess) {
        setLogs(prev => [...prev, { line: `Error: ${data.error}`, type: 'stderr', timestamp: Date.now() }]);
      }
    };

    socket.on('logs:line', handleLog);
    socket.on('logs:subscribed', handleSubscribed);
    socket.on('logs:error', handleError);

    return () => {
      socket.emit('logs:unsubscribe', { processName: expandedProcess });
      socket.off('logs:line', handleLog);
      socket.off('logs:subscribed', handleSubscribed);
      socket.off('logs:error', handleError);
    };
  }, [expandedProcess, tailLines]);

  const loadProcesses = async () => {
    const data = await api.getProcessesList().catch(() => []);
    setProcesses(data);
    setLoading(false);
  };

  const handleRestart = async (name) => {
    setRestarting(prev => ({ ...prev, [name]: true }));
    await fetch('/api/commands/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `pm2 restart ${name}` })
    }).catch(() => null);
    setTimeout(() => {
      setRestarting(prev => ({ ...prev, [name]: false }));
      loadProcesses();
    }, 2000);
  };

  const handleStop = async (name) => {
    setRestarting(prev => ({ ...prev, [name]: true }));
    await fetch('/api/commands/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `pm2 stop ${name}` })
    }).catch(() => null);
    setTimeout(() => {
      setRestarting(prev => ({ ...prev, [name]: false }));
      loadProcesses();
    }, 2000);
  };

  const handleStart = async (name) => {
    setRestarting(prev => ({ ...prev, [name]: true }));
    await fetch('/api/commands/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `pm2 start ${name}` })
    }).catch(() => null);
    setTimeout(() => {
      setRestarting(prev => ({ ...prev, [name]: false }));
      loadProcesses();
    }, 2000);
  };

  const toggleExpand = (name) => {
    setExpandedProcess(prev => prev === name ? null : name);
    setLogs([]);
  };

  const handlePm2Save = async () => {
    setSaving(true);
    const result = await fetch('/api/commands/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'pm2 save' })
    }).then(r => r.json()).catch(() => ({ success: false }));
    setSaving(false);
    if (result.success) {
      toast.success('PM2 process list saved to startup');
    } else {
      toast.error('Failed to save PM2 process list');
    }
  };

  // Filter to only show PortOS-managed processes
  const managedProcesses = processes.filter(proc => isPortOSManaged(proc.name));

  const formatMemory = (bytes) => {
    if (!bytes) return '0 MB';
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatUptime = (ms) => {
    if (!ms) return '-';
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (hours > 24) {
      return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    }
    return `${hours}h ${mins}m`;
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'online': return 'bg-port-success';
      case 'stopped': return 'bg-gray-500';
      case 'errored': return 'bg-port-error';
      default: return 'bg-port-warning';
    }
  };

  if (loading) {
    return <div className="text-center py-8 text-gray-400">Loading processes...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">PM2 Processes</h1>
          <p className="text-gray-500 text-sm sm:text-base">PortOS-managed processes ({managedProcesses.length} of {processes.length} total)</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handlePm2Save}
            disabled={saving}
            className="px-3 sm:px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 text-sm sm:text-base"
          >
            <Save size={16} className={saving ? 'animate-pulse' : ''} />
            <span className="hidden sm:inline">{saving ? 'Saving...' : 'PM2 Save'}</span>
            <span className="sm:hidden">{saving ? '...' : 'Save'}</span>
          </button>
          <button
            onClick={loadProcesses}
            className="px-3 sm:px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors text-sm sm:text-base"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="bg-port-card border border-port-border rounded-xl overflow-hidden overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead className="bg-port-border/50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400 w-8"></th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Name</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Status</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">PID</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">CPU</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Memory</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Uptime</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Restarts</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-port-border">
            {managedProcesses.map(proc => (
              <Fragment key={proc.pm_id}>
                <tr className="hover:bg-port-border/20">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleExpand(proc.name)}
                      className="text-gray-400 hover:text-white transition-transform"
                    >
                      <span className={`inline-block transition-transform ${expandedProcess === proc.name ? 'rotate-90' : ''}`}>▶</span>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-medium text-white">{proc.name}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-2 px-2 py-1 rounded text-xs ${getStatusColor(proc.status)} bg-opacity-20`}>
                      <span className={`w-2 h-2 rounded-full ${getStatusColor(proc.status)}`} />
                      {proc.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 font-mono text-sm">{proc.pid || '-'}</td>
                  <td className="px-4 py-3 text-gray-400">{proc.cpu ? `${proc.cpu}%` : '-'}</td>
                  <td className="px-4 py-3 text-gray-400">{formatMemory(proc.memory)}</td>
                  <td className="px-4 py-3 text-gray-400">{formatUptime(proc.uptime)}</td>
                  <td className="px-4 py-3 text-gray-400">{proc.restarts}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      {proc.status === 'online' ? (
                        <>
                          <button
                            onClick={() => handleRestart(proc.name)}
                            disabled={restarting[proc.name]}
                            className="px-2 py-1 text-xs bg-port-warning/20 text-port-warning hover:bg-port-warning/30 rounded disabled:opacity-50"
                          >
                            {restarting[proc.name] ? '...' : 'Restart'}
                          </button>
                          <button
                            onClick={() => handleStop(proc.name)}
                            disabled={restarting[proc.name]}
                            className="px-2 py-1 text-xs bg-port-error/20 text-port-error hover:bg-port-error/30 rounded disabled:opacity-50"
                          >
                            Stop
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleStart(proc.name)}
                          disabled={restarting[proc.name]}
                          className="px-2 py-1 text-xs bg-port-success/20 text-port-success hover:bg-port-success/30 rounded disabled:opacity-50"
                        >
                          {restarting[proc.name] ? '...' : 'Start'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedProcess === proc.name && (
                  <tr>
                    <td colSpan={9} className="p-0">
                      <div className="bg-port-bg border-t border-port-border">
                        <div className="flex items-center justify-between px-4 py-2 border-b border-port-border">
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-gray-400">Live logs for {proc.name}</span>
                            {subscribed && (
                              <span className="text-xs text-port-success">● streaming</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-gray-500">Tail lines:</label>
                              <select
                                value={tailLines}
                                onChange={(e) => {
                                  setTailLines(Number(e.target.value));
                                  setLogs([]);
                                }}
                                className="px-2 py-1 text-xs bg-port-card border border-port-border rounded text-white"
                              >
                                <option value={100}>100</option>
                                <option value={250}>250</option>
                                <option value={500}>500</option>
                                <option value={1000}>1000</option>
                                <option value={2000}>2000</option>
                              </select>
                            </div>
                            <span className="text-xs text-gray-600">{logs.length} lines</span>
                            <button
                              onClick={() => setLogs([])}
                              className="text-xs text-gray-500 hover:text-white"
                            >
                              Clear
                            </button>
                            <button
                              onClick={() => setFullscreen(true)}
                              className="text-xs text-gray-500 hover:text-white flex items-center gap-1"
                              title="Fullscreen"
                            >
                              <Maximize2 size={12} />
                              Fullscreen
                            </button>
                          </div>
                        </div>
                        <div
                          ref={logsRef}
                          className="h-[32rem] overflow-auto p-3 font-mono text-xs"
                        >
                          {logs.length === 0 ? (
                            <div className="text-gray-500">
                              {subscribed ? 'No logs yet...' : 'Connecting to log stream...'}
                            </div>
                          ) : (
                            logs.map((log, i) => (
                              <div
                                key={i}
                                className={`py-0.5 ${log.type === 'stderr' ? 'text-port-error' : 'text-gray-300'}`}
                              >
                                <span className="text-gray-600 mr-2">
                                  {new Date(log.timestamp).toLocaleTimeString()}
                                </span>
                                {log.line}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {processes.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-gray-500">
                  No PM2 processes running
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Fullscreen Log Modal */}
      {fullscreen && expandedProcess && (
        <div className="fixed inset-0 bg-port-bg z-50 flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-port-border bg-port-card">
            <div className="flex items-center gap-4">
              <span className="text-lg font-medium text-white">Logs: {expandedProcess}</span>
              {subscribed && (
                <span className="text-sm text-port-success">● streaming</span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-500">Tail lines:</label>
                <select
                  value={tailLines}
                  onChange={(e) => {
                    setTailLines(Number(e.target.value));
                    setLogs([]);
                  }}
                  className="px-2 py-1 text-sm bg-port-bg border border-port-border rounded text-white"
                >
                  <option value={100}>100</option>
                  <option value={250}>250</option>
                  <option value={500}>500</option>
                  <option value={1000}>1000</option>
                  <option value={2000}>2000</option>
                </select>
              </div>
              <span className="text-sm text-gray-600">{logs.length} lines</span>
              <button
                onClick={() => setLogs([])}
                className="text-sm text-gray-500 hover:text-white"
              >
                Clear
              </button>
              <button
                onClick={() => setFullscreen(false)}
                className="p-2 text-gray-400 hover:text-white"
                title="Exit fullscreen"
              >
                <X size={20} />
              </button>
            </div>
          </div>
          <div
            ref={fullscreenLogsRef}
            className="flex-1 overflow-auto p-4 font-mono text-sm"
          >
            {logs.length === 0 ? (
              <div className="text-gray-500">
                {subscribed ? 'No logs yet...' : 'Connecting to log stream...'}
              </div>
            ) : (
              logs.map((log, i) => (
                <div
                  key={i}
                  className={`py-0.5 ${log.type === 'stderr' ? 'text-port-error' : 'text-gray-300'}`}
                >
                  <span className="text-gray-600 mr-3">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  {log.line}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function GitPage() {
  const [apps, setApps] = useState([]);
  const [selectedApp, setSelectedApp] = useState('');
  const [gitInfo, setGitInfo] = useState(null);
  const [diff, setDiff] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [loading, setLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    api.getApps().then(apps => {
      setApps(apps);
      if (apps.length > 0) {
        setSelectedApp(apps[0].repoPath);
      }
    }).catch(() => []);
  }, []);

  useEffect(() => {
    if (selectedApp) loadGitInfo();
  }, [selectedApp]);

  const loadGitInfo = async () => {
    if (!selectedApp) return;
    setLoading(true);
    const info = await api.getGitInfo(selectedApp).catch(() => null);
    setGitInfo(info);
    setLoading(false);
  };

  const loadDiff = async () => {
    if (!selectedApp) return;
    const result = await api.getGitDiff(selectedApp).catch(() => ({ diff: '' }));
    setDiff(result.diff || '');
    setShowDiff(true);
  };

  const handleStage = async (file) => {
    await api.stageFiles(selectedApp, [file]);
    await loadGitInfo();
  };

  const handleUnstage = async (file) => {
    await api.unstageFiles(selectedApp, [file]);
    await loadGitInfo();
  };

  const handleCommit = async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    await api.createCommit(selectedApp, commitMessage).catch(() => null);
    setCommitMessage('');
    setCommitting(false);
    await loadGitInfo();
  };

  const getStatusIcon = (file) => {
    if (file.added) return <Plus size={14} className="text-port-success" />;
    if (file.deleted) return <Minus size={14} className="text-port-error" />;
    return <FileText size={14} className="text-port-warning" />;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Git Status</h1>
        <div className="flex items-center gap-4">
          <select
            value={selectedApp}
            onChange={(e) => setSelectedApp(e.target.value)}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
          >
            {apps.map(app => (
              <option key={app.id} value={app.repoPath}>{app.name}</option>
            ))}
          </select>
          <button
            onClick={loadGitInfo}
            className="p-2 text-gray-400 hover:text-white"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-8 text-gray-400">Loading...</div>
      ) : gitInfo && gitInfo.isRepo ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Status Panel */}
          <div className="space-y-4">
            {/* Branch Info */}
            <div className="bg-port-card border border-port-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <GitBranch size={18} className="text-port-accent" />
                <span className="font-medium text-white">{gitInfo.branch}</span>
                {gitInfo.status?.clean && (
                  <span className="text-xs text-port-success px-2 py-0.5 bg-port-success/20 rounded">Clean</span>
                )}
              </div>
              <div className="flex gap-4 text-sm">
                <div className="text-gray-400">
                  <span className="text-port-success">+{gitInfo.diffStats?.insertions || 0}</span>
                  <span className="mx-1">/</span>
                  <span className="text-port-error">-{gitInfo.diffStats?.deletions || 0}</span>
                </div>
                <div className="text-gray-500">
                  {gitInfo.diffStats?.files || 0} files changed
                </div>
              </div>
            </div>

            {/* Changed Files */}
            <div className="bg-port-card border border-port-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-400">Changed Files</h3>
                <button
                  onClick={loadDiff}
                  className="text-xs text-port-accent hover:underline"
                >
                  View Diff
                </button>
              </div>
              <div className="space-y-1 max-h-64 overflow-auto">
                {gitInfo.status?.files?.map((file, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm py-1 group">
                    {getStatusIcon(file)}
                    <span className={`flex-1 font-mono text-xs ${file.staged ? 'text-port-success' : 'text-gray-300'}`}>
                      {file.path}
                    </span>
                    <span className="text-xs text-gray-500">{file.status}</span>
                    {file.staged ? (
                      <button
                        onClick={() => handleUnstage(file.path)}
                        className="opacity-0 group-hover:opacity-100 text-xs text-gray-400 hover:text-white"
                      >
                        Unstage
                      </button>
                    ) : (
                      <button
                        onClick={() => handleStage(file.path)}
                        className="opacity-0 group-hover:opacity-100 text-xs text-gray-400 hover:text-white"
                      >
                        Stage
                      </button>
                    )}
                  </div>
                ))}
                {(!gitInfo.status?.files || gitInfo.status.files.length === 0) && (
                  <div className="text-gray-500 text-sm">No changes</div>
                )}
              </div>
            </div>

            {/* Quick Commit */}
            {gitInfo.status?.staged > 0 && (
              <div className="bg-port-card border border-port-border rounded-xl p-4">
                <h3 className="text-sm font-medium text-gray-400 mb-2">Quick Commit</h3>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    placeholder="Commit message..."
                    className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  />
                  <button
                    onClick={handleCommit}
                    disabled={committing || !commitMessage.trim()}
                    className="px-4 py-2 bg-port-success hover:bg-port-success/80 text-white rounded-lg text-sm disabled:opacity-50"
                  >
                    Commit
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Recent Commits */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Recent Commits</h3>
            <div className="space-y-2">
              {gitInfo.recentCommits?.map((commit, i) => (
                <div key={i} className="py-2 border-b border-port-border last:border-0">
                  <div className="flex items-center gap-2">
                    <code className="text-xs text-port-accent">{commit.hash}</code>
                    <span className="text-sm text-white truncate">{commit.message}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {commit.author} • {new Date(commit.date).toLocaleDateString()}
                  </div>
                </div>
              ))}
              {(!gitInfo.recentCommits || gitInfo.recentCommits.length === 0) && (
                <div className="text-gray-500 text-sm">No commits</div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-port-card border border-port-border rounded-xl p-8 text-center text-gray-500">
          {gitInfo ? 'Not a git repository' : 'Select an app to view git status'}
        </div>
      )}

      {/* Diff Modal */}
      {showDiff && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDiff(false)}>
          <div className="bg-port-card border border-port-border rounded-xl w-3/4 max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-port-border">
              <h3 className="font-medium text-white">Git Diff</h3>
              <button onClick={() => setShowDiff(false)} className="text-gray-400 hover:text-white">×</button>
            </div>
            <pre className="p-4 overflow-auto max-h-[70vh] text-sm font-mono">
              {diff.split('\n').map((line, i) => {
                let color = 'text-gray-300';
                if (line.startsWith('+') && !line.startsWith('+++')) color = 'text-port-success';
                if (line.startsWith('-') && !line.startsWith('---')) color = 'text-port-error';
                if (line.startsWith('@@')) color = 'text-port-accent';
                return <div key={i} className={color}>{line}</div>;
              })}
              {!diff && <span className="text-gray-500">No changes to display</span>}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function UsagePage() {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUsage();
  }, []);

  const loadUsage = async () => {
    setLoading(true);
    const data = await api.getUsage().catch(() => null);
    setUsage(data);
    setLoading(false);
  };

  const formatNumber = (num) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return String(num);
  };

  if (loading) {
    return <div className="text-center py-8 text-gray-400">Loading usage data...</div>;
  }

  if (!usage) {
    return <div className="text-center py-8 text-gray-500">No usage data available</div>;
  }

  const maxActivity = Math.max(...(usage.last7Days?.map(d => d.sessions) || [1]));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Usage Metrics</h1>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(usage.totalSessions)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Sessions</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(usage.totalMessages)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Messages</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(usage.totalToolCalls)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Tool Calls</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(usage.totalTokens?.input + usage.totalTokens?.output)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Tokens</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center col-span-2 sm:col-span-1">
          <div className="text-xl sm:text-2xl font-bold text-port-success">${usage.estimatedCost?.toFixed(2)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Est. Cost</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
        {/* 7-Day Activity */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3 sm:mb-4">Last 7 Days</h3>
          <div className="flex items-end gap-1 sm:gap-2 h-24 sm:h-32">
            {usage.last7Days?.map((day, i) => (
              <div key={i} className="flex-1 flex flex-col items-center">
                <div
                  className="w-full bg-port-accent/60 rounded-t"
                  style={{ height: `${(day.sessions / maxActivity) * 100}%`, minHeight: day.sessions > 0 ? 4 : 0 }}
                />
                <div className="text-[10px] sm:text-xs text-gray-500 mt-1 sm:mt-2">{day.label}</div>
                <div className="text-[10px] sm:text-xs text-gray-400">{day.sessions}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Hourly Distribution */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3 sm:mb-4">Hourly Distribution</h3>
          <div className="flex items-end gap-0.5 h-24 sm:h-32">
            {usage.hourlyActivity?.map((count, hour) => {
              const maxHour = Math.max(...usage.hourlyActivity);
              return (
                <div key={hour} className="flex-1 flex flex-col items-center">
                  <div
                    className="w-full bg-port-accent/40 rounded-t"
                    style={{ height: `${(count / (maxHour || 1)) * 100}%`, minHeight: count > 0 ? 2 : 0 }}
                    title={`${hour}:00 - ${count} sessions`}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-[10px] sm:text-xs text-gray-500 mt-1 sm:mt-2">
            <span>12am</span>
            <span>6am</span>
            <span>12pm</span>
            <span>6pm</span>
            <span>12am</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
        {/* Top Providers */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-2 sm:mb-3">Top Providers</h3>
          <div className="space-y-1 sm:space-y-2">
            {usage.topProviders?.map((provider, i) => (
              <div key={i} className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-2 border-b border-port-border last:border-0 gap-1 sm:gap-0">
                <span className="text-white text-sm sm:text-base">{provider.name}</span>
                <div className="text-xs sm:text-sm text-gray-400">
                  <span>{provider.sessions} sessions</span>
                  <span className="mx-1 sm:mx-2">•</span>
                  <span>{formatNumber(provider.tokens)} tokens</span>
                </div>
              </div>
            ))}
            {(!usage.topProviders || usage.topProviders.length === 0) && (
              <div className="text-gray-500 text-sm">No provider data</div>
            )}
          </div>
        </div>

        {/* Top Models */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-2 sm:mb-3">Top Models</h3>
          <div className="space-y-1 sm:space-y-2">
            {usage.topModels?.map((model, i) => (
              <div key={i} className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-2 border-b border-port-border last:border-0 gap-1 sm:gap-0">
                <span className="text-white font-mono text-xs sm:text-sm truncate max-w-[200px] sm:max-w-none">{model.model}</span>
                <div className="text-xs sm:text-sm text-gray-400">
                  <span>{model.sessions} sessions</span>
                  <span className="mx-1 sm:mx-2">•</span>
                  <span>{formatNumber(model.tokens)} tokens</span>
                </div>
              </div>
            ))}
            {(!usage.topModels || usage.topModels.length === 0) && (
              <div className="text-gray-500 text-sm">No model data</div>
            )}
          </div>
        </div>
      </div>

      {/* Refresh button */}
      <div className="flex justify-end">
        <button
          onClick={loadUsage}
          className="flex items-center gap-2 px-4 py-2 text-gray-400 hover:text-white"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
    </div>
  );
}

export function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [killing, setKilling] = useState({});
  const [expandedPid, setExpandedPid] = useState(null);
  const REFRESH_INTERVAL = 3;

  useEffect(() => {
    loadAgents();
    const interval = setInterval(loadAgents, REFRESH_INTERVAL * 1000);
    return () => clearInterval(interval);
  }, []);

  const loadAgents = async () => {
    const data = await api.getAgents().catch(() => []);
    setAgents(data);
    setLoading(false);
  };

  const handleKill = async (pid) => {
    setKilling(prev => ({ ...prev, [pid]: true }));
    await api.killAgent(pid).catch(() => null);
    setTimeout(() => {
      setKilling(prev => ({ ...prev, [pid]: false }));
      loadAgents();
    }, 1000);
  };

  const toggleExpand = (pid) => {
    setExpandedPid(prev => prev === pid ? null : pid);
  };

  const formatStartTime = (timestamp) => {
    return new Date(timestamp).toLocaleString();
  };

  const totalCpu = agents.reduce((sum, a) => sum + (a.cpu || 0), 0);
  const totalMemory = agents.reduce((sum, a) => sum + (a.memory || 0), 0);

  if (loading) {
    return <div className="text-center py-8 text-gray-400">Scanning for AI agents...</div>;
  }

  return (
    <div className="space-y-4 lg:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 sm:gap-3">
          <Activity size={24} className="sm:w-7 sm:h-7 text-purple-400" />
          <h1 className="text-lg sm:text-2xl font-bold text-white font-mono">AI Agent Processes</h1>
          <span className="hidden sm:inline text-gray-500 text-sm">({REFRESH_INTERVAL}s)</span>
        </div>
        <button
          onClick={loadAgents}
          className="flex items-center justify-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 bg-port-card border border-port-border hover:border-gray-500 text-white text-sm rounded-lg transition-colors"
        >
          <RefreshCw size={14} className="sm:w-4 sm:h-4" />
          <span className="sm:inline">Refresh</span>
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <div className="bg-port-card border border-port-border rounded-lg sm:rounded-xl p-2 sm:p-5 flex items-center justify-between">
          <div>
            <div className="text-gray-400 text-[10px] sm:text-sm mb-0.5 sm:mb-1">Processes</div>
            <div className="text-lg sm:text-3xl font-bold text-white font-mono">{agents.length}</div>
          </div>
          <Terminal size={20} className="sm:w-8 sm:h-8 text-purple-400" />
        </div>
        <div className="bg-port-card border border-port-border rounded-lg sm:rounded-xl p-2 sm:p-5 flex items-center justify-between">
          <div>
            <div className="text-gray-400 text-[10px] sm:text-sm mb-0.5 sm:mb-1">CPU</div>
            <div className="text-lg sm:text-3xl font-bold text-white font-mono">{totalCpu.toFixed(1)}%</div>
          </div>
          <Cpu size={20} className="sm:w-8 sm:h-8 text-blue-400" />
        </div>
        <div className="bg-port-card border border-port-border rounded-lg sm:rounded-xl p-2 sm:p-5 flex items-center justify-between">
          <div>
            <div className="text-gray-400 text-[10px] sm:text-sm mb-0.5 sm:mb-1">Memory</div>
            <div className="text-lg sm:text-3xl font-bold text-white font-mono">{totalMemory.toFixed(1)}%</div>
          </div>
          <MemoryStick size={20} className="sm:w-8 sm:h-8 text-green-400" />
        </div>
      </div>

      {/* Running Processes */}
      <div className="bg-port-card border border-port-border rounded-lg sm:rounded-xl">
        <div className="px-3 sm:px-6 py-3 sm:py-4 border-b border-port-border">
          <h2 className="text-base sm:text-lg font-semibold text-white">Running Processes</h2>
        </div>

        {/* Mobile Card View */}
        <div className="sm:hidden divide-y divide-port-border">
          {agents.map(agent => (
            <div key={agent.pid} className="p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-white text-sm">{agent.agentName.toLowerCase()}</span>
                  {agent.source === 'cos' && (
                    <span className="px-1.5 py-0.5 text-[10px] bg-purple-500/20 text-purple-400 rounded">CoS</span>
                  )}
                </div>
                <button
                  onClick={() => handleKill(agent.pid)}
                  disabled={killing[agent.pid]}
                  className="text-red-400 hover:text-red-300 disabled:opacity-50 p-1"
                >
                  <XCircle size={18} className={killing[agent.pid] ? 'animate-pulse' : ''} />
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2 text-xs">
                <div>
                  <div className="text-gray-500">PID</div>
                  <div className="font-mono text-white">{agent.pid}</div>
                </div>
                <div>
                  <div className="text-gray-500">Time</div>
                  <div className="font-mono text-cyan-400">{agent.runtimeFormatted}</div>
                </div>
                <div>
                  <div className="text-gray-500">CPU</div>
                  <div className="font-mono text-green-400">{agent.cpu?.toFixed(1)}%</div>
                </div>
                <div>
                  <div className="text-gray-500">Mem</div>
                  <div className="font-mono text-blue-400">{agent.memory?.toFixed(1)}%</div>
                </div>
              </div>
              <button
                onClick={() => toggleExpand(agent.pid)}
                className="mt-2 text-xs text-gray-500 hover:text-white flex items-center gap-1"
              >
                <span className={`inline-block transition-transform ${expandedPid === agent.pid ? 'rotate-90' : ''}`}>▶</span>
                {expandedPid === agent.pid ? 'Hide details' : 'Show details'}
              </button>
              {expandedPid === agent.pid && (
                <div className="mt-3 pt-3 border-t border-port-border space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-gray-500 uppercase tracking-wide mb-0.5">Agent Type</div>
                      <div className="text-purple-400">{agent.agentName}</div>
                    </div>
                    <div>
                      <div className="text-gray-500 uppercase tracking-wide mb-0.5">Parent PID</div>
                      <div className="text-gray-300 font-mono">{agent.ppid}</div>
                    </div>
                    {agent.model && (
                      <div>
                        <div className="text-gray-500 uppercase tracking-wide mb-0.5">Model</div>
                        <div className="text-yellow-400 font-mono">{agent.model}</div>
                      </div>
                    )}
                    {agent.taskId && (
                      <div>
                        <div className="text-gray-500 uppercase tracking-wide mb-0.5">Task ID</div>
                        <div className="text-gray-300 font-mono truncate">{agent.taskId}</div>
                      </div>
                    )}
                  </div>
                  {agent.prompt && (
                    <div>
                      <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Task</div>
                      <div className="bg-port-bg border border-port-border rounded p-2 text-xs text-gray-300 line-clamp-3">
                        {agent.prompt}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {agents.length === 0 && (
            <div className="px-3 py-8 text-center text-gray-500 text-sm">
              No AI agents currently running
            </div>
          )}
        </div>

        {/* Desktop Table View */}
        <div className="hidden sm:block overflow-x-auto">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr className="border-b border-port-border">
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400 w-8"></th>
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400">PID</th>
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400">Runtime</th>
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400">CPU %</th>
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400">Memory %</th>
              <th className="px-4 py-4 text-left text-sm font-semibold text-gray-400">Command</th>
              <th className="px-4 py-4 text-center text-sm font-semibold text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody>
            {agents.map(agent => (
              <Fragment key={agent.pid}>
                <tr className="border-b border-port-border/50 hover:bg-port-border/20">
                  <td className="px-4 py-4">
                    <button
                      onClick={() => toggleExpand(agent.pid)}
                      className="text-gray-400 hover:text-white transition-transform"
                    >
                      <span className={`inline-block transition-transform ${expandedPid === agent.pid ? 'rotate-90' : ''}`}>▶</span>
                    </button>
                  </td>
                  <td className="px-4 py-4 font-mono text-white">{agent.pid}</td>
                  <td className="px-4 py-4 font-mono text-cyan-400">{agent.runtimeFormatted}</td>
                  <td className="px-4 py-4 font-mono text-green-400">{agent.cpu?.toFixed(1)}%</td>
                  <td className="px-4 py-4 font-mono text-blue-400">{agent.memory?.toFixed(1)}%</td>
                  <td className="px-4 py-4 font-mono text-gray-300">
                    {agent.agentName.toLowerCase()}
                    {agent.source === 'cos' && (
                      <span className="ml-2 px-1.5 py-0.5 text-[10px] bg-purple-500/20 text-purple-400 rounded">CoS</span>
                    )}
                  </td>
                  <td className="px-4 py-4 text-center">
                    <button
                      onClick={() => handleKill(agent.pid)}
                      disabled={killing[agent.pid]}
                      className="text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
                      title="Kill process"
                    >
                      <XCircle size={22} className={killing[agent.pid] ? 'animate-pulse' : ''} />
                    </button>
                  </td>
                </tr>
                {expandedPid === agent.pid && (
                  <tr>
                    <td colSpan={7} className="p-0">
                      <div className="bg-port-bg border-t border-port-border">
                        <div className="px-3 sm:px-6 py-4 space-y-4">
                          {/* Process Details Grid */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Agent Type</div>
                              <div className="text-sm text-purple-400 font-medium">
                                {agent.agentName}
                                {agent.source === 'cos' && <span className="ml-1 text-xs text-purple-300">(CoS)</span>}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Parent PID</div>
                              <div className="text-sm text-gray-300 font-mono">{agent.ppid}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Started At</div>
                              <div className="text-sm text-gray-300">{formatStartTime(agent.startTime)}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Runtime (ms)</div>
                              <div className="text-sm text-gray-300 font-mono">{agent.runtime?.toLocaleString()}</div>
                            </div>
                            {agent.model && (
                              <div>
                                <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Model</div>
                                <div className="text-sm text-yellow-400 font-mono">{agent.model}</div>
                              </div>
                            )}
                            {agent.agentId && (
                              <div>
                                <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Agent ID</div>
                                <div className="text-sm text-gray-300 font-mono">{agent.agentId}</div>
                              </div>
                            )}
                            {agent.taskId && (
                              <div>
                                <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Task ID</div>
                                <div className="text-sm text-gray-300 font-mono">{agent.taskId}</div>
                              </div>
                            )}
                            {agent.workspacePath && (
                              <div>
                                <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Workspace</div>
                                <div className="text-sm text-gray-300 font-mono truncate" title={agent.workspacePath}>
                                  {agent.workspacePath.split('/').pop()}
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Full Command */}
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Full Command</div>
                            <div className="bg-port-card border border-port-border rounded-lg p-3 overflow-x-auto">
                              <code className="text-sm text-cyan-300 font-mono whitespace-pre-wrap break-all">
                                {agent.command}
                              </code>
                            </div>
                          </div>

                          {/* Task Prompt (for CoS agents) */}
                          {agent.prompt && (
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Task Prompt</div>
                              <div className="bg-port-card border border-port-border rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto">
                                <p className="text-sm text-gray-300 whitespace-pre-wrap">
                                  {agent.prompt}
                                </p>
                              </div>
                            </div>
                          )}

                          {/* Resource Usage Bar */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <div className="flex items-center justify-between text-xs mb-1">
                                <span className="text-gray-500 uppercase tracking-wide">CPU Usage</span>
                                <span className="text-green-400 font-mono">{agent.cpu?.toFixed(1)}%</span>
                              </div>
                              <div className="h-2 bg-port-border rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-green-500 rounded-full transition-all"
                                  style={{ width: `${Math.min(agent.cpu || 0, 100)}%` }}
                                />
                              </div>
                            </div>
                            <div>
                              <div className="flex items-center justify-between text-xs mb-1">
                                <span className="text-gray-500 uppercase tracking-wide">Memory Usage</span>
                                <span className="text-blue-400 font-mono">{agent.memory?.toFixed(1)}%</span>
                              </div>
                              <div className="h-2 bg-port-border rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-blue-500 rounded-full transition-all"
                                  style={{ width: `${Math.min(agent.memory || 0, 100)}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {agents.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                  No AI agents currently running
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
