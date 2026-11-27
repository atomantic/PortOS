import ExecutionOptionsAttribution from '../../providers/ExecutionOptionsAttribution.jsx';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Copy, Trash2, RotateCcw, ScrollText, Square } from 'lucide-react';
import {
  getRuns,
  getRun,
  deleteRun,
  stopRun,
  getRunPrompt,
  getRunOutput,
  deleteFailedRuns,
} from '../../../services/apiRuns.js';
import { TABS } from '../constants';
import { agentPath, taskPath } from '../crossLinks.js';
import socket from '../../../services/socket';
import { formatTime, formatRuntime, formatBytes, formatDateTime } from '../../../utils/formatters';
import BrailleSpinner from '../../BrailleSpinner';
import Banner from '../../ui/Banner';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import useConfirmDelete from '../../../hooks/useConfirmDelete';
import ListLoadError from '../../ui/ListLoadError';
import useListResource from '../../../hooks/useListResource';
import ProcessLogModal from '../../ui/ProcessLogModal';
import { copyToClipboard } from '../../../lib/clipboard';

const CLEAR_FAILED = Symbol('clear failed runs');
const runEventsPath = TABS.find(({ id }) => id === 'run-events').to;

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
  const detailRequests = useRef(new Map());
  const [sourceFilter, setSourceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const [stoppingIds, setStoppingIds] = useState(() => new Set());
  // The failed run whose system logs are open in the log modal, or null.
  const [logModalRun, setLogModalRun] = useState(null);

  // Server total behind the newest-100 page, for the "newest N of total" note.
  const [totalRuns, setTotalRuns] = useState(null);
  // A deep-linked run outside the loaded page: { status: 'loading'|'ready'|'missing', run }.
  const [pinned, setPinned] = useState(null);
  // The totals are a side effect of the fetcher, which useListResource cannot
  // drop with the rows: only the newest read (and no read that predates a local
  // delete, which also bumps totalGen) may write them.
  const totalGen = useRef(0);
  const fetchRuns = useCallback(
    () => {
      const gen = ++totalGen.current;
      return getRuns(100, 0, sourceFilter, { silent: true }).then(data => {
      if (gen === totalGen.current) {
        setTotalRuns({ source: sourceFilter, total: Number.isFinite(data?.total) ? data.total : null });
      }
      return data?.runs || [];
      });
    },
    [sourceFilter]
  );
  // A confirmed local delete lowers the server total by `count`; null when the
  // count is unknown for this source filter, which hides the note until a re-read.
  const adjustTotal = (count) => {
    totalGen.current += 1;
    setTotalRuns(prev => (prev && count !== null && prev.total !== null
      ? { ...prev, total: Math.max(0, prev.total - count) }
      : null));
  };
  const { items: runs, state: runsState, error: runsError, retry: loadRuns, setItems: setRuns } = useListResource(fetchRuns);
  const loading = runsState === 'loading';

  // Run lifecycle transitions (an AI run starting or ending, a CoS agent
  // finishing, the post-listen boot close of runs a previous process left
  // open, #16557) arrive as `system:activity` invalidations. The server
  // coalesces a burst into one frame naming only its last source, so every
  // frame re-reads the page in place; a reconnect re-reads frames missed while
  // offline. A frame that lands while the list is loading, or while a re-read
  // is running, is held and read once that settles (that read may have seen
  // the record before the change), so a burst costs at most one follow-up read.
  // A failed re-read keeps the last successful rows on screen.
  // Set below; the socket-driven re-read calls it so one handler covers both.
  const refreshPinnedRef = useRef(null);
  const runsReady = useRef(false);
  runsReady.current = runsState === 'ready';
  const refreshGeneration = useRef(0);
  const refreshInFlight = useRef(false);
  const refreshPending = useRef(false);
  const refreshRuns = useCallback(() => {
    refreshPinnedRef.current?.();
    if (!runsReady.current || refreshInFlight.current) {
      refreshPending.current = true;
      return;
    }
    refreshPending.current = false;
    const current = ++refreshGeneration.current;
    refreshInFlight.current = true;
    const settle = (list) => {
      if (current !== refreshGeneration.current) return;
      refreshInFlight.current = false;
      if (list && runsReady.current) setRuns(list);
      if (refreshPending.current) refreshRuns();
    };
    fetchRuns().then(settle, () => settle(null));
  }, [fetchRuns, setRuns]);
  // A confirmed delete must not be undone by a re-read that started before it:
  // drop that read and, if one was running, start a fresh one after the delete.
  const supersedeRefresh = () => {
    const wasInFlight = refreshInFlight.current;
    refreshGeneration.current += 1;
    refreshInFlight.current = false;
    if (wasInFlight) refreshRuns();
  };
  useEffect(() => {
    if (runsState !== 'ready' || !refreshPending.current) return;
    refreshPending.current = false;
    refreshRuns();
  }, [runsState, refreshRuns]);
  useEffect(() => {
    socket.on('system:activity', refreshRuns);
    socket.on('connect', refreshRuns);
    return () => {
      refreshGeneration.current += 1;
      refreshInFlight.current = false;
      socket.off('system:activity', refreshRuns);
      socket.off('connect', refreshRuns);
    };
  }, [refreshRuns]);

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

  const handleDelete = async (id) => {
    const deleted = await deleteRun(id).catch(() => null);
    if (!deleted && deleted !== undefined) return;
    supersedeRefresh();
    adjustTotal(1);
    setRuns(prev => prev.filter(run => run.id !== id));
    if (expandedId === id) setExpandedId(null);
    if (pinRef.current?.run?.id === id) dropPin();
  };

  const handleStop = async (id) => {
    setStoppingIds((prev) => new Set(prev).add(id));
    const stopped = await stopRun(id).then(() => true).catch(() => false);
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
    await Promise.all([loadRuns(), refreshPinned()]);
    setStoppingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const loadRunDetails = useCallback((id, { force = false } = {}) => {
    const pending = detailRequests.current.get(id);
    if (pending) return pending;
    const cached = expandedDetails[id];
    if (cached && !force) return Promise.resolve(cached);

    setExpandedDetails(prev => ({ ...prev, [id]: { status: 'loading' } }));
    const request = Promise.all([
      getRunPrompt(id, { silent: true }),
      getRunOutput(id, { silent: true }),
    ]).then(
      ([prompt, output]) => ({ status: 'ready', prompt, output }),
      error => ({ status: 'error', error }),
    ).then(detail => {
      setExpandedDetails(prev => ({ ...prev, [id]: detail }));
      detailRequests.current.delete(id);
      return detail;
    });
    detailRequests.current.set(id, request);
    return request;
  }, [expandedDetails]);

  const expandRun = useCallback((id) => {
    setExpandedId(id);
    loadRunDetails(id);
  }, [loadRunDetails]);

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
  const deepLinkOpened = useRef(null);
  useEffect(() => {
    if (deepLinkOpened.current === deepLinkRunId || !deepLinkRunId || loading) return;
    if (!runs.some(run => run.id === deepLinkRunId)) return;
    deepLinkOpened.current = deepLinkRunId;
    expandRun(deepLinkRunId);
  }, [deepLinkRunId, loading, runs, expandRun]);

  // A link can name a run older than the newest-100 page. Resolve it by id (one
  // GET, only on this miss) and pin it above the list; a 404 shows a notice, any
  // other failure a retryable error. Every pinned read (first lookup and the
  // re-reads below) takes a generation from pinGen and applies only while it is
  // still the newest, so a changed selection, a delete or a later read drops it;
  // pinTarget is the id in play, which also keeps one miss to one read.
  const pinTarget = useRef(null);
  const pinGen = useRef(0);
  const pinRef = useRef(null);
  pinRef.current = pinned;
  const [pinRetry, setPinRetry] = useState(0);
  // At most one pinned read in flight plus one follow-up, like the list refresh:
  // a burst of invalidations must not keep superseding the read that would land.
  const pinFlight = useRef(false);
  const pinPending = useRef(false);
  const pinFlightToken = useRef(0);
  const dropPin = useCallback(() => {
    pinGen.current += 1;
    setPinned(null);
  }, []);
  const readPinned = useCallback((id) => {
    const initial = !(pinRef.current?.status === 'ready' && pinRef.current.run.id === id);
    const gen = ++pinGen.current;
    return getRun(id, { silent: true }).then(
      (run) => {
        if (gen !== pinGen.current) return;
        if (!run?.id) { if (initial) setPinned({ status: 'missing', run: null }); return; }
        setPinned({ status: 'ready', run });
        if (initial) expandRun(run.id);
      },
      (err) => {
        if (gen !== pinGen.current) return;
        if (err?.status === 404) setPinned({ status: 'missing', run: null });
        else if (initial) setPinned({ status: 'error', run: null, message: err?.message || 'request failed' });
      }
    );
  }, [expandRun]);
  const startPinnedRead = useCallback((id) => {
    pinFlight.current = true;
    const token = pinFlightToken.current;
    readPinned(id).finally(() => {
      if (token !== pinFlightToken.current) return;
      pinFlight.current = false;
      if (!pinPending.current) return;
      pinPending.current = false;
      if (pinTarget.current && pinRef.current) startPinnedRead(pinTarget.current);
    });
  }, [readPinned]);
  // Any change of the ?run= selection (including clearing it) retires the pin
  // and the read in flight for the previous one.
  useEffect(() => () => {
    dropPin();
    deepLinkOpened.current = null;
    pinTarget.current = null;
    pinFlight.current = false;
    pinPending.current = false;
    pinFlightToken.current += 1;
  }, [deepLinkRunId, dropPin]);
  useEffect(() => {
    if (!deepLinkRunId || pinTarget.current === deepLinkRunId || deepLinkOpened.current === deepLinkRunId || runsState !== 'ready') return;
    if (runs.some(run => run.id === deepLinkRunId)) return;
    pinTarget.current = deepLinkRunId;
    setPinned({ status: 'loading', run: null });
    startPinnedRead(deepLinkRunId);
  }, [deepLinkRunId, runsState, runs, startPinnedRead, pinRetry]);
  const retryPinned = () => {
    pinTarget.current = null;
    setPinRetry(n => n + 1);
  };

  // Lifecycle invalidations and a Stop reach the pinned run too: re-read it by
  // id (newest read wins) so it cannot keep showing Running after it ended.
  const refreshPinned = useCallback(() => {
    if (!pinTarget.current || !pinRef.current) return Promise.resolve();
    if (pinFlight.current) {
      pinPending.current = true;
      return Promise.resolve();
    }
    return startPinnedRead(pinTarget.current);
  }, [startPinnedRead]);
  refreshPinnedRef.current = refreshPinned;

  const handleResume = async (run) => {
    const details = await loadRunDetails(run.id);
    if (details.status !== 'ready') {
      setExpandedId(run.id);
      return;
    }
    navigate('/devtools/runner', {
      state: {
        continueFrom: {
          prompt: details.prompt,
          output: details.output,
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

  const hasFailedRuns = runs.some(run => run.success === false);
  const logProc = logModalRun ? runLogProcessName(logModalRun.source) : '';

  const handleClearFailed = async () => {
    const result = await deleteFailedRuns().catch(() => null);
    if (result !== null) {
      supersedeRefresh();
      // deletedCount spans every source, so it only adjusts the unfiltered total.
      adjustTotal(sourceFilter === 'all' && Number.isFinite(result?.deletedCount) ? result.deletedCount : null);
      setRuns(prev => prev.filter(r => r.success !== false));
      if (pinRef.current?.run?.success === false) dropPin();
      else if (pinRef.current?.status === 'loading') refreshPinned();
    }
  };

  const renderRun = (run) => {
    const detail = expandedDetails[run.id];
    const expanded = expandedId === run.id;
    const detailsId = `run-details-${run.id}`;
    const runLabel = [run.providerName, run.model, `(${run.id})`].filter(Boolean).join(' ');
    const stopLabel = stoppingIds.has(run.id) ? 'Stopping run' : 'Stop run';

    return <div key={run.id}>
      <div
        className="flex flex-wrap items-center gap-2 sm:gap-4 p-3 sm:p-4"
        data-testid={`run-row-${run.id}`}
      >
        <button
          type="button"
          className="flex items-center gap-3 flex-1 basis-64 min-w-0 min-h-11 rounded text-left hover:bg-port-border/20 focus-visible:outline-2 focus-visible:outline-port-accent"
          onClick={() => toggleExpand(run.id)}
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
        >
          <span className="sr-only">Run details for</span>
          <span aria-hidden="true" className={`shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
          <span aria-hidden="true" className="text-xl shrink-0">🤖</span>
          <span className="flex-1 min-w-0">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 [overflow-wrap:anywhere]">
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
            </span>
            <span className="block text-xs text-gray-500 font-mono truncate mt-1">
              {run.prompt?.substring(0, 100)}{run.prompt?.length > 100 ? '...' : ''}
            </span>
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <span className="inline-flex items-center gap-1.5 text-sm text-gray-400 shrink-0">
            <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${run.success ? 'bg-port-success' : run.success === false ? 'bg-port-error' : 'bg-port-warning'}`} />
            {run.success ? 'Succeeded' : run.success === false ? 'Failed' : 'Running'}
          </span>
          <span className="text-sm text-gray-500 shrink-0">{formatTime(run.startTime)}</span>
          {isConfirming(run.id) ? (
            <ConfirmButtonPair
              prompt={run.success === null ? 'Stop and delete?' : 'Delete?'}
              ariaLabel={`Confirm ${run.success === null ? 'stop and delete' : 'delete'} run ${runLabel}`}
              onConfirm={() => confirmDelete(() => handleDelete(run.id))}
              onCancel={cancelDelete}
              className="flex-wrap"
            />
          ) : (
            <>
              {run.success === false && (
                <button
                  type="button"
                  onClick={() => setLogModalRun(run)}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-accent transition-colors"
                  title="View system logs"
                  aria-label={`View system logs for run ${runLabel}`}
                  data-testid={`view-logs-${run.id}`}
                >
                  <ScrollText size={14} aria-hidden="true" />
                </button>
              )}
              {run.success !== null && (
                <button
                  type="button"
                  onClick={() => handleResume(run)}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-accent transition-colors"
                  title="Resume run" aria-label={`Resume run ${runLabel}`}
                  data-testid={`resume-run-${run.id}`}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                </button>
              )}
              {run.success === null && (
                <button
                  type="button"
                  onClick={() => handleStop(run.id)}
                  disabled={stoppingIds.has(run.id)}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error transition-colors disabled:opacity-40"
                  title={stopLabel}
                  aria-label={`${stopLabel} ${runLabel}`}
                  data-testid={`stop-run-${run.id}`}
                >
                  <Square size={14} aria-hidden="true" fill="currentColor" />
                </button>
              )}
              <button
                type="button"
                onClick={() => requestDelete(run.id)}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error transition-colors"
                title="Delete run" aria-label={`Delete run ${runLabel}`}
                data-testid={`delete-run-${run.id}`}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>

      {run.claudeSignInExpiring === true && (
        <div className="px-3 pb-3 sm:px-4 sm:pb-4 min-w-0">
          <Banner tone="warning" size="md" title="Claude Code sign-in expires soon" srLabel={false} role="note">
            <p>Renew the sign-in with <code>claude auth login</code>. The CLI notice in the run output has the expiry window.</p>
          </Banner>
        </div>
      )}

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
      {expanded && (
        <div id={detailsId} className="px-4 pb-4 bg-port-bg border-t border-port-border">
          <div className="pt-4 space-y-4">
            {/* Execution ID */}
            <div className="mb-4">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Execution ID</div>
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs text-gray-400 font-mono select-all [overflow-wrap:anywhere]">{run.id}</code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(run.id, 'Execution ID copied to clipboard')}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-white transition-colors"
                  title="Copy execution ID"
                  aria-label="Copy execution ID"
                >
                  <Copy size={12} aria-hidden="true" />
                </button>
                {run.source === 'cos-agent' && (
                  <Link to={`${runEventsPath}?${new URLSearchParams({ run: run.id })}`}
                    className="inline-flex min-h-11 items-center px-2 text-xs text-port-accent hover:underline">
                    View run events
                  </Link>
                )}
                {run.source === 'cos-agent' && run.agentId && (
                  <Link to={agentPath(run.agentId)}
                    className="inline-flex min-h-11 items-center px-2 text-xs text-port-accent hover:underline">
                    View agent
                  </Link>
                )}
                {run.source === 'cos-agent' && run.taskId && (
                  <Link to={taskPath(run.taskId)}
                    className="inline-flex min-h-11 items-center px-2 text-xs text-port-accent hover:underline">
                    View task
                  </Link>
                )}
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

            {detail?.status === 'loading' && <BrailleSpinner text="Loading run details" />}
            {detail?.status === 'error' && (
              <ListLoadError
                what="run details"
                error={detail.error}
                onRetry={() => loadRunDetails(run.id, { force: true })}
              />
            )}
            {detail?.status === 'ready' && (
              <>
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Prompt</div>
                  <div className="bg-port-card border border-port-border rounded-lg p-3 max-h-48 overflow-auto">
                    <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap break-all">
                      {detail.prompt || '(no prompt)'}
                    </pre>
                  </div>
                </div>
                {run.success !== null && (
                  <div>
                    <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Output</div>
                    <div className="bg-port-card border border-port-border rounded-lg p-3 max-h-64 overflow-auto">
                      <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-all">
                        {detail.output || '(no output)'}
                      </pre>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>;
  };

  return (
    <div className="space-y-4 lg:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="text-lg sm:text-xl font-bold text-white">Recent Runs</h2>
        {hasFailedRuns && (
          <button
            type="button"
            onClick={() => requestDelete(CLEAR_FAILED)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-error/20 hover:bg-port-error/30 text-port-error rounded-lg transition-colors self-end sm:self-auto"
          >
            <Trash2 size={14} aria-hidden="true" />
            Clear Failed
          </button>
        )}
      </div>

      {isConfirming(CLEAR_FAILED) && (
        <InlineConfirmRow
          autoFocus
          question="Delete every failed run on this install? This removes their prompts and output."
          confirmText="Delete failed runs"
          onConfirm={() => confirmDelete(handleClearFailed)}
          onCancel={cancelDelete}
        />
      )}

      {/* Source Filter */}
      <div role="group" aria-label="Filter runs by source" className="flex flex-wrap gap-1.5 sm:gap-2">
        {[
          { value: 'all', label: 'All' },
          { value: 'devtools', label: 'DevTools' },
          { value: 'cos-agent', label: 'CoS' }
        ].map(filter => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={sourceFilter === filter.value}
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
      <div role="group" aria-label="Filter runs by status" className="flex flex-wrap gap-1.5 sm:gap-2">
        {[
          { value: 'all', label: 'All Status' },
          { value: 'success', label: 'Success' },
          { value: 'running', label: 'Running' },
          { value: 'failed', label: 'Failed' }
        ].map(filter => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={statusFilter === filter.value}
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

      {totalRuns?.source === sourceFilter && totalRuns.total > runs.length && (
        <p className="text-xs text-gray-500">Showing the newest {runs.length} of {totalRuns.total} runs</p>
      )}
      {pinned?.status === 'missing' && (
        <Banner tone="info" size="md" srLabel={false} role="note">Run not found or deleted.</Banner>
      )}
      {pinned?.status === 'error' && (
        <Banner tone="error" size="md" srLabel={false} role="alert">
          Could not load run {deepLinkRunId} — {pinned.message}{' '}
          <button type="button" onClick={retryPinned} className="min-h-11 underline">Retry</button>
        </Banner>
      )}
      {pinned?.status === 'ready' && !runs.some(run => run.id === pinned.run.id) && (
        <div className="bg-port-card border border-port-accent/40 rounded-lg sm:rounded-xl overflow-hidden" data-testid="pinned-run">
          {renderRun(pinned.run)}
        </div>
      )}

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
            {filteredRuns.map(renderRun)}
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
