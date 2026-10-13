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
  const incomplete = interruption || scanIncomplete || assessmentUnverified || validationFailed || publicationIncomplete;
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
      {scanner && <div className="mt-1 break-words">
        <div>Security scanner (agent reported): {scanner.status}</div>
        <div>Model: {scanner.model ?? 'unknown'} · Effort: {scanner.effort ?? 'unknown'} · Auth: {scanner.auth}</div>
        <div>Estimated cost: {scanner.estimatedCostUsd == null ? 'unknown' : formatUsd(scanner.estimatedCostUsd, { maximumFractionDigits: 4 })} · Budget: {scanner.maxCostUsd == null ? 'unknown' : formatUsd(scanner.maxCostUsd, { maximumFractionDigits: 4 })} (API-equivalent USD)</div>
        <div>Time limit: {scanner.timeLimitSeconds == null ? 'unknown' : `${formatCount(scanner.timeLimitSeconds)}s`} · Exit: {scanner.exitCode ?? 'unknown'}</div>
        <div>Artifacts — findings: {scanner.artifacts?.findings == null ? 'unknown' : scanner.artifacts.findings ? 'saved' : 'absent'}; coverage: {scanner.artifacts?.coverage == null ? 'unknown' : scanner.artifacts.coverage ? 'saved' : 'absent'}</div>
      </div>}
      {!handoff && assessment && <div>{assessment.status === 'recorded' ? 'Assessment saved' : assessment.status === 'persistence-failed' ? 'Assessment could not be saved' : assessment.status === 'not-attempted' ? 'Assessment not attempted' : 'Assessment not verified as saved'}</div>}
      {!handoff && validationFailed && <div>Delivery validation failed</div>}
      {!handoff && publicationIncomplete && <div>{publication.status === 'running' ? 'Publication checks running' : 'Publication blocked; worktree preserved'}</div>}
    </div>
  );
}
