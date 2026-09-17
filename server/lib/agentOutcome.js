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

/**
 * True only when a handoff record proves a continuation was actually QUEUED —
 * `resumedTaskId` is the field `resumeAgent`/`relaunchAgent` stamp when they
 * requeue the same task. `isAgentHandoff` alone is not proof: it also reads
 * true for `retireStrandedPausedAgents` (`server/services/agentManagement.js`),
 * which stamps `resumed: true` on a pause whose task is gone or moved on,
 * with nothing requeued.
 *
 * Use this — not the bare predicate — anywhere the caller is about to SKIP its
 * own completion handling because it believes a continuation run will fire the
 * completion instead. Skipping on the bare predicate strands the chain when
 * the retirement was actually terminal (#7469: a quota-burn family's
 * continuation cycle, and a maintenance run's step evaluation, both stalled
 * this way until the next scheduled tick).
 *
 * Consumers that only ask "was this a genuine success/failure" (reports,
 * the activity calendar, task learning) should keep using `isAgentHandoff` — a
 * stranded retirement isn't a genuine outcome either, so folding it in there
 * is correct.
 */
export function isQueuedContinuation(agent) {
  return isAgentHandoff(agent) && !!agent?.result?.resumedTaskId;
}

/**
 * The one line a handoff card should show: WHAT THE USER CHANGED.
 *
 * When a continuation was actually queued (`resumedTaskId`), `metadata.pauseReason`
 * wins: on a Relaunch that is the sentence the user is looking for ("Relaunched by
 * user on codex / gpt-5"), while `result.error` holds `resumeAgent`'s summary,
 * which says where the TASK went rather than why this run stopped.
 *
 * With no continuation the order flips. `retireStrandedPausedAgents` also stamps
 * `resumed: true` — on a pause whose task was deleted or moved on — and there the
 * pause reason is the ORIGINAL one ("Paused by user"), which would read as a
 * deliberate provider swap for a run that was simply abandoned. `result.error`
 * ("Pause retired — its task … no longer exists") is the honest line.
 *
 * Lives here beside the predicate even though only the client renders it: this is
 * the file the client re-exports, and splitting the pair would put half the
 * contract back in a copy.
 */
export function agentHandoffReason(agent) {
  const error = agent?.result?.error;
  const pauseReason = agent?.metadata?.pauseReason;
  const handedOn = !!agent?.result?.resumedTaskId;
  return (handedOn ? pauseReason || error : error || pauseReason) || 'Handed off to a new run';
}
