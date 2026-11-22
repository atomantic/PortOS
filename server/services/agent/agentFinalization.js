import { isCleanupOnlyRecovery, verifyCleanupCompletion } from '../cleanupOnlyCompletion.js';
import { storeCompletionData, completionReplayInput } from './agentCompletionData.js';
import { completionDispatchFence, prepareCompletionTaskHandoff, recoverCompletionTaskHandoff } from './agentCompletionTaskHandoff.js';
import { hasClaimCheckoutBindings } from '../completedCheckoutEvidence.js';
import { hasClaimFlowContract } from '../../lib/claimFlowTaskTypes.js';
import { isLegacyDeepAudit } from '../../lib/auditWorkflow.js';
import { retryHoldMetadata, isDeliveryCleanupHeld } from '../../lib/taskRetryHold.js';
import { prClaimWasVerified } from '../../lib/prDisposition.js';
import { isAuditTaskType } from '../../lib/auditCatalog.js';
import { isPrivateSecurityTask } from '../../lib/privateSecurityPolicy.js';
import { isTruthyMeta } from '../../lib/metadataFlags.js';
import { getAppDataForTask } from './agentAppWorkspace.js';
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

import { join } from 'path';
import { normalizeTaskOutcome, resolveTaskOutcome } from '../../lib/agent/agentOutcome.js';
import { outsideGitMutationLifetime } from '../../lib/gitMutationLifetime.js';
import { PATHS, safeJSONParse, tryReadFile, } from '../../lib/fileUtils.js';
import { emitLog } from '../cos/cosEvents.js';
import { getAgentRecord, updateAgent, completeAgent } from '../cos/cosAgentLifecycle.js';
import { updateTask } from '../cos/cosTaskStore.js';
import { isExpectedUnpersistedMiss } from '../../lib/autonomousJobTask.js';
import { getActiveProvider } from '../provider/providers.js';
import { markProviderUsageLimit, markProviderUnavailable } from '../provider/providerStatus.js';
import { resolveProviderBench } from '../../lib/provider/providerCooldown.js';
import { resolveFailedTaskDecision, resolveFailedTaskUpdate, resolveTypeFailureSignal, resolveUndeliveredTaskUpdate } from './agentErrorAnalysis.js';
import { resolveAgentFinalVerdict } from '../../lib/agent/agentFinalVerdict.js';
import { completeAgentRun } from './agentRunTracking.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { committedDuringRun, } from '../../lib/gitCommitProbe.js';
import { detectPrimaryCheckoutDrift } from '../../lib/primaryCheckoutGuard.js';
import { isProgrammaticIoTaskType, resolveTaskHookType, declaresNoCommitCriterion, isClaimFlowDispatch, } from '../taskTypeHooks.js';
import { processAgentCompletion } from './agentCompletion.js';
import { extractFinalSummary } from './agentSummaryExtraction.js';
import { usesCreativeDirectorScratchCwd, removeCreativeDirectorScratchCwd } from '../../lib/spawnCwd.js';
import { isUpdateRepoRepairTask, verifyUpdateRepoRepairCompletion } from '../updateRepoRepairCompletion.js';
import { permitsNoChangeCompletion } from '../../lib/noChangeCompletion.js';
import { PR_OBSERVATION, PR_OBSERVATION_POLICY, prObservation, prVerdictFromObservation, observePrClaim, } from './agentPrVerification.js';
import { followUpAgentGoalFidelity, reviewGoalFidelity } from './agentGoalFidelity.js';
import { dispatchTaskOutputHookOnce, dispatchRecoveredTaskOutputHook, resolveProgrammaticIoVerdict } from './agentOutputHookDispatch.js';
/**
 * Evaluate a completed autonomous run against its DECLARED success criteria
 * (issue #2344). Distinct from the runner's exit-code `success`: it answers
 * "did the run actually produce the work it was supposed to?" using the one
 * machine-checkable criterion the CoS can actually observe — did the run leave
 * a commit behind inside its own run window (`committedDuringRun`)?
 *
 * That probe replaced a task-id commit-marker grep in #3637. NOTHING ever
 * emitted that marker — no prompt, template, or slashdo command asked an agent
 * to stamp a task id into a commit subject, and the root AGENTS.md forbids
 * exactly that shape of subject line — so the criterion was unsatisfiable and
 * stamped `validationPassed: false` on every ordinary code-editing run,
 * poisoning the task-learning buckets it feeds.
 *
 * Returns a null sentinel when NO criterion is declared (interactive/user tasks,
 * user-terminated runs, or a run with no task id / workspace / run window to
 * validate against), so downstream telemetry never conflates "not declared" with
 * "declared and failed". For autonomous tasks it verifies the commit on BOTH
 * success and failure — a clean exit that committed nothing is an honest miss,
 * and that is exactly the signal task-learning wants. `committedDuringRun` is
 * non-throwing and hard-timeout-bounded, so a non-repo workspace or a hung git
 * degrades to "no commit" rather than stalling finalize.
 *
 * `startedAt` (epoch ms) bounds the window. A non-finite value means we can't
 * tell this run's commits from anything already in the repo, so the criterion is
 * undeclared (null) rather than a manufactured `false`.
 *
 * `hookResult` is the programmatic-I/O output-hook result (from
 * `dispatchTaskOutputHook`), which finalizeAgent resolves BEFORE calling this so
 * those task types can be judged by their real deliverable; `success` is the
 * runner's exit-code verdict that hook result is weighed against. Both are
 * absent/null for every other task shape.
 *
 * That branch is also the only one that can return `SKIP_LEARNING_VERDICT` — the
 * third answer, meaning "nothing evaluated this run, so don't record it at all"
 * (#4107). It rides `result.validationPassed` like the boolean/null verdicts and
 * is consumed by `buildTaskTelemetryContext`; see `lib/learningVerdict.js`.
 *
 * @returns {Promise<boolean|null|'skip-learning'>}
 */
