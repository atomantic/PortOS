/**
 * Is a completed agent record an OUTCOME, or a handoff to its own continuation?
 *
 * `resumeAgent` (and `relaunchAgent`, which composes a pause with a resume)
 * retires the old record with `success: false` and requeues the SAME task — most
 * often because the user swapped providers after a CLI hit a usage limit, not
 * because the work failed. Every consumer that reads `result.success` as the
 * verdict therefore booked a phantom failure per swap: a red "Failed" card in the
 * history, a failed task in the daily report and the weekly digest, a dented
 * success rate, a quota-burn denial recorded against "Relaunched by user", a
 * feature agent flipped to `error`.
 *
 * The rule task-learning already applies (`initTaskLearning`, #4540: "a record
 * retired by resumeAgent is a CONTINUATION, not an outcome") belongs to all of
 * them, so it lives here once instead of being restated — or forgotten — per
 * consumer.
 *
 * Keyed on `result.resumed`, which `resumeAgent` has always stamped, so ALREADY
 * ARCHIVED relaunches are reclassified retroactively: no migration, and an
 * install's existing history stops reporting swaps as failures the moment it
 * upgrades. Mirrored, with the same contract, at `client/src/lib/agentOutcome.js`.
 *
 * Pure and dependency-free — read from report builders, event listeners, and the
 * learning writer alike, none of which should drag in the agent-state graph for
 * one predicate.
 */

/**
 * True when this record was retired to hand its task to a continuation run
 * (resume / relaunch) rather than because the run reached a verdict.
 */
export function isAgentHandoff(agent) {
  return agent?.result?.resumed === true;
}

/** True when the run reached a real verdict — the only records worth counting. */
export function isAgentOutcome(agent) {
  return !!agent?.result && !isAgentHandoff(agent);
}

/** True when the run genuinely failed: a verdict was reached and it was negative. */
export function isAgentFailure(agent) {
  return isAgentOutcome(agent) && agent.result.success !== true;
}
