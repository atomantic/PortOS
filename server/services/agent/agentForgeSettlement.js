/** Reconciles the reported agent outcome with checkout, pull request and release evidence. */

import { isCleanupOnlyRecovery, verifyCleanupCompletion } from '../cleanupOnlyCompletion.js';
import { hasClaimFlowContract } from '../../lib/claimFlowTaskTypes.js';
import { isPrivateSecurityTask } from '../../lib/privateSecurityPolicy.js';
import { normalizeTaskOutcome } from '../../lib/agent/agentOutcome.js';
import { safeJSONParse, tryReadFile } from '../../lib/fileUtils.js';
import { emitLog } from '../cos/cosEvents.js';
import { getAgentRecord, updateAgent } from '../cos/cosAgentLifecycle.js';
import { resolveAgentFinalVerdict } from '../../lib/agent/agentFinalVerdict.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { detectPrimaryCheckoutDrift } from '../../lib/primaryCheckoutGuard.js';
import { resolveTaskHookType } from '../taskTypeHooks.js';
import { extractFinalSummary } from './agentSummaryExtraction.js';
import { permitsNoChangeCompletion } from '../../lib/noChangeCompletion.js';
import { PR_OBSERVATION, PR_OBSERVATION_POLICY, prObservation, prVerdictFromObservation, observePrClaim } from './agentPrVerification.js';
import { followUpAgentGoalFidelity, reviewGoalFidelity } from './agentGoalFidelity.js';

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
 * The six-step forge completion pipeline shared by live finalization and
 * dead-agent recovery: persist the summary, then review follow-up, claim
 * disposition, claim outcome, and review handoff. `summarize` / eligibility
 * flags stay with the caller — recovery and finalizeAgent gate those differently.
 *
 * @returns {Promise<{ reportedCompletion: object|null, reportedOutcome: object|null, mergedReviewFollowUp: object|null, claimDisposition: object|null, deliveryHeld: boolean }>}
 */
export async function reconcileForgeReportedOutcome({
  agentId, task, agent, workspacePath, finalSummary, existingRecord,
  summarize, reviewEligible, claimEligible, handoffEligible,
}) {
  const reportedCompletion = summarize
    ? await persistCompletionSummary(agentId, { workspacePath, finalSummary, existingRecord }) : null;
  let reportedOutcome = reportedCompletion?.taskOutcome ?? null;
  const mergedReviewFollowUp = await completionReviewFollowUp({
    task, agentId, workspacePath, reportedOutcome, eligible: reviewEligible,
  });
  if (mergedReviewFollowUp) reportedOutcome = mergedReviewFollowUp.taskOutcome;
  const claimDisposition = await completionClaimDisposition({
    task, agent, agentId, reportedOutcome, success: claimEligible,
  });
  reportedOutcome = await completionClaimOutcome(agentId, reportedOutcome, claimDisposition);
  const reviewHandoff = await completionReviewHandoff({
    task, agent, agentId, reportedOutcome, eligible: handoffEligible,
  });
  if (reviewHandoff) reportedOutcome = reviewHandoff.taskOutcome;
  return {
    reportedCompletion,
    reportedOutcome,
    mergedReviewFollowUp,
    claimDisposition,
    deliveryHeld: ['blocked', 'incomplete'].includes(reportedOutcome?.status),
  };
}

/** Release verification for do-release and synchronization handoff v2. */
export async function applyReleaseDeliveryGate(owner, taskOutcome) {
  const { verifyReleaseDelivery } = await import('../releaseDeliveryGate.js');
  const delivery = await verifyReleaseDelivery(owner, taskOutcome);
  if (delivery && !delivery.verified) {
    return {
      taskOutcome: {
        status: 'incomplete',
        reason: `Release synchronization is unfinished: ${delivery?.reason || 'evidence unavailable'}`,
      },
      held: true,
    };
  }
  return { taskOutcome, held: false };
}

export function releaseDeliveryApplies(metadata) {
  return metadata?.taskAnalysisType === 'do-release'
    || metadata?.releasePublication?.synchronizationHandoffVersion === 2;
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
    claimObservation: primaryObservation.outcome === PR_OBSERVATION.SKIPPED && noChangeObservation ? noChangeObservation : primaryObservation,
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

async function verifyForgeReportedOutcome(ctx) {
  const { agentId, task, workspacePath, finalSummary, terminatedByUser, executionSuccess } = ctx;
  // Only a clean, uninterrupted, non-private run whose own analysis raised no
  // terminal error may have its reported hold re-judged against the forge.
  const forgeVerifiable = executionSuccess && !terminatedByUser && !ctx.executionInterruption
    && !isPrivateSecurityTask(task) && !ctx.reportedErrorAnalysis?.actionable && !ctx.reportedErrorAnalysis?.permanent;
  const forge = await reconcileForgeReportedOutcome({
    agentId, task, workspacePath, finalSummary,
    summarize: !terminatedByUser && !isPrivateSecurityTask(task),
    reviewEligible: forgeVerifiable, claimEligible: forgeVerifiable, handoffEligible: forgeVerifiable,
  });
  const { reportedCompletion, reportedOutcome: reportedTaskOutcome, mergedReviewFollowUp, claimDisposition, deliveryHeld } = forge;
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
 * @param {import('./agentFinalization.js').CompletionContext} ctx
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