export async function evaluateSuccessCriteria({ agentId = null, task, terminatedByUser, workspacePath, startedAt = null, success = false, hookResult = null, branchProvenEmpty = false, emptyBranchInconclusiveEvidence = null, claimDisposition = null, mergedReviewFollowUp = null, retirementCompletion = null, runtimeContinuation = null, prWatcherTargetsSettled = null }) {
  if (terminatedByUser) return null;
  if (isUpdateRepoRepairTask(task)) return success
    && await verifyUpdateRepoRepairCompletion(task, agentId, workspacePath).catch(() => false);
  if (isCleanupOnlyRecovery(task)) return (retirementCompletion || await verifyCleanupCompletion(task))?.status === 'verified';
  if (success && mergedReviewFollowUp?.status === 'verified') return true;
  const taskType = task?.taskType || 'user';
  // The SCHEDULED type (`metadata.analysisType`) if any, else the queue category —
  // the same resolution the programmatic-I/O gate uses, reused for the coordinator
  // gate below so both key on the task's real type, not the CoS bucket ('internal').
  const scheduledType = resolveTaskHookType(task);
  // Programmatic-I/O tasks (taskTypeHooks.js) declare their OWN criterion — the
  // sentinel parsed and the hook accepted it — so this branch comes FIRST: it is
  // keyed on the hook result rather than on a workspace/commit, and must not be
  // pre-empted by the `!workspacePath` bail below (a hook that already ran and
  // threw is a real verdict even if the worktree is gone). Their prompts
  // explicitly FORBID committing or opening a PR (the worktree is discarded), so
  // the commit criterion would mark every correct run a failure (#2700).
  // Judging them purely by exit code instead is also wrong: an exit-0 run whose
  // `.agent-done` sentinel was missing/malformed, or whose hook threw, produced
  // nothing usable and must be recorded as the failure it is (#2727).
  if (isProgrammaticIoTaskType(scheduledType)) {
    return resolveProgrammaticIoVerdict({ success, hookResult });
  }
  // Only the server-owned selected-issue verifier supplies this proof. Ordinary
  // claim shipping keeps its existing PR/fidelity gates and undeclared criterion.
  if (success && hasClaimFlowContract(task) && claimDisposition?.status === 'verified') return true;
  if (success && runtimeContinuation?.status === 'verified') return true;
  if (success && prWatcherTargetsSettled?.status === 'verified') return true;
  // Interactive/user tasks declare no machine-checkable criterion; neither does
  // a run missing the task id or workspace needed to validate.
  if (taskType === 'user' || !task?.id || !workspacePath) return null;
  // A PortOS-owned audit can validly conclude that its shipped data is current.
  // `branchProvenEmpty` is only set by verifyPrClaim after the forge answered that
  // no PR exists AND the branch was proven empty; the task marker narrows this
  // exception to an explicitly opted-in autonomous job. Do not use the marker
  // as a general no-commit exemption: a real change still needs the commit probe.
  if (success && branchProvenEmpty === true && permitsNoChangeCompletion(task)) {
    // An empty audit branch is valid only when its actual report was saved.
    return !isAuditTaskType(scheduledType) || hookResult?.auditAssessment?.status === 'recorded';
  }
  // A marked no-change audit needs a forge answer and an unambiguous empty-branch
  // proof. If either check was inconclusive, leave learning undeclared rather than
  // scoring a correct no-op as a commit miss. A non-empty branch remains a real
  // change path and still uses the ordinary commit criterion below.
  if (success && permitsNoChangeCompletion(task) && emptyBranchInconclusiveEvidence?.inconclusive === true) return null;
  // Pipeline/media tasks deliver artifacts, not a commit — the
  // commit criterion doesn't apply, so don't mislabel a clean artifact run as a
  // validation miss (which would also pollute the correlation window). null =
  // no commit criterion declared for this task shape. Unlike programmatic-I/O
  // tasks they register no output hook, so there is no deliverable signal to
  // judge them by — they stay exit-code-judged (unchanged by #2727).
  if (task?.metadata?.pipeline || task?.metadata?.mediaJob) return null;
  // gh/git/external COORDINATOR task types (NON_COMMITTING_COORDINATOR_TASK_TYPES in
  // taskTypeHooks.js — branch-reconcile/issue-reconcile/branch-cleanup/jira-status-report)
  // deliver their work as a side effect — a merged PR, a resolved conflict, a deleted
  // branch, a posted report — and by design NEVER produce a commit. Because
  // their workspacePath IS set (the app's live checkout), the commit check above would
  // return false on every SUCCESSFUL run and drive their learning bucket to ~0% (#2696) —
  // the same artifact #2700 fixed for the programmatic-I/O reasoning run. They register no
  // output hook, so like pipeline/media jobs there is no deliverable signal to judge them
  // by; fall back to the exit code (null = criterion undeclared). Uses the predicate (not a
  // bare `scheduledType` lookup) so the archived `taskAnalysisType` shape resolves the same
  // way the learning bucket does — see isNonCommittingCoordinatorTask.
  //
  // ALSO covers the per-task `worktreeChangesExpected: false` signal the
  // tracker-filing types (reference-watch / ux) stamp at dispatch: on a
  // github/gitlab/jira app they file issues/tickets out of band and make no
  // commit at all, so the commit check would score every SUCCESSFUL run as a
  // failure — the #2696 artifact again. The flag is per-task, not type-keyed,
  // so the same type still gets its commit criterion on a `plan`-tracker app
  // where it legitimately commits PLAN.md items (#3273).
  if (declaresNoCommitCriterion(task)) return null;
  // A CLAIM flow (plan-task / claim-issue / claim-issue-gitlab / claim-issue-jira /
  // claim-work) commits in the claim/<item> worktree the AGENT cuts, not in this
  // workspace — the app's live checkout on the common path, since CoS keeps
  // `useWorktree` false so it never provisions a nested worktree. The run-window
  // probe is workspace-scoped, so it sees nothing and the declared false OVERRIDES
  // the exit code in task-learning, scoring every successful claim run a failure
  // and pinning the type's bucket at ~0% — the #2696 artifact by a new route.
  // The goal-fidelity gate still judges the run against the claimed issue's
  // requirements, so the exit code (not the probe) is the honest criterion here.
  // Not folded into declaresNoCommitCriterion: that predicate also gates the
  // goal-fidelity gate's no-diff bail, which claim flows must NOT take — their
  // claim-worktree diff is exactly what the fidelity review reads.
  if (isClaimFlowDispatch(task)) return null;
  // No usable run window means no way to attribute a commit to THIS run — the
  // sentinel, not a false verdict (#3637).
  if (!Number.isFinite(startedAt)) return null;
  return await committedDuringRun(workspacePath, startedAt);
}

/**
 * Branch-jack check (#3680): did this WORKTREE agent commit to the primary
 * checkout instead of its own worktree?
 *
 * Reads the `primaryCheckoutBaseline` that `agentLifecycle.js` stamped onto the
 * agent record at spawn time and re-reads that checkout now. Living here rather
 * than in the TUI spawner is what makes the guard apply to all three spawn modes
 * — TUI `finish()`, direct-CLI `close`, and runner-mode `handleAgentCompletion`
 * all funnel through `finalizeAgent` — without triplicating it.
 *
 * Non-worktree runs carry no baseline (they legitimately work IN the primary),
 * so they short-circuit to "no drift" before any git call.
 *
 * @returns {Promise<{drifted: boolean, message?: string, suggestedFix?: string, category?: string}>}
 */
export async function checkPrimaryCheckoutDrift(agentId) {
  const agent = await getAgentRecord(agentId).catch(() => null);
  const baseline = agent?.metadata?.primaryCheckoutBaseline || null;
  if (!baseline) return { drifted: false };
  return await detectPrimaryCheckoutDrift(baseline, { agentBranch: agent?.metadata?.worktreeBranch || null });
}

/** Server-owned merge evidence settles only the assigned review/merge target. */
async function completionReviewFollowUp({ task, agentId, workspacePath, reportedOutcome, eligible }) {
  if (!eligible) return null;
  const verified = await (await import('../reviewFollowUpCompletion.js')).verifyMergedReviewFollowUp(task, workspacePath)
    .catch(() => null);
  if (!verified) return null;
  const taskOutcome = {
    status: reportedOutcome?.status === 'completed' ? 'completed' : 'no-action-needed',
    reason: `The assigned review/merge target is verified MERGED: ${verified.prUrl}. Preserved corrections and checkout retirement remain separate obligations.`,
  };
  await updateAgent(agentId, { metadata: { taskOutcome, taskOutcomeSource: 'forge-verification',
    reportedTaskOutcome: reportedOutcome, mergedReviewFollowUp: verified } });
  return { ...verified, taskOutcome };
}

async function completionClaimDisposition({ task, agent, agentId, reportedOutcome, success }) {
  if (!success || !['no-action-needed', 'blocked'].includes(reportedOutcome?.status)
    || reportedOutcome.recovery || !hasClaimFlowContract(task)) return null;
  return import('../claimDisposition.js').then(async ({ verifyClaimDisposition }) =>
    verifyClaimDisposition({ task, agent: agent || await getAgentRecord(agentId), reportedOutcome, success }))
    .catch(() => ({ status: 'unverified', reason: 'tracker-unavailable' }));
}

