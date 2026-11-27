/**
 * Agent Finalization
 *
 * The shared end-of-run path for ALL three spawn modes (runner-mode
 * `handleAgentCompletion`, the TUI `finish()` handler, and the direct-CLI
 * `close` handler): success-criteria
 * evaluation, the programmatic-I/O output hook, and the centralized state
 * writes (`completeAgent` / `updateTask` / run tracking).
 *
 * Extracted from `agentLifecycle.js` (issue #2837) to break the static import
 * cycle it sat in the middle of: `agentCliSpawning.js` and
 * `agentTuiSpawning.js` both need `finalizeAgent`, while
 * `agentLifecycle.js` imports BOTH spawners. This module is a leaf with
 * respect to that cluster — it must NOT import `agentLifecycle.js`,
 * `agentCliSpawning.js`, `agentTuiSpawning.js`, or `agentManagement.js`, or the
 * cycle comes straight back. `server/test/guards/modules/serviceImportCycles.test.js`
 * enforces that.
 */

import { storeCompletionData, completionReplayInput } from './agentCompletionData.js';
import { prepareCompletionTaskHandoff, recoverCompletionTaskHandoff } from './agentCompletionTaskHandoff.js';
import { prClaimWasVerified } from '../../lib/prDisposition.js';
import { isAuditTaskType } from '../../lib/auditCatalog.js';
import { isPrivateSecurityTask } from '../../lib/privateSecurityPolicy.js';
import { isTruthyMeta } from '../../lib/metadataFlags.js';
import { PREREQUISITE_BLOCKED_CATEGORIES, DELIVERY_RECOVERY_BLOCKED_CATEGORIES } from '../../lib/taskBlockCategories.js';
import { getAppDataForTask } from './agentAppWorkspace.js';
import { outsideGitMutationLifetime } from '../../lib/gitMutationLifetime.js';
import { emitLog } from '../cos/cosEvents.js';
import { getAgentRecord, updateAgent, completeAgent } from '../cos/cosAgentLifecycle.js';
import { updateTask } from '../cos/cosTaskStore.js';
import { isExpectedUnpersistedMiss } from '../../lib/autonomousJobTask.js';
import { getActiveProvider } from '../provider/providers.js';
import { markProviderUsageLimit, markProviderUnavailable } from '../provider/providerStatus.js';
import { resolveProviderBench } from '../../lib/provider/providerCooldown.js';
import { resolveTypeFailureSignal } from './agentErrorAnalysis.js';
import { completeAgentRun } from './agentRunTracking.js';
import { resolveTaskHookType } from '../taskTypeHooks.js';
import { processAgentCompletion } from './agentCompletion.js';
import { usesCreativeDirectorScratchCwd, removeCreativeDirectorScratchCwd } from '../../lib/spawnCwd.js';
import { applyDeliverySettlement } from './agentSuccessCriteria.js';
import { resolveForgeOutcome } from './agentForgeSettlement.js';
import { completionTaskFence } from './agentDeliveryRecovery.js';

export { applyDeliverySettlement, resolveForgeOutcome };
export { evaluateSuccessCriteria } from './agentSuccessCriteria.js';
export { retireDeadAgent } from './agentRetirement.js';
export { checkPrimaryCheckoutDrift } from './agentForgeSettlement.js';

/**
 * Stamp an LI hand-off's per-proposal execution verdict into a completion `taskUpdate`'s
 * federated metadata (#2779), mutating `taskUpdate.metadata` in place. Shared by every
 * agent-completion path that marks an LI hand-off task terminal — finalizeAgent (the main
 * path) AND the post-restart recovery path in handleAgentCompletion — so a hand-off that
 * completes through a bypass still federates its outcome to the originating peer (codex P2);
 * without this only finalizeAgent-completed hand-offs would ever reach peer A.
 *
 * `buildLiExecutionVerdict` reuses the exact validation-authoritative outcome + environmental
 * gate the LOCAL #2765 write uses, so both peers record the identical verdict; a non-hand-off
 * task (no `liProposal`) or an environmental completion yields null (no stamp). Best-effort
 * and defensive (runs outside the request lifecycle): a lazy-import/build failure logs and
 * leaves `taskUpdate` unstamped rather than throwing into the completion path. Lazy imports
 * keep the taskLearning/LI graphs off agentLifecycle's static chain.
 *
 * @param {object} taskUpdate  the update object about to be passed to updateTask (mutated)
 * @param {object} task        the persisted task (carries `metadata.liProposal` when a hand-off)
 * @param {{ success:boolean, validationPassed?:boolean|null, errorAnalysis?:object|null }} signals
 * @returns {Promise<object>} the same `taskUpdate` (stamped when applicable)
 */
