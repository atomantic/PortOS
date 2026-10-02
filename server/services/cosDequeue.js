/**
 * CoS Dequeue — priority/capacity helpers (issue #2530)
 *
 * The spawn-side scheduler `dequeueNextTask` (in cos.js) fills open agent slots
 * by draining four priority tiers in order. This module holds the capacity and
 * ownership decisions — the per-cycle capacity tracker and
 * the idle tier-eligibility predicate — so the scheduler and its unit
 * tests share ONE implementation instead of the tests re-deriving a local
 * replica of the guards.
 *
 * Idle review has one shared admission/handoff workflow here: check the
 * autonomous ceiling and project eligibility BEFORE preparation can consume a
 * human request or commit cooldown/marker state. The two engines retain only
 * their trigger ordering and dispatch adapters.
 *
 * Priority-tier order, shared by BOTH engines (`dequeueNextTask` in cos.js and
 * `evaluateTasks` in cosTaskGenerator.js; pinned by the source-order regression
 * tests in cos.test.js): 0 on-demand (bypasses pause) → 1 user → 2 auto-approved
 * → 3.6 feature agents → 4 idle review. The evaluator additionally runs `maybeQueueImprovementTasks` between 2 and
 * 3.6, which only WRITES queue rows (batch regeneration) and never spawns, so the
 * event-driven dequeue deliberately has no counterpart.
 */

import { hasActiveTaskOwner } from './agentState.js';
import { emitLog } from './cosEvents.js';

/**
 * Per-cycle spawn-capacity tracker. Owns the running `spawned` count and the
 * per-project tally, and exposes the exact `canSpawn` / `trackSpawn` closure the
 * scheduler uses to enforce the global slot cap AND the per-project cap.
 *
 * `availableSlots` = global cap minus currently-running agents (may be 0 or
 * negative if a config change shrank the cap below live load — callers still
 * guard with `availableSlots <= 0`). `perProjectLimit` falls back to the global
 * cap when `maxConcurrentAgentsPerProject` is unset/0, matching the scheduler's
 * historical behavior.
 *
 * `canSpawn(task, ceiling = availableSlots)` — autonomous tiers pass a lower
 * `ceiling` (the daily CoS action budget) so a task admitted there counts
 * against both the global slots and the budget. A task with no `metadata.app`
 * buckets into the `_self` project key (PortOS-on-itself work) so app-less tasks
 * can't bypass the per-project cap.
 *
 * The THIRD cap is per local inference endpoint (issue #4834): a single GPU
 * can't hold N model contexts at once, so agents whose provider resolves to the
 * same local endpoint dispatch `localEndpointLimit` at a time and the rest stay
 * queued. Callers supply the already-resolved pieces — `localEndpointCounts`
 * (endpoint → running agents) and `resolveLocalEndpoint(task)` (which endpoint a
 * candidate would land on, built by cosLocalEndpointSlots.js) — so this module
 * stays pure and dependency-free. A task resolving to `null` (cloud provider, or
 * a TUI provider with no recorded endpoint) is ungated. `onLocalEndpointHold`
 * fires on a denial so the scheduler can log queued-no-slot without this module
 * importing the event bus.
 *
 * `canSpawnCommitted` opts a tier out of that third cap. Two tiers use it,
 * because a denial there is DESTRUCTIVE rather than a defer — each has already
 * committed side effects by the time `canSpawn` runs, and none of them persists
 * the task, so `false` discards the only copy:
 *
 *   - Priority 0 has cleared the on-demand request and bound the app-review
 *     marker — a denial silently swallows the user's explicit "Run".
 *   - Priority 3 has bound the app-review marker and advanced the 30-minute
 *     review cooldown (issue #978's failure mode).
 *
 * Emitting instead is strictly better — the authoritative cap at subAgentSpawner's
 * `task:ready` chokepoint HOLDS the task (still `pending`, marker released, job
 * reservation freed), which is exactly the outcome these tiers cannot produce.
 * Idle review prechecks global/project capacity before preparation below.
 */
