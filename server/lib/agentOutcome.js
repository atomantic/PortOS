/**
 * Is a completed agent record an OUTCOME, or a handoff to its own continuation?
 *
 * `resumeAgent` (and `relaunchAgent`, which composes a pause with a resume)
 * retires the old record with `success: false` and requeues the SAME task — most
 * often because the user swapped providers after a CLI hit a usage limit, not
 * because the work failed. Every consumer that read `result.success` as the
 * verdict therefore booked a phantom failure per swap: a red "Failed" card in the
 * history, a failed task in the daily report and the weekly digest, a dented
 * success rate, a quota-burn denial recorded against "Relaunched by user", a
 * feature agent flipped to `error`.
 *
 * The rule task-learning already applied (`initTaskLearning`, #4540: "a record
 * retired by resumeAgent is a CONTINUATION, not an outcome") belongs to all of
 * them, so it lives here once instead of being restated — or forgotten — per
 * consumer.
 *
 * Keyed on `result.resumed`, which `resumeAgent` has always stamped, so ALREADY
 * ARCHIVED relaunches are reclassified retroactively: no migration, and an
 * install's existing history stops reporting swaps as failures the moment it
 * upgrades. Mirrored, with the same contract, at `client/src/lib/agentOutcome.js`
 * and pinned to it by `agentOutcome.parity.test.js`.
 *
 * Pure and dependency-free — read from report builders, event listeners, and the
 * learning writer alike, none of which should drag in the agent-state graph for
 * one predicate.
 */

/**
 * True when this record was retired to hand its task to a continuation run
 * (resume / relaunch) rather than because the run reached a verdict.
 *
 * Takes the whole record, but reads only `result`, so the stats writer inside
 * `completeAgent` — which has the result in hand before any record exists — can
 * ask the same question with `isAgentHandoff({ result })`.
 *
 * STRICT equality on purpose. A truthy check would also swallow a future
 * `resumed: 'partial'` or a round-tripped string, silently dropping a real
 * outcome from every count that now filters on this.
 */
export function isAgentHandoff(agent) {
  return agent?.result?.resumed === true;
}
