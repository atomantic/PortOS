/** Shared live progress content for the schedule card and corner notification. */
export default function MaintenanceRunStatus({ run }) {
  const done = Object.keys(run.completed || {}).length;
  const total = run.steps?.length || 0;
  const step = run.active?.taskType || run.steps?.find(entry => !run.completed?.[entry.id])?.taskRef?.taskType;
  return <div className="space-y-1 text-xs" role="status">
    <p>{run.status} · {done}/{total} steps{run.status === 'running' && step ? ` · ${step}` : ''}</p>
    <progress aria-label="Maintenance steps completed" value={done} max={total || 1} className="w-full h-1 accent-port-accent" />
    {run.active && <p className="flex items-center gap-2">
      {run.active.status === 'running' && <span aria-hidden="true" className="w-2 h-2 rounded-full bg-port-accent motion-safe:animate-pulse" />}
      {run.active.status || 'queued'}
      {run.active.agentId && <a className="underline" href={`/cos/agents/${encodeURIComponent(run.active.agentId)}`} target="_blank" rel="noopener noreferrer">Open agent in new tab</a>}
    </p>}
    {run.reason && <p>{run.reason}</p>}
  </div>;
}
