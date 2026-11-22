import { assertDatabaseAdmission } from '../../lib/databaseMaintenanceJournal.js';
import { dropRunnerAgent } from './agentState.js';
/**
 * Agent lifecycle guard primitives: small dependency-injected helpers carved out of
 * `spawnAgentForTask` / `handleAgentCompletion` (agentLifecycle.js) so their concurrency
 * contracts are testable against the real code (#2548). Spawn admission also consults the
 * persistent database fence.
 */

/** Returned by `withSpawnDedupGuard` when a spawn for `taskId` is already in flight. A Symbol so it differs from a legitimate `null` result. */
export const SPAWN_DEDUP_SKIP = Symbol('spawn-dedup-skip');

/**
 * Run `fn` under a per-task spawn dedup guard (#1563): a held `taskId` returns `SPAWN_DEDUP_SKIP`;
 * otherwise the guard is acquired SYNCHRONOUSLY (before any `await` in `fn`) and released in a
 * `finally` only once `fn` settles, so no racer slips in between release and the runner accepting
 * the agent.
 * @param {Set<string>} spawningTasks - the in-process dedup set
 * @param {string} taskId
 * @param {() => Promise<any>} fn - the guarded spawn work
 * @returns {Promise<any|typeof SPAWN_DEDUP_SKIP>}
 */
export async function withSpawnDedupGuard(spawningTasks, taskId, fn) {
  assertDatabaseAdmission();
  if (spawningTasks.has(taskId)) return SPAWN_DEDUP_SKIP;
  spawningTasks.add(taskId);
  try {
    return await fn();
  } finally {
    spawningTasks.delete(taskId);
  }
}

/** Returned when a self-update is running: a temporary hold (task stays queued), distinct from the duplicate-dispatch skip so callers log the right reason. */
export const SPAWN_UPDATE_SKIP = Symbol('spawn-update-skip');

/**
 * Run `fn` only when no self-update is in progress (#4124): `update.sh` spends seconds in
 * `git pull` / `npm install` before `pm2 delete`, and an agent started in that window is severed
 * by the restart, so the spawn is a no-op and the task stays queued. The predicate is injected to
 * keep this module free of state and I/O.
 * @param {() => boolean} isUpdateInProgress - synchronous flag reader
 * @param {() => Promise<any>} fn - the guarded spawn work
 * @returns {Promise<any|typeof SPAWN_UPDATE_SKIP>}
 */
export async function withUpdateInProgressGuard(isUpdateInProgress, fn) {
  if (isUpdateInProgress()) return SPAWN_UPDATE_SKIP;
  return fn();
}

/**
 * Run `fn`, then drop the `runnerAgents` entry for `agentId` in a `finally`, so a throw in any
 * completion step never strands the entry (unbounded growth, misrouted re-emitted completion) or
 * its in-flight Ollama hold (every later context reload deferred to the drain timeout).
 * @param {string} agentId
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withRunnerAgentCleanup(agentId, fn) {
  try {
    return await fn();
  } finally {
    dropRunnerAgent(agentId);
  }
}