export function createDequeueCapacity(state, {
  agentsByProject = {},
  localEndpointCounts = {},
  localEndpointLimit = Infinity,
  resolveLocalEndpoint = () => null,
  onLocalEndpointHold = null,
} = {}) {
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;
  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  // A caller passing 0/NaN would wedge every local-endpoint task forever; floor
  // at 1 so the cap degrades to "serialize", never to "never dispatch".
  // `Infinity` (the no-cap default) passes through unchanged.
  const localSlotLimit = Math.max(1, Number(localEndpointLimit) || 1);

  const spawnProjectCounts = { ...agentsByProject };
  const spawnLocalEndpointCounts = { ...localEndpointCounts };
  const spawnedTaskIds = [];
  let spawned = 0;

  const admit = (task, ceiling, gateLocalEndpoint) => {
    // App eligibility probes have no task id yet; only real tasks can have
    // an owner (a running legacy agent may also have no taskId).
    if (task.id && hasActiveTaskOwner(task.id, state.agents)) return false;
    if (spawned >= ceiling) return false;
    const project = task.metadata?.app || '_self';
    if ((spawnProjectCounts[project] || 0) >= perProjectLimit) return false;
    const endpoint = gateLocalEndpoint ? resolveLocalEndpoint(task) : null;
    if (endpoint) {
      const running = spawnLocalEndpointCounts[endpoint] || 0;
      if (running >= localSlotLimit) {
        onLocalEndpointHold?.(task, endpoint, running);
        return false;
      }
    }
    return true;
  };

  const canSpawn = (task, ceiling = availableSlots) => admit(task, ceiling, true);
  // For a COMMITTED tier — one that has already taken side effects and does not
  // persist the task, so a denial would discard it rather than defer it. Skips
  // only the local-endpoint cap; see the header for which tiers qualify and why.
  const canSpawnCommitted = (task, ceiling = availableSlots) => admit(task, ceiling, false);

  const trackSpawn = (task) => {
    const project = task.metadata?.app || '_self';
    spawnProjectCounts[project] = (spawnProjectCounts[project] || 0) + 1;
    const endpoint = resolveLocalEndpoint(task);
    if (endpoint) spawnLocalEndpointCounts[endpoint] = (spawnLocalEndpointCounts[endpoint] || 0) + 1;
    spawnedTaskIds.push(typeof task?.id === 'string' && task.id ? task.id : 'unknown-task');
    spawned++;
  };

  return {
    availableSlots,
    perProjectLimit,
    localEndpointLimit: localSlotLimit,
    spawnProjectCounts,
    spawnLocalEndpointCounts,
    canSpawn,
    canSpawnCommitted,
    trackSpawn,
    // Live read of the running spawn count — a getter so callers always see the
    // current total after trackSpawn mutations rather than a stale snapshot.
    get spawned() { return spawned; },
    get spawnedTaskIds() { return spawnedTaskIds; },
  };
}

/**
 * Count running agents grouped by the local inference endpoint they occupy
 * (issue #4834). `endpointForAgent` maps a running agent to its local endpoint
 * or null — supplied by cosLocalEndpointSlots.js so this stays pure. Agents on
 * cloud providers (and TUI providers with no recorded endpoint) resolve to null
 * and are not counted, mirroring the ungated path in `createDequeueCapacity`.
 */
export function countRunningAgentsByLocalEndpoint(agents, endpointForAgent) {
  const counts = {};
  for (const agent of Object.values(agents || {})) {
    if (agent.status !== 'running') continue;
    const endpoint = endpointForAgent(agent);
    if (!endpoint) continue;
    counts[endpoint] = (counts[endpoint] || 0) + 1;
  }
  return counts;
}

/**
 * Priority 3.6 (feature agents) tier. Shared by both spawn engines: due feature
 * agents are autonomous work, so they yield to pending user tasks, need CoS
 * auto-run in `execute`, and spend only the autonomous ceiling. Each admitted
 * agent is marked as holding a pending task so a second cycle cannot re-spawn it.
 *
 * Priority 3.5 (autonomous jobs) has no inline tier: those are handled by
 * registerJobSchedules(), which sets up one-shot timers per job via
 * executeScheduledJob(). Spawning them here as well caused duplicate agent spawns
 * on startup when both paths fired for the same past-due job.
 *
 * `spawnedCount()` reads the engine's live spawn total (it grows as agents are
 * admitted); `canSpawn`/`emitSpawn`/`trackSpawn` are the engine's own hooks.
 */
export async function admitFeatureAgentTasks({
  spawnedCount,
  hasPendingUserTasks,
  cosAutonomyMode,
  autonomousSlotCeiling,
}, { canSpawn, emitSpawn, trackSpawn }) {
  if (spawnedCount() >= autonomousSlotCeiling || hasPendingUserTasks || cosAutonomyMode !== 'execute') return;

  const { getDueFeatureAgents, generateTaskFromFeatureAgent, setCurrentAgent } = await import('./featureAgents.js');
  const dueAgents = await getDueFeatureAgents().catch(err => {
    emitLog('debug', `Feature agents check failed: ${err.message}`);
    return [];
  });
  for (const fa of dueAgents) {
    if (spawnedCount() >= autonomousSlotCeiling) break;
    const task = generateTaskFromFeatureAgent(fa);
    if (!canSpawn(task, autonomousSlotCeiling)) continue;
    emitSpawn(task);
    trackSpawn(task);
    await setCurrentAgent(fa.id, task.id).catch(() => {});
    emitLog('info', `Feature agent due: ${fa.name}`, { featureAgentId: fa.id });
  }
}

