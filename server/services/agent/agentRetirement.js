/** Settles and records an interrupted agent’s delivery before releasing its recovery work. */

import { isCleanupOnlyRecovery, verifyCleanupCompletion } from '../cleanupOnlyCompletion.js';
import { hasClaimCheckoutBindings } from '../completedCheckoutEvidence.js';
import { isDeliveryCleanupHeld } from '../../lib/taskRetryHold.js';
import { isPrivateSecurityTask } from '../../lib/privateSecurityPolicy.js';
import { DELIVERY_RECOVERY_BLOCKED_CATEGORIES } from '../../lib/taskBlockCategories.js';
import { join } from 'path';
import { resolveTaskOutcome } from '../../lib/agent/agentOutcome.js';
import { PATHS, tryReadFile } from '../../lib/fileUtils.js';
import { emitLog } from '../cos/cosEvents.js';
import { getAgentRecord, completeAgent } from '../cos/cosAgentLifecycle.js';
import { updateTask } from '../cos/cosTaskStore.js';
import { completeAgentRun } from './agentRunTracking.js';
import { isProgrammaticIoTaskType, resolveTaskHookType, declaresNoCommitCriterion } from '../taskTypeHooks.js';
import { dispatchRecoveredTaskOutputHook, resolveProgrammaticIoVerdict } from './agentOutputHookDispatch.js';
import { reconcileForgeReportedOutcome, applyReleaseDeliveryGate, releaseDeliveryApplies } from './agentForgeSettlement.js';
import { resolveDeliveryRecoveryUpdate, runtimeRecoveryFence } from './agentDeliveryRecovery.js';

/**
 * Validation verdict for a recovered run: the retirement / programmatic-I/O /
 * saved verdict first, then a merged-review or claim disposition. A disposition
 * never erases a recorded failed delivery gate, but a saved pass cannot replace a
 * fresh selected-issue proof on no-op recovery.
 */
function resolveRecoveredValidation({ task, agent, effectiveSuccess, recoveredHook, retirementCompletion, mergedReviewFollowUp, claimDisposition }) {
  let recovered;
  if (retirementCompletion) recovered = retirementCompletion.status === 'verified';
  else if (isProgrammaticIoTaskType(resolveTaskHookType(task))) {
    recovered = resolveProgrammaticIoVerdict({ success: effectiveSuccess, hookResult: recoveredHook });
  } else recovered = agent.result?.validationPassed ?? null;
  if (recovered === false || !(mergedReviewFollowUp || claimDisposition)) return recovered;
  return mergedReviewFollowUp || claimDisposition.status === 'verified' ? true : null;
}

/** Run-record output for a recovered agent: its transcript, else buffered lines; redacted for private security. */
async function recoveredRunOutput(agent, isPrivateSecurity) {
  if (isPrivateSecurity) return 'Private security assessment interrupted; inspect its local assessment archive.';
  const bufferedOutput = Array.isArray(agent.output)
    ? agent.output.map((entry) => typeof entry === 'string' ? entry : entry?.line).filter(Boolean).join('\n')
    : '';
  return await tryReadFile(join(PATHS.cosAgents, agent.id, 'output.txt')) ?? bufferedOutput;
}

/**
 * Fenced write of a recovery task update. Returns the update still owned by this
 * agent (null once another owner changed the task's status) and whether ownership was lost.
 */
async function persistRecoveredTaskUpdate({ task, agent, recoveryUpdate }) {
  if (!recoveryUpdate) return { recoveryUpdate, recoveryOwnershipLost: false };
  const update = await updateTask(task.id, recoveryUpdate, task.taskType || 'user', {
    expectedStatus: task.status || null, expectedTask: { description: task.description, priority: task.priority, metadata: task.metadata },
    recoveryOwner: { id: agent.id, startedAt: agent.startedAt },
    // Runtime resolution reloads the dispatch; guard its fresh snapshot rather
    // than the older task initially supplied to this recovered run.
    ...runtimeRecoveryFence(recoveryUpdate)[0],
  });
  if (update?.error) throw new Error(`Could not persist recovered task outcome: ${update.error}`);
  if (update?.statusChanged && recoveryUpdate.metadata?.blockedCategory === 'runtime-verification') {
    throw new Error('Could not persist recovered task outcome: task ownership changed');
  }
  if (update?.statusChanged) return { recoveryUpdate: null, recoveryOwnershipLost: true };
  return { recoveryUpdate, recoveryOwnershipLost: false };
}

