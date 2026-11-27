/**
 * Admits queued CoS tasks in priority order when agent capacity opens.
 */

import { maintenance } from '../../lib/maintenanceAdmission.js';
import { isHostShuttingDown } from '../../lib/hostShutdown.js';
import { drainOnDemandRequests } from '../onDemandDrain.js';
import { useRunner, spawningTasks } from '../agent/agentState.js';
import { loadState, isDaemonRunning } from './cosState.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { getUserTasks, getCosTasks } from './cosTaskStore.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { admitAutoApprovedSystemTasks, admitPendingUserTasks, resolveAutonomyBudget, countRunningAgentsByProject, isWithinProjectLimit } from './cosTaskGenerator.js';
import { admitFeatureAgentTasks, admitIdleReviewTask, createDequeueCapacity, countRunningAgentsByLocalEndpoint } from './cosDequeueAdmission.js';
import { buildLocalEndpointSlotContext } from './cosLocalEndpointSlots.js';

export { admitFeatureAgentTasks, admitIdleReviewTask, closeStolenIdleReviewCard, countRunningAgentsByLocalEndpoint, countUnregisteredInFlight, createDequeueCapacity, isIdleTierEligible, isUserTaskRunnableUnattended } from './cosDequeueAdmission.js';

/**
 * Is spawning currently held because the CoS Runner is down?
 *
 * The single predicate behind the three places that must agree: the dequeue
 * gate, `tryImmediateSpawn`, and `forceSpawnTask`'s refusal. False in direct
 * mode, where there is no runner to be down. `cosRunnerClient` is imported
 * lazily (mirroring cosAgentLifecycle's runner calls) so a static edge doesn't
 * drag socket.io-client into the graph of every suite that loads this module.
 */
export async function isRunnerHolding() {
  if (!useRunner) return false;
  const { isRunnerReachable } = await import('./cosRunnerClient.js');
  return !(await isRunnerReachable());
}

/**
 * Attempt to immediately spawn a newly added user task if there are available agent slots.
 * This bypasses the evaluation interval for user-submitted tasks so they start instantly.
 */
export async function tryImmediateSpawn(task) {
  if (isHostShuttingDown()) return;
  if (!isDaemonRunning()) return;

  const { paused } = await loadState();
  if (paused) return;

  if (await isRunnerHolding()) {
    emitLog('debug', `⏳ Queued task ${task.id} - CoS Runner is down`);
    return;
  }

  const state = await loadState();
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  if (availableSlots <= 0) {
    emitLog('debug', `⏳ Queued task ${task.id} - no available slots (${runningAgents}/${state.config.maxConcurrentAgents})`);
    return;
  }

  // Check per-project limit
  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  const agentsByProject = countRunningAgentsByProject(state.agents);
  if (!isWithinProjectLimit(task, agentsByProject, perProjectLimit)) {
    const project = task.metadata?.app || '_self';
    emitLog('debug', `⏳ Queued task ${task.id} - per-project limit reached for ${project} (${agentsByProject[project] || 0}/${perProjectLimit})`);
    return;
  }

  // No local-endpoint check here (#4834). The task is already persisted by
  // `addTask`, so emitting and letting the chokepoint hold it produces exactly
  // the state an early return would — still `pending`, marker released, job
  // reservation freed — and the chokepoint also counts in-flight reservations,
  // which a snapshot here cannot. A copy would be a weaker duplicate that can
  // pass a task the chokepoint then holds, for a fourth provider-list fetch.

  emitLog('info', `⚡ Immediate spawn: ${task.id} (${task.priority || 'MEDIUM'})`, {
    taskId: task.id,
    availableSlots
  });
  cosEvents.emit('task:ready', { ...task, taskType: 'user' });
}

// ─── dequeueNextTask priority tiers ────────────────────────────────────────
//
// dequeueNextTask (below) is a thin orchestrator that threads a shared `ctx`
// through the five priority tiers in order. Each tier is a focused async helper
// that reads/mutates the per-cycle spawn capacity via `ctx.capacity` (the pure
// tracker from cosDequeueAdmission.js) and emits `task:ready` for admitted tasks. This
// mirrors the established `spawnPriorityN(ctx)` decomposition in
// cosTaskGenerator.js's evaluateTasks (issue #2530). `ctx` is frozen: a tier
// returns the values a later tier needs and the orchestrator passes them on as
// named arguments, so tier order cannot silently change what a tier reads.

