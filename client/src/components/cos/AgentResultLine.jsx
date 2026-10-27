import { Fragment } from 'react';
import { Link } from 'react-router';
import { CheckCircle, AlertCircle, RotateCcw } from 'lucide-react';
import { formatCount, formatUsd, formatDateTime } from '../../utils/formatters';
import { isAgentHandoff, agentHandoffReason, normalizeTaskOutcome, isTaskDeliveryComplete } from '../../lib/agentOutcome';

/** Shared delivery and execution verdict for cards and the Resume dialog. */
export default function AgentResultLine({ agent, className = '' }) {
  const publication = agent?.metadata?.releasePublication;
  const synchronization = agent?.metadata?.releaseSynchronization || publication?.synchronization;
  if (!agent?.result) return <ReleasePublicationLine publication={publication} synchronization={synchronization} className={className} />;
  const handoff = isAgentHandoff(agent);
  const outcome = normalizeTaskOutcome(agent.result.taskOutcome);
  const executionSuccess = agent.result.executionSuccess ?? agent.result.success;
  const assessment = [agent.metadata?.auditAssessment, agent.result.auditAssessment]
    .find(value => value?.status === 'recorded') || agent.metadata?.auditAssessment || agent.result.auditAssessment;
  const assessmentUnverified = assessment && assessment.status !== 'recorded';
  const validationFailed = agent.result.validationPassed === false;
  const publicationValidation = agent.metadata?.publicationValidation;
  const publicationIncomplete = ['running', 'blocked'].includes(publicationValidation?.status);
  const syncIncomplete = synchronization && synchronization.status !== 'verified';
  const interruption = agent.metadata?.executionInterruption || agent.result.executionInterruption;
  const scanner = agent.metadata?.securityScan;
  const scanIncomplete = scanner && scanner.status !== 'completed';
  const cleanup = agent.metadata?.cleanupOutcome;
  const cleanupRecovery = agent.metadata?.recoveryOrigin?.subsystem === 'repository-cleanup';
  const cleanupTracked = cleanupRecovery || cleanup || agent.result.cleanupPending === true;
  const cleanupComplete = isCleanupComplete(cleanup);
  const cleanupPending = cleanupTracked && !cleanupComplete;
  const merged = cleanup?.committedIntegrationVerified === true;
  // A completed cleanup audit supersedes the old cleanup-only handoff, while
  // unrelated delivery decisions and execution failures keep their own verdict.
  const cleanupResolved = cleanupComplete && merged && (outcome?.recovery?.mode === 'cleanup'
    || (executionSuccess && agent.metadata?.repoStateVerification?.deliveryVerified === true));
  const deliveryHeld = ['blocked', 'incomplete'].includes(outcome?.status) && !cleanupResolved;
  const deliveryComplete = isTaskDeliveryComplete(agent) || cleanupResolved;
  const incomplete = cleanupPending || interruption || scanIncomplete || assessmentUnverified || validationFailed || publicationIncomplete || syncIncomplete;
  const tone = handoff ? 'text-port-accent' : !executionSuccess ? 'text-port-error' : incomplete || deliveryHeld ? 'text-port-warning'
    : deliveryComplete ? 'text-port-success' : executionSuccess ? 'text-port-text-muted' : 'text-port-error';

  return (
    <div className={`text-sm ${tone} ${className}`.trim()}>
      <ReleasePublicationLine publication={publication} synchronization={synchronization} />
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
      {!handoff && outcome?.reason && (!cleanupTracked || outcome.recovery?.mode === 'approval') && <div>{outcome.reason}</div>}
      {interruption && <div>Execution interrupted: {interruption.category === 'content-refusal' ? 'provider safety refusal; automatic retry stopped' : interruption.category}</div>}
      {!handoff && cleanupTracked && <CleanupStatus cleanup={cleanup} outcome={outcome} />}
      <SecurityScanEvidence scanner={scanner} control={agent.metadata?.securityScanControl} />
      {!handoff && assessment && <div>{assessment.status === 'recorded' ? 'Assessment saved' : assessment.status === 'persistence-failed' ? 'Assessment could not be saved' : assessment.status === 'not-attempted' ? 'Assessment not attempted' : 'Assessment not verified as saved'}</div>}
      {!handoff && validationFailed && <div>Delivery validation failed</div>}
      {!handoff && publicationIncomplete && <div>{publicationValidation.status === 'running' ? 'Publication checks running' : 'Publication blocked; worktree preserved'}</div>}
    </div>
  );
}