/**
 * Priority 4 (idle-review) tier eligibility. The idle task only fires when the
 * daemon is COMPLETELY idle this cycle — nothing else spawned (`spawned === 0`),
 * no pending user tasks, idle review enabled, and CoS auto-run in `execute`.
 * The `spawned === 0` fence is stricter than the auto-approved tier's `< ceiling`
 * admission: even a single autonomous spawn suppresses idle on the same cycle.
 */
export function isIdleTierEligible({ spawned, hasPendingUserTasks, idleReviewEnabled, autonomyMode }) {
  return spawned === 0
    && !!idleReviewEnabled
    && !hasPendingUserTasks
    && autonomyMode === 'execute';
}

/**
 * Close the preflight card of a human "Run" this tier STOLE, now that the
 * admission decision on the task it produced is final (`admittedTask` is that
 * task, or null when none will run).
 *
 * Lives beside `isIdleTierEligible` for the same reason: both spawn engines run
 * their own copy of the idle-review tier, and anything the two must agree on
 * belongs in ONE body rather than in a pair of blocks a grep test has to police.
 * The import is deferred so the far more common uncarded tick — every idle tick
 * that did not steal a request — pays neither the module nor a task read.
 */
export async function closeStolenIdleReviewCard(cardId, admittedTask) {
  if (!cardId) return null;
  const { finishPreflightDispatch } = await import('./preflightTaskCard.js');
  return finishPreflightDispatch(cardId, admittedTask?.id ?? null);
}

/**
 * Shared idle-review lifecycle for the periodic and dequeue engines. Capacity
 * comes from each engine's existing tracker; the same committed admission
 * predicate filters apps before generation and admits the resulting task.
 * Local-endpoint denial remains the spawn chokepoint's durable hold/release.
 */
export async function admitIdleReviewTask({
  state,
  alreadySpawned,
  hasPendingUserTasks,
  cosAutonomyMode,
  autonomousSlotCeiling,
  ignoreTaskId = null,
}, { canSpawn, emitSpawn, trackSpawn }) {
  if (!isIdleTierEligible({
    spawned: alreadySpawned,
    hasPendingUserTasks,
    idleReviewEnabled: state.config.idleReviewEnabled,
    autonomyMode: cosAutonomyMode,
  }) || alreadySpawned >= autonomousSlotCeiling) return;

  // Deferred: the generator imports this owner, and ordinary capacity users
  // need neither the task store nor the prompt-generation dependency graph.
  const { getCosTasks } = await import('./cosTaskStore.js');
  if ((await getCosTasks()).autoApproved?.length) return;
  const { generateIdleReviewTask, recordDeferredPerpetualDispatch } = await import('./cosTaskGenerator.js');
  const { task, pendingPerpetualDispatch, preflightCardId } = await generateIdleReviewTask(state, {
    ignoreTaskId,
    isAppEligible: (app) => canSpawn({ metadata: { app: app.id } }, autonomousSlotCeiling),
  });
  const admitted = task && canSpawn(task, autonomousSlotCeiling);
  if (admitted) {
    await recordDeferredPerpetualDispatch(pendingPerpetualDispatch, await import('./taskSchedule.js'));
    emitSpawn(task);
    trackSpawn(task);
  }
  await closeStolenIdleReviewCard(preflightCardId, admitted ? task : null);
}

/**
 * Priority 1 (user) tier: is this pending user row runnable unattended?
 *
 * The user tier otherwise spawns EVERY pending row, so `autoApproved` carried no
 * weight in the user file — and that is exactly where its `false` is most
 * informative. A strict row always parses auto-approved, so `false` on a user row
 * can only come from the parser's RECOVERY match (taskParser.js), which cannot
 * tell a genuine legacy row from a task-shaped SENTENCE sitting at column 0 inside
 * a legacy multi-line description body (#7300). Spawning that is an agent run
 * minted from prose. The row is preserved and stays pending for a human.
 *
 * `undefined` is NOT that claim — a task built without the field (most user rows)
 * stays runnable, so this narrows nothing that was already running.
 *
 * `approvalRequired` is the same hold said the way the FILE can hold it: the user
 * `TASKS.md` writes `| APPROVAL |` on a withheld row (#7367), which reads back as
 * `approvalRequired: true` + `autoApproved: false`. Both are checked so the hold
 * survives whichever half a producer or a peer merge happens to carry.
 *
 * Lives beside `isIdleTierEligible` for the same reason: both spawn engines run
 * their own copy of the user tier, and anything the two must agree on belongs in
 * ONE body rather than in a pair of blocks a grep test has to police.
 */
export function isUserTaskRunnableUnattended(task) {
  return task?.autoApproved !== false && task?.approvalRequired !== true;
}