/**
 * Retire an agent whose process is gone — the one step list both recovery
 * paths now share (issue #8440). Before this, the orphan sweep
 * (`runCleanupOrphanedAgents`) and the post-restart recovery
 * (`completeUntrackedAgentFromCosState`) each hand-maintained their own copy
 * of this sequence, and the copies drifted (only the sweep closed the run
 * record; #3182's output-hook fix had to land in both).
 *
 * Order matters and is preserved from the sweep, the stricter of the two
 * originals: the output hook reads the last surviving sentinel/output before
 * it is removed, the run record closes BEFORE the agent record (so a run
 * write failure leaves the agent eligible for the next sweep to retry, while
 * a later agent-write failure is harmless because `completeAgentRun`'s
 * `endTime` guard makes a retry a no-op), and the agent record closes last.
 *
 * A private-security task/agent has no immutable source inventory with which
 * to validate a report, so it is always retired as a failure (the caller's
 * `success` is overridden) and its run-record output is redacted to a fixed
 * notice rather than the raw transcript.
 *
 * @param {object} params
 * @param {object} params.agent        the dead agent's record (`id`, `metadata`, `output`, `startedAt`)
 * @param {object|null} params.task    the agent's task, if resolvable (drives the private-security check
 *   and the programmatic-I/O output hook)
 * @param {boolean} params.success     the run's outcome; overridden to `false` for a private-security task
 * @param {number} params.exitCode     the exit code recorded on the closed run (143/1 for the sweep's
 *   interrupted/orphaned reap, the real exit code for post-restart recovery)
 * @param {number} params.duration     the run's wall-clock duration in ms, for the closed run record
 * @param {string} [params.errorMessage] the error recorded on the agent (and, wrapped, on the run record)
 * @param {string} [params.category]   the run-record error category (e.g. `orphaned` / `interrupted`)
 * @param {object} [params.agentResultExtra] caller-specific fields merged into the agent-record
 *   result (e.g. the sweep's `interruptedByRestart` telemetry) — kept out of the shared shape so
 *   one caller's bookkeeping detail doesn't leak an unused field onto the other's records
 * @returns {Promise<{ success: boolean, taskOutcome: object|null, deliveryHeld: boolean }>} the effective success used for the retirement (post
 *   private-security override), so callers that branch on it don't have to re-derive it
 */
async function prepareRetiredAgent({ agent, task, success, exitCode, errorMessage, category }) {
  if (agent.metadata?.taskAnalysisType === 'security' && agent.metadata.useRunner) {
    const { settleAgentSecurityScan } = await import('./agentSecurityScan.js');
    const scanner = await settleAgentSecurityScan(agent.id);
    if (scanner?.status === 'refused') agent = { ...agent, metadata: { ...agent.metadata,
      executionInterruption: { category: 'content-refusal', source: 'security-scanner' } } };
  }
  const isPrivateSecurity = isPrivateSecurityTask(task) || isPrivateSecurityTask(agent);
  const interruption = agent.metadata?.executionInterruption;
  const refused = ['content-refusal', 'content-filtered'].includes(interruption?.category);
  const executionSuccess = success && exitCode === 0;
  const recoveryEligible = executionSuccess && !isPrivateSecurity && !interruption;
  const claimEligible = recoveryEligible && agent.result?.validationPassed !== false;
  const forge = await reconcileForgeReportedOutcome({
    agentId: agent.id, task, agent, workspacePath: agent.metadata?.workspacePath, existingRecord: agent,
    summarize: !isPrivateSecurity && !refused,
    reviewEligible: recoveryEligible, claimEligible, handoffEligible: claimEligible,
  });
  return {
    agent, task, isPrivateSecurity, interruption, refused, executionSuccess, ...forge,
    effectiveSuccess: isPrivateSecurity || refused || forge.deliveryHeld ? false : success,
    errorAnalysis: refused ? {
      category: interruption.category, origin: interruption.source || 'provider',
      message: 'Provider safety refusal; automatic continuation, retries and provider fallback are disabled.',
      permanent: true, actionable: false, requiresFallback: false,
    } : { message: errorMessage, category },
  };
}