export async function stampLiExecutionVerdict(taskUpdate, task, { success, validationPassed = null, errorAnalysis = null } = {}) {
  const liProposal = task?.metadata?.liProposal || null;
  if (!liProposal) return taskUpdate;
  try {
    const [{ buildLiExecutionVerdict }, { LI_EXECUTION_VERDICT_KEY }] = await Promise.all([
      import('../taskLearning/metrics.js'),
      import('../layeredIntelligenceOutcomes.js')
    ]);
    const verdict = buildLiExecutionVerdict({ liProposal, success, validationPassed, errorAnalysis, executedAt: new Date().toISOString() });
    if (verdict) {
      taskUpdate.metadata = { ...(taskUpdate.metadata || {}), [LI_EXECUTION_VERDICT_KEY]: verdict };
    }
  } catch (err) {
    emitLog('warn', `⚠️ Failed to stamp LI execution verdict for task ${task?.id}: ${err.message}`, { taskId: task?.id });
  }
  return taskUpdate;
}

async function sidelineFailedAgentProvider({ providerId, verdict, terminatedByUser }) {
  if (!verdict.success && !terminatedByUser && verdict.errorAnalysis) {
    // Bench the provider when the PROVIDER is what failed — not the agent's
    // work. `origin: 'provider'` is agentErrorAnalysis's provenance flag (#2642),
    // set only for structured provider chrome, never for a loose keyword sweep of
    // a transcript the agent itself wrote. Without a bench the provider stays
    // "available", so the very next dequeue picks it again and dies identically:
    // that is how one `agy` account-verification block could take down a whole
    // queue of tasks in under a minute. `resolveProviderBench` (shared with
    // promptRunner) picks the window and declines to bench request-specific
    // failures; the cooldown then routes the retry to a fallback
    // (agentProviderResolution.js) and auto-expires without anyone intervening.
    // Provenance is the WHOLE gate — deliberately not `|| category === 'usage-limit'
    // || category === 'rate-limit'`, which is what this used to key on. Those
    // categories have loose alternatives (a bare "rate limit" / "quota exceeded" an
    // agent's own failing test can print), so a category-only check benches a
    // healthy provider off the agent's transcript. Genuine limits already carry
    // `origin: 'provider'` via their `structuredMarker`, so nothing real is lost.
    // Every finalizeAgent caller analyzes through analyzeAgentFailure or
    // detectImmediateFallbackSignal, and both stamp an origin on every branch.
    const bench = verdict.errorAnalysis.origin === 'provider' ? resolveProviderBench(verdict.errorAnalysis) : null;
    // Lazy provider lookup — resolve the active provider only when a marker
    // fires AND the caller didn't already know the id, keeping the ordinary
    // failure path free of a settings-file read.
    const markerProviderId = bench ? providerId || (await getActiveProvider())?.id : null;
    if (markerProviderId) {
      // `markUsageLimit` parses its own window out of the provider's message
      // ("resets 5pm"), so a usage limit keeps its dedicated marker.
      const mark = bench.marker === 'usage-limit'
        ? markProviderUsageLimit(markerProviderId, verdict.errorAnalysis)
        : markProviderUnavailable(markerProviderId, {
          reason: bench.category,
          message: bench.message || 'Provider unavailable',
          waitTimeMs: bench.waitTimeMs
        });
      await mark.catch(err => {
        emitLog('warn', `Failed to sideline provider: ${err.message}`, { providerId: markerProviderId, category: bench.category });
      });
    }
  }
}