/**
 * Priority 0 — on-demand task requests (explicit user "Run"). Runs even while
 * paused. Drains the on-demand request queue, generating + persisting a task per
 * request. Returns the schedule it loaded so the orchestrator can hand it to
 * Priority 2's disabled-analysis-type gate (avoids a second load).
 */
async function spawnDequeuePriority0OnDemand(ctx) {
  const { state, capacity, ignoreTaskId } = ctx;

  const { schedule } = await drainOnDemandRequests({ state }, {
    capacityExhausted: () => capacity.spawned >= capacity.availableSlots,
    projectCapacityExhausted: (appId) =>
      (capacity.spawnProjectCounts[appId || '_self'] || 0) >= capacity.perProjectLimit,
    // Priority 0 is a COMMITTED tier — the request is cleared and the app-review
    // marker bound before this runs, and nothing persists the task on a denial,
    // so it opts out of the local-endpoint cap (#4834).
    canSpawn: (task) => capacity.canSpawnCommitted(task),
    emitSpawn: (task) => {
      cosEvents.emit('task:ready', task);
      capacity.trackSpawn(task);
    },
    // Forward `ignoreTaskId` so a completion-triggered re-issue is dedup-safe
    // against the still-in_progress task that triggered it.
    addTaskOptions: { ignoreTaskId },
  });

  return { schedule };
}

/**
 * Priority 1 — pending user tasks. Returns `hasPendingUserTasks`
 * for the idle tier below.
 */
async function spawnDequeuePriority1UserTasks(ctx) {
  const { instanceId, capacity } = ctx;

  const userTaskData = await getUserTasks();
  const pendingUserTasks = userTaskData.grouped?.pending || [];

  await admitPendingUserTasks({ pendingUserTasks, instanceId }, {
    capacityExhausted: () => capacity.spawned >= capacity.availableSlots,
    isOwned: (task) => capacity.isTaskOwned(task),
    canSpawn: (task) => capacity.canSpawn(task),
    emitSpawn: (task) => cosEvents.emit('task:ready', task),
    trackSpawn: (task) => capacity.trackSpawn(task),
  });

  return { hasPendingUserTasks: pendingUserTasks.length > 0 };
}

/**
 * Priority 2 — auto-approved system tasks, gated by the CoS auto-run domain.
 * Returns `cosAutonomyMode` and `autonomousSpawnCeiling` (used by the
 * idle tier) resolved from the daily CoS budget (#711). `off`/`dry-run` withhold
 * the unattended spawn; `dry-run` logs what execute mode would have run.
 */
async function spawnDequeuePriority2AutoApproved(ctx, { taskSchedule }) {
  const { state, instanceId, capacity } = ctx;

  const cosTaskData = await getCosTasks();
  const runningAgentEntries = Object.values(state.agents).filter((agent) => agent.status === 'running');
  const { cosAutonomyMode, autonomousActionsRemaining } = await resolveAutonomyBudget(state, runningAgentEntries);
  const autonomousSpawnCeiling = Math.min(capacity.availableSlots, capacity.spawned + autonomousActionsRemaining);

  await admitAutoApprovedSystemTasks({
    state,
    cosTaskData,
    taskSchedule,
    cosAutonomyMode,
    autonomousSlotCeiling: autonomousSpawnCeiling,
    alreadySpawned: capacity.spawned,
    perProjectLimit: capacity.perProjectLimit,
    spawnProjectCounts: capacity.spawnProjectCounts,
    instanceId,
  }, {
    isOwned: (task) => capacity.isTaskOwned(task),
    canSpawn: (task, ceiling) => capacity.canSpawn(task, ceiling),
    trackSpawn: (task) => capacity.trackSpawn(task),
    emitSpawn: (task) => {
      cosEvents.emit('task:ready', task);
    },
  });

  return { cosAutonomyMode, autonomousSpawnCeiling };
}

/**
 * Priority 3.6 — due feature agents. Same shared admission pass as
 * evaluateTasks, so an agent that comes due is dispatched by the next
 * completion/queue event instead of waiting for a batch evaluation.
 */