async function settleRetiredDelivery(state) {
  const { agent, task, reportedOutcome, mergedReviewFollowUp, claimDisposition, executionSuccess, refused, isPrivateSecurity } = state;
  let { effectiveSuccess, deliveryHeld } = state;
  const recoveredHook = await dispatchRecoveredTaskOutputHook({
    agentId: agent.id, task, success: effectiveSuccess, workspacePath: agent.metadata?.workspacePath || null,
  });
  if (Number(task?.metadata?.auditDispositionVersion) === 1 && recoveredHook?.auditDisposition?.status !== 'complete') effectiveSuccess = false;
  const retirementCompletion = isCleanupOnlyRecovery(task) ? await verifyCleanupCompletion(task) : null;
  const validationPassed = resolveRecoveredValidation({ task, agent, effectiveSuccess, recoveredHook,
    retirementCompletion, mergedReviewFollowUp, claimDisposition });
  let taskOutcome = reportedOutcome || retirementCompletion ? resolveTaskOutcome({
    reported: retirementCompletion?.status === 'unverified'
      ? { status: 'incomplete', reason: retirementCompletion.reason } : reportedOutcome,
    success: effectiveSuccess, validationPassed, noCommitDeclared: declaresNoCommitCriterion(task),
  }) : null;
  if (effectiveSuccess && releaseDeliveryApplies(agent.metadata)) {
    const gated = await applyReleaseDeliveryGate(agent, taskOutcome);
    if (gated.held) {
      taskOutcome = gated.taskOutcome;
      deliveryHeld = true;
    }
  }
  if (['blocked', 'incomplete'].includes(taskOutcome?.status)) effectiveSuccess = false;
  const savedCleanup = isDeliveryCleanupHeld(task?.metadata) && task.metadata.deliveryRecoveryAgentId === agent.id;
  const cleanupAllowed = savedCleanup || (executionSuccess && validationPassed !== false
    && (agent.metadata?.isWorktree === true || hasClaimCheckoutBindings(agent.metadata)));
  const recoveryOutcome = !cleanupAllowed && taskOutcome?.recovery?.mode === 'cleanup' ? { ...taskOutcome, recovery: undefined } : taskOutcome;
  let recoveryUpdate = deliveryHeld && !refused && !isPrivateSecurity && task?.id && task.status !== 'completed'
    ? await resolveDeliveryRecoveryUpdate(task, recoveryOutcome, agent.id) : null;
  if (recoveryUpdate?.runtimeRecoveryContext) taskOutcome = recoveryUpdate.metadata.taskOutcome;
  return { ...state, recoveredHook, retirementCompletion, validationPassed, taskOutcome, deliveryHeld, effectiveSuccess, savedCleanup, recoveryUpdate };
}

