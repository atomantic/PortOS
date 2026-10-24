import { Link } from 'react-router';
import { Clock, Loader2 } from 'lucide-react';
import { formatCount, formatDateTime, formatDurationMs } from '../../utils/formatters';

const HOLD_REASONS = {
  'cleanup-already-warned': 'A previous cleanup attempt left warnings; waiting for a fresh delivery and preservation check.',
  'already-absent-preservation-unverified': 'The workspace is gone; its preservation evidence still needs verification.',
  'cognitive-review-pending': 'Waiting for the cleanup recovery task to review preservation and finish cleanup.',
  'active-agent-owner': 'Waiting for the current workspace owner to finish.',
};

export function DeliveryRecoverySchedule({ recovery }) {
  return <div className="px-3 py-2 text-sm text-port-text-muted space-y-1">
    <p>Agent execution has ended. These tasks are waiting for delivery verification or workspace cleanup.</p>
    <p>{!recovery ? 'Automatic recovery schedule unavailable.'
      : recovery.blockedReason ? `Automatic recovery is waiting: ${recovery.blockedReason}.`
        : recovery.nextRunAt ? `Next recovery sweep: ${formatDateTime(recovery.nextRunAt)}.${recovery.nextRunAt <= Date.now() ? ' Scheduled time reached; awaiting scheduler confirmation.' : ''}`
          : 'The recovery sweep has no confirmed next run time.'}</p>
    {recovery?.intervalMs && <p>When enabled, checks run every {formatDurationMs(recovery.intervalMs)}, up to {formatCount(recovery.batchSize)} jobs per sweep. A sweep may leave a job waiting if its dependency is unresolved; completion time is unknown.</p>}
  </div>;
}

export default function DeliveryStatus({ agent, ownerId }) {
  const metadata = agent?.metadata;
  const cleanup = metadata?.cleanupOutcome;
  const verification = metadata?.repoStateVerification;
  const activity = agent?.deliveryActivity;
  const reason = cleanup?.reason || verification?.reasons?.join(', ') || metadata?.completionCleanup?.reason;
  const checkedAt = verification?.checkedAt || cleanup?.observedAt;
  const stages = Object.values(metadata?.completionCleanup?.stages || {});
  const recoveries = [...new Set([cleanup?.taskId,
    ...Object.values(metadata?.repoCleanupRecoveries || {}).map(entry => entry.taskId)].filter(Boolean))];
  const id = agent?.id || ownerId;

  return <div className="mb-2 space-y-1 text-sm text-port-text-muted [overflow-wrap:anywhere]" aria-label="Delivery activity">
    <p className="flex items-center gap-2 text-port-warning">
      {activity ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none shrink-0" />
        : <Clock size={14} aria-hidden="true" className="shrink-0" />}
      {activity ? activity.label : 'Waiting for delivery recovery — agent is not running'}
    </p>
    <p>{reason ? `Last check: ${HOLD_REASONS[reason] || `${reason.replaceAll('-', ' ')}.`}` : 'No delivery check result is available yet.'}</p>
    {checkedAt && <p>Last checked: {formatDateTime(checkedAt)}</p>}
    {agent?.result?.taskOutcome?.reason && <details>
      <summary className="cursor-pointer">Agent handoff: what remains</summary>
      <p className="whitespace-pre-wrap">{agent.result.taskOutcome.reason}</p>
    </details>}
    {stages.length > 0 && <p>Completion steps confirmed: {formatCount(stages.filter(stage => stage.status === 'done').length)} of {formatCount(stages.length)}</p>}
    {cleanup?.owners?.length > 0 && <p>Waiting for current owners to finish: {cleanup.owners.map((owner, index) =>
      <span key={owner}>{index > 0 && ', '}<Link className="underline" to={`/cos/agents/${encodeURIComponent(owner)}`}>{owner}</Link></span>)}</p>}
    {recoveries.map(taskId => <p key={taskId}><Link className="text-port-accent underline" to={`/cos/tasks?task=${encodeURIComponent(taskId)}`}>View recovery task {taskId}</Link> — its current status determines when recovery can continue.</p>)}
    {id && <Link className="inline-block text-port-accent underline" to={`/cos/agents/${encodeURIComponent(id)}`}>View agent report and execution log</Link>}
  </div>;
}