async function spawnDequeuePriority36FeatureAgents(ctx, { hasPendingUserTasks, cosAutonomyMode, autonomousSpawnCeiling }) {
  const { capacity } = ctx;
  return admitFeatureAgentTasks({
    spawnedCount: () => capacity.spawned,
    hasPendingUserTasks,
    cosAutonomyMode,
    autonomousSlotCeiling: autonomousSpawnCeiling,
  }, {
    canSpawn: (task, ceiling) => capacity.canSpawn(task, ceiling),
    emitSpawn: (task) => cosEvents.emit('task:ready', task),
    trackSpawn: (task) => capacity.trackSpawn(task),
  });
}

/**
 * Priority 4 — idle review task, only when the daemon is completely idle this
 * cycle. The shared owner checks eligibility and capacity before preparation,
 * then performs the committed handoff.
 */
async function spawnDequeuePriority4IdleReview(ctx, { hasPendingUserTasks, cosAutonomyMode, autonomousSpawnCeiling }) {
  const { capacity } = ctx;
  return admitIdleReviewTask({
    state: ctx.state,
    alreadySpawned: capacity.spawned,
    hasPendingUserTasks,
    cosAutonomyMode,
    autonomousSlotCeiling: autonomousSpawnCeiling,
    ignoreTaskId: ctx.ignoreTaskId,
  }, {
    canSpawn: (task, ceiling) => capacity.canSpawnCommitted(task, ceiling),
    emitSpawn: (task) => cosEvents.emit('task:ready', task),
    trackSpawn: (task) => capacity.trackSpawn(task),
  });
}

// Every dequeue below is scheduled from a timer/setImmediate outside the request
// lifecycle, so a rejection has nowhere to bubble: it escapes as an unhandled
// rejection, which setupProcessErrorHandlers classifies `critical` and broadcasts
// `system:critical-error` to every browser, while the open slot it was meant to
// fill stays empty until an unrelated event fires another cycle. One wrapper so
// the guard cannot drift between the ~10 call sites.
export const scheduleDequeue = (options = {}) => setImmediate(() => {
  dequeueNextTask(options).catch(err =>
    console.error(`❌ CoS dequeue cycle failed: ${err?.message ?? String(err)}`));
});

/**
 * Event-driven task dequeue — the primary way tasks get spawned.
 *
 * Triggered by: agent:completed, tasks:changed, status:resumed
 * Thin orchestrator: computes per-cycle capacity, then threads a shared `ctx`
 * through the priority tiers in order (same tiers/numbering as evaluateTasks;
 * evaluateTasks' queue-regeneration step is
 * batch-only and has no event-driven counterpart):
 *   0. On-demand requests (bypasses pause)
 *   1. User tasks
 *   2. Auto-approved system tasks
 *   3.6. Due feature agents
 *   4. Idle review task (if idleReviewEnabled)
 * Returns silently when idle — no log noise.
 */
/**
 * `ignoreTaskId` names a task that just completed but may still read
 * `pending`/`in_progress` on disk — `agent:completed` fires from `completeAgent`,
 * before the completion flow's `updateTask` settles it. Generators that count
 * in-flight work against a spend budget (#3179) must exclude it or they
 * charge the finished run twice. Only the completion continuation passes it; every
 * other caller runs outside that window and correctly leaves it null.
 */