async function recordScheduledAgentOutcome({ agentId, task, verdict, terminatedByUser, hookResult, completedAt = null }) {
  // Type-level consecutive-failure ledger (#2616): feed the per-type
  // backoff/auto-park in taskSchedule. Only SCHEDULED task types carry
  // `metadata.analysisType`; user/ad-hoc tasks don't participate — so this gate
  // deliberately does NOT use resolveTaskHookType (#2727). That resolver falls back
  // to `task.taskType`, which for an ad-hoc task is the CoS queue category
  // ('internal', 'user'); ledgering those would invent a failure ledger for a
  // "task type" that no schedule owns. "Which tasks run a hook" and "which task
  // types back off" are genuinely different questions. The pure
  // resolveTypeFailureSignal decides success vs failure vs skip — including the
  // exit-0-but-unparseable-output case that must count as a failure.
  const scheduledType = task?.metadata?.analysisType || null;
  if (scheduledType) {
    const signal = resolveTypeFailureSignal({
      success: verdict.success,
      terminatedByUser,
      hookResult,
      errorCategory: verdict.errorAnalysis?.category
    });
    if (signal.record !== 'skip') {
      const ledgerAppId = task?.metadata?.app || null;
      const { recordTaskTypeFailure, recordTaskTypeSuccess } = await import('../taskSchedule.js');
      const ledgerUpdate = signal.record === 'failure'
        ? recordTaskTypeFailure(scheduledType, ledgerAppId, { errorCategory: signal.category })
        : completedAt !== null ? recordTaskTypeSuccess(scheduledType, ledgerAppId, { notAfter: completedAt })
          : recordTaskTypeSuccess(scheduledType, ledgerAppId);
      await ledgerUpdate.catch(err => {
        emitLog('warn', `⚠️ Task-type ledger update failed for ${scheduledType}: ${err.message}`, { taskType: scheduledType, agentId });
      });
    }
  }
}

function completionRecord({ task, verdict, hookResult, fidelity, executionInterruption, exitCode, duration, outputBuffer, validationPassed }) {
  return {
    success: verdict.success,
    validationPassed,
    ...(isAuditTaskType(resolveTaskHookType(task)) ? {
      auditAssessment: hookResult?.auditAssessment || { status: 'unverified' },
      ...(Number(task.metadata?.auditDispositionVersion) === 1 ? { auditDisposition: hookResult?.auditDisposition || { status: 'unverified' } } : {}),
    } : {}),
    exitCode,
    duration,
    outputLength: outputBuffer?.length ?? 0,
    errorAnalysis: verdict.errorAnalysis,
    ...(executionInterruption ? { executionInterruption } : {}),
    // Recorded whatever the verdict — a `ship` is the evidence that the gate ran
    // and cleared the run, which is what makes a run with no `goalFidelity` block
    // legible as "never judged" rather than "judged fine".
    ...(fidelity.review ? { goalFidelity: fidelity.review } : {}),
    ...(verdict.error !== undefined ? { error: verdict.error } : {}),
    ...(verdict.completionReason !== undefined ? { completionReason: verdict.completionReason } : {}),
  };
}

async function recordCompletionCleanupIntent({ agentId, cleanupOwner, task, deliverySuccess, outputBuffer, prEvidence }) {
  const priorCleanup = cleanupOwner?.metadata?.completionCleanup;
  const settledCleanup = ['completed', 'failed', 'abandoned'].includes(priorCleanup?.status);
  const replay = priorCleanup?.replay || (!settledCleanup && cleanupOwner?.startedAt ? await storeCompletionData(cleanupOwner, 'replay', completionReplayInput({ task,
    effectiveSuccess: deliverySuccess, outputBuffer,
    prClaimVerified: prClaimWasVerified(prEvidence.cleanupEvidence), branchProvenEmpty: prEvidence.branchProvenEmpty })) : undefined);
  await updateAgent(agentId, { metadata: { completionCleanup: { ...priorCleanup,
    version: 1, status: priorCleanup?.status || 'pending', stages: priorCleanup?.stages || {}, replay, context: undefined } } });
}

