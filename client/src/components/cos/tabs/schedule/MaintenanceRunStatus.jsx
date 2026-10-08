import { X } from 'lucide-react';
import { formatCount } from '../../../../utils/formatters';
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
  const running = run.status === 'running';
  const current = running && activeIndex >= 0
    ? activeIndex + 1
    : (running && total > 0 && done < total ? done + 1 : done);
  const step = activeType || steps.find((entry) => !Object.hasOwn(completed, entry.id))?.taskRef?.taskType;
  return { current, done, total, step };
}

/** Shared live progress content for the schedule card and corner notification. */
export default function MaintenanceRunStatus({ run, showSteps = false, renderStepSettings, onDismiss }) {
  const { current, done, total, step } = maintenanceRunProgress(run);
  return <div className={`space-y-1 text-xs min-w-0 ${showSteps ? 'w-full' : ''}`} role="status">
    <div className="flex items-center justify-between gap-2">
      <p className="min-w-0 flex-1">{run.status} · {current}/{total} steps{run.status === 'running' && step ? ` · ${step}` : ''}</p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="min-h-[44px] min-w-[44px] -my-2 -mr-2 inline-flex items-center justify-center rounded text-gray-400 hover:text-white transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
    <progress aria-label="Maintenance steps completed" value={done} max={total || 1} className="w-full h-1 accent-port-accent" />
    {run.auditDepth === 'deep' && Object.entries(run.deepAudits || {}).map(([id, audit]) => <div key={id} className="space-y-1 max-h-36 overflow-y-auto pr-1">
      <p>Deep discovery: {audit.discoveryComplete ? 'complete' : 'partial'} · {formatCount(audit.reviewedUnits)}/{formatCount(audit.totalUnits)} units reviewed · {formatCount(audit.satisfiedPasses)}/{formatCount(audit.requiredPasses)} pass requirements</p>
      <p>{formatCount(audit.blockedUnits)} blocked · {formatCount(audit.pendingCandidates)} candidates awaiting triage · Delivery: {audit.deliveryComplete ? 'complete' : 'pending'} · {formatCount(audit.pendingRemediations)} remediations pending</p>
      {audit.revision && <p>Source revision: <code>{audit.revision.slice(0, 12)}</code></p>}
      {audit.reason && <p className="break-words">{audit.reason}</p>}
    </div>)}
    {run.active && <p className="flex items-center gap-2">
      {run.active.status === 'running' && <span aria-hidden="true" className="w-2 h-2 rounded-full bg-port-accent motion-safe:animate-pulse" />}
      {run.active.status || 'queued'}
      {run.active.agentId && <a className="underline" href={`/cos/agents/${encodeURIComponent(run.active.agentId)}`} target="_blank" rel="noopener noreferrer">Open agent in new tab</a>}
    </p>}
    {run.reason && <details><summary className="cursor-pointer">Run details</summary><p className="break-all max-h-36 overflow-y-auto">{run.reason}</p></details>}
    {showSteps && <MaintenanceStepChecklist steps={run.steps} completed={run.completed} activeStepId={run.active?.stepId} renderStepSettings={renderStepSettings} />}
  </div>;
}
