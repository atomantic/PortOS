import { Link } from 'react-router';
import { useState } from 'react';
import { Clock, Loader2 } from 'lucide-react';
import { formatCount, formatDateTime } from '../../utils/formatters';
import { recheckCosAgentCleanup } from '../../services/api';
import toast from '../ui/Toast';

const HOLD_REASONS = {
  'cleanup-already-warned': 'A previous cleanup attempt left warnings; waiting for a fresh delivery and preservation check.',
  'already-absent-preservation-unverified': 'The workspace is gone; its preservation evidence still needs verification.',
  'cognitive-review-pending': 'Waiting for the cleanup recovery task to review preservation and finish cleanup.',
  'active-agent-owner': 'Waiting for the current workspace owner to finish.',
  'release-sync-local-review-unretained': 'Waiting for release review evidence to be verified before cleanup.',
  'cleanup-review-required': 'The retained checkout needs a preservation review before it can be removed.',
  'completion-stages-pending': 'Other completion steps must finish before cleanup can be retried safely.',
  'completion-handoff-pending': 'Repository cleanup is verified. The next completion recovery pass finishes the pipeline or Creative Director hand-off, then completes the task.',
  'leave-open-cleanup-unsupported': 'The pull request is meant to stay open, so its checkout is being preserved.',
  'cleanup-provenance-unverified': 'The run’s execution and cleanup ownership could not be verified.',
  'checkout-capture-unverified': 'The original checkout capture could not be verified.',
  'checkout-capture-pending': 'Waiting for the original checkout capture to be recovered.',
  'swarm-continuation-pending': 'A pending swarm continuation must be resolved before cleanup can finish without starting more work.',
};

export default function DeliveryStatus({ agent, ownerId, taskId, onRefresh }) {
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
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
      {activity ? activity.label : 'Execution ended; delivery or cleanup still needs repair'}
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
    {agent?.status === 'completed' && agent.taskId === taskId && agent.result?.cleanupPending === true && !activity && <div>
      <button type="button" disabled={checking} className="min-h-[44px] rounded border border-port-border px-2 text-port-accent disabled:opacity-50"
        onClick={async () => {
          setChecking(true);
          const result = await recheckCosAgentCleanup(agent.id, taskId, { silent: true }).catch(error => {
            if (error.code !== 'HOST_CONTROL_FORBIDDEN') toast.error(error.message);
            return null;
          });
          setChecking(false);
          if (result) {
            const reasons = result.reasons?.length ? result.reasons : (result.reason ? [result.reason] : []);
            const message = result.verified ? 'Cleanup verified.' : `Cleanup still needs attention${reasons.length ? `: ${reasons.map(reason => HOLD_REASONS[reason] || reason.replaceAll('-', ' ')).join(' ')}` : '.'}`;
            setCheckResult(message);
            // Activity moves the row between sections, which can unmount it
            // before this request completes. A toast preserves the result.
            if (result.verified) toast.success(`${taskId}: ${message}`);
            else toast.info(`${taskId}: ${message}`);
          }
          if (onRefresh) onRefresh();
        }}>{checking ? 'Checking cleanup…' : 'Retry cleanup'}</button>
      {checkResult && <p role="status">{checkResult}</p>}
    </div>}
    {id && <Link className="inline-block text-port-accent underline" to={`/cos/agents/${encodeURIComponent(id)}`}>View agent report and execution log</Link>}
  </div>;
}
