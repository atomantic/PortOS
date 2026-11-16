/**
 * The CoS task STATUS TRANSITION vocabulary (#6620).
 *
 * Pure and dependency-free: the one place that answers "what KIND of transition is this?" for `writeTaskUpdate` (services/cosTaskStore.js), whose lifecycle rules (clear blocked/pause metadata, drop a spent resume pointer, retire the retry hold, release the federation claim, stamp/clear the requeue marker, pick the `tasks:changed` action) each re-derived it from the raw `(previousStatus, updates.status)` pair over 130 lines (the retry-hold clear and claim release were one predicate written twice; the requeue stamp and emitted action keyed on the same `in_progress → pending` edge 52 lines apart). Getting one wrong isn't cosmetic: a missed pause-key clear made `resumeAgent` read its own pause as spent and spawn a SECOND agent; a stale claim lease blocks a retry for a full lease window; a stale `existingBranch` attaches a fresh perpetual run to a long-merged branch. Pure and dependency-free; metadata predicates (is this block a pause? is this branch the resume's?) are deliberately NOT here (they read metadata, not the status pair).
 */

/** Terminal once `completed` or `blocked`: a resume pointer is spent and the federated merge stops advancing it. One definition for `writeTaskUpdate`'s pointer drop, its stale-failure reaper and `cosTaskMerge`'s release-on-transition. */
export const isTerminalTaskStatus = (status) => status === 'completed' || status === 'blocked';

/**
 * Classify one `(previousStatus, nextStatus)` pair. `nextStatus` is the patch's `status` AS PASSED: `undefined`/empty means the write carries no status, which is not "unchanged" (a lease-renewal heartbeat passes none and must release nothing, while an explicit write to the held status applies that status's rules).
 * Fields gating a RELEASE therefore require a status to be present; fields describing the resulting state fall back to `previousStatus`.
 */
export function resolveTaskStatusTransition(previousStatus, nextStatus) {
  // A falsy `nextStatus` is "no status in this patch" (`writeTaskUpdate` uses the same truthiness test), so '' never lands.
  const setsStatus = Boolean(nextStatus);
  const resultingStatus = setsStatus ? nextStatus : previousStatus;

  // A revive: parked and spawnable again; drives the `unblocked` action that re-runs cos.init's dequeue (#2614).
  const isRevive = resultingStatus === 'pending' && (previousStatus === 'blocked' || previousStatus === 'completed');
  // The one BACKWARD lifecycle step (#3376), done by the orphan sweep and retry-hold release; the federated merge must tell it from an ordinary edit on a peer's stale `pending` copy.
  const isRequeue = resultingStatus === 'pending' && previousStatus === 'in_progress';

  return {
    action: isRevive ? 'unblocked' : (isRequeue ? 'requeued' : 'updated'),
    isRevive,
    isRequeue,
    // A fresh spawn; retires the requeue stamp (THIS run's `lastSpawnedAt` is what a future requeue must beat).
    entersInProgress: nextStatus === 'in_progress',
    // A status OTHER than `in_progress` lands: retires every in-flight-only marker (retry hold, federation claim/lease); false with no status, so a heartbeat releases nothing.
    leavesInProgress: setsStatus && nextStatus !== 'in_progress',
    leavesBlocked: setsStatus && nextStatus !== 'blocked' && previousStatus === 'blocked',
    // Keyed on the PATCH, not the resulting state: re-editing a completed task isn't a fresh arrival at a terminal status and must not re-run one-shot terminal cleanups.
    isTerminal: isTerminalTaskStatus(nextStatus)
  };
}
