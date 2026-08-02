/**
 * The REQUEUE stamp (#3376) — pure metadata helpers for the one backward step in
 * the CoS task lifecycle.
 *
 * A task normally advances `pending → in_progress → (challenged) → terminal`, and
 * the federated merge leans on that (higher status = newer truth). Two paths move
 * it BACKWARD on purpose: the orphan sweep's requeue (`handleOrphanedTask`) and
 * the retry-hold release (`releaseRetryHold`, #3373). Both write the resume
 * pointer telling the retry which branch/worktree to continue from, so a peer's
 * stale `in_progress` snapshot must not win that merge and discard it.
 *
 * Recency alone can't decide it: an ordinary content edit landing on a peer's
 * stale `pending` copy also carries a newer `updatedAt`, and letting THAT beat a
 * genuinely running `in_progress` would revert a live task and invite a duplicate
 * spawn. So the requeue stamps `lastRequeuedAt` and the merge asks a causal
 * question instead — did the requeue happen AFTER the spawn the other side is
 * reporting? Only a real transition sets the stamp, and `cosTaskStore` clears it
 * on the next spawn, so the comparison stays anchored to the current run.
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
 * Is `pendingTask` the product of requeuing the very run `inProgressTask` is
 * reporting — i.e. did the requeue happen strictly AFTER that spawn?
 *
 * True means the `in_progress` side is a pre-requeue snapshot and the `pending`
 * side is the newer truth (with the resume pointer, and with its claim already
 * released by the same write — see #1563). False means we cannot establish that
 * ordering, which covers an ordinary edit on a stale `pending` copy AND a peer
 * that predates the stamp; callers fall back to the lifecycle rank there, so an
 * older peer behaves exactly as it does today.
 *
 * Depends only on the pair, so both peers compute the same answer.
 */
export function isPostSpawnRequeue(pendingTask, inProgressTask) {
  if (pendingTask?.status !== 'pending' || inProgressTask?.status !== 'in_progress') return false;
  const requeuedAt = stampMs(pendingTask, REQUEUED_AT_KEY);
  const spawnedAt = stampMs(inProgressTask, LAST_SPAWNED_AT_KEY);
  if (requeuedAt === null || spawnedAt === null) return false;
  return requeuedAt > spawnedAt;
}