async function completionClaimOutcome(agentId, reportedOutcome, claimDisposition) {
  if (claimDisposition?.status !== 'verified' || reportedOutcome?.status !== 'blocked'
    || !claimDisposition.issues?.some(issue => issue.disposition === 'operator-blocked')) return reportedOutcome;
  const taskOutcome = { status: 'no-action-needed',
    reason: 'The selected claim disposition was independently verified. No actionable work remains for this attempt; operator-blocked issues remain open for their documented unblock condition.' };
  await updateAgent(agentId, { metadata: { taskOutcome, taskOutcomeSource: 'forge-verification',
    reportedTaskOutcome: reportedOutcome } });
  return taskOutcome;
}

// A claim held only by a required human approval has done everything a run
// can: the open PR is the human's queue item, so a retry or an operator block
// would only duplicate it. An unverifiable hold keeps its bounded retry.
async function completionReviewHandoff({ task, agent, agentId, reportedOutcome, eligible }) {
  if (!eligible || !['blocked', 'incomplete'].includes(reportedOutcome?.status)
    || reportedOutcome.recovery || !hasClaimFlowContract(task)) return null;
  const handoff = await import('../claimReviewHandoff.js').then(async ({ verifyClaimReviewHandoff }) =>
    verifyClaimReviewHandoff({ task, agent: agent || await getAgentRecord(agentId), reportedOutcome, success: true }))
    .catch(() => null);
  if (handoff?.status !== 'verified') return null;
  const waiting = handoff.pullRequests.filter(pr => pr.awaitingHumanReview).map(pr => pr.url || `#${pr.number}`);
  const taskOutcome = { status: 'completed',
    reason: `Handed off for human review: ${waiting.join(', ')} ${waiting.length === 1 ? 'is' : 'are'} published with passing checks and waiting only on a required approving review that a person must give. The claim branch and checkout stay in place until the PR merges.` };
  await updateAgent(agentId, { metadata: { taskOutcome, taskOutcomeSource: 'forge-verification',
    reportedTaskOutcome: reportedOutcome, reviewHandoff: handoff } });
  return { ...handoff, taskOutcome };
}

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
export async function retireDeadAgent({ agent, task, success, exitCode, duration, errorMessage, category, agentResultExtra = {} }) {
  if (agent.metadata?.taskAnalysisType === 'security' && agent.metadata.useRunner) {
    const { settleAgentSecurityScan } = await import('./agentSecurityScan.js');
    const scanner = await settleAgentSecurityScan(agent.id);
    if (scanner?.status === 'refused') agent = { ...agent, metadata: { ...agent.metadata,
      executionInterruption: { category: 'content-refusal', source: 'security-scanner' } } };
  }
  const isPrivateSecurity = isPrivateSecurityTask(task) || isPrivateSecurityTask(agent);
  const interruption = agent.metadata?.executionInterruption;
  const refused = ['content-refusal', 'content-filtered'].includes(interruption?.category);
  const reportedCompletion = !isPrivateSecurity && !refused
    ? await persistCompletionSummary(agent.id, { workspacePath: agent.metadata?.workspacePath, existingRecord: agent }) : null;
  let reportedOutcome = reportedCompletion?.taskOutcome ?? null;
  const executionSuccess = success && exitCode === 0;
  const recoveryEligible = executionSuccess && !isPrivateSecurity && !interruption;
  const mergedReviewFollowUp = await completionReviewFollowUp({ task, agentId: agent.id,
    workspacePath: agent.metadata?.workspacePath, reportedOutcome,
    eligible: recoveryEligible });
  if (mergedReviewFollowUp) reportedOutcome = mergedReviewFollowUp.taskOutcome;
  const claimDisposition = await completionClaimDisposition({ task, agent, reportedOutcome,
    success: recoveryEligible && agent.result?.validationPassed !== false });
  reportedOutcome = await completionClaimOutcome(agent.id, reportedOutcome, claimDisposition);
  const reviewHandoff = await completionReviewHandoff({ task, agent, agentId: agent.id, reportedOutcome,
    eligible: recoveryEligible && agent.result?.validationPassed !== false });
  if (reviewHandoff) reportedOutcome = reviewHandoff.taskOutcome;
  // Only an explicit hold suppresses orphan recovery; a failed delivery check
  // must retain the caller's normal failure/retry handling.
  let deliveryHeld = ['blocked', 'incomplete'].includes(reportedOutcome?.status);
  let effectiveSuccess = isPrivateSecurity || refused || deliveryHeld ? false : success;
  const errorAnalysis = refused ? {
    category: interruption.category, origin: interruption.source || 'provider',
    message: 'Provider safety refusal; automatic continuation, retries and provider fallback are disabled.',
    permanent: true, actionable: false, requiresFallback: false,
  } : { message: errorMessage, category };

  const recoveredHook = await dispatchRecoveredTaskOutputHook({
    agentId: agent.id,
    task,
    success: effectiveSuccess,
    workspacePath: agent.metadata?.workspacePath || null,
  });

  if (Number(task?.metadata?.auditDispositionVersion) === 1 && recoveredHook?.auditDisposition?.status !== 'complete') effectiveSuccess = false;
  const retirementCompletion = isCleanupOnlyRecovery(task) ? await verifyCleanupCompletion(task) : null;
  const validationPassed = resolveRecoveredValidation({ task, agent, effectiveSuccess, recoveredHook,
    retirementCompletion, mergedReviewFollowUp, claimDisposition });
  let taskOutcome = reportedOutcome || retirementCompletion ? resolveTaskOutcome({ reported: retirementCompletion?.status === 'unverified'
    ? { status: 'incomplete', reason: retirementCompletion.reason } : reportedOutcome,
    success: effectiveSuccess, validationPassed, noCommitDeclared: declaresNoCommitCriterion(task) }) : null;
  if (effectiveSuccess && (agent.metadata?.taskAnalysisType === 'do-release'
    || agent.metadata?.releasePublication?.synchronizationHandoffVersion === 2)) {
    const { verifyReleaseDelivery } = await import('../releaseDeliveryGate.js');
    const delivery = await verifyReleaseDelivery(agent, taskOutcome);
    if (delivery && !delivery.verified) {
      taskOutcome = { status: 'incomplete', reason: `Release synchronization is unfinished: ${delivery?.reason || 'evidence unavailable'}` };
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

  if (agent.metadata?.runId) {
    await completeAgentRun(
      agent.metadata.runId,
      await recoveredRunOutput(agent, isPrivateSecurity),
      exitCode,
      duration,
      errorAnalysis,
      effectiveSuccess ? null : false,
      { executionSuccess, taskOutcome },
    );
  }

  const persisted = await persistRecoveredTaskUpdate({ task, agent, recoveryUpdate });
  recoveryUpdate = persisted.recoveryUpdate;
  const { recoveryOwnershipLost } = persisted;
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
    ...(Number(task?.metadata?.auditDispositionVersion) === 1 ? { success: effectiveSuccess,
      auditDisposition: recoveredHook?.auditDisposition || { status: 'unverified' } } : {}),
    ...(refused ? { success: false, error: errorAnalysis.message, errorAnalysis, executionInterruption: interruption } : {}),
  });

  // Recovery retires the run without reaching finalizeAgent's completion
  // cleanup, so the sentinel has no other owner — and the hook above was the
  // last consumer of its payload. Persist the outcome before removing evidence.
  // Keep this recovery-only dependency lazy: the
  // completion-cleanup module also imports worktree/PR orchestration, while
  // agentFinalization is on the static path of nearly every agent service.
  const { removeCompletionSentinel } = await import('./agentCompletionCleanup.js');
  await removeCompletionSentinel({ agentId: agent.id, agentState: agent })
    .catch(err => emitLog('warn', `Completion sentinel removal failed for ${agent.id}: ${err.message}`, { agentId: agent.id }));

  if (recoveryUpdate?.metadata?.retryPendingCleanup
    || ['task-approval', 'task-recovery-exhausted', 'runtime-verification'].includes(recoveryUpdate?.metadata?.blockedCategory)) {
    const { releaseRetryHold } = await import('./agentWorktreeCleanup.js');
    await releaseRetryHold({ agentId: agent.id, task, success: false, agentMetadata: agent.metadata })
      .catch(err => emitLog('warn', `Recovered delivery retry deferred for ${agent.id}: ${err.message}`, { agentId: agent.id }));
  }

  return { success: effectiveSuccess, taskOutcome, deliveryHeld };
}

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

