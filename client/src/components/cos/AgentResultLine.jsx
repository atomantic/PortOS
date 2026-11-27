import { Fragment } from 'react';
import { Link } from 'react-router';
import { CheckCircle, AlertCircle, RotateCcw } from 'lucide-react';
import { formatCount, formatUsd, formatDateTime } from '../../utils/formatters';
import { isAgentHandoff, agentHandoffReason, normalizeTaskOutcome, isTaskDeliveryComplete } from '../../lib/agentOutcome';

/** Shared delivery and execution verdict for cards and the Resume dialog. */
export default function AgentResultLine({ agent, className = '' }) {
  const state = deriveAgentResultState(agent);
  if (!state.hasResult) return <ReleasePublicationLine publication={state.publication} synchronization={state.synchronization} className={className} />;
  return (
    <div className={`text-sm ${state.tone} min-w-0 max-w-full ${className}`.trim()}>
      <ReleasePublicationLine publication={state.publication} synchronization={state.synchronization} />
      <ResultVerdict state={state} agent={agent} />
      <CleanupEvidence state={state} />
      <InterruptionEvidence interruption={state.interruption} />
      {!state.handoff && state.cleanupTracked && <CleanupStatus cleanup={state.cleanup} outcome={state.outcome} />}
      <SecurityScanEvidence scanner={state.scanner} control={agent.metadata?.securityScanControl} />
      <AssessmentEvidence assessment={state.assessment} handoff={state.handoff} />
      <ValidationEvidence state={state} />
    </div>
  );
}

/** Derive display decisions without coupling them to React rendering. */
export function deriveAgentResultState(agent) {
  const result = agent?.result;
  const metadata = agent?.metadata || {};
  const publication = metadata.releasePublication;
  const synchronization = metadata.releaseSynchronization || publication?.synchronization;
  if (!result) return { hasResult: false, publication, synchronization };

  const handoff = isAgentHandoff(agent);
  const outcome = normalizeTaskOutcome(result.taskOutcome);
  const executionSuccess = result.executionSuccess ?? result.success;
  const assessment = selectAssessment(metadata.auditAssessment, result.auditAssessment);
  const cleanup = metadata.cleanupOutcome;
  const cleanupTracked = metadata.recoveryOrigin?.subsystem === 'repository-cleanup' || cleanup || result.cleanupPending === true;
  const cleanupComplete = isCleanupComplete(cleanup);
  const cleanupPending = cleanupTracked && !cleanupComplete;
  const assignedPrMerged = hasVerifiedMergedReviewFollowUp(metadata);
  const cleanupResolved = cleanupComplete && isCleanupSuperseded(outcome, executionSuccess, metadata);
  const deliveryHeld = ['blocked', 'incomplete'].includes(outcome?.status) && !cleanupResolved;
  const deliveryComplete = isTaskDeliveryComplete(agent) || cleanupResolved;
  const publicationValidation = metadata.publicationValidation;
  const scanner = metadata.securityScan;
  const interruption = metadata.executionInterruption || result.executionInterruption;
  const validationFailed = result.validationPassed === false;
  const publicationIncomplete = ['running', 'blocked'].includes(publicationValidation?.status);
  const incomplete = hasIncompleteEvidence({ cleanupPending, interruption, scanner, assessment, validationFailed, publicationIncomplete, synchronization });
  return {
    hasResult: true, publication, synchronization, handoff, outcome, executionSuccess, assessment,
    cleanup, cleanupTracked, cleanupComplete, cleanupPending,
    merged: cleanup?.committedIntegrationVerified === true, assignedPrMerged,
    deliveryHeld, deliveryComplete, interruption, scanner, validationFailed,
    publicationValidation, publicationIncomplete, incomplete,
    tone: resultTone({ handoff, executionSuccess, incomplete, deliveryHeld, deliveryComplete }),
  };
}

