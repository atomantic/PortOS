/**
 * The window in which one CoS task is BOTH pending and active, and the single
 * settlement every reader that pairs the task list with the agent list makes.
 *
 * `spawnAgentForTask` (services/agentLifecycle.js) registers an agent as
 * `running` BEFORE it flips that agent's task off `pending`. Between those two
 * writes the task reads `pending` on the task list and `running` on the agent
 * list, so a surface that counts each list on its own reports "1 pending" AND
 * "1 active" for what is one task — and the phantom only clears on a later
 * poll, which is why it reads as a counter stuck rather than as a race.
 * Reversing the two writes would not close it: they land in two different
 * stores, and the UI joins the lists from two separate HTTP reads anyway.
 *
 * A task a live agent already holds is ACTIVE, never queued. Counting it as
 * queued is the direction that misleads: it invites the user (and the dequeue
 * surfaces) to believe there is backlog waiting on a free slot when there is
 * none.
 *
 * BOUNDED BY `SPAWN_CLAIM_GRACE_MS`, for the reason `forceSpawnTask` is. Past
 * that window a `pending` task carrying a `running` agent is not mid-spawn, it
 * is a BROKEN state — a zombie record whose process died before the sweep
 * caught it. Settling it as active indefinitely would hide the stuck task from
 * every pending count AND drop it out of the lists that render its "Run now"
 * recovery, so the bound hands it back as queued work the user can restart.
 *
 * Pure leaf with no imports, so `client/src/lib/cosSpawnWindow.js` re-exports
 * it and the UI shares this settlement rather than keeping a copy that can
 * drift.
 */

/**
 * How long a `running` agent on a still-`pending` task is read as mid-spawn
 * rather than as a zombie. `services/cos.js#forceSpawnTask` bounds its
 * live-agent refusal on the same constant, so the count, the list, and the
 * button agree about which tasks are still yours to start.
 */
export const SPAWN_CLAIM_GRACE_MS = 60_000;

/** How long ago this agent started, or `Infinity` when it never said. */
export function spawnClaimAgeMs(agent, now = Date.now()) {
  const startedAt = new Date(agent?.startedAt ?? NaN).getTime();
  return Number.isFinite(startedAt) ? now - startedAt : Infinity;
}

/**
 * Map a task id → the live agent holding it.
 *
 * A Map rather than a Set of ids because the CoS Tasks tab renders an Active
 * row's relaunch control off the agent record, and the age bound above needs
 * the agent's `startedAt`.
 *
 * `taskId` falls back to `metadata.taskId` — `registerAgent` stamps the
 * top-level field, but the resume/relaunch paths in `agentManagement.js` read
 * both, and a settlement that recognized fewer holders than they do would
 * disagree with them about which task is running.
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
 * Settle one `{ tasks, grouped }` task source for a RESPONSE.
 *
 * Stamps `spawning: true` on each mid-spawn task and moves it from
 * `grouped.pending` to `grouped.in_progress`, so a consumer counting
 * `grouped.pending.length` gets the honest queue depth without knowing this
 * module exists — the failure mode being that every new reader of the payload
 * has to remember to fetch the agent list and subtract.
 *
 * `status` is deliberately left at its persisted `pending`: it is what the
 * record says, a client may PATCH against it, and `spawning` is the flag a row
 * renders its mid-spawn state from. Only the API layer settles — the dispatch
 * readers of `getAllTasks()` (task generation, retry revival, dedup) must keep
 * seeing the raw truth.
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
