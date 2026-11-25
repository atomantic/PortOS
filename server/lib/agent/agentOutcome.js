/**
 * Is a completed agent record an OUTCOME, or a handoff to its own continuation?
 *
 * `resumeAgent` (and `relaunchAgent`) retire the old record with `success: false` and requeue the SAME task, usually
 * because the user swapped providers; reading `result.success` as the verdict would book a phantom failure per swap
 * (history, reports, success rate, quota-burn denials). Keyed on `result.resumed`, so already-archived relaunches are
 * reclassified with no migration. Mirrored at `client/src/lib/agentOutcome.js` and pinned by
 * `agentOutcome.parity.test.js`. Pure and dependency-free so report builders and listeners avoid the agent-state graph.
 */

/**
 * True when this record was retired to hand its task to a continuation run (resume / relaunch) rather than because the
 * run reached a verdict. Reads only `result`, so `isAgentHandoff({ result })` works before a record exists.
 * Strict `=== true` on purpose: a truthy check would swallow `resumed: 'partial'` or a round-tripped string and silently
 * drop a real outcome from every count.
 */
export function isAgentHandoff(agent) {
  return agent?.result?.resumed === true;
}

/**
 * True only when a handoff record proves a continuation was actually QUEUED (`resumedTaskId` is stamped when the same task
 * is requeued). `isAgentHandoff` alone is not proof: `retireStrandedPausedAgents` also stamps `resumed: true` on a pause
 * whose task is gone, with nothing requeued.
 *
 * Use this anywhere the caller would SKIP its own completion handling because a continuation will fire it; skipping on
 * the bare predicate strands the chain (#7469). Consumers asking "was this a genuine success/failure" keep using
 * `isAgentHandoff`.
 */
export function isQueuedContinuation(agent) {
  return isAgentHandoff(agent) && !!agent?.result?.resumedTaskId;
}

/**
 * The one line a handoff card should show: WHAT THE USER CHANGED.
 *
 * With a queued continuation (`resumedTaskId`), `metadata.pauseReason` wins ("Relaunched by user on codex / gpt-5"),
 * since `result.error` says where the TASK went. Without one the order flips: a stranded retirement keeps the ORIGINAL
 * pause reason ("Paused by user"), which would misread as a provider swap, so `result.error` is the honest line.
 * Lives beside the predicate because the client re-exports this file.
 */
export function agentHandoffReason(agent) {
  const error = agent?.result?.error;
  const pauseReason = agent?.metadata?.pauseReason;
  const handedOn = !!agent?.result?.resumedTaskId;
  return (handedOn ? pauseReason || error : error || pauseReason) || 'Handed off to a new run';
}


export const GITHUB_WORKFLOW_SCOPE = 'github-workflow-scope';
export const GITHUB_WORKFLOW_SCOPE_REMEDY = 'gh auth refresh -h github.com -s workflow';

// Older task outcomes lack the fixed code. Recognize only an explicit
// workflow-scope deficiency, not a branch policy error or an advisory probe.
const missingWorkflowScope = /(?:\b(?:lacks?|missing|without)\b[^.\n]{0,60}\bworkflow.{0,5}\s+scope\b|\bworkflow.{0,5}\s+scope\b[^.\n]{0,25}\b(?:missing|required)\b)/i;

export function isGitHubWorkflowScopeBlock(task) {
  const metadata = task?.metadata;
  if (task?.status !== 'blocked' || metadata?.blocker || metadata?.blockedCategory !== 'task-approval') return false;
  const outcome = metadata.taskOutcome;
  return outcome?.recovery?.mode === 'approval' && (outcome.recovery.code === GITHUB_WORKFLOW_SCOPE
    || (typeof outcome.reason === 'string' && /github|\.github\/workflows/i.test(outcome.reason) && missingWorkflowScope.test(outcome.reason)));
}

/** Explicit delivery evidence, separate from a process ending normally. */
export function normalizeTaskOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!['completed', 'no-action-needed', 'blocked', 'incomplete'].includes(value.status)) return null;
  if (typeof value.reason !== 'string' || !value.reason.trim()) return null;
  const outcome = { status: value.status, reason: value.reason.trim() };
  if (['blocked', 'incomplete'].includes(value.status)) {
    if (value.recovery?.mode === 'runtime') outcome.recovery = { mode: 'runtime',
      prUrl: typeof value.recovery.prUrl === 'string' ? value.recovery.prUrl : '',
      requiredCommit: typeof value.recovery.requiredCommit === 'string' ? value.recovery.requiredCommit : '' };
    if (value.recovery?.mode === 'cleanup') outcome.recovery = { mode: 'cleanup' };
    if (value.recovery?.mode === 'dependency-wait'
      && ['ownerTaskId', 'ownerAgentId', 'prUrl'].every(key => typeof value.recovery[key] === 'string'
        && value.recovery[key].length > 0 && value.recovery[key].length <= (key === 'prUrl' ? 2048 : 160))) {
      outcome.recovery = { mode: 'dependency-wait', ownerTaskId: value.recovery.ownerTaskId,
        ownerAgentId: value.recovery.ownerAgentId, prUrl: value.recovery.prUrl };
    }
    if (value.recovery?.mode === 'approval') {
      const options = Array.isArray(value.recovery.options)
        ? value.recovery.options.filter(option => typeof option === 'string' && option.trim()).map(option => option.trim()) : [];
      // Malformed approval requests fail closed, with concrete default choices.
      outcome.recovery = { mode: 'approval',
        ...(value.recovery.code === GITHUB_WORKFLOW_SCOPE ? { code: GITHUB_WORKFLOW_SCOPE } : {}),
        options: options.length >= 2 ? options : [
        'Address the named prerequisite, then retry the retained work.',
        'Keep the task stopped and preserve its work.',
      ] };
    }
  }
  return outcome;
}

/** Only evidenced delivery may resolve external work; legacy exits are unknown. */
export function isTaskDeliveryComplete(agent) {
  const outcome = normalizeTaskOutcome(agent?.result?.taskOutcome);
  const sync = agent?.metadata?.releaseSynchronization;
  if (sync && sync.status !== 'verified') return false;
  return !isAgentHandoff(agent) && agent?.result?.success === true
    && agent.result.validationPassed !== false
    && ['completed', 'no-action-needed'].includes(outcome?.status);
}

export function resolveTaskOutcome({ reported, success, validationPassed, branchProvenEmpty, noChangeAllowed, noCommitDeclared = false }) {
  if (reported && ['blocked', 'incomplete'].includes(reported.status)) return reported;
  if (!success) return { status: 'incomplete', reason: 'Delivery checks did not pass.' };
  // Legacy learning criteria include commit probes that are not delivery gates (an audit may save its report without a
  // code change); keep those runs unverified unless the agent supplied a delivery contract.
  if (validationPassed === false) return reported
    ? { status: 'incomplete', reason: 'Delivery checks did not pass.' } : null;
  if (branchProvenEmpty && noChangeAllowed) return { status: 'no-action-needed', reason: 'The permitted no-change result was verified against the repository.' };
  // Coordinators and other no-commit shapes leave validation null on purpose (the exit code judged the run), so a
  // reported no-action is their delivery contract. A committing task must not take this branch: its null means the
  // no-op was never checked against the repository.
  if (reported?.status === 'no-action-needed' && validationPassed !== true) {
    if (noCommitDeclared && validationPassed == null) return reported;
    return { status: 'incomplete', reason: 'The reported no-action-needed result was not verified.' };
  }
  if (reported) return reported;
  return validationPassed === true ? { status: 'completed', reason: 'The task delivery criteria passed.' } : null;
}