function selectAssessment(metadataAssessment, resultAssessment) {
  return [metadataAssessment, resultAssessment].find(value => value?.status === 'recorded')
    || metadataAssessment || resultAssessment;
}

function hasVerifiedMergedReviewFollowUp(metadata) {
  const followUp = metadata.mergedReviewFollowUp;
  return metadata.taskOutcomeSource === 'forge-verification' && followUp?.status === 'verified'
    && typeof followUp.prUrl === 'string' && !!followUp.prUrl
    && followUp.prUrl === metadata.reviewLoopMergeTarget?.url;
}

function isCleanupSuperseded(outcome, executionSuccess, metadata) {
  return outcome?.recovery?.mode === 'cleanup'
    || (executionSuccess && metadata.repoStateVerification?.deliveryVerified === true);
}

function hasIncompleteEvidence({ cleanupPending, interruption, scanner, assessment, validationFailed, publicationIncomplete, synchronization }) {
  return Boolean(cleanupPending || interruption || (scanner && scanner.status !== 'completed')
    || (assessment && assessment.status !== 'recorded') || validationFailed || publicationIncomplete
    || (synchronization && synchronization.status !== 'verified'));
}

function resultTone({ handoff, executionSuccess, incomplete, deliveryHeld, deliveryComplete }) {
  if (handoff) return 'text-port-accent';
  if (!executionSuccess) return 'text-port-error';
  if (incomplete || deliveryHeld) return 'text-port-warning';
  if (deliveryComplete) return 'text-port-success';
  return 'text-port-text-muted';
}

function ResultVerdict({ state, agent }) {
  const { handoff, deliveryHeld, executionSuccess, outcome, incomplete, deliveryComplete } = state;
  return (
    <span className="flex items-center gap-2">
      {handoff ? <><RotateCcw size={14} aria-hidden="true" /> {agentHandoffReason(agent)}</>
        : deliveryHeld && executionSuccess ? <><AlertCircle size={14} aria-hidden="true" /> {outcome.status === 'blocked' ? 'Task blocked' : 'Task incomplete'}</>
          : executionSuccess ? <><CheckCircle size={14} aria-hidden="true" /> {incomplete || !deliveryComplete ? 'Execution completed' : outcome?.status === 'no-action-needed' ? 'No action needed' : 'Completed successfully'}</>
            : <><AlertCircle size={14} aria-hidden="true" /> {agent?.result?.error || 'Failed'}</>}
    </span>
  );
}

function CleanupEvidence({ state }) {
  const { handoff, cleanupTracked, assignedPrMerged, merged, cleanupPending, cleanupComplete, deliveryComplete, outcome } = state;
  if (handoff) return null;
  return <>
    {cleanupTracked && (assignedPrMerged && (!merged || cleanupPending) ? <>
      <div>Assigned pull request merged.</div>
      <div>Later local work may still need delivery verification.</div>
    </> : <div>{merged ? 'Code merged.' : cleanupComplete ? 'Local worktree cleaned up.' : deliveryComplete ? 'Delivery verified.' : 'Cleanup pending.'}</div>)}
    {outcome?.reason && (!cleanupTracked || outcome.recovery?.mode === 'approval') && <div>{outcome.reason}</div>}
  </>;
}

function InterruptionEvidence({ interruption }) {
  if (!interruption) return null;
  const detail = interruption.category === 'content-refusal' ? 'provider safety refusal; automatic retry stopped' : interruption.category;
  return <div>Execution interrupted: {detail}</div>;
}

function AssessmentEvidence({ assessment, handoff }) {
  if (!assessment || handoff) return null;
  const labels = {
    recorded: 'Assessment saved',
    'persistence-failed': 'Assessment could not be saved',
    'not-attempted': 'Assessment not attempted',
  };
  return <div>{labels[assessment.status] || 'Assessment not verified as saved'}</div>;
}

