import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Bot, ExternalLink, ListOrdered, PauseCircle, Play, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';
import MediaJobsQueue from '../media/MediaJobsQueue.jsx';
import BrailleSpinner from '../BrailleSpinner.jsx';
import Banner from '../ui/Banner.jsx';
import toast from '../ui/Toast.jsx';
import { useAutoRefetch } from '../../hooks/useAutoRefetch.js';
import * as api from '../../services/api.js';

const taskLabel = (task) => task.title || task.description || task.prompt || task.id;

function CountCard({ label, value, tone = 'text-white' }) {
  return (
    <div className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone}`}>{value}</div>
    </div>
  );
}

export default function QueuesPanel() {
  const [spawningId, setSpawningId] = useState(null);
  const [queueError, setQueueError] = useState(null);
  const fetchTasks = useCallback(() => api.getCosTasks({ silent: true }).then(
    (next) => {
      setQueueError(null);
      return next;
    },
    (error) => {
      setQueueError(error?.message || 'Agent queue status is unavailable');
      throw error;
    },
  ), []);
  const { data, loading, refetch } = useAutoRefetch(
    fetchTasks,
    5000,
  );
  const tasks = useMemo(() => {
    const user = data?.user?.tasks || [];
    const internal = data?.cos?.tasks || [];
    return [
      ...user.map((task) => ({ ...task, source: 'user' })),
      ...internal.map((task) => ({ ...task, source: 'internal' })),
    ];
  }, [data]);
  const pending = tasks.filter((task) => task.status === 'pending');
  const running = tasks.filter((task) => task.status === 'in_progress');
  const awaitingApproval = pending.filter((task) => task.approvalRequired);
  const queueKnown = data != null;

  const runNow = async (task) => {
    setSpawningId(task.id);
    const result = await api.forceSpawnTask(task.id, { silent: true }).catch((error) => {
      toast.error(error?.message || 'Could not start task');
      return null;
    });
    setSpawningId(null);
    if (!result) return;
    toast.success(`Spawning ${task.id}`);
    refetch();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <CountCard label="Agent pending" value={queueKnown ? pending.length : '—'} tone={queueKnown && pending.length ? 'text-port-warning' : 'text-white'} />
        <CountCard label="Agent running" value={queueKnown ? running.length : '—'} tone={queueKnown && running.length ? 'text-port-accent' : 'text-white'} />
        <CountCard label="Need approval" value={queueKnown ? awaitingApproval.length : '—'} tone={queueKnown && awaitingApproval.length ? 'text-purple-300' : 'text-white'} />
        <CountCard label="Queue sources" value={queueKnown ? '2' : '—'} />
      </div>

      <MediaJobsQueue className="min-h-[120px]" />

      <section className="rounded-2xl border border-port-border bg-port-card p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bot size={17} className="text-port-accent" />
            <div>
              <h3 className="font-semibold text-white">Agent task queue</h3>
              <p className="text-xs text-gray-500">User tasks and autonomous system work.</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Link to="/cos/tasks" className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2 text-xs text-port-accent hover:bg-port-accent/10">
              Full queue <ExternalLink size={12} />
            </Link>
            <button type="button" onClick={refetch} className="grid h-9 w-9 place-items-center rounded-lg text-gray-400 hover:bg-port-border/40 hover:text-white" aria-label="Refresh agent queue">
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        {queueError && (
          <Banner className="mt-4" tone="warning" icon={AlertTriangle}>
            Agent queue refresh failed. {queueKnown ? 'Showing the last known snapshot.' : 'Counts and pending work are unknown.'}
          </Banner>
        )}

        {loading && !queueKnown ? (
          <div className="mt-4 text-sm text-gray-400"><BrailleSpinner text="Loading agent queue…" /></div>
        ) : !queueKnown ? (
          <div className="mt-4 rounded-xl bg-port-warning/5 p-4 text-sm text-port-warning">
            Agent queue status is unavailable.
          </div>
        ) : pending.length === 0 ? (
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-port-success/5 p-4 text-sm text-port-success">
            <ListOrdered size={16} /> No pending agent tasks.
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {pending.map((task) => (
              <div key={`${task.source}:${task.id}`} className="flex flex-col gap-3 rounded-xl bg-port-bg/40 p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-gray-500">{task.id}</span>
                    <span className="rounded bg-port-border px-1.5 py-0.5 text-[10px] uppercase text-gray-400">{task.source}</span>
                    {task.approvalRequired && <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] uppercase text-purple-300">approval required</span>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-gray-200">{taskLabel(task)}</p>
                </div>
                {task.approvalRequired ? (
                  <Link
                    to={`/cos/tasks?task=${encodeURIComponent(task.id)}&source=${task.source}`}
                    aria-label={`Review task ${task.id}`}
                    className="inline-flex min-h-[36px] items-center justify-center gap-1 rounded-lg border border-purple-500/30 px-3 py-1.5 text-xs text-purple-300 hover:bg-purple-500/10"
                  >
                    <PauseCircle size={13} /> Review
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => runNow(task)}
                    disabled={spawningId != null}
                    aria-label={spawningId === task.id ? `Starting task ${task.id}` : `Run task ${task.id} now`}
                    className="inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg bg-port-accent/15 px-3 py-1.5 text-xs font-medium text-port-accent hover:bg-port-accent/25 disabled:opacity-50"
                  >
                    <Play size={13} /> {spawningId === task.id ? 'Starting…' : 'Run now'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
