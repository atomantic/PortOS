/**
 * Agent lifecycle guard primitives.
 *
 * Two tiny, dependency-injected control-flow helpers carved out of the
 * ~470-LOC `spawnAgentForTask` and `handleAgentCompletion` orchestrators
 * (agentLifecycle.js) so the concurrency contracts they enforce are unit-
 * testable against the REAL code path instead of a hand-copied replica
 * (issue #2548). All of them operate purely on the collection/predicate passed
 * in — no module state, no I/O — so a test can drive them with a throwaway
 * collection or a stub predicate.
 */

/**
 * Sentinel returned by `withSpawnDedupGuard` when the guard was already held
 * for `taskId` — i.e. a concurrent spawn is already in flight and this call
 * must not proceed. A Symbol (not `null`) so the caller can distinguish
 * "deduped, do nothing" from a legitimate `null` result of the wrapped work.
 */
export const SPAWN_DEDUP_SKIP = Symbol('spawn-dedup-skip');

/**
 * Run `fn` under a per-task spawn dedup guard.
 *
 * Contract (the race closed by issue #1563 / the spawningTasks fix):
 *   1. If `spawningTasks` already holds `taskId`, return `SPAWN_DEDUP_SKIP`
 *      without touching the set — a duplicate `task:ready` re-emit is rejected.
 *   2. Otherwise acquire the guard SYNCHRONOUSLY (before the first `await`
 *      inside `fn`), so a second call landing while `fn` is suspended at any
 *      await sees the guard held and dedups at step 1 rather than spawning a
 *      second agent for the same task id.
 *   3. Release the guard in a `finally` so it outlives the entire wrapped
 *      body — every early `return`, and any throw, still releases it. Holding
 *      the guard until `fn` settles (not merely until the task is flipped to
 *      in_progress) is what prevents the late-delete race where a racer slips
 *      in between the release and the runner actually accepting the agent.
 *
 * @param {Set<string>} spawningTasks - the in-process dedup set
 * @param {string} taskId
 * @param {() => Promise<any>} fn - the guarded spawn work
 * @returns {Promise<any|typeof SPAWN_DEDUP_SKIP>}
 */
export async function withSpawnDedupGuard(spawningTasks, taskId, fn) {
  if (spawningTasks.has(taskId)) return SPAWN_DEDUP_SKIP;
  spawningTasks.add(taskId);
  try {
    return await fn();
  } finally {
    spawningTasks.delete(taskId);
  }
}

/**
 * Sentinel returned by `withUpdateInProgressGuard` when a PortOS self-update is
 * running. A distinct Symbol from `SPAWN_DEDUP_SKIP` so the caller can log the
 * right reason — "held for an update" is a temporary, self-clearing hold, not a
 * duplicate dispatch — while both share the same "no-op, leave the task queued"
 * contract.
 */
export const SPAWN_UPDATE_SKIP = Symbol('spawn-update-skip');

/**
 * Run `fn` only when no self-update is in progress.
 *
 * Contract (the race closed by issue #4124): `/api/update/execute` blocks on
 * live CoS agents both before and after acquiring the update lock, but
 * `update.sh` then spends multiple seconds in `git pull` / submodule update /
 * `npm install` before it reaches `pm2 delete`. An agent that starts inside
 * THAT window is severed by the restart — its PTY/child process is a child of
 * this server. This guard closes it from the spawn side: while the update flag
 * is set, a spawn is a no-op and the task stays queued for after the restart,
 * rather than burning a spawn (and its retry budget) on a doomed run.
 *
 * The predicate is injected rather than imported so this module stays free of
 * module state and I/O, and so a test can drive the real guard with a stub.
 *
 * @param {() => boolean} isUpdateInProgress - synchronous flag reader
 * @param {() => Promise<any>} fn - the guarded spawn work
 * @returns {Promise<any|typeof SPAWN_UPDATE_SKIP>}
 */
export async function withUpdateInProgressGuard(isUpdateInProgress, fn) {
  if (isUpdateInProgress()) return SPAWN_UPDATE_SKIP;
  return fn();
}

/**
 * Run `fn`, then unconditionally delete `key` from `map` in a `finally`.
 *
 * The completion-side counterpart to `withSpawnDedupGuard`: a throw from any
 * inner step of `handleAgentCompletion` (completeAgent, updateTask,
 * processAgentCompletion, finalizeAgent…) must never strand the agent's entry
 * in the in-memory `runnerAgents` map — a stale entry grows memory unboundedly
 * and can re-trigger/misroute completion if the runner re-emits the event.
 * The error still propagates to the caller; the finally only guards the map.
 *
 * @param {Map<string, any>} map
 * @param {string} key
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withMapEntryCleanup(map, key, fn) {
  try {
    return await fn();
  } finally {
    map.delete(key);
  }
}
