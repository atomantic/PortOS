import { Fragment } from 'react';
import { Link } from 'react-router';
import { CheckCircle, AlertCircle, RotateCcw } from 'lucide-react';
import { formatCount, formatUsd } from '../../utils/formatters';
import { isAgentHandoff, agentHandoffReason } from '../../lib/agentOutcome';

/**
 * The one-line verdict on a finished agent run — THREE outcomes, not two.
 *
 * A run retired by Resume/Relaunch carries `success: false` because it never
 * reached a verdict: its task was handed to a continuation, usually because the
 * user swapped providers after hitting a usage limit. Rendering that red said the
 * run failed, for something the user did on purpose.
 *
 * Shared by the run card and the Resume dialog. They had the same two-way ternary
 * copy-pasted, so going from two states to three meant editing both — and the
 * copies had already drifted on the fallback text. One component instead, so the
 * next state costs one edit and the two surfaces cannot disagree about what the
 * same record says.
 */
export default function AgentResultLine({ agent, className = '' }) {
  if (!agent?.result) return null;
  const handoff = isAgentHandoff(agent);
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
  const cleanupPending = (cleanupRecovery || cleanup) && cleanup?.status !== 'verified';
  const incomplete = cleanupPending || interruption || scanIncomplete || assessmentUnverified || validationFailed || publicationIncomplete;
  const tone = handoff ? 'text-port-accent' : agent.result.success ? incomplete ? 'text-port-warning' : 'text-port-success' : 'text-port-error';

  return (
    <div className={`text-sm ${tone} ${className}`.trim()}>
      <span className="flex items-center gap-2">
      {handoff ? (
        <><RotateCcw size={14} aria-hidden="true" /> {agentHandoffReason(agent)}</>
      ) : agent.result.success ? (
        <><CheckCircle size={14} aria-hidden="true" /> {incomplete || assessment ? 'Execution completed' : 'Completed successfully'}</>
      ) : (
        <><AlertCircle size={14} aria-hidden="true" /> {agent.result.error || 'Failed'}</>
      )}
      </span>
      {interruption && <div>Execution interrupted: {interruption.category === 'content-refusal' ? 'provider safety refusal; automatic retry stopped' : interruption.category}</div>}
      {cleanupPending && <div>Cleanup {cleanup?.status === 'already-absent' ? 'already absent; preservation unverified' : cleanup?.status === 'blocked' ? 'blocked' : 'unverified/pending'}{cleanup?.reason ? `: ${cleanup.reason}` : ''}<CleanupHolders owners={cleanup?.owners} /></div>}
      <SecurityScanEvidence scanner={scanner} control={agent.metadata?.securityScanControl} />
      {!handoff && assessment && <div>{assessment.status === 'recorded' ? 'Assessment saved' : assessment.status === 'persistence-failed' ? 'Assessment could not be saved' : assessment.status === 'not-attempted' ? 'Assessment not attempted' : 'Assessment not verified as saved'}</div>}
      {!handoff && validationFailed && <div>Delivery validation failed</div>}
      {!handoff && publicationIncomplete && <div>{publication.status === 'running' ? 'Publication checks running' : 'Publication blocked; worktree preserved'}</div>}
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