function completionRecoveryOwnership(metadata, agentId) {
  const recoveryAgent = metadata?.deliveryRecoveryAgentId === agentId;
  return {
    ...(DELIVERY_RECOVERY_BLOCKED_CATEGORIES.has(metadata?.blockedCategory)
      || metadata?.retryPendingCleanup === agentId || recoveryAgent ? { deliveryRecoveryOwned: true } : {}),
    ...(recoveryAgent ? { cleanupPending: true } : {}),
  };
}

// Private assessment transcripts stay in the local report; run history only
// points at it.
function completionRunOutput(task, success, outputBuffer) {
  if (!isPrivateSecurityTask(task)) return outputBuffer;
  return success
    ? 'Private security assessment: see the local Review Hub report.'
    : 'Private security assessment report was not verified; inspect the local assessment archive.';
}

/**
 * Shared end-of-run state writes for all three spawn paths
 * (`handleAgentCompletion` runner-mode, TUI `finish`, direct-CLI `close`).
 * Path-specific cleanup (worktree, sentinel removal, pty kill, in-memory
 * map deletes) stays at the calling site; this helper owns the
 * centralized state writes only.
 */
export async function finalizeAgent(input) {
  return outsideGitMutationLifetime(() => finalizeAgentInCompletionContext(input));
}

/**
 * @typedef {object} CompletionContext
 * @property {string} agentId
 * @property {object} task
 * @property {string} taskType
 * @property {string|null|undefined} runId
 * @property {string|null|undefined} providerId
 * @property {boolean} reportedSuccess
 * @property {number|null|undefined} exitCode
 * @property {number|null|undefined} duration
 * @property {string|undefined} outputBuffer
 * @property {string|null} finalSummary
 * @property {object|null|undefined} reportedErrorAnalysis
 * @property {object|null} executionInterruption
 * @property {boolean} terminatedByUser
 * @property {string|undefined} error
 * @property {string|undefined} completionReason
 * @property {string|null} workspacePath
 * @property {boolean} recovery
 * @property {boolean} prExpected
 * @property {number|null} startedAt
 * @property {boolean} executionSuccess
 * @property {number|null} runStartedAt
 */
/**
 * Normalize finalizeAgent's input into a typed completion context shared across
 * all finalization stages.
 *
 * @param {object} input
 * @returns {CompletionContext}
 */
export function createCompletionContext({
  agentId,
  task,
  runId,
  providerId,
  success: reportedSuccess,
  exitCode,
  duration,
  outputBuffer,
  finalSummary = null,
  errorAnalysis: reportedErrorAnalysis,
  executionInterruption = null,
  terminatedByUser = false,
  error,
  completionReason,
  workspacePath = null,
  recovery = false,
  prExpected = false,
  startedAt = null,
}) {
  const executionSuccess = reportedSuccess && (typeof exitCode !== 'number' || exitCode === 0);
  // The run window the commit criterion is evaluated against (#3637). Callers
  // that don't track their own start timestamp still know how long the run took,
  // and `duration` is measured from the same instant, so derive it — a missing
  // window would otherwise leave every such path permanently undeclared.
  //
  // `duration > 0`, not `>= 0`: the spawn-rejected path reports a zero-length
  // run because the agent never started. A window that cannot contain a commit
  // is not evidence of one, so it stays the null sentinel ("no criterion
  // evaluated") rather than recording a run that never happened as a miss.
  const runStartedAt = Number.isFinite(startedAt)
    ? startedAt
    : (Number.isFinite(duration) && duration > 0 ? Date.now() - duration : null);
  return {
    agentId,
    task,
    taskType: task?.taskType || 'user',
    runId,
    providerId,
    reportedSuccess,
    exitCode,
    duration,
    outputBuffer,
    finalSummary,
    reportedErrorAnalysis,
    executionInterruption,
    terminatedByUser,
    error,
    completionReason,
    workspacePath,
    recovery,
    prExpected,
    startedAt,
    executionSuccess,
    runStartedAt,
  };
}

/**
 * Stage 3 of agent finalization: persist LI verdict, cleanup intent, handoff
 * metadata, agent completion record, run tracking record, final task update,
 * provider sidelining, scheduled-task ledger, and scratch cleanup.
 *
 * @param {CompletionContext} ctx
 * @param {object} forgeOutcome
 * @param {object} settlement
 * @returns {Promise<object>}
 */