export async function dequeueNextTask({ ignoreTaskId = null } = {}) {
  if (maintenance.held() || maintenance.agentDiskPressure()) return;
  if (!isDaemonRunning()) return;
  // Same reason as the runner gate below: the tiers' side effects cannot be
  // taken back, and an agent registered after the shutdown marker snapshot is
  // charged as a genuine orphan on the next boot (#14170).
  if (isHostShuttingDown()) return;

  // In runner mode the cos-runner app owns every agent process, so a cycle run
  // while it is down can only produce holds. Bail before the tiers rather than
  // after: they drain on-demand requests, advance review cooldowns, bind the
  // synthetic app-review marker, and spend `capacity` — side effects a hold
  // downstream cannot take back. Same shape as the `availableSlots <= 0` gate
  // below; "the runner is off" is the same fact as "there is nowhere to spawn".
  // `connection:ready` re-runs this the moment the runner returns.
  if (await isRunnerHolding()) return;

  // A global pause stops scheduled/autonomous spawning, but NOT explicit user
  // triggers: on-demand requests (Priority 0) are processed even while paused so
  // a manual "Run" from an app's automation page still fires. The autonomous
  // tiers (Priority 1+) are skipped below when paused.
  const { paused } = await loadState();

  const state = await loadState();

  // Bail before the provider fetch below. This function fires from ~8 event
  // sources plus a setImmediate on every completion, and a saturated pool — the
  // state that makes those fire in bursts — would otherwise pay two awaits and
  // a full agent scan per trigger for a tracker discarded immediately.
  if (state.config.maxConcurrentAgents - Object.values(state.agents).filter(a => a.status === 'running').length <= 0) return;

  // Per-local-endpoint agent slots (#4834). A CoS agent runs a vendor CLI that
  // talks to the local model server directly, so promptRunner's in-flight gate
  // never sees it; without this, two agents can be dispatched at one GPU and
  // take an accelerator OOM. Resolved once per cycle and threaded into the
  // capacity tracker, which enforces it alongside the global/per-project caps.
  //
  // Predictive only — it just avoids emitting a task the chokepoint would hold,
  // so unlike `acquireLocalEndpointSpawnSlot` it does NOT count in-flight
  // reservations. Erring toward admitting is correct here: the authoritative
  // gate still refuses, and a hold is cheap.
  const localSlots = await buildLocalEndpointSlotContext();
  // One debug line per saturated endpoint per cycle, not one per queued task —
  // the user/system tiers `continue` past a denial, so a 40-task queue behind
  // one busy GPU would otherwise emit 40 identical log events, each broadcast
  // to every CoS-subscribed socket client.
  const loggedFullEndpoints = new Set();
  const capacity = createDequeueCapacity(state, {
    inFlightTaskIds: spawningTasks,
    agentsByProject: countRunningAgentsByProject(state.agents),
    localEndpointCounts: countRunningAgentsByLocalEndpoint(state.agents, localSlots.endpointForAgent),
    localEndpointLimit: localSlots.limit,
    resolveLocalEndpoint: localSlots.resolveLocalEndpoint,
    onLocalEndpointHold: (task, endpoint, running) => {
      if (loggedFullEndpoints.has(endpoint)) return;
      loggedFullEndpoints.add(endpoint);
      emitLog('debug', `⏳ Queued task ${task.id} - local endpoint ${endpoint} at capacity (${running}/${localSlots.limit})`, {
        taskId: task.id,
        endpoint
      });
    }
  });
  const availableSlots = capacity.availableSlots;

  if (availableSlots <= 0) return;

  // This instance's federation id, resolved once per cycle so the priority
  // tiers below can skip tasks a peer holds a live lease on (#1650). Warm path
  // is the cheap cached read; only the cold boot creates the identity.
  const instanceId = await ensureInstanceId();

  // Shared spawn context threaded through each priority tier. The tiers mutate
  // the running spawn total + per-project counts through `capacity` (whose
  // `canSpawn`/`trackSpawn` close over that state). Frozen: cross-tier values
  // (schedule, hasPendingUserTasks, cosAutonomyMode, autonomousSpawnCeiling) are
  // returned by the tier that resolves them and passed on as named arguments.
  const ctx = Object.freeze({
    state,
    instanceId,
    capacity,
    ignoreTaskId
  });

  // Priority 0 (on-demand) runs even when paused — an explicit user "Run"
  // bypasses the global pause.
  const { schedule: taskSchedule } = await spawnDequeuePriority0OnDemand(ctx);

  // Global pause stops every autonomous/scheduled/user tier below; only the
  // on-demand queue above (explicit user "Run") bypasses it.
  if (paused) return;

  // Priority 1 spends against the global slot cap.
  const { hasPendingUserTasks } = await spawnDequeuePriority1UserTasks(ctx);

  // Priorities 2, 3.6 and 4 spend against the lower autonomous ceiling that
  // Priority 2 resolves `autonomousSpawnCeiling` from the daily budget.
  const { cosAutonomyMode, autonomousSpawnCeiling } = await spawnDequeuePriority2AutoApproved(ctx, { taskSchedule });
  await spawnDequeuePriority36FeatureAgents(ctx, { hasPendingUserTasks, cosAutonomyMode, autonomousSpawnCeiling });
  await spawnDequeuePriority4IdleReview(ctx, { hasPendingUserTasks, cosAutonomyMode, autonomousSpawnCeiling });

  if (capacity.spawned > 0) {
    const ids = capacity.spawnedTaskIds.join(', ');
    emitLog('info', `⚡ Dequeued ${capacity.spawned} task(s): ${ids}`, {
      spawned: capacity.spawned,
      taskIds: capacity.spawnedTaskIds,
      availableSlots,
    });
  }
}