async function recordRetiredAgent(state, { exitCode, duration, errorMessage, agentResultExtra = {} }) {
  const { agent, task, effectiveSuccess, executionSuccess, taskOutcome, errorAnalysis, isPrivateSecurity,
    validationPassed, claimDisposition, retirementCompletion, recoveredHook, refused, interruption, savedCleanup } = state;
  if (agent.metadata?.runId) {
    await completeAgentRun(
      agent.metadata.runId,
      await recoveredRunOutput(agent, isPrivateSecurity),
      exitCode, duration, errorAnalysis,
      effectiveSuccess ? null : false,
      { executionSuccess, taskOutcome },
    );
  }
  const persisted = await persistRecoveredTaskUpdate({ task, agent, recoveryUpdate: state.recoveryUpdate });
  const { recoveryUpdate, recoveryOwnershipLost } = persisted;
  await completeAgent(agent.id, {
    success: effectiveSuccess,
    executionSuccess,
    ...(recoveryUpdate ? { deliveryRecoveryOwned: true } : {}),
    ...(recoveryUpdate?.metadata?.deliveryRecoveryAgentId === agent.id ? { cleanupPending: true } : {}),
    ...(savedCleanup && !recoveryOwnershipLost ? { cleanupDeliveryVerified: true } : {}),
    taskOutcome,
    validationPassed,
    ...(claimDisposition ? { claimDisposition } : {}),
    ...(retirementCompletion ? { retirementCompletion } : {}),
    exitCode,
    duration,
    orphaned: true,
    error: errorMessage,
    ...agentResultExtra,
    ...(Number(task?.metadata?.auditDispositionVersion) === 1 ? {
      auditDisposition: recoveredHook?.auditDisposition || { status: 'unverified' },
    } : {}),
    ...(refused ? { success: false, error: errorAnalysis.message, errorAnalysis, executionInterruption: interruption } : {}),
  });
  return { ...state, recoveryUpdate, taskOutcome, effectiveSuccess };
}

async function releaseRetiredAgent({ agent, task, recoveryUpdate, recoveredHook }) {
  // Recovery retires the run without reaching finalizeAgent's completion
  // cleanup, so the sentinel has no other owner. Persist the outcome before
  // removing evidence. Lazy: completion cleanup imports worktree/PR orchestration,
  // while agentFinalization is on the static path of nearly every agent service.
  const { removeCompletionSentinel } = await import('./agentCompletionCleanup.js');
  const needsAuditRefresh = Number(task?.metadata?.auditDispositionVersion ?? agent.metadata?.auditDispositionVersion) === 1;
  const freshAgent = needsAuditRefresh ? await getAgentRecord(agent.id).catch(() => null) : null;
  const baseAgent = freshAgent || agent;
  const agentState = recoveredHook?.auditDisposition?.status === 'complete'
    ? { ...baseAgent, metadata: { ...baseAgent.metadata, auditFindings: { ...baseAgent.metadata?.auditFindings, status: 'complete' } } }
    : baseAgent;
  await removeCompletionSentinel({ agentId: agent.id, agentState, task })
    .catch(err => emitLog('warn', `Completion sentinel removal failed for ${agent.id}: ${err.message}`, { agentId: agent.id }));
  if (recoveryUpdate?.metadata?.retryPendingCleanup
    || DELIVERY_RECOVERY_BLOCKED_CATEGORIES.has(recoveryUpdate?.metadata?.blockedCategory)) {
    const { releaseRetryHold } = await import('./agentWorktreeCleanup.js');
    await releaseRetryHold({ agentId: agent.id, task, success: false, agentMetadata: agent.metadata })
      .catch(err => emitLog('warn', `Recovered delivery retry deferred for ${agent.id}: ${err.message}`, { agentId: agent.id }));
  }
}

export async function retireDeadAgent({ agent, task, success, exitCode, duration, errorMessage, category, agentResultExtra = {} }) {
  const prepared = await prepareRetiredAgent({ agent, task, success, exitCode, errorMessage, category });
  const settled = await settleRetiredDelivery(prepared);
  const recorded = await recordRetiredAgent(settled, { exitCode, duration, errorMessage, agentResultExtra });
  await releaseRetiredAgent(recorded);
  return { success: recorded.effectiveSuccess, taskOutcome: recorded.taskOutcome, deliveryHeld: recorded.deliveryHeld };
}
