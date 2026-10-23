import { Fragment } from 'react';
import { Link } from 'react-router';
import { CheckCircle, AlertCircle, RotateCcw } from 'lucide-react';
import { formatCount, formatUsd } from '../../utils/formatters';
import { isAgentHandoff, agentHandoffReason, normalizeTaskOutcome, isTaskDeliveryComplete } from '../../lib/agentOutcome';

/** Shared delivery and execution verdict for cards and the Resume dialog. */
export default function AgentResultLine({ agent, className = '' }) {
  if (!agent?.result) return null;
  const handoff = isAgentHandoff(agent);
  const outcome = normalizeTaskOutcome(agent.result.taskOutcome);
  const deliveryHeld = ['blocked', 'incomplete'].includes(outcome?.status);
  const deliveryComplete = isTaskDeliveryComplete(agent);
  const executionSuccess = agent.result.executionSuccess ?? agent.result.success;
  const assessment = [agent.metadata?.auditAssessment, agent.result.auditAssessment]
    .find(value => value?.status === 'recorded') || agent.metadata?.auditAssessment || agent.result.auditAssessment;
  const assessmentUnverified = assessment && assessment.status !== 'recorded';
  const validationFailed = agent.result.validationPassed === false;
  const publication = agent.metadata?.publicationValidation;
  const publicationIncomplete = ['running', 'blocked'].includes(publication?.status);
  const interruption = agent.metadata?.executionInterruption || agent.result.executionInterruption;
  const scanner = agent.metadata?.securityScan;
  const scanIncomplete = scanner && scanner.status !== 'completed';
  const cleanup = agent.metadata?.cleanupOutcome;
  const cleanupRecovery = agent.metadata?.recoveryOrigin?.subsystem === 'repository-cleanup';
  const cleanupTracked = cleanupRecovery || cleanup || agent.result.cleanupPending === true;
  const cleanupPending = cleanupTracked && cleanup?.status !== 'verified';
  const merged = cleanup?.committedIntegrationVerified === true;
  const incomplete = cleanupPending || interruption || scanIncomplete || assessmentUnverified || validationFailed || publicationIncomplete;
  const tone = handoff ? 'text-port-accent' : !executionSuccess ? 'text-port-error' : incomplete || deliveryHeld ? 'text-port-warning'
    : deliveryComplete ? 'text-port-success' : executionSuccess ? 'text-port-text-muted' : 'text-port-error';

  return (
    <div className={`text-sm ${tone} ${className}`.trim()}>
      <span className="flex items-center gap-2">
      {handoff ? (
        <><RotateCcw size={14} aria-hidden="true" /> {agentHandoffReason(agent)}</>
      ) : deliveryHeld && executionSuccess ? (
        <><AlertCircle size={14} aria-hidden="true" /> {outcome.status === 'blocked' ? 'Task blocked' : 'Task incomplete'}</>
      ) : executionSuccess ? (
        <><CheckCircle size={14} aria-hidden="true" /> {incomplete || !deliveryComplete ? 'Execution completed' : outcome.status === 'no-action-needed' ? 'No action needed' : 'Completed successfully'}</>
      ) : (
        <><AlertCircle size={14} aria-hidden="true" /> {agent.result.error || 'Failed'}</>
      )}
      </span>
      {!handoff && cleanupTracked && <div>{merged ? 'Code merged.' : deliveryComplete ? 'Delivery verified.' : 'Code delivery still needs verification.'}</div>}
      {!handoff && outcome?.reason && !cleanupTracked && <div>{outcome.reason}</div>}
      {interruption && <div>Execution interrupted: {interruption.category === 'content-refusal' ? 'provider safety refusal; automatic retry stopped' : interruption.category}</div>}
      {!handoff && cleanupTracked && <CleanupStatus cleanup={cleanup} outcome={outcome} />}
      <SecurityScanEvidence scanner={scanner} control={agent.metadata?.securityScanControl} />
      {!handoff && assessment && <div>{assessment.status === 'recorded' ? 'Assessment saved' : assessment.status === 'persistence-failed' ? 'Assessment could not be saved' : assessment.status === 'not-attempted' ? 'Assessment not attempted' : 'Assessment not verified as saved'}</div>}
      {!handoff && validationFailed && <div>Delivery validation failed</div>}
      {!handoff && publicationIncomplete && <div>{publication.status === 'running' ? 'Publication checks running' : 'Publication blocked; worktree preserved'}</div>}
    </div>
  );
}