// A no-change audit needs forge + empty-branch proof even when its spawner
// leaves PR creation to cleanup. Reuse a completed primary check; a thrown
// check is inconclusive, never proof that there was nothing to ship.
//
// The "could not prove it" marker is a branch-less `forge-unavailable`: we tried
// and learned nothing, which is what keeps `evaluateSuccessCriteria` from
// scoring a correct no-op as a commit miss.
async function resolveNoChangeObservation({
  noChangeAudit, prExpected, primaryObservation,
  task, workspacePath, success, agentId, agentSummary = null,
}) {
  if (!noChangeAudit) return null;
  const unproven = prObservation(PR_OBSERVATION.FORGE_UNAVAILABLE, { inconclusive: true });
  if (prExpected) return primaryObservation.outcome === PR_OBSERVATION.CHECK_THREW ? unproven : primaryObservation;
  return observePrClaim({ task, workspacePath, success, prExpected: true, agentSummary })
    .catch(err => {
      emitLog('warn', `⚠️ No-change verification failed for ${agentId}: ${err.message}`, { agentId });
      return unproven;
    });
}

/**
 * Project the primary observation (and the auxiliary no-change proof, when one
 * was taken) onto the four answers finalize actually needs. One place decides
 * all four, so a rule repaired in one of them cannot drift out of the others —
 * which is how #4540 and #5074 each had to be applied three times.
 *
 * Authority is asymmetric, and deliberately so:
 *   - COMPLETION is the primary check's alone. The auxiliary proof is taken for
 *     spawners that leave PR creation to cleanup, so a non-empty auxiliary
 *     branch is not a delivery failure — cleanup still has to open that PR after
 *     finalize (#5074). It must never downgrade a run.
 *   - EVIDENCE (ledger + cleanup) may fall back to the auxiliary proof, but only
 *     where the primary named no branch at all AND the proof is a positive
 *     `empty-branch`. Anything weaker leaves cleanup free to ask the forge again
 *     and create the PR.
 */
