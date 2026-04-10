import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, RotateCcw, MessageSquarePlus } from 'lucide-react';
import * as api from '../services/api';
import { formatTime, formatRuntime } from '../utils/formatters';
import BrailleSpinner from '../components/BrailleSpinner';

export function RunsHistoryPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedDetails, setExpandedDetails] = useState({});
  const [sourceFilter, setSourceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const loadRuns = useCallback(async () => {
    setLoading(true);
    const data = await api.getRuns(100, 0, sourceFilter).catch(() => ({ runs: [] }));
    setRuns(data.runs || []);
    setLoading(false);
  }, [sourceFilter]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // Filter runs by source and status
  const filteredRuns = runs.filter(run => {
    // Source filter (already applied via API, but kept for client-side consistency)
    const matchesSource = sourceFilter === 'all' || run.source === sourceFilter;

    // Status filter
    let matchesStatus = true;
    if (statusFilter === 'success') matchesStatus = run.success === true;
    else if (statusFilter === 'running') matchesStatus = run.success === null;
    else if (statusFilter === 'failed') matchesStatus = run.success === false;

    return matchesSource && matchesStatus;
  });

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    await api.deleteRun(id);
    setRuns(prev => prev.filter(run => run.id !== id));
    if (expandedId === id) setExpandedId(null);
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
    return <div className="text-center py-8"><BrailleSpinner text="Loading runs history" /></div>;
  }

  const failedCount = runs.filter(r => r.success === false).length;

  const handleClearFailed = async () => {
    const result = await api.deleteFailedRuns().catch(() => null);
    if (result) {
      setRuns(prev => prev.filter(r => r.success !== false));
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

      {/* Status Filter */}
      <div className="flex flex-wrap gap-1.5 sm:gap-2">
        {[
          { value: 'all', label: 'All Status' },
          { value: 'success', label: 'Success' },
          { value: 'running', label: 'Running' },
          { value: 'failed', label: 'Failed' }
        ].map(filter => (
          <button
            key={filter.value}
            onClick={() => setStatusFilter(filter.value)}
            className={`px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg text-xs sm:text-sm font-medium transition-colors ${
              statusFilter === filter.value
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
        {filteredRuns.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            {runs.length === 0 ? 'No AI runs yet' : 'No runs match the selected filters'}
          </div>
        ) : (
          <div className="divide-y divide-port-border">
            {filteredRuns.map(run => (
              <div key={run.id}>
                <div
                  className="p-3 sm:p-4 hover:bg-port-border/20 cursor-pointer group"
                  onClick={() => toggleExpand(run.id)}
                  data-testid={`run-row-${run.id}`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <button
                        type="button"
                        className="text-gray-400 hover:text-white shrink-0"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpand(run.id);
                        }}
                        aria-label={expandedId === run.id ? 'Collapse run details' : 'Expand run details'}
                      >
                        <span className={`inline-block transition-transform ${expandedId === run.id ? 'rotate-90' : ''}`}>▶</span>
                      </button>
                      <span className="text-xl shrink-0">🤖</span>
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
                      <span className={`w-2 h-2 rounded-full shrink-0 ${run.success ? 'bg-port-success' : run.success === false ? 'bg-port-error' : 'bg-port-warning'}`} />
                      <span className="text-sm text-gray-500 shrink-0">{formatTime(run.startTime)}</span>
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
                      {/* Execution ID */}
                      <div className="mb-4">
                        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Execution ID</div>
                        <div className="flex items-center gap-2">
                          <code className="text-xs text-gray-400 font-mono select-all">{run.id}</code>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard?.writeText(run.id).catch(() => {});
                            }}
                            className="p-1 text-gray-500 hover:text-white transition-colors"
                            title="Copy execution ID"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          </button>
                        </div>
                      </div>

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

                      {/* Output - show for all completed runs */}
                      {run.success !== null && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Output</div>
                          <div className="bg-port-card border border-port-border rounded-lg p-3 max-h-64 overflow-auto">
                            <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-all">
                              {expandedDetails[run.id]?.output !== undefined
                                ? (expandedDetails[run.id].output || '(no output)')
                                : 'Loading output...'}
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

export default RunsHistoryPage;