function CleanupStatus({ cleanup, outcome }) {
  const verified = cleanup?.status === 'verified';
  const absent = cleanup?.status === 'already-absent';
  const blocked = cleanup?.status === 'blocked';
  const owners = Array.isArray(cleanup?.owners) && cleanup.owners.length > 0;
  return (
    <div>
      <div>{verified ? 'Local cleanup confirmed; preservation verified.'
        : absent ? 'The local worktree is already gone, but PortOS has not verified its backup yet.'
          : blocked ? 'Local cleanup is blocked. PortOS has not confirmed safe removal.'
            : 'Local cleanup is pending; preservation and removal are not yet confirmed.'}</div>
      {!verified && <div>{owners ? <>Next: wait for the current owner to finish.<CleanupHolders owners={cleanup.owners} /></>
        : cleanup?.taskId ? <>Next: the <Link className="underline" to={`/cos/tasks?task=${encodeURIComponent(cleanup.taskId)}&source=internal`}>cleanup recovery task</Link> must verify preservation and finish cleanup.</>
          : absent ? 'Next: PortOS must verify the preservation evidence.'
            : 'Next: PortOS must resolve the cleanup hold and verify preservation before removal.'}</div>}
      <details className="mt-1 text-port-text-muted">
        <summary className="cursor-pointer">Cleanup diagnostics</summary>
        <pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify({ cleanup: cleanup || null, reportedOutcome: outcome }, null, 2)}</pre>
      </details>
    </div>
  );
}

// The live run(s) a claim-owner hold waits on. Without them the card said only
// "claim-owner-ambiguous" and the operator had to hunt for the run (#12769).
function CleanupHolders({ owners }) {
  if (!Array.isArray(owners) || owners.length === 0) return null;
  return (
    <span className="break-words">
      {' '}— waiting on {owners.length === 1 ? 'live run' : 'live runs'}{' '}
      {owners.map((id, index) => (
        <Fragment key={id}>
          {index > 0 && ', '}
          <Link to={`/cos/agents/${encodeURIComponent(id)}`} className="font-mono underline">{id}</Link>
        </Fragment>
      ))}
    </span>
  );
}

export function SecurityScanEvidence({ scanner, control }) {
  if (!scanner) return null;
  return (
      <div className="mt-1 break-words">
        <div>Security scanner ({scanner.source === 'runner' ? 'runner observed' : 'agent reported'}): {control?.status || scanner.status}{control && ' (runner connection lost)'}</div>
        {scanner.status === 'invalid-input' && <div>Input rejected before scanner launch</div>}
        {scanner.baseline && <div>Committed baseline: {scanner.baseline.commit} · Tree: {scanner.baseline.tree}. Uncommitted files and submodules excluded; symlinks read as link text. Subsequent repairs are not certified.</div>}
        {scanner.preflight && <div>Input rejections: {formatCount(scanner.preflight.rejectedRequests)} · Last: {scanner.preflight.lastError.field} item {formatCount(scanner.preflight.lastError.index + 1)} — {scanner.preflight.lastError.code}</div>}
        <div>Model: {scanner.model ?? 'unknown'} · Effort: {scanner.effort ?? 'unknown'} · Auth: {scanner.auth}</div>
        <div>Estimated baseline: {scanner.estimatedCostUsd == null ? 'unknown' : formatUsd(scanner.estimatedCostUsd, { maximumFractionDigits: 4 })} · Estimate cap: {scanner.maxCostUsd == null ? 'unknown' : scanner.maxCostUsd === 'unlimited' ? 'none (no estimate cap)' : formatUsd(scanner.maxCostUsd, { maximumFractionDigits: 4 })} (API-equivalent USD)</div>
        <div>Short-context estimates do not measure billed charges or ChatGPT subscription quota.</div>
        <div>Time limit: {scanner.timeLimitSeconds == null ? 'unknown' : scanner.timeLimitSeconds === 'unlimited' ? 'none (no elapsed-time deadline)' : `${formatCount(scanner.timeLimitSeconds)}s`} · Exit: {scanner.exitCode ?? 'unknown'}</div>
        <div>Artifacts — findings: {scanner.artifacts?.findings == null ? 'unknown' : scanner.artifacts.findings ? 'saved' : 'absent'}; coverage: {scanner.artifacts?.coverage == null ? 'unknown' : scanner.artifacts.coverage ? 'saved' : 'absent'}</div>
        {(control?.cleanup || scanner.cleanup) && <div>Process cleanup: {control?.cleanup || scanner.cleanup}</div>}
      </div>
  );
}
