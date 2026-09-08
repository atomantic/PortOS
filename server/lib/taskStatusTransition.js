/**
 * The CoS task STATUS TRANSITION vocabulary (#6620).
 *
 * `writeTaskUpdate` (services/cosTaskStore.js) applies half a dozen lifecycle
 * rules to a task update — clear the blocked/pause metadata, drop a spent resume
 * pointer, retire the retry hold, release the federation claim, stamp or clear
 * the requeue marker, pick the `tasks:changed` action. Each of those used to
 * re-derive "what transition is this?" from the raw `(previousStatus,
 * updates.status)` pair at its own site, spread over 130 lines: the retry-hold
 * clear and the claim release were the IDENTICAL predicate written twice twelve
 * lines apart, and the requeue stamp and the emitted action independently keyed
 * on the same `in_progress → pending` edge 52 lines apart while having to agree.
 *
 * Every one of those sites arrived in a different feature commit, and getting one
 * wrong is not cosmetic: a missed pause-key clear made `resumeAgent` read its own
 * pause as spent and spawn a SECOND agent on a fresh task; a stale claim lease
 * blocks a legitimate retry by this instance or its peer for a full lease window;
 * a stale `existingBranch` silently attaches a fresh perpetual run to a
 * long-merged branch. So the question is asked ONCE, here, and every rule reads
 * the answer off the descriptor rather than re-deriving one.
 *
 * Pure and dependency-free — it answers only "what KIND of transition is this?".
 * Metadata predicates (is this block a pause? is this branch pointer the resume's?)
 * are deliberately NOT here: they read the task's metadata, not its status pair,
 * and belong at the application site.
 */

/**
 * A task is terminal once it is `completed` or `blocked` — the point at which a
 * resume pointer is spent and the federated merge stops advancing it. One
 * definition for `writeTaskUpdate`'s pointer drop, its stale-failure reaper, and
 * `cosTaskMerge`'s release-on-transition, which each carried their own copy.
 */
export const isTerminalTaskStatus = (status) => status === 'completed' || status === 'blocked';

/**
 * Classify one `(previousStatus, nextStatus)` pair.
 *
 * `nextStatus` is the update patch's `status` field AS PASSED — `undefined` (or
 * empty) when the write carries no status at all, which is a meaningful case and
 * not a synonym for "unchanged": a lease-renewal heartbeat passes no status and
 * must release nothing, while an explicit write to the status the task already
 * holds does apply the transition rules for that status. Fields that gate a
 * RELEASE therefore require a status to be present; fields that describe the
 * task's resulting state fall back to `previousStatus`.
 *
 * @param {string|undefined} previousStatus - the task's status before the write
 * @param {string|undefined} nextStatus - `updates.status`, or undefined/'' when absent
 * @returns {{
 *   action: 'unblocked'|'requeued'|'updated',
 *   isRevive: boolean, isRequeue: boolean,
 *   entersInProgress: boolean, leavesInProgress: boolean,
 *   leavesBlocked: boolean, isTerminal: boolean
 * }}
 */
export function resolveTaskStatusTransition(previousStatus, nextStatus) {
  // A falsy `nextStatus` is "no status in this patch": `writeTaskUpdate` spreads
  // the status onto the task with the same truthiness test, so '' never lands.
  const setsStatus = Boolean(nextStatus);
  // The status the task will hold after the write.
  const resultingStatus = setsStatus ? nextStatus : previousStatus;

  // A revive: the task was parked and is spawnable again. Drives the `unblocked`
  // action, which is what re-runs cos.init's dequeue (#2614).
  const isRevive = resultingStatus === 'pending' && previousStatus === 'blocked';
  // The one BACKWARD step in the lifecycle (#3376) — the orphan sweep and the
  // retry-hold release both perform it, and the federated merge has to tell it
  // apart from an ordinary edit landing on a peer's stale `pending` copy.
  const isRequeue = resultingStatus === 'pending' && previousStatus === 'in_progress';

  return {
    action: isRevive ? 'unblocked' : (isRequeue ? 'requeued' : 'updated'),
    isRevive,
    isRequeue,
    // A fresh spawn. Retires the requeue stamp: from here on THIS run's
    // `lastSpawnedAt` is what a future requeue must beat.
    entersInProgress: nextStatus === 'in_progress',
    // The write lands a status OTHER than `in_progress` — the edge that retires
    // every in-flight-only marker (the retry hold, the federation claim/lease).
    // False for a patch carrying no status, so a heartbeat releases nothing.
    leavesInProgress: setsStatus && nextStatus !== 'in_progress',
    // Out of `blocked` by any door — a dedupe revive, an autopilot re-dispatch, a
    // cooldown expiry, or a human unblocking it from the task list.
    leavesBlocked: setsStatus && nextStatus !== 'blocked' && previousStatus === 'blocked',
    // Keyed on the PATCH, not the resulting state: re-editing an already-completed
    // task is not a fresh arrival at a terminal status and must not re-run the
    // one-shot terminal cleanups.
    isTerminal: isTerminalTaskStatus(nextStatus)
  };
}