function resolvePrEvidence({ primaryObservation, noChangeObservation }) {
  const primary = PR_OBSERVATION_POLICY[primaryObservation.outcome];
  const provenEmpty = (observation) => observation?.outcome === PR_OBSERVATION.EMPTY_BRANCH;
  const evidence = !primary.namesBranch && provenEmpty(noChangeObservation)
    ? noChangeObservation
    : primaryObservation;
  const evidencePolicy = PR_OBSERVATION_POLICY[evidence.outcome];
  return {
    completionOk: primary.completionOk,
    completionVerdict: prVerdictFromObservation(primaryObservation),
    branchProvenEmpty: provenEmpty(primaryObservation) || provenEmpty(noChangeObservation),
    emptyBranchInconclusiveEvidence: noChangeObservation ? prVerdictFromObservation(noChangeObservation) : null,
    // The branch the surviving evidence names, for the operator-facing log line.
    evidenceBranch: evidence.branch || noChangeObservation?.branch || null,
    ledgerEntry: evidencePolicy.recordable
      ? {
        verified: evidencePolicy.completionOk,
        branch: evidence.branch,
        category: evidencePolicy.category,
        branchProvenEmpty: provenEmpty(evidence),
      }
      : null,
    cleanupEvidence: prVerdictFromObservation(evidence),
  };
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

function logPrimaryCheckoutDrift(agentId, task, drift) {
  if (drift.drifted) {
    emitLog('warn', `${drift.message} — reported by ${agentId}; PortOS will not repair it automatically`, {
      agentId, taskId: task?.id, category: drift.category
    });
  } else if (drift.unattributed) {
    // #3703: commits WERE stranded on the primary, but none are patch-equivalent
    // to this agent's own branch — another actor (a coding-on-main agent, the
    // human's terminal, `update.sh`'s pull) moved it. Unreviewed commits on the
    // primary are still worth surfacing, but this run did not cause them, so it is
    // warn-logged WITHOUT downgrading an otherwise-successful run to a failure.
    emitLog('warn', `${drift.message} — not attributable to ${agentId}; this run stays successful`, {
      agentId, taskId: task?.id
    });
  } else if (drift.fastForwarded) {
    // Movement without stranded commits — a pull, not a branch-jack. Logged so
    // "the primary moved during this run" stays visible without being a failure.
    emitLog('info', `↪️ Primary checkout moved ${drift.commitCount ?? '?'} commit(s) during ${agentId}, all already upstream — not a branch-jack`, {
      agentId, taskId: task?.id
    });
  }
}

function logPrCompletionVerdict({ agentId, task, prEvidence, primaryPrObservation }) {
  const prCompletionVerdict = prEvidence.completionVerdict;
  if (!prEvidence.completionOk) {
    emitLog('warn', `⚠️ ${prCompletionVerdict.message} — recording ${agentId} as needs-attention (${prCompletionVerdict.category}) rather than complete`, {
      agentId, taskId: task?.id, branch: prCompletionVerdict.branch, category: prCompletionVerdict.category
    });
  } else if (prEvidence.branchProvenEmpty) {
    // A no-op run is a legitimate completion, not a silent one — the human still
    // wants to know a task burned an agent and concluded there was nothing to do.
    emitLog('info', `🫧 ${agentId} opened no change request and committed nothing to ${prEvidence.evidenceBranch} — recording the run as complete with no change warranted`, {
      agentId, taskId: task?.id, branch: prEvidence.evidenceBranch
    });
  } else if (primaryPrObservation.outcome === PR_OBSERVATION.WORK_LANDED_ELSEWHERE) {
    // The parallel-claim stand-down: this run's commits are redundant, the work
    // itself is on the default branch via a change request the forge confirmed
    // merged. Worth surfacing — the branch cleanup will discard the duplicate
    // commits, and the human should know why.
    emitLog('info', `🤝 ${agentId} opened no change request for ${prEvidence.evidenceBranch} but its summary's landed work was verified merged — recording the run as complete`, {
      agentId, taskId: task?.id, branch: prEvidence.evidenceBranch
    });
  }
}

/**
 * Task-specific corrections to the output hook's result, applied in this order.
 * Returns the hook result unchanged when neither applies.
 */
function correctHookResultForTask(task, hookResult) {
  let corrected = hookResult;
  // A private assessment's deliverable is the validated, persisted report.
  // A skipped, thrown or timed-out hook cannot establish that deliverable,
  // even when the CLI exited zero. Keep other task types' existing semantics.
  if (isPrivateSecurityTask(task) && (!corrected?.ran || corrected.threw
    || corrected.outcome?.accepted !== true)) {
    corrected = {
      ...corrected,
      ran: true,
      outcome: corrected?.outcome?.accepted === false ? corrected.outcome : {
        accepted: false,
        permanent: true,
        reason: 'private-security-report-unverified',
        message: 'Private assessment report was not validated and saved. Inspect the local output and retry explicitly.',
      },
    };
  }

  // A persisted assessment or delivered PR cannot hide an untracked finding.
  // Keep assessment, execution and disposition as separate evidence.
  if (Number(task.metadata?.auditDispositionVersion) === 1
    && corrected?.auditDisposition?.status !== 'complete') {
    corrected = { ...corrected, ran: true, outcome: {
      accepted: false, permanent: true, reason: 'audit-disposition-incomplete',
      message: 'Audit findings are not fully disposed: ' + (corrected?.auditDisposition?.reason || 'register could not be verified and saved'),
    } };
  }
  return corrected;
}

function hookTaskMetadataPatch(hookResult) {
  const hookOutcome = hookResult?.outcome;
  return hookOutcome?.taskMetadata && typeof hookOutcome.taskMetadata === 'object'
    && !Array.isArray(hookOutcome.taskMetadata)
    ? hookOutcome.taskMetadata
    : null;
}

/**
 * The task write for a finished run. `preHookTask` is the task as it stood
 * before the hook's metadata patch; only a success, or a failure the hook itself
 * judged, carries that patch forward (see the hookMetadata note in finalizeAgent).
 */
async function resolveFinalTaskUpdate({ task, preHookTask, hookMetadata, verdict, terminatedByUser, agentId }) {
  if (isLegacyDeepAudit(task.metadata) && !terminatedByUser) {
    return { status: 'in_progress', metadata: { ...preHookTask.metadata, ...retryHoldMetadata(agentId) } };
  }
  if (terminatedByUser) {
    return {
      status: 'blocked',
      metadata: {
        ...preHookTask.metadata,
        blockedReason: 'Terminated by user',
        blockedCategory: 'user-terminated',
        blockedAt: new Date().toISOString(),
      },
    };
  }
  if (verdict.success) {
    return hookMetadata ? { status: 'completed', metadata: task.metadata } : { status: 'completed' };
  }
  return resolveFailedTaskUpdate(verdict.source === 'hook' ? task : preHookTask, verdict.errorAnalysis, agentId);
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

const PREREQUISITE_BLOCKED_CATEGORIES = ['runtime-verification', 'internal-dependency', 'internal-dependency-unverified'];
const DELIVERY_RECOVERY_BLOCKED_CATEGORIES = ['task-approval', 'task-recovery-exhausted', ...PREREQUISITE_BLOCKED_CATEGORIES];

// Folds an explicit task hold and any scanner/provider safety refusal into the
// reported execution state the verdict ladder reads. A cleanup-only hold keeps
// the reported success; a refusal is persisted as the run's interruption.
async function settleReportedExecution({ agentId, task, reportedTaskOutcome, deliveryHeld, ...reported }) {
  let { reportedSuccess, error, reportedErrorAnalysis, executionInterruption } = reported;
  if (deliveryHeld && reportedTaskOutcome.recovery?.mode !== 'cleanup'
    && !reportedErrorAnalysis?.actionable && !reportedErrorAnalysis?.permanent) {
    reportedSuccess = false;
    error = reportedTaskOutcome.reason;
    reportedErrorAnalysis = { category: `task-${reportedTaskOutcome.status}`, message: error,
      permanent: true, actionable: false, requiresFallback: false };
  }
  if (resolveTaskHookType(task) === 'security') {
    const { settleAgentSecurityScan } = await import('./agentSecurityScan.js');
    const scanner = await settleAgentSecurityScan(agentId);
    if (scanner?.status === 'refused') {
      reportedSuccess = false;
      reportedErrorAnalysis = { category: 'content-refusal', origin: 'provider', permanent: true, actionable: false,
        requiresFallback: false, message: 'Security scanner safety refusal; automatic continuation, retries and provider fallback are disabled.' };
      executionInterruption = { category: 'content-refusal', source: 'security-scanner' };
    }
  }
  if (['content-refusal', 'content-filtered'].includes(reportedErrorAnalysis?.category)) {
    executionInterruption ||= { category: reportedErrorAnalysis.category, source: reportedErrorAnalysis.origin || 'provider' };
    reportedSuccess = false;
  }
  if (executionInterruption) {
    await updateAgent(agentId, { metadata: { executionInterruption } })
      .catch(err => emitLog('warn', `Could not persist execution interruption for ${agentId}: ${err.message}`, { agentId }));
  }
  return { reportedSuccess, error, reportedErrorAnalysis, executionInterruption };
}

// A held delivery that nothing terminal explains goes to delivery recovery;
// every other run takes the normal final task update. A clean, validated run's
// cleanup-only outcome was already normalized to `completed`, so one still
// asking for cleanup here did not earn it and recovers as ordinary work.
async function resolveCompletionTaskUpdate({
  task, preHookTask, hookMetadata, hookResult, verdict, taskOutcome, reportedTaskOutcome, deliveryHeld, deliverySuccess,
  executionInterruption, terminatedByUser, agentId,
}) {
  const terminalFailure = !verdict.success && (verdict.errorAnalysis?.actionable || verdict.errorAnalysis?.permanent)
    && !(verdict.source === 'reported' && verdict.errorAnalysis?.category === `task-${reportedTaskOutcome?.status}`);
  const deliveryRecovers = !deliverySuccess && (deliveryHeld || verdict.success) && !terminatedByUser
    && !terminalFailure && !executionInterruption && !isPrivateSecurityTask(task) && hookResult?.outcome?.accepted !== false;
  if (!deliveryRecovers) return resolveFinalTaskUpdate({ task, preHookTask, hookMetadata, verdict, terminatedByUser, agentId });
  return resolveDeliveryRecoveryUpdate(preHookTask, taskOutcome.recovery?.mode === 'cleanup'
    ? { ...taskOutcome, recovery: undefined } : taskOutcome, agentId);
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
    ...(DELIVERY_RECOVERY_BLOCKED_CATEGORIES.includes(metadata?.blockedCategory)
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

async function verifyForgeReportedOutcome(ctx) {
  const { agentId, task, workspacePath, finalSummary, terminatedByUser, executionSuccess } = ctx;
  const reportedCompletion = !terminatedByUser && !isPrivateSecurityTask(task)
    ? await persistCompletionSummary(agentId, { workspacePath, finalSummary }) : null;
  let reportedTaskOutcome = reportedCompletion?.taskOutcome ?? null;
  // Only a clean, uninterrupted, non-private run whose own analysis raised no
  // terminal error may have its reported hold re-judged against the forge.
  const forgeVerifiable = executionSuccess && !terminatedByUser && !ctx.executionInterruption
    && !isPrivateSecurityTask(task) && !ctx.reportedErrorAnalysis?.actionable && !ctx.reportedErrorAnalysis?.permanent;
  // A successful process may report a hold after discovering its PR merged.
  // Verify that exact target before the hold can schedule another run.
  const mergedReviewFollowUp = await completionReviewFollowUp({
    task, agentId, workspacePath, reportedOutcome: reportedTaskOutcome, eligible: forgeVerifiable,
  });
  if (mergedReviewFollowUp) reportedTaskOutcome = mergedReviewFollowUp.taskOutcome;
  const claimDisposition = await completionClaimDisposition({
    task, agentId, reportedOutcome: reportedTaskOutcome, success: forgeVerifiable,
  });
  reportedTaskOutcome = await completionClaimOutcome(agentId, reportedTaskOutcome, claimDisposition);
  const reviewHandoff = await completionReviewHandoff({
    task, agentId, reportedOutcome: reportedTaskOutcome, eligible: forgeVerifiable,
  });
  if (reviewHandoff) reportedTaskOutcome = reviewHandoff.taskOutcome;
  const deliveryHeld = ['blocked', 'incomplete'].includes(reportedTaskOutcome?.status);
  const settled = await settleReportedExecution({
    agentId, task, reportedTaskOutcome, deliveryHeld,
    reportedSuccess: ctx.reportedSuccess,
    error: ctx.error,
    reportedErrorAnalysis: ctx.reportedErrorAnalysis,
    executionInterruption: ctx.executionInterruption,
  });
  return {
    reportedCompletion,
    reportedTaskOutcome,
    forgeVerifiable,
    mergedReviewFollowUp,
    claimDisposition,
    deliveryHeld,
    ...settled,
  };
}

async function verifyForgePrEvidence(ctx, reportedSuccess) {
  const { agentId, task, runId, workspacePath, outputBuffer, terminatedByUser, prExpected } = ctx;
  // #3358: a run whose task shape promised a PR is not successful until the
  // forge confirms one exists. Runs BEFORE the completion verdict is derived so
  // every downstream write (task status, learning telemetry, the "Completed
  // successfully" the UI renders off `result.success`) sees the corrected value.
  // A THROW here is not a verdict — fall back to the reported outcome rather
  // than manufacturing a failure out of a check that never ran, and say so by
  // NAME so the ledger gate below doesn't have to infer it from an empty result.
  const noChangeAudit = !terminatedByUser && reportedSuccess && permitsNoChangeCompletion(task);
  // The agent's own completion summary — the sentinel text when one was
  // ingested, the transcript tail otherwise. The PR check reads it for exactly
  // one purpose: recognizing the stand-down a parallel claim produces ("the
  // work already landed via PR #N"), which the resume briefing itself tells a
  // retry to report. Never trusted alone — the named change request is verified
  // against the forge before it excuses anything.
  const agentSummary = terminatedByUser ? null : extractFinalSummary(outputBuffer);
  const primaryPrObservation = terminatedByUser
    ? prObservation(PR_OBSERVATION.SKIPPED)
    : await observePrClaim({ task, workspacePath, success: reportedSuccess, prExpected, agentSummary })
      .catch(err => {
        emitLog('warn', `⚠️ PR verification failed for ${agentId}: ${err.message}`, { agentId });
        return prObservation(PR_OBSERVATION.CHECK_THREW);
      });

  // Codex/Antigravity/OpenCode sessions can own the PR workflow without being
  // able to type slashdo commands, so their spawners deliberately pass
  // `prExpected: false` and let cleanup act as the PR-creation backstop. A
  // marked catalog audit still needs the same forge + empty-branch proof before
  // a clean exit can satisfy its no-change success criterion.
  const noChangeObservation = await resolveNoChangeObservation({
    noChangeAudit, prExpected, primaryObservation: primaryPrObservation,
    task, workspacePath, success: reportedSuccess, agentId, agentSummary,
  });
  const prEvidence = resolvePrEvidence({ primaryObservation: primaryPrObservation, noChangeObservation });
  if (primaryPrObservation.outcome === PR_OBSERVATION.VERIFIED_CLAIM && primaryPrObservation.url) {
    const { recordBranchCompletionPolicy } = await import('../branchCompletionPolicy.js');
    await recordBranchCompletionPolicy({
      agentId, task, repoPath: workspacePath,
      branch: primaryPrObservation.branch, prUrl: primaryPrObservation.url,
    });
  }

  // Record the verdict in the lifecycle ledger (#4540) — but ONLY for an outcome
  // the policy table marks recordable. The sparse result returns the same
  // `{ ok: true }` for "the PR is there", for "this run never promised one", for
  // "there was no branch to ask about", and for "the check threw"; appending on
  // every call would file four different facts under one word and make the
  // ledger lie about the one transition it exists to explain.
  if (prEvidence.ledgerEntry) {
    const { verified, branch, category } = prEvidence.ledgerEntry;
    await appendRunEvent({
      kind: 'run.pr-verified',
      runId,
      agentId,
      taskId: task?.id,
      // Keyed on the run AND the verdict. The run part collapses a retried
      // finalize (the close handler and the orphan sweep can both reach this
      // path) into one entry; the verdict part keeps a run whose SECOND check
      // found the PR its first check missed from being silently suppressed by
      // the miss — that transition is the whole reason to look at the ledger.
      eventId: `pr-verify:${agentId}:${runId || 'no-run'}:${verified ? 'ok' : category || 'failed'}`,
      data: {
        verified,
        branch: branch ?? null,
        category: category ?? null,
        branchProvenEmpty: prEvidence.ledgerEntry.branchProvenEmpty,
      },
    });
  }
  return { primaryPrObservation, prEvidence };
}

/**
 * Stage 1 of agent finalization: persist reported completion, verify forge-owned
 * completion overrides (merged review follow-up, claim disposition, review handoff),
 * inspect PR/no-change evidence and primary-checkout drift, and run goal-fidelity review.
 *
 * @param {CompletionContext} ctx
 * @returns {Promise<object>}
 */
export async function resolveForgeOutcome(ctx) {
  const { agentId, task, workspacePath, terminatedByUser, completionReason, runStartedAt } = ctx;
  const reported = await verifyForgeReportedOutcome(ctx);
  const { primaryPrObservation, prEvidence } = await verifyForgePrEvidence(ctx, reported.reportedSuccess);

  // #3680: a worktree agent that committed to the PRIMARY checkout left
  // unreviewed commits on an unprotected branch. Same posture as the PR check —
  // a throw is not a verdict, so fall back to "no drift" rather than
  // manufacturing a failure out of a check that never ran.
  const drift = await checkPrimaryCheckoutDrift(agentId).catch(err => {
    emitLog('warn', `⚠️ Primary-checkout drift check failed for ${agentId}: ${err.message}`, { agentId });
    return { drifted: false };
  });
  logPrimaryCheckoutDrift(agentId, task, drift);
  // The run's outcome is one pure resolution over the evidence (see
  // resolveAgentFinalVerdict for the drift > PR > fidelity > hook > reported
  // ladder). Fidelity and the output hook are themselves gated on an earlier
  // layer's answer, so each stage below re-resolves with the evidence gathered
  // so far rather than amending a shared accumulator.
  const verdictEvidence = {
    reportedSuccess: reported.reportedSuccess,
    errorAnalysis: reported.reportedErrorAnalysis,
    error: reported.error,
    completionReason,
    terminatedByUser,
    drift,
    prEvidence,
  };
  const deliveredVerdict = resolveAgentFinalVerdict(verdictEvidence);
  logPrCompletionVerdict({ agentId, task, prEvidence, primaryPrObservation });

  const retirementCompletion = isCleanupOnlyRecovery(task) ? await verifyCleanupCompletion(task) : null;
  const { fidelity, fidelityDowngrade } = await reviewGoalFidelity({
    agentId, task, workspacePath, startedAt: runStartedAt, deliveredVerdict,
    claimDisposition: reported.claimDisposition, retirementCompletion,
    executionReport: reported.reportedCompletion?.summary,
  });
  const judgedVerdict = resolveAgentFinalVerdict({ ...verdictEvidence, fidelityReview: fidelity.review });
  await followUpAgentGoalFidelity({ agentId, task, fidelity, fidelityDowngrade });

  return {
    reportedTaskOutcome: reported.reportedTaskOutcome,
    forgeVerifiable: reported.forgeVerifiable,
    mergedReviewFollowUp: reported.mergedReviewFollowUp,
    claimDisposition: reported.claimDisposition,
    deliveryHeld: reported.deliveryHeld,
    executionInterruption: reported.executionInterruption,
    prEvidence,
    verdictEvidence,
    retirementCompletion,
    fidelity,
    judgedVerdict,
  };
}

async function resolveSettledTaskOutcome({
  agentId, task, executionSuccess, verdict, validationPassed,
  reportedTaskOutcome, retirementCompletion, branchProvenEmpty,
}) {
  const runtimeCompletionMissing = task.metadata?.runtimeVerification?.status === 'resumed'
    && !reportedTaskOutcome && validationPassed !== true;
  const reported = retirementCompletion?.status === 'unverified'
    ? { status: 'incomplete', reason: retirementCompletion.reason }
    : runtimeCompletionMissing
      ? { status: 'incomplete', reason: 'Runtime verification completion was not established.' }
      : reportedTaskOutcome;
  let taskOutcome = resolveTaskOutcome({
    reported,
    success: verdict.success,
    validationPassed,
    branchProvenEmpty,
    noChangeAllowed: permitsNoChangeCompletion(task),
    noCommitDeclared: declaresNoCommitCriterion(task),
  });
  if (verdict.success) {
    const owner = await getAgentRecord(agentId);
    if (owner?.metadata?.taskAnalysisType === 'do-release'
      || owner?.metadata?.releasePublication?.synchronizationHandoffVersion === 2) {
      const { verifyReleaseDelivery } = await import('../releaseDeliveryGate.js');
      const delivery = await verifyReleaseDelivery(owner, taskOutcome);
      if (delivery && !delivery.verified) {
        taskOutcome = {
          status: 'incomplete',
          reason: `Release synchronization is unfinished: ${delivery?.reason || 'evidence unavailable'}`,
        };
      }
    }
  }
  if (verdict.success && executionSuccess && validationPassed !== false && taskOutcome?.recovery?.mode === 'cleanup') {
    taskOutcome = { status: 'completed', ...(taskOutcome.reason ? { reason: taskOutcome.reason } : {}) };
  }
  return taskOutcome;
}

/**
 * Stage 2 of agent finalization: dispatch the task output hook, resolve the final
 * verdict and success-criteria validation, apply release/cleanup delivery gates,
 * and build the fenced task update.
 *
 * @param {CompletionContext} ctx
 * @param {object} forgeOutcome
 * @returns {Promise<object>}
 */
export async function applyDeliverySettlement(ctx, forgeOutcome) {
  const { agentId, task, workspacePath, recovery, terminatedByUser, executionSuccess, runStartedAt } = ctx;
  const {
    reportedTaskOutcome, forgeVerifiable, mergedReviewFollowUp, claimDisposition,
    deliveryHeld, executionInterruption, prEvidence, verdictEvidence, retirementCompletion,
    fidelity, judgedVerdict,
  } = forgeOutcome;
  const branchProvenEmpty = prEvidence.branchProvenEmpty;

  // Programmatic-I/O task types (e.g. layered-intelligence) run a deterministic
  // post-agent step on the agent's STRUCTURED output — the parsed `.agent-done`
  // payload — rather than only handling the completion sentinel. Read + dispatch
  // it mode-agnostically here (the single finalize chokepoint for TUI/CLI/runner
  // agents), gated on the task type actually registering an output hook so a
  // normal agent pays no extra I/O. Its side effects (filing an issue, etc.) are
  // isolated from the agent's discarded worktree — the payload is the only
  // durable channel out. Errors are caught: a hook failure must not strand the
  // rest of finalize. See taskTypeHooks.js + the design plan.
  //
  // Ordering (#2727): this runs BEFORE completeAgent because the hook result is
  // the only signal that can judge a programmatic-I/O run (see
  // evaluateSuccessCriteria), and completeAgent is what writes the learning
  // verdict — so the judgement has to exist first. Safe for every other task
  // shape: dispatchTaskOutputHook is a no-op unless the type registers a hook
  // (isProgrammaticIoTaskType), so nothing else is reordered. And
  // `agent:completed` — which schedules the next dequeue — still fires from
  // completeAgent below, i.e. AFTER any handoff task the hook enqueues. The cost
  // of awaiting here is that the agent still counts against the CoS concurrency
  // gate for the hook's duration, so the dispatch is hard-bounded — see
  // withOutputHookTimeout.
  const hookResult = correctHookResultForTask(task,
    await dispatchTaskOutputHookOnce({ agentId, task, success: judgedVerdict.success, workspacePath, recovery }));

  // Output hooks may return a trusted metadata patch that advances a staged
  // workflow. Apply it before task persistence and cleanup so the next stage
  // sees the narrowed input set. An explicit `accepted: false` is a real
  // programmatic-output failure even when the agent exited zero; this is the
  // fail-closed path for incomplete or contradictory eligibility envelopes.
  // The patch only travels with a run the hook itself failed or one that
  // succeeded — any other failure or a user termination is resolved against the
  // task as it stood before the hook ran, so a retry does not inherit a stage
  // advance its own run never earned.
  const hookMetadata = hookTaskMetadataPatch(hookResult);
  const preHookTask = hookMetadata ? { ...task } : task;
  if (hookMetadata) {
    task.metadata = { ...task.metadata, ...hookMetadata };
  }

  // A permanent hook rejection on an already-failed run escalates only while
  // that failure would still be retried; a task the prior failure would block
  // is terminal and keeps its own diagnosis. Asked of the PURE retry decision
  // so the side-effecting resolveFailedTaskUpdate below runs exactly once.
  const verdict = resolveAgentFinalVerdict({
    ...verdictEvidence,
    fidelityReview: fidelity.review,
    hookResult,
    failureIsTerminal: (analysis) => isPrivateSecurityTask(task)
      || resolveFailedTaskDecision(preHookTask, analysis, { agentId }).status === 'blocked',
  });

  const runtimeContinuation = forgeVerifiable && verdict.success && reportedTaskOutcome?.status === 'completed'
    && task.metadata?.runtimeVerification?.status === 'resumed'
    ? await import('../runtimeVerification.js')
      .then(({ verifyRuntimeVerificationContinuation }) => verifyRuntimeVerificationContinuation(task, agentId))
      .catch(() => null) : null;
  // #15552: a pr-watcher target that merged between poll and spawn leaves a
  // correct no-op; the forge, not the agent's report, establishes that.
  const prWatcherTargetsSettled = forgeVerifiable && verdict.success && reportedTaskOutcome?.status === 'no-action-needed'
    ? await import('../prWatcherCompletion.js')
      .then(({ verifyPrWatcherTargetsSettled }) => verifyPrWatcherTargetsSettled(task, workspacePath))
      .catch(() => null) : null;

  // Success-criteria validation (issue #2344): stamp an explicit pass/fail (or
  // null-when-undeclared) verdict onto the completion result, distinct from the
  // exit-code `success`, so task-learning telemetry can distinguish "ran clean
  // but produced nothing" from a genuine success. Best-effort — a validation
  // check failure must never block finalize (falls back to the null sentinel).
  const validationPassed = await evaluateSuccessCriteria({
    agentId,
    task,
    terminatedByUser,
    workspacePath,
    startedAt: runStartedAt,
    success: verdict.success,
    hookResult,
    branchProvenEmpty,
    emptyBranchInconclusiveEvidence: prEvidence.emptyBranchInconclusiveEvidence,
    claimDisposition,
    mergedReviewFollowUp,
    retirementCompletion,
    runtimeContinuation,
    prWatcherTargetsSettled,
  })
    .catch(err => {
      emitLog('warn', `⚠️ Success-criteria validation failed for ${agentId}: ${err.message}`, { agentId });
      return null;
    });

  let taskOutcome = await resolveSettledTaskOutcome({
    agentId, task, executionSuccess, verdict, validationPassed,
    reportedTaskOutcome, retirementCompletion, branchProvenEmpty,
  });
  const outcomeHeld = ['blocked', 'incomplete'].includes(taskOutcome?.status);
  const deliverySuccess = verdict.success && !outcomeHeld;
  const deliveryVerdict = !deliverySuccess && verdict.success ? {
    ...verdict,
    success: false,
    error: taskOutcome.reason,
    errorAnalysis: {
      category: hookResult?.outcome?.reason || `task-${taskOutcome.status}`,
      message: taskOutcome.reason,
      permanent: true,
      actionable: false,
      requiresFallback: false,
    },
  } : verdict;
  const cleanupOwner = await getAgentRecord(agentId);
  const cleanupEligible = cleanupOwner?.metadata?.isWorktree === true || hasClaimCheckoutBindings(cleanupOwner?.metadata);
  const taskUpdate = await resolveCompletionTaskUpdate({
    task, preHookTask, hookMetadata, hookResult, verdict, taskOutcome,
    reportedTaskOutcome, deliveryHeld, deliverySuccess,
    executionInterruption, terminatedByUser, agentId,
  });
  if (taskUpdate.runtimeRecoveryContext) taskOutcome = taskUpdate.metadata.taskOutcome;
  taskUpdate.metadata = { ...(taskUpdate.metadata || task.metadata), taskOutcome };

  return {
    hookResult,
    preHookTask,
    verdict,
    validationPassed,
    taskOutcome,
    deliverySuccess,
    deliveryVerdict,
    cleanupOwner,
    cleanupEligible,
    taskUpdate,
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
  const prerequisiteTaskResult = PREREQUISITE_BLOCKED_CATEGORIES.includes(taskUpdate.metadata?.blockedCategory)
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
        .then(({ releaseAppIssueClaim }) => releaseAppIssueClaim(resolvedApp, serverClaimTarget))
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

/** Persist an explicitly delivered completion, independently of delivery success.
 * The transcript remains available separately; it is never a substitute for a
 * missing final response, including on a partial Deep checkpoint.
 */
async function persistCompletionSummary(agentId, { workspacePath, finalSummary = null, existingRecord = null }) {
  const { doneSentinelPath, parseSentinelPayload } = await import('../../lib/agent/agentSentinel.js');
  const sentinelPath = doneSentinelPath(workspacePath, agentId);
  const contents = sentinelPath ? await tryReadFile(sentinelPath) : null;
  let summary = null;
  let source = null;
  let taskOutcome = null;
  let taskOutcomeSource = null;
  if (typeof contents === 'string' && contents.trim()) {
    const trimmed = contents.trim();
    const envelope = trimmed.match(/^```json\s*\n([\s\S]*?)\n```$/)?.[1]?.trim() ?? trimmed;
    // A malformed structured envelope must not be rendered as a human answer.
    // Legacy markdown sentinels remain supported.
    const structured = trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('```json');
    const parsed = structured ? safeJSONParse(envelope, null) : null;
    taskOutcome = normalizeTaskOutcome(parsed?.taskOutcome);
    if (taskOutcome) taskOutcomeSource = 'sentinel';
    if (!structured || (parsed && !Array.isArray(parsed) && typeof parsed.summary === 'string')) {
      const parsedSentinel = parseSentinelPayload(envelope);
      summary = parsedSentinel.summary.trim() || null;
      taskOutcome = parsedSentinel.taskOutcome || null;
      if (summary) source = 'sentinel';
    }
  }
  if (!summary && typeof finalSummary === 'string') {
    const terminal = parseSentinelPayload(finalSummary);
    summary = terminal.summary.trim() || null;
    if (!taskOutcome && terminal.taskOutcome) {
      taskOutcome = terminal.taskOutcome;
      taskOutcomeSource = 'terminal-result';
    }
    if (summary) source = 'terminal-result';
  }
  if (!taskOutcome) {
    // Cleanup may already have removed the sentinel on a finalization replay.
    // A new prose summary cannot clear the same agent's saved delivery outcome.
    const existing = existingRecord || await getAgentRecord(agentId);
    if (existing?.id === agentId) {
      taskOutcome = normalizeTaskOutcome(existing.result?.taskOutcome)
        || (['sentinel', 'terminal-result'].includes(existing.metadata?.taskOutcomeSource)
          ? normalizeTaskOutcome(existing.metadata?.taskOutcome) : null);
      if (taskOutcome) taskOutcomeSource = existing.metadata?.taskOutcomeSource || 'saved-result';
    }
    // Only retain summaries with a recorded source, never heuristic transcripts.
    if (!summary && existing?.id === agentId
      && ['sentinel', 'terminal-result'].includes(existing.metadata?.taskSummarySource)
      && typeof existing.metadata?.taskSummary === 'string'
      && existing.metadata.taskSummary.trim()) return { taskOutcome, summary: existing.metadata.taskSummary };
  }
  await updateAgent(agentId, { metadata: {
    taskSummary: summary,
    taskSummarySource: source,
    taskOutcome,
    taskOutcomeSource,
    simplifySummary: null,
  } });
  return { taskOutcome, summary };
}

// Runtime evidence is server-owned and never inferred from completion prose.
async function resolveDeliveryRecoveryUpdate(task, outcome, agentId) {
  if (outcome?.recovery?.mode === 'dependency-wait') {
    const { resolveInvestigationDependencyUpdate } = await import('../investigationDependencyWait.js');
    return resolveInvestigationDependencyUpdate(task, outcome, agentId);
  }
  if (outcome?.recovery?.mode === 'runtime') {
    const { resolveRuntimeVerificationUpdate } = await import('../runtimeVerification.js');
    return resolveRuntimeVerificationUpdate(task, outcome, agentId);
  }
  return resolveUndeliveredTaskUpdate(task, outcome, agentId);
}

function runtimeRecoveryFence(update) {
  if (update.dependencyWaitContext) return [update.dependencyWaitContext];
  if (update.metadata?.blockedCategory !== 'runtime-verification') return update.runtimeRecoveryContext ? [update.runtimeRecoveryContext] : [];
  const p = update.metadata.runtimeVerification;
  return [{ ...update.runtimeRecoveryContext, expectedStatus: p.dispatchStatus, expectedMetadata: {
    ...(p.dispatchStatus === 'blocked' ? { runtimeVerificationId: update.metadata.runtimeVerificationId } : {}),
    ...Object.fromEntries(['claimedBy', 'claimedAt', 'lastSpawnedAt', 'totalSpawnCount'].map(key => [key, p.dispatch?.[key]])),
  } }];
}

// The run's own task write. A recovery fence already names its expected task
// and owner, so it wins over the dispatch fence field by field.
function completionTaskFence(update, agent) {
  const [recovery] = runtimeRecoveryFence(update);
  const dispatch = completionDispatchFence(agent);
  if (!dispatch) return recovery ? [recovery] : [];
  return [{ ...dispatch, ...recovery, expectedMetadata: { ...dispatch.expectedMetadata, ...recovery?.expectedMetadata } }];
}
