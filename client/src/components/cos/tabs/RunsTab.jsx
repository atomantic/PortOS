import ExecutionOptionsAttribution from '../../providers/ExecutionOptionsAttribution.jsx';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Trash2, RotateCcw, ScrollText, Square } from 'lucide-react';
import * as api from '../../../services/api';
import { formatTime, formatRuntime, formatBytes, formatDateTime } from '../../../utils/formatters';
import BrailleSpinner from '../../BrailleSpinner';
import Banner from '../../ui/Banner';
import ListLoadError from '../../ui/ListLoadError';
import useListResource from '../../../hooks/useListResource';
import ProcessLogModal from '../../ui/ProcessLogModal';
import { writeClipboardSilently } from '../../../lib/clipboard';
import { clickableProps, onActivateKeyDown } from '../../../lib/a11yKeyboard.js';

// Map an AI run's source to the PM2 process whose system log holds the full
// context for that run. CoS-agent runs are driven by the `portos-cos` process;
// everything else (DevTools runs) is driven by the main `portos-server`.
export function runLogProcessName(source) {
  return source === 'cos-agent' ? 'portos-cos' : 'portos-server';
}

export default function RunsTab() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const deepLinkRunId = searchParams.get('run');
  const [expandedId, setExpandedId] = useState(null);
  const [expandedDetails, setExpandedDetails] = useState({});
  const [sourceFilter, setSourceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [stoppingIds, setStoppingIds] = useState(() => new Set());
  // The failed run whose system logs are open in the log modal, or null.
  const [logModalRun, setLogModalRun] = useState(null);

  const fetchRuns = useCallback(
    () => api.getRuns(100, 0, sourceFilter, { silent: true }).then(data => data?.runs || []),
    [sourceFilter]
  );
  const { items: runs, state: runsState, error: runsError, retry: loadRuns, setItems: setRuns } = useListResource(fetchRuns);
  const loading = runsState === 'loading';

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
    const deleted = await api.deleteRun(id).catch(() => null);
    if (!deleted && deleted !== undefined) return;
    setRuns(prev => prev.filter(run => run.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  const handleStop = async (id, e) => {
    e.stopPropagation();
    setStoppingIds((prev) => new Set(prev).add(id));
    const stopped = await api.stopRun(id).then(() => true).catch(() => false);
    if (!stopped) {
      setStoppingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }
    // Completion metadata lands asynchronously after the child process exits;
    // refresh once so the row transitions from Running to its terminal state.
    await loadRuns();
    setStoppingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const expandRun = useCallback(async (id) => {
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
  }, [expandedDetails]);

  const toggleExpand = (id) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    expandRun(id);
  };

  // Open the run named by `?run=<id>` on entry — the Local LLM Playground links
  // straight at a run it just finished. One-shot: switching CoS tabs drops the
  // param, and the user stays free to collapse the row afterwards.
  const deepLinkOpened = useRef(false);
  useEffect(() => {
    if (deepLinkOpened.current || !deepLinkRunId || loading) return;
    if (!runs.some(run => run.id === deepLinkRunId)) return;
    deepLinkOpened.current = true;
    expandRun(deepLinkRunId);
  }, [deepLinkRunId, loading, runs, expandRun]);

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
    return (
      <div className="flex items-center justify-center py-12">
        <BrailleSpinner text="Loading runs" />
      </div>
    );
  }

  const failedCount = runs.filter(r => r.success === false).length;
  const logProc = logModalRun ? runLogProcessName(logModalRun.source) : '';

  const handleClearFailed = async () => {
    const ok = await api.deleteFailedRuns().then(() => true).catch(() => false);
    if (ok) {
      setRuns(prev => prev.filter(r => r.success !== false));
    }
  };

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="text-lg sm:text-xl font-bold text-white">Recent Runs</h2>
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
        {runsState === 'error' ? (
          <ListLoadError what="runs" error={runsError} onRetry={loadRuns} className="m-3" />
        ) : filteredRuns.length === 0 ? (
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
                  {...clickableProps(() => toggleExpand(run.id))}
                  onKeyDown={onActivateKeyDown(() => toggleExpand(run.id))}
                  data-testid={`run-row-${run.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                    <div className="flex items-center gap-3 flex-1 basis-64 min-w-0">
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
                          <ExecutionOptionsAttribution value={run.executionOptions} />
                          {run.source === 'cos-agent' && (
                            <span className="text-xs text-port-accent-2 bg-port-accent-2/10 px-2 py-0.5 rounded">
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
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 min-w-0">
                      <span className="inline-flex items-center gap-1.5 text-sm text-gray-400 shrink-0">
                        <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${run.success ? 'bg-port-success' : run.success === false ? 'bg-port-error' : 'bg-port-warning'}`} />
                        {run.success ? 'Succeeded' : run.success === false ? 'Failed' : 'Running'}
                      </span>
                      <span className="text-sm text-gray-500 shrink-0">{formatTime(run.startTime)}</span>
                      {run.success === false && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setLogModalRun(run); }}
                          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-accent transition-colors"
                          title="View system logs"
                          aria-label="View system logs"
                          data-testid={`view-logs-${run.id}`}
                        >
                          <ScrollText size={14} />
                        </button>
                      )}
                      {run.success !== null && (
                        <button
                          onClick={(e) => handleResume(run, e)}
                          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-accent transition-colors"
                          title="Resume run" aria-label="Resume run"
                          data-testid={`resume-run-${run.id}`}
                        >
                          <RotateCcw size={14} />
                        </button>
                      )}
                      {run.success === null && (
                        <button
                          onClick={(e) => handleStop(run.id, e)}
                          disabled={stoppingIds.has(run.id)}
                          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error transition-colors disabled:opacity-40"
                          title={stoppingIds.has(run.id) ? 'Stopping run' : 'Stop run'}
                          aria-label={stoppingIds.has(run.id) ? 'Stopping run' : 'Stop run'}
                          data-testid={`stop-run-${run.id}`}
                        >
                          <Square size={14} fill="currentColor" />
                        </button>
                      )}
                      <button
                        onClick={(e) => handleDelete(run.id, e)}
                        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error transition-colors"
                        title="Delete run" aria-label="Delete run"
                        data-testid={`delete-run-${run.id}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Failure guidance stays visible; only execution diagnostics collapse. */}
                {(run.error || run.success === false) && (() => {
                  const exitInfo = getExitCodeInfo(run.exitCode);
                  const hasExitCode = run.exitCode !== undefined && run.exitCode !== null && run.exitCode !== 0;
                  return (
                    <div className="px-3 pb-3 sm:px-4 sm:pb-4 min-w-0">
                      <Banner tone="error" size="md" title="Run failed" srLabel={false} role="note">
                        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {run.error || (hasExitCode ? exitInfo.description : 'This run did not complete successfully.')}
                        </p>
                        {run.suggestedFix && (
                          <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
                            <span className="font-medium">Suggested fix: </span>{run.suggestedFix}
                          </p>
                        )}
                      </Banner>
                    </div>
                  );
                })()}

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
                              writeClipboardSilently(run.id);
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
                          <div className="text-gray-300">{formatDateTime(run.startTime)}</div>
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
                        {run.errorCategory && run.errorCategory !== 'unknown' && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Failure category</div>
                            <div className="text-gray-300 [overflow-wrap:anywhere]">{run.errorCategory}</div>
                          </div>
                        )}
                        {run.outputSize && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Output Size</div>
                            <div className="text-gray-300 font-mono">{formatBytes(run.outputSize)}</div>
                          </div>
                        )}
                      </div>

                      {run.errorDetails && run.errorDetails !== run.error && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Additional error details</div>
                          <pre className="text-xs text-port-error/80 font-mono whitespace-pre-wrap break-all">
                            {run.errorDetails}
                          </pre>
                        </div>
                      )}

                      {/* Prompt */}
                      <div>
                        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Prompt</div>
                        <div className="bg-port-card border border-port-border rounded-lg p-3 max-h-48 overflow-auto">
                          <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap break-all">
                            {expandedDetails[run.id]?.prompt || run.prompt || <BrailleSpinner text="Loading prompt" />}
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
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ProcessLogModal
        open={!!logModalRun}
        onClose={() => setLogModalRun(null)}
        processName={logProc}
        title={logProc ? `System Logs — ${logProc}` : 'System Logs'}
      />
    </div>
  );
}
