/**
 * The window in which one CoS task is BOTH pending and active, and the single
 * settlement every reader pairing the task list with the agent list makes.
 *
 * `spawnAgentForTask` (services/agentLifecycle.js) registers an agent as
 * `running` BEFORE flipping its task off `pending`, so between those writes a
 * surface counting each list separately reports "1 pending" AND "1 active" for
 * one task. Reordering would not close it: the writes hit two stores and the UI
 * joins two separate HTTP reads.
 *
 * A task a live agent holds is ACTIVE, never queued (counting it queued implies
 * backlog that does not exist).
 *
 * BOUNDED BY `SPAWN_CLAIM_GRACE_MS`, as `forceSpawnTask` is: past it, a
 * `pending` task with a `running` agent is a BROKEN state (usually a zombie
 * record). Settling it as active would hide it from pending counts and from the
 * lists rendering its "Run now" recovery, so the bound hands it back as queued.
 *
 * Pure leaf with no imports; `client/src/lib/cosSpawnWindow.js` re-exports it so
 * the UI shares this settlement.
 */

/** How long a `running` agent on a `pending` task reads as mid-spawn rather than zombie; `forceSpawnTask` shares it. */
export const SPAWN_CLAIM_GRACE_MS = 60_000;

/** How long ago this agent started, or `Infinity` when it never said. */
export function spawnClaimAgeMs(agent, now = Date.now()) {
  const startedAt = new Date(agent?.startedAt ?? NaN).getTime();
  return Number.isFinite(startedAt) ? now - startedAt : Infinity;
}

/**
 * Map a task id → the live agent holding it (a Map because the age bound and the
 * relaunch control need the agent record).
 *
 * `taskId` falls back to `metadata.taskId` because `agentManagement.js` resume/relaunch
 * paths read both; recognizing fewer holders would disagree with them.
 */
export function runningAgentsByTaskId(agents) {
  const held = new Map();
  for (const agent of agents || []) {
    if (agent?.status !== 'running') continue;
    const taskId = agent.taskId || agent.metadata?.taskId;
    if (taskId) held.set(taskId, agent);
  }
  return held;
}

/** The live agent mid-spawn on this task id, or `null`. */
export function spawningAgentForTask(taskId, runningAgents, { now = Date.now(), graceMs = SPAWN_CLAIM_GRACE_MS } = {}) {
  const holder = runningAgents?.get(taskId) || null;
  return holder && spawnClaimAgeMs(holder, now) < graceMs ? holder : null;
}

/** A task the task list still reads `pending` while a live agent already holds it. */
export function isSpawningTask(task, runningAgents, options) {
  return task?.status === 'pending' && Boolean(spawningAgentForTask(task.id, runningAgents, options));
}

/** `tasks` minus the ones a live agent already holds — the honest queued set. */
export function withoutSpawningTasks(tasks, runningAgents, options) {
  return (tasks || []).filter((task) => !isSpawningTask(task, runningAgents, options));
}

/** How many of `tasks` are mid-spawn — what the queued set sheds, and the active set owes. */
export function countSpawningTasks(tasks, runningAgents, options) {
  return (tasks || []).filter((task) => isSpawningTask(task, runningAgents, options)).length;
}

/** The id-list form, for callers that read pending task IDS rather than records. */
export function unclaimedTaskIds(taskIds, runningAgents, options) {
  return (taskIds || []).filter((id) => !spawningAgentForTask(id, runningAgents, options));
}

/**
 * Settle one `{ tasks, grouped }` task source for a RESPONSE: stamps `spawning: true`
 * on mid-spawn tasks and moves them from `grouped.pending` to `grouped.in_progress`
 * so consumers get the honest queue depth without fetching the agent list.
 *
 * `status` stays at its persisted `pending` (clients may PATCH against it). Only the
 * API layer settles; dispatch readers of `getAllTasks()` must see the raw truth.
 */
export function settleTaskSourceSpawnWindow(source, runningAgents, options) {
  if (!source || typeof source !== 'object' || !Array.isArray(source.tasks)) return source;
  const spawningIds = new Set(
    source.tasks.filter((task) => isSpawningTask(task, runningAgents, options)).map((task) => task.id)
  );
  if (spawningIds.size === 0) return source;
  const stamp = (task) => (spawningIds.has(task?.id) ? { ...task, spawning: true } : task);
  const grouped = source.grouped && {
    ...source.grouped,
    pending: (source.grouped.pending || []).filter((task) => !spawningIds.has(task?.id)),
    in_progress: [...(source.grouped.in_progress || []), ...(source.grouped.pending || []).filter((task) => spawningIds.has(task?.id)).map(stamp)],
  };
  return { ...source, tasks: source.tasks.map(stamp), ...(grouped ? { grouped } : {}) };
}
