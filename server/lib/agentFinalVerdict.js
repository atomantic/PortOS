/**
 * Agent final verdict (#9645)
 *
 * The completion outcome `finalizeAgent` (services/agentFinalization.js)
 * persists, as one pure function of the evidence it gathered: the agent's
 * reported result, primary-checkout drift, the PR claim check, the goal-fidelity
 * review, and the programmatic-I/O output hook. Kept out of the finalization
 * module so the precedence ladder can be read — and tested — without the
 * agent-state graph that module drags in.
 */

import { PR_MISSING_CATEGORY } from './prDisposition.js';
import { PRIMARY_CHECKOUT_MUTATED_ESCALATION, PRIMARY_CHECKOUT_MUTATED_REASON } from './primaryCheckoutGuard.js';
import { GOAL_FIDELITY_CATEGORY, formatGoalFidelitySummary, goalFidelityHoldsRun } from './goalFidelity.js';

/**
 * The `errorAnalysis` shape for a detected branch-jack. `actionable` because a
 * human has to decide whether to discard the primary's commits — a retry cannot
 * repair this, and silently retrying would leave the mutated checkout in place.
 */
function primaryCheckoutDriftAnalysis(drift) {
  return {
    category: drift.category,
    // Observed by the spawner from the checkout's own git state, not scraped out
    // of the transcript — the same provenance rule the structural analyses use.
    origin: 'runner',
    completionReason: PRIMARY_CHECKOUT_MUTATED_REASON,
    actionable: true,
    escalation: PRIMARY_CHECKOUT_MUTATED_ESCALATION,
    message: drift.message,
    suggestedFix: drift.suggestedFix
  };
}

/**
 * The `errorAnalysis` shape for a failed PR verification. Non-actionable so the
 * task RETRIES (a re-run can open the missing PR, or find the forge back) rather
 * than blocking on a first miss — `resolveFailedTaskDecision` still blocks it
 * once it has burned its retry budget.
 */
function prVerificationAnalysis(verdict) {
  return {
    category: verdict.category,
    message: verdict.message,
    actionable: false,
    suggestedFix: verdict.category === PR_MISSING_CATEGORY
      ? `The branch ${verdict.branch} holds ${verdict.commitsAhead ?? 'unreviewed'} commit(s) but has no open change request. Re-run the task, or open it by hand (\`gh pr create --head ${verdict.branch}\` / \`glab mr create --source-branch ${verdict.branch}\`).`
      : 'Check the forge probe on the System Health page — the forge CLI could not reach the forge, so the run\'s change request could not be confirmed.'
  };
}

/** `errorAnalysis` for a run held by the goal-fidelity gate. */
function goalFidelityAnalysis(review) {
  const named = [...(review.missing || []), ...(review.unrequested || [])];
  return {
    category: GOAL_FIDELITY_CATEGORY,
    message: `${formatGoalFidelitySummary(review)} — the diff does not deliver the task's stated objective`,
    actionable: false,
    origin: 'goal-fidelity-review',
    suggestedFix: named.length
      ? `Re-read the task against the change and reconcile: ${named.slice(0, 3).join('; ')}.`
      : 'Re-read the task against the change: the review found the work does something other than what was asked.',
  };
}

/**
 * The run's outcome as one pure function of the evidence finalize gathered.
 * Diagnoses apply in a fixed priority — drift > PR > fidelity > hook > the
 * originally reported error — and each later layer can only replace a verdict
 * it is eligible to replace:
 *
 *   - DRIFT overrides only a run that would otherwise have been a success. On a
 *     run that already failed, the original analysis is the better diagnosis;
 *     the branch-jack is on the record via finalize's warn log either way.
 *   - PR replaces any non-drift verdict when the forge could not confirm the
 *     promised change request — a concrete delivery failure.
 *   - FIDELITY can only hold a run that is still a success; re-judging a failed
 *     run against its objective would trade a real cause for a symptom.
 *   - HOOK rejection fails a successful run outright. On an already-failed run
 *     it takes over only when the rejection is PERMANENT (#6124), the run named
 *     no other cause (an `unknown` category), and the prior failure would not
 *     already block the task — a terminal decision keeps its own diagnosis
 *     rather than being re-resolved into a second investigation task. A
 *     non-escalating rejection of an otherwise-undowngraded failure surfaces the
 *     original analysis on the card.
 *
 * Callers gate evidence gathering on an earlier layer's answer (fidelity runs
 * only on a delivered success; the hook is told the judged outcome), so they
 * call this with the evidence collected so far and omit the rest — an omitted
 * layer simply does not apply. Returns a frozen verdict; nothing downstream may
 * amend it.
 *
 * @param {object} p
 * @param {(errorAnalysis: object) => boolean} [p.failureIsTerminal] whether a
 *   failure with this analysis would block the task. Consulted only when a
 *   permanent hook rejection lands on an already-failed run; must be pure.
 * @returns {Readonly<{source: 'reported'|'drift'|'pr'|'fidelity'|'hook', success: boolean, errorAnalysis: object|null|undefined, error: string|undefined, completionReason: string|undefined}>}
 */