function ValidationEvidence({ state }) {
  const { handoff, validationFailed, publicationIncomplete, publicationValidation } = state;
  return <>
    {!handoff && validationFailed && <div>Delivery validation failed</div>}
    {!handoff && publicationIncomplete && <div>{publicationValidation.status === 'running' ? 'Publication checks running' : 'Publication blocked; worktree preserved'}</div>}
  </>;
}

function isCleanupComplete(cleanup) {
  return (cleanup?.status === 'verified' || cleanup?.status === 'already-absent')
    && (cleanup.unresolved == null || cleanup.unresolved === 0);
}

function CleanupStatus({ cleanup, outcome }) {
  const verified = isCleanupComplete(cleanup);
  const mergedAbsent = cleanup?.reason === 'already-absent-merged'
    || (cleanup?.status === 'already-absent' && cleanup.committedIntegrationVerified === true);
  const absent = cleanup?.status === 'already-absent';
  const owners = Array.isArray(cleanup?.owners) && cleanup.owners.length > 0;
  return (
    <div>
      <div>{verified ? mergedAbsent ? 'Local worktree already removed; merged delivery confirmed.' : absent ? 'Local worktree already removed.' : 'Local worktree cleaned up.'
        : absent && cleanup.total > 1 ? 'Other repository cleanup is pending.'
          : 'Local worktree cleanup is pending.'}</div>
      {!verified && (owners || cleanup?.taskId) && <div>{owners ? <>Next: wait for the current owner to finish.<CleanupHolders owners={cleanup.owners} /></>
        : <>Next: the <Link className="underline" to={`/cos/tasks?task=${encodeURIComponent(cleanup.taskId)}&source=internal`}>cleanup recovery task</Link> will finish cleanup.</>}</div>}
      <details className="mt-1 text-port-text-muted">
        <summary className="cursor-pointer pointer-coarse:min-h-11">Cleanup diagnostics</summary>
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
        {scanner.preflight && <div>Input rejections: {formatCount(scanner.preflight.rejectedRequests)}{scanner.preflight.lastError && <> · Last: {scanner.preflight.lastError.field} item {formatCount(scanner.preflight.lastError.index + 1)} — {scanner.preflight.lastError.code}</>}</div>}
        <div>Model: {scanner.model ?? 'unknown'} · Effort: {scanner.effort ?? 'unknown'} · Auth: {scanner.auth}</div>
        <div>Estimated baseline: {scanner.estimatedCostUsd == null ? 'unknown' : formatUsd(scanner.estimatedCostUsd, { maximumFractionDigits: 4 })} · Estimate cap: {scanner.maxCostUsd == null ? 'unknown' : scanner.maxCostUsd === 'unlimited' ? 'none (no estimate cap)' : formatUsd(scanner.maxCostUsd, { maximumFractionDigits: 4 })} (API-equivalent USD)</div>
        <div>Short-context estimates do not measure billed charges or ChatGPT subscription quota.</div>
        <div>Time limit: {scanner.timeLimitSeconds == null ? 'unknown' : scanner.timeLimitSeconds === 'unlimited' ? 'none (no elapsed-time deadline)' : `${formatCount(scanner.timeLimitSeconds)}s`} · Exit: {scanner.exitCode ?? 'unknown'}</div>
        <div>Artifacts — findings: {scanner.artifacts?.findings == null ? 'unknown' : scanner.artifacts.findings ? 'saved' : 'absent'}; coverage: {scanner.artifacts?.coverage == null ? 'unknown' : scanner.artifacts.coverage ? 'saved' : 'absent'}</div>
        {(control?.cleanup || scanner.cleanup) && <div>Process cleanup: {control?.cleanup || scanner.cleanup}</div>}
      </div>
  );
}