function isCleanupComplete(cleanup) {
  return cleanup?.status === 'verified' && (cleanup.unresolved == null || cleanup.unresolved === 0);
}

function CleanupStatus({ cleanup, outcome }) {
  const verified = isCleanupComplete(cleanup);
  const mergedAbsent = cleanup?.reason === 'already-absent-merged'
    || (cleanup?.status === 'already-absent' && cleanup.committedIntegrationVerified === true);
  const absent = cleanup?.status === 'already-absent';
  const blocked = cleanup?.status === 'blocked';
  const owners = Array.isArray(cleanup?.owners) && cleanup.owners.length > 0;
  return (
    <div>
      <div>{verified ? mergedAbsent ? 'Local worktree already removed; merged delivery confirmed.' : 'Local cleanup confirmed; preservation verified.'
        : absent ? mergedAbsent ? cleanup.total > 1 ? 'Other repository cleanup still needs verification.' : 'The local worktree is already gone; preservation still needs verification.' : 'The local worktree is already gone; code delivery still needs verification.'
          : blocked ? 'Local cleanup is blocked. PortOS has not confirmed safe removal.'
            : 'Local cleanup is pending; preservation and removal are not yet confirmed.'}</div>
      {!verified && <div>{owners ? <>Next: wait for the current owner to finish.<CleanupHolders owners={cleanup.owners} /></>
        : cleanup?.taskId ? <>Next: the <Link className="underline" to={`/cos/tasks?task=${encodeURIComponent(cleanup.taskId)}&source=internal`}>cleanup recovery task</Link> must verify preservation and finish cleanup.</>
          : absent ? 'Next: PortOS must verify the remaining delivery and cleanup state.'
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

/** Publication is independent of the agent's eventual execution result. */
export function ReleasePublicationLine({ publication, synchronization, className = '' }) {
  const pub = publication || synchronization?.publication;
  const sync = synchronization || pub?.synchronization;
  if (!pub && !sync) return null;
  if (pub && pub.status !== 'verified' && !sync) return null;

  const tag = pub?.tag || sync?.tag;
  const releaseUrl = pub?.releaseUrl || sync?.releaseUrl;
  const publishedAt = pub?.publishedAt || sync?.publishedAt;

  const syncStatus = sync?.status;
  const syncLabel = () => {
    if (!syncStatus || syncStatus === 'pending') {
      return sync ? 'Published — synchronization pending' : 'Published — synchronization not yet verified';
    }
    if (syncStatus === 'running') return 'Published — synchronization running';
    if (syncStatus === 'blocked') return 'Published — synchronization blocked';
    if (syncStatus === 'verified') return 'Published — synchronization verified';
    return 'Published — synchronization not yet verified';
  };

  const syncTone = () => {
    if (syncStatus === 'verified') return 'text-port-success';
    if (syncStatus === 'blocked') return 'text-port-error';
    if (syncStatus === 'running') return 'text-port-warning';
    return 'text-port-text-muted';
  };

  return (
    <div className={`text-sm break-words ${className}`.trim()}>
      <div className={syncStatus === 'verified' || !syncStatus ? 'text-port-success' : syncTone()}>
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
      {syncStatus === 'blocked' && sync?.blocker && (
        <div className="text-xs text-port-error">
          Blocker: {sync.blocker}
        </div>
      )}
    </div>
  );
}