export function resolveAgentFinalVerdict({
  reportedSuccess,
  errorAnalysis,
  error,
  completionReason,
  terminatedByUser = false,
  drift = null,
  prEvidence,
  fidelityReview = null,
  hookResult = null,
  failureIsTerminal = () => false,
}) {
  const driftDowngrade = Boolean(drift?.drifted) && reportedSuccess && !terminatedByUser;
  const prVerdict = prEvidence.completionVerdict;
  const delivered = driftDowngrade
    ? {
      source: 'drift',
      success: false,
      errorAnalysis: primaryCheckoutDriftAnalysis(drift),
      error: drift.message,
      completionReason: PRIMARY_CHECKOUT_MUTATED_REASON,
    }
    : !prEvidence.completionOk
      ? {
        source: 'pr',
        success: false,
        errorAnalysis: prVerificationAnalysis(prVerdict),
        error: prVerdict.message,
        completionReason: prVerdict.category,
      }
      : { source: 'reported', success: Boolean(reportedSuccess), errorAnalysis, error, completionReason };

  const fidelityAnalysis = delivered.success && goalFidelityHoldsRun(fidelityReview)
    ? goalFidelityAnalysis(fidelityReview)
    : null;
  const judged = fidelityAnalysis
    ? {
      source: 'fidelity',
      success: false,
      errorAnalysis: fidelityAnalysis,
      error: fidelityAnalysis.message,
      completionReason: GOAL_FIDELITY_CATEGORY,
    }
    : delivered;

  const hookOutcome = hookResult?.outcome;
  const hookRejected = !terminatedByUser && Boolean(hookResult?.ran) && hookOutcome?.accepted === false;
  if (!hookRejected) return Object.freeze(judged);

  // A PERMANENT rejection — the stage produced no parseable output at all —
  // re-fails identically on every retry, so it blocks instead of burning
  // MAX_TASK_RETRIES spawns. Honoured only when the run named no other cause:
  // a run that failed for a NAMED reason (rate-limit, auth-error, a killed
  // provider) is missing its output because the environment misbehaved, and
  // keeps its ordinary retries.
  const causeNamed = !judged.success && Boolean(judged.errorAnalysis?.category) && judged.errorAnalysis.category !== 'unknown';
  const hookPermanent = hookOutcome.permanent === true && !causeNamed;
  if (judged.success || (hookPermanent && !failureIsTerminal(judged.errorAnalysis))) {
    const analysis = {
      category: hookOutcome.reason || 'output-hook-rejected',
      message: hookOutcome.message || 'The scheduled task output was rejected by its validation hook',
      actionable: false,
      ...(hookPermanent && { permanent: true }),
      origin: 'task-output-hook',
    };
    return Object.freeze({
      source: 'hook',
      success: false,
      errorAnalysis: analysis,
      error: analysis.message,
      completionReason: analysis.category,
    });
  }
  // A rejection on an already-failed run keeps its original diagnosis. Surface
  // that analysis on the card too, without replacing a prior downgrade.
  if (judged.source === 'reported') {
    return Object.freeze({
      ...judged,
      error: judged.errorAnalysis?.message || error,
      completionReason: judged.errorAnalysis?.category || completionReason,
    });
  }
  return Object.freeze(judged);
}
