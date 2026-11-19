/**
 * The CoS spawn budget: one counter, `metadata.totalSpawnCount`, capped by
 * `MAX_TOTAL_SPAWNS`. The task store keeps it monotonic (see
 * `applySpawnAccounting` in cosTaskStore.js): a write raises it or leaves it,
 * and only an explicit `spawnBudgetOperation: { kind: 'reset' }` lowers it.
 *
 * A dependency-free leaf so a caller needing only the vocabulary does not load
 * the store.
 */

// Per-run dispatch accounting. It belongs to the task that was dispatched, so a
// new task built from another task's metadata must not inherit it.
export const SPAWN_HISTORY_METADATA_KEYS = Object.freeze(['totalSpawnCount', 'lastSpawnedAt', 'claimedBy', 'claimedAt',
  'failureCount', 'orphanRetryCount', 'lastAgentId', 'failedAgentId', 'deliveryDecisionAgentId']);

/**
 * A stored spawn count as a non-negative safe integer, or null when it is absent
 * or not a count. Rows written before #16407, and peers on older versions, hold
 * the count as its decimal string.
 */
export function spawnBudgetCount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}
