import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Play, Terminal } from 'lucide-react';
import toast from '../../ui/Toast';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { formatDurationMs } from '../../../utils/formatters';
import { cancelOpenCodeAgentBenchmark, getMtplxServerStatus, runOpenCodeAgentBenchmark } from '../../../services/apiLocalLlm.js';
import { LOCAL_TUI_AGENT_BENCHMARK_TARGETS } from '../../../../../server/lib/localAgentBenchmarkTargets.js';
import { LOCAL_RUNTIME_MANAGE_URLS } from '../../../../../server/lib/modelPinMembership.js';
import { modelKey } from './assessmentDetails';

const STATIC_AGENT_TARGETS = Object.entries(LOCAL_TUI_AGENT_BENCHMARK_TARGETS)
  .filter(([backend]) => backend !== 'mtplx')
  .map(([backend, { label, modelId }]) => ({ backend, label, modelId }));

export default function AgentBenchmarkPanel({ active, disabled }) {
  const [results, setAgentBenchmarkResults] = useState({});
  const [activeTargetKey, setActiveTargetKey] = useState(null);
  const [runAgentBenchmark, agentBenchmarkRunning] = useAsyncAction(async (target) => {
    const result = await runOpenCodeAgentBenchmark({ backend: target.backend, modelId: target.modelId }, { silent: true });
    if (result?.cancelled) {
      toast.success('Agent task check cancelled');
      return result;
    }
    setAgentBenchmarkResults((previous) => ({ ...previous, [modelKey(target)]: result }));
    if (result?.completed) {
      toast.success(`${target.label}: agent task completed`);
    } else if (result) {
      toast.warning(`${target.label}: ${result.error || 'agent task did not complete'}`);
    }
    return result;
  }, { errorMessage: 'OpenCode agent benchmark failed' });

  const [cancelBenchmark, cancelling] = useAsyncAction(
    () => cancelOpenCodeAgentBenchmark({ silent: true }),
    { errorMessage: 'Could not cancel the agent task check' },
  );
  const running = agentBenchmarkRunning || cancelling || disabled;

  const runTarget = async (target) => {
    const targetKey = modelKey(target);
    setActiveTargetKey(targetKey);
    try {
      await runAgentBenchmark(target);
    } finally {
      setActiveTargetKey(null);
    }
  };

  const [mtplxStatus, setMtplxStatus] = useState(null);
  const [cacheError, setCacheError] = useState(null);
  const [cacheLoading, setCacheLoading] = useState(true);
  const [cacheRequest, setCacheRequest] = useState(0);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setCacheLoading(true);
    getMtplxServerStatus({ silent: true })
      .then((status) => {
        if (!current) return;
        setCacheError(status.cacheError);
        if (!status.cacheError) setMtplxStatus(status);
      })
      .catch((error) => { if (current) setCacheError(error?.message || 'Could not read the MTPLX cache'); })
      .finally(() => { if (current) setCacheLoading(false); });
    return () => { current = false; };
  }, [active, cacheRequest]);

  const mtplxModels = [...new Set((mtplxStatus?.cachedModelRows || [])
    .filter((row) => row.valid && typeof row.repo === 'string')
    .map((row) => row.repo))];
  const targets = [...STATIC_AGENT_TARGETS, ...mtplxModels.map((modelId) => ({
    backend: 'mtplx', label: LOCAL_TUI_AGENT_BENCHMARK_TARGETS.mtplx.label, modelId,
  }))];
  const completed = targets
    .map((target) => ({ target, result: results?.[modelKey(target)] }))
    .filter(({ result }) => result?.completed);
  const leader = [...completed]
    .filter(({ result }) => Number.isFinite(result.elapsedMs))
    .sort((a, b) => a.result.elapsedMs - b.result.elapsedMs)[0];

  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-gray-300">
        <Terminal size={12} className="text-port-accent" />
        <h3 className="font-medium">Local TUI agent-task check</h3>
      </div>
      <p className="text-[11px] text-gray-500">
        Run one explicit task through each configured local TUI preset and compare completion evidence.
      </p>
      <details className="border border-port-border/70 rounded px-2 py-1.5">
        <summary className="cursor-pointer text-[11px] text-gray-400">How the task check is measured</summary>
        <p className="text-[11px] text-gray-500 pt-1.5">
          The harness asks the agent to create and read a sentinel file in a temporary workspace. Completion time includes startup and terminal paste overhead; it is not engine throughput.
        </p>
      </details>
      {leader && (
        <div className="text-[11px] text-port-accent border border-port-accent/30 rounded px-2 py-1">
          Current task leader: <span className="font-medium">{leader.target.label} · {leader.target.modelId}</span> — {formatDurationMs(leader.result.elapsedMs)} fastest completion
        </div>
      )}
      {cacheLoading && <p className="text-[11px] text-gray-400" role="status">Reading cached MTPLX checkpoints…</p>}
      {cacheError && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-port-warning">
          <span role="status">MTPLX cache unavailable. {cacheError}</span>
          <button type="button" disabled={cacheLoading} onClick={() => setCacheRequest((value) => value + 1)} className="rounded border border-port-border px-2 py-1 hover:border-port-accent disabled:opacity-50">Retry</button>
        </div>
      )}
      {!cacheLoading && !cacheError && mtplxStatus?.supported !== false && mtplxModels.length === 0 && (
        <p className="text-[11px] text-gray-400">
          Add a complete checkpoint on the <Link className="text-port-accent hover:underline" to={LOCAL_RUNTIME_MANAGE_URLS.mtplx}>MTPLX runtime page</Link> to run an MTPLX task check.
        </p>
      )}
      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {targets.map((target) => {
          const result = results?.[modelKey(target)];
          return (
            <div key={modelKey(target)} className="bg-port-card border border-port-border/70 rounded p-2 space-y-1.5">
              <div className="text-[11px] text-gray-300">{target.label}</div>
              <div className="text-[10px] text-gray-500 font-mono break-all">{target.modelId}</div>
              {result && (
                <div className={`text-[10px] ${result.completed ? 'text-emerald-400' : 'text-port-warning'}`}>
                  {result.completed ? 'sentinel complete' : (result.error || 'task failed')}
                </div>
              )}
              {result?.completed && (
                <div className="text-[10px] text-gray-400 space-y-0.5">
                  <div>
                    {result.toolCalls === null || result.toolCalls === undefined
                      ? 'PTY-backed TUI'
                      : `${result.toolCalls} tool call${result.toolCalls === 1 ? '' : 's'}`}
                    {' · '}{formatDurationMs(result.elapsedMs)}
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => runTarget(target)}
                disabled={running}
                className="w-full flex items-center justify-center gap-1 px-2 py-1 text-[10px] pointer-coarse:min-h-11 rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white transition-colors disabled:opacity-50"
              >
                <Play size={10} /> {activeTargetKey === modelKey(target) ? 'Running…' : 'Run task check'}
              </button>
              {activeTargetKey === modelKey(target) && (
                <button
                  type="button"
                  disabled={cancelling}
                  onClick={cancelBenchmark}
                  className="w-full px-2 py-1 text-[10px] pointer-coarse:min-h-11 rounded border border-port-border text-gray-300 hover:border-port-accent disabled:opacity-50"
                >
                  {cancelling ? 'Cancelling…' : 'Cancel task check'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
