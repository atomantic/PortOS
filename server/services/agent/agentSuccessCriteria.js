/** Evaluates an agent’s declared success criteria and computes the task update from its delivery evidence. */

import { isCleanupOnlyRecovery, verifyCleanupCompletion } from '../cleanupOnlyCompletion.js';
import { hasClaimCheckoutBindings } from '../completedCheckoutEvidence.js';
import { hasClaimFlowContract } from '../../lib/claimFlowTaskTypes.js';
import { isLegacyDeepAudit } from '../../lib/auditWorkflow.js';
import { retryHoldMetadata } from '../../lib/taskRetryHold.js';
import { isAuditTaskType } from '../../lib/auditCatalog.js';
import { isPrivateSecurityTask } from '../../lib/privateSecurityPolicy.js';
import { isTruthyMeta } from '../../lib/metadataFlags.js';
import { resolveTaskOutcome } from '../../lib/agent/agentOutcome.js';
import { emitLog } from '../cos/cosEvents.js';
import { getAgentRecord } from '../cos/cosAgentLifecycle.js';
import { resolveFailedTaskDecision, resolveFailedTaskUpdate } from './agentErrorAnalysis.js';
import { resolveAgentFinalVerdict } from '../../lib/agent/agentFinalVerdict.js';
import { committedDuringRun } from '../../lib/gitCommitProbe.js';
import { isProgrammaticIoTaskType, resolveTaskHookType, declaresNoCommitCriterion, isClaimFlowDispatch } from '../taskTypeHooks.js';
import { isUpdateRepoRepairTask, verifyUpdateRepoRepairCompletion } from '../updateRepoRepairCompletion.js';
import { permitsNoChangeCompletion } from '../../lib/noChangeCompletion.js';
import { verifyRunMergedPr } from './agentPrVerification.js';
import { dispatchTaskOutputHookOnce, resolveProgrammaticIoVerdict } from './agentOutputHookDispatch.js';
import { applyReleaseDeliveryGate, releaseDeliveryApplies } from './agentForgeSettlement.js';
import { resolveDeliveryRecoveryUpdate } from './agentDeliveryRecovery.js';

const COMMIT_PROBE_UNAVAILABLE = Symbol('commit-probe-unavailable');

// The standalone learning verdict retains its boolean/null contract. Finalization
// also needs the cause of a miss to resolve a reported delivery.
export async function evaluateSuccessCriteria(input) {
  const criterion = await evaluateCriterion(input);
  return criterion === COMMIT_PROBE_UNAVAILABLE ? false : criterion;
}

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
 * produces a distinct unavailable result for settlement.
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
 * @returns {Promise<boolean|null|'skip-learning'|symbol>}
 */
async function evaluateCriterion({ agentId = null, task, terminatedByUser, workspacePath, startedAt = null, success = false, hookResult = null, branchProvenEmpty = false, emptyBranchInconclusiveEvidence = null, claimDisposition = null, mergedReviewFollowUp = null, retirementCompletion = null, runtimeContinuation = null, prWatcherTargetsSettled = null }) {
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
  return (await committedDuringRun(workspacePath, startedAt)) ?? COMMIT_PROBE_UNAVAILABLE;
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
    if (releaseDeliveryApplies(owner?.metadata)) {
      const gated = await applyReleaseDeliveryGate(owner, taskOutcome);
      if (gated.held) taskOutcome = gated.taskOutcome;
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
 * @param {import('./agentFinalization.js').CompletionContext} ctx
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
  // A watcher can deliver entirely on the forge. Its report selects the check
  // for a merge or a stale selection, and dispatch metadata binds the targets.
  const outcomeStatus = reportedTaskOutcome?.status;
  const prWatcherTargetsSettled = forgeVerifiable && verdict.success && resolveTaskHookType(preHookTask) === 'pr-watcher'
    && (outcomeStatus === 'completed' || outcomeStatus === 'no-action-needed')
    ? await import('../prWatcherCompletion.js')
      .then(({ verifyPrWatcherTargetsSettled }) => verifyPrWatcherTargetsSettled(preHookTask, workspacePath, outcomeStatus))
      .catch(() => null) : null;

  // Success-criteria validation (issue #2344): stamp an explicit pass/fail (or
  // null-when-undeclared) verdict onto the completion result, distinct from the
  // exit-code `success`, so task-learning telemetry can distinguish "ran clean
  // but produced nothing" from a genuine success. Best-effort — a validation
  // check failure must never block finalize (falls back to the null sentinel).
  // An investigation reporting completed work still owes delivery evidence when
  // the auxiliary check for a permitted no-change outcome was inconclusive.
  const reportedInvestigationFix = reportedTaskOutcome?.status === 'completed' && isTruthyMeta(task.metadata?.isInvestigation);
  const criterion = await evaluateCriterion({
    agentId,
    task,
    terminatedByUser,
    workspacePath,
    startedAt: runStartedAt,
    success: verdict.success,
    hookResult,
    branchProvenEmpty,
    emptyBranchInconclusiveEvidence: reportedInvestigationFix ? null : prEvidence.emptyBranchInconclusiveEvidence,
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

  let validationPassed = criterion;
  let validationFailure = null;
  if (criterion === COMMIT_PROBE_UNAVAILABLE) {
    validationPassed = false;
    if (forgeVerifiable && verdict.success && reportedTaskOutcome?.status === 'completed') {
      const missing = await verifyRunMergedPr({
        agent: await getAgentRecord(agentId).catch(() => null), task, workspacePath, startedAt: runStartedAt,
        observation: prEvidence.claimObservation,
      }).catch(() => 'The assigned PR or checkout could not be read.');
      validationPassed = missing === null;
      if (missing) validationFailure = { status: 'incomplete', reason: `Run-window Git commit count unavailable. ${missing}` };
    }
  }

  let taskOutcome = await resolveSettledTaskOutcome({
    agentId, task, executionSuccess, verdict, validationPassed,
    reportedTaskOutcome: validationFailure || reportedTaskOutcome, retirementCompletion, branchProvenEmpty,
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