/** Publication is independent of the agent's eventual execution result. */
export function ReleasePublicationLine({ publication, synchronization, className = '' }) {
  const pub = publication || synchronization?.publication;
  const sync = synchronization || pub?.synchronization;
  const publicationVerified = pub?.status === 'verified';
  if (!pub && !sync) return null;
  if (!publicationVerified && !sync) return null;

  const tag = publicationVerified ? pub?.tag || sync?.tag : null;
  const releaseUrl = publicationVerified ? pub?.releaseUrl || sync?.releaseUrl : null;
  const publishedAt = publicationVerified ? pub?.publishedAt || sync?.publishedAt : null;

  const syncStatus = sync?.status;
  const delivered = publicationVerified && sync?.delivery?.status === 'verified';
  // A reset checkpoint no longer retries; its blocker below is historical.
  const retired = Boolean(sync?.operatorReset);
  const publicationLabel = publicationVerified ? 'Published' : 'Publication not verified';
  const syncLabel = () => {
    if (delivered) return `${publicationLabel} — delivery observed`;
    if (retired) return `${publicationLabel} — synchronization retired by operator`;
    if (!syncStatus || syncStatus === 'pending') {
      return sync ? `${publicationLabel} — synchronization pending` : `${publicationLabel} — synchronization not yet verified`;
    }
    if (syncStatus === 'running') return `${publicationLabel} — synchronization running`;
    if (syncStatus === 'blocked') return `${publicationLabel} — synchronization blocked`;
    if (syncStatus === 'verified') return `${publicationLabel} — synchronization verified`;
    return `${publicationLabel} — synchronization not yet verified`;
  };

  const syncTone = () => {
    if (delivered) return 'text-port-success';
    if (retired) return 'text-port-text-muted';
    if (syncStatus === 'verified') return 'text-port-success';
    if (syncStatus === 'blocked') return 'text-port-error';
    if (syncStatus === 'running') return 'text-port-warning';
    return 'text-port-text-muted';
  };

  return (
    <div className={`text-sm break-words ${className}`.trim()}>
      <div className={!publicationVerified ? 'text-port-warning' : syncTone()}>
        {syncLabel()}
      </div>
      {tag && releaseUrl && (
        <a href={releaseUrl} target="_blank" rel="noopener noreferrer" className="underline text-port-success">
          {tag}
        </a>
      )}
      {publishedAt && (
        <>
          {' · '}
          <time dateTime={publishedAt} className="text-port-success">
            {formatDateTime(publishedAt)}
          </time>
        </>
      )}
      {sync?.identity && (
        <div className="text-xs text-port-text-muted font-mono truncate" title={sync.identity}>
          Release sync: {sync.identity}
        </div>
      )}
      {sync?.prUrl && (
        <div className="text-xs">
          <a href={sync.prUrl} target="_blank" rel="noopener noreferrer" className="underline text-port-accent">
            Sync PR{sync.headSha ? ` (${sync.headSha.slice(0, 7)})` : ''}
          </a>
        </div>
      )}
      {delivered && sync.delivery.prUrl && (
        <div className="text-xs">
          <a href={sync.delivery.prUrl} target="_blank" rel="noopener noreferrer" className="underline text-port-accent">
            Delivery PR{sync.delivery.headSha ? ` (${sync.delivery.headSha.slice(0, 7)})` : ''}
          </a>
        </div>
      )}
      {delivered && sync.delivery.checkedAt && (
        <div className="text-xs text-port-text-muted">Delivery checked: <time dateTime={sync.delivery.checkedAt}>{formatDateTime(sync.delivery.checkedAt)}</time></div>
      )}
      {(delivered || retired) && syncStatus === 'blocked' && (
        <div className="text-xs text-port-text-muted">Historical synchronization: blocked</div>
      )}
      {syncStatus === 'blocked' && sync?.blocker && (
        <div className={`text-xs ${retired ? 'text-port-text-muted' : 'text-port-error'}`}>
          {delivered || retired ? 'Historical blocker' : 'Blocker'}: {sync.blocker}
        </div>
      )}
      {syncStatus === 'blocked' && sync?.nextAction && (
        <div className="text-xs text-port-text-muted">Next action: {sync.nextAction}</div>
      )}
    </div>
  );
}

