import MaintenanceStepChecklist from './MaintenanceStepChecklist';

/**
 * Live status is 1-based ("running · 3/7 steps · module-hygiene") so it matches
 * the checklist numbering. The progress bar still uses completed-count.
 */
export function maintenanceRunProgress(run = {}) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const completed = run.completed || {};
  const total = steps.length;
  const done = Object.keys(completed).length;
  const activeId = run.active?.stepId;
  const activeType = run.active?.taskType;
  const activeIndex = steps.findIndex((entry) => (activeId
    ? entry.id === activeId
    : Boolean(activeType) && entry.taskRef?.taskType === activeType && !Object.hasOwn(completed, entry.id)));
  const current = activeIndex >= 0
    ? activeIndex + 1
    : (run.status === 'running' && total > 0 && done < total ? done + 1 : done);
  const step = activeType || steps.find((entry) => !Object.hasOwn(completed, entry.id))?.taskRef?.taskType;
  return { current, done, total, step };
}

/** Shared live progress content for the schedule card and corner notification. */
export default function MaintenanceRunStatus({ run, showSteps = false }) {
  const { current, done, total, step } = maintenanceRunProgress(run);
  return <div className={`space-y-1 text-xs min-w-0 ${showSteps ? 'w-full' : ''}`} role="status">
    <p>{run.status} · {current}/{total} steps{run.status === 'running' && step ? ` · ${step}` : ''}</p>
    <progress aria-label="Maintenance steps completed" value={done} max={total || 1} className="w-full h-1 accent-port-accent" />
    {run.active && <p className="flex items-center gap-2">
      {run.active.status === 'running' && <span aria-hidden="true" className="w-2 h-2 rounded-full bg-port-accent motion-safe:animate-pulse" />}
      {run.active.status || 'queued'}
      {run.active.agentId && <a className="underline" href={`/cos/agents/${encodeURIComponent(run.active.agentId)}`} target="_blank" rel="noopener noreferrer">Open agent in new tab</a>}
    </p>}
    {run.reason && <details><summary className="cursor-pointer">Run details</summary><p className="break-all">{run.reason}</p></details>}
    {showSteps && <MaintenanceStepChecklist steps={run.steps} completed={run.completed} activeStepId={run.active?.stepId} />}
  </div>;
}
