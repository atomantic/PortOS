/**
 * The REQUEUE stamp (#3376): pure metadata helpers for the one backward step in the CoS task lifecycle.
 *
 * Tasks advance `pending → in_progress → (challenged) → terminal` and the federated merge leans on that (higher status = newer truth); the orphan sweep's requeue (`handleOrphanedTask`) and the retry-hold release (`releaseRetryHold`, #3373) move it BACKWARD on purpose, writing the resume pointer, so a peer's stale `in_progress` snapshot must not win and discard it. Recency alone can't decide (an ordinary edit on a peer's stale `pending` copy also has a newer `updatedAt`, and letting it beat a running `in_progress` would revert a live task and invite a duplicate spawn), so the requeue stamps `lastRequeuedAt` and the merge asks a causal question: did the requeue happen AFTER the spawn the other side reports? Only a real transition sets the stamp and `cosTaskStore` clears it on the next spawn, anchoring the comparison to the current run.
 */

/** Metadata key stamped by `cosTaskStore.updateTask` on `in_progress → pending`. */
export const REQUEUED_AT_KEY = 'lastRequeuedAt';

/** Metadata key stamped by `agentLifecycle` when it marks a task `in_progress`. */
export const LAST_SPAWNED_AT_KEY = 'lastSpawnedAt';

const stampMs = (task, key) => {
  const ms = Date.parse(task?.metadata?.[key] ?? '');
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Is `pendingTask` the product of requeuing the very run `inProgressTask` reports, i.e. did the requeue happen strictly AFTER that spawn? True means the `in_progress` side is a pre-requeue snapshot and `pending` is the newer truth (with the resume pointer and its claim already released by the same write, #1563);
 * false means the ordering can't be established (an ordinary edit on a stale `pending` copy, or a peer predating the stamp) and callers fall back to lifecycle rank. Depends only on the pair, so both peers compute the same answer.
 * Both stamps are wall-clock but the comparison isn't cross-peer: a machine requeues only a run of its OWN (`releaseRetryHold` is scoped to this instance's agent; the orphan sweep leaves a task alone while a peer holds a live lease, `isHeldByOther`), so spawn and requeue share one clock and skew doesn't enter; if it did, the failure is benign (fall back to rank; the next sweep requeues again).
 */
export function isPostSpawnRequeue(pendingTask, inProgressTask) {
  if (pendingTask?.status !== 'pending' || inProgressTask?.status !== 'in_progress') return false;
  const requeuedAt = stampMs(pendingTask, REQUEUED_AT_KEY);
  const spawnedAt = stampMs(inProgressTask, LAST_SPAWNED_AT_KEY);
  if (requeuedAt === null || spawnedAt === null) return false;
  return requeuedAt > spawnedAt;
}