export async function recordCompletionArtifacts(ctx, forgeOutcome, settlement) {
  const {
    agentId, task, taskType, runId, providerId, exitCode, duration,
    outputBuffer, terminatedByUser, executionSuccess,
  } = ctx;
  const { executionInterruption, prEvidence, claimDisposition, retirementCompletion, fidelity } = forgeOutcome;
  const {
    hookResult, preHookTask, verdict, validationPassed, taskOutcome,
    deliverySuccess, deliveryVerdict, cleanupOwner, cleanupEligible, taskUpdate,
  } = settlement;

  // Each write shares the cosState mutex, but separate records are not atomic.
  // Persist cleanup intent first so a crash after completeAgent can replay only
  // the guarded task handoff; full finalization and hooks must not run twice.
  // completeAgentRun writes its own runs/<id>/metadata.json (separate lock),
  // so its place in the chain is purely about progress reporting on partial
  // failure.
  await stampLiExecutionVerdict(taskUpdate, task, {
    success: deliverySuccess, validationPassed, errorAnalysis: deliveryVerdict.errorAnalysis,
  });
  await recordCompletionCleanupIntent({ agentId, cleanupOwner, task, deliverySuccess, outputBuffer, prEvidence });
  if (cleanupEligible) {
    await prepareCompletionTaskHandoff(await getAgentRecord(agentId),
      Object.fromEntries(Object.entries(taskUpdate.metadata || {}).filter(([key, value]) =>
        key !== 'privateSecurityScope' && JSON.stringify(value) !== JSON.stringify(preHookTask.metadata?.[key]))));
  }
  // Persist the prerequisite BEFORE retiring execution. A crash between the
  // agent and task writes must never expose this dispatch to generic retry.
  const prerequisiteTaskResult = PREREQUISITE_BLOCKED_CATEGORIES.has(taskUpdate.metadata?.blockedCategory)
    ? await updateTask(task.id, taskUpdate, taskType, ...completionTaskFence(taskUpdate, cleanupOwner)) : null;
  if (prerequisiteTaskResult?.error || prerequisiteTaskResult?.statusChanged) {
    throw new Error('Delivery prerequisite task ownership changed before completion');
  }
  const completedAgent = await completeAgent(agentId, {
    ...completionRecord({
      task, verdict: deliveryVerdict, hookResult, fidelity, executionInterruption,
      exitCode, duration, outputBuffer, validationPassed,
    }),
    executionSuccess,
    taskOutcome,
    requireCheckoutSettlement: false,
    ...(claimDisposition ? { claimDisposition } : {}),
    ...(retirementCompletion ? { retirementCompletion } : {}),
    ...completionRecoveryOwnership(taskUpdate.metadata, agentId),
  });
  const capturePending = completedAgent?.result?.cleanupPending === true;
  if (capturePending) {
    taskUpdate.status = 'in_progress';
    taskUpdate.metadata = {
      ...taskUpdate.metadata,
      deliveryRecovery: 'cleanup',
      deliveryRecoveryAgentId: agentId,
      taskOutcome: completedAgent.result.taskOutcome,
    };
  }

  if (runId) {
    // Every failed verdict overrides exit-code/commit rescue in run tracking,
    // so the history cannot contradict the task or the cleanup decision (#3358).
    await completeAgentRun(
      runId,
      completionRunOutput(task, verdict.success, outputBuffer),
      exitCode,
      duration,
      deliveryVerdict.errorAnalysis,
      deliverySuccess ? null : false,
      { executionSuccess, taskOutcome },
    );
  }

  // The bounded source inventory belongs only to this run and its private
  // report. Task metadata is replicated to peers and reused in later prompts.
  if (isPrivateSecurityTask(task)) {
    delete task.privateSecurityScope;
    if (taskUpdate.metadata) delete taskUpdate.metadata.privateSecurityScope;
  }
  const taskResult = prerequisiteTaskResult || (capturePending
    ? await recoverCompletionTaskHandoff(await getAgentRecord(agentId)) || { error: 'Completion cleanup task ownership changed' }
    : await updateTask(task.id, taskUpdate, taskType, ...completionTaskFence(taskUpdate, cleanupOwner)));
  if (taskResult?.error && !isExpectedUnpersistedMiss(task, taskResult.error)) {
    const label = terminatedByUser ? 'blocked' : verdict.success ? 'completed' : 'failed';
    emitLog('warn', `⚠️ Failed to update ${label} task ${task.id}: ${taskResult.error} (taskType=${taskType})`, {
      taskId: task.id, agentId, error: taskResult.error,
    });
  }

  await sidelineFailedAgentProvider({ providerId, verdict, terminatedByUser });

  // Pending physical cleanup is a separate obligation. Record the validated
  // execution verdict now, with a timestamp fence against a newer failure.
  const cleanupExecution = capturePending && executionSuccess && validationPassed !== false;
  await recordScheduledAgentOutcome({
    agentId,
    task,
    verdict: cleanupExecution ? verdict : deliveryVerdict,
    terminatedByUser,
    hookResult,
    completedAt: cleanupExecution ? completedAgent.completedAt || '' : null,
  });

  await processAgentCompletion(agentId, task, deliverySuccess, outputBuffer);

  // If PortOS stamped `@me` + `in-progress` at spawn for a server-provisioned
  // claim and the run stopped with no PR (clean `no-action-needed` or a
  // terminal `blocked` on an empty branch), release those markers defensively
  // so an agent that forgot to unmark never leaves a zombie `in-progress` issue.
  const serverClaimTarget = isTruthyMeta(task.metadata?.claimServerCheckout)
    ? String(task.metadata?.claimTarget ?? '').trim()
    : '';
  const unusedServerClaim = /^\d+$/.test(serverClaimTarget)
    && !prEvidence.cleanupEvidence?.prs?.length
    && taskUpdate.status !== 'pending'
    && (taskOutcome?.status === 'no-action-needed'
      || (taskUpdate.status === 'blocked' && prEvidence.branchProvenEmpty === true));
  if (unusedServerClaim && task.metadata?.app) {
    const resolvedApp = await getAppDataForTask(task).catch(() => null);
    if (resolvedApp) {
      await import('../appIssues.js')
        .then(async ({ releaseAppIssueClaim }) => {
          const inboxIssue = task.metadata.githubIssueClaim;
          if (!inboxIssue) return releaseAppIssueClaim(resolvedApp, serverClaimTarget);
          const { resolveNotificationAgentEnv } = await import('../githubNotificationAgentAuth.js');
          const inboxEnv = await resolveNotificationAgentEnv(task);
          return releaseAppIssueClaim(resolvedApp, serverClaimTarget, {
            inboxIssue, inboxLogin: task.metadata.githubAccount?.login, inboxEnv,
          });
        })
        .catch(err => {
          emitLog('warn', `⚠️ Could not release unused claim markers for issue #${serverClaimTarget}: ${err.message}`, { agentId, taskId: task.id });
        });
    }
  }

  if (usesCreativeDirectorScratchCwd(task)) {
    await removeCreativeDirectorScratchCwd(agentId).catch((err) => {
      emitLog('warn', `⚠️ CD scratch cleanup failed for ${agentId}: ${err.message}`, { agentId });
    });
  }

  // Hand the CORRECTED verdict back so the caller's worktree cleanup runs on the
  // same answer this function just persisted (#3358). Without it, a run
  // downgraded to `pr-missing` would still be cleaned up as a success — worktree
  // removed, local branch deleted, and no resume pointer recorded — destroying
  // the state the retry needs to open the PR that is missing.
  return {
    success: capturePending ? false : deliverySuccess,
    taskOutcome,
    prClaimVerified: prClaimWasVerified(prEvidence.cleanupEvidence),
    branchProvenEmpty: prEvidence.branchProvenEmpty,
    cleanupEvidence: prEvidence.cleanupEvidence,
  };
}

async function finalizeAgentInCompletionContext(input) {
  const ctx = createCompletionContext(input);
  const forgeOutcome = await resolveForgeOutcome(ctx);
  const settlement = await applyDeliverySettlement(ctx, forgeOutcome);
  return recordCompletionArtifacts(ctx, forgeOutcome, settlement);
}
