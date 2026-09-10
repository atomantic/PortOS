/**
 * CoS Dequeue — pure priority/capacity helpers (issue #2530)
 *
 * The spawn-side scheduler `dequeueNextTask` (in cos.js) fills open agent slots
 * by draining four priority tiers in order. This module holds the *pure*,
 * side-effect-free pieces of that decision — the per-cycle capacity tracker and
 * the idle tier-eligibility predicate — so the scheduler and its unit
 * tests share ONE implementation instead of the tests re-deriving a local
 * replica of the guards.
 *
 * The async tiers themselves (which load schedules, generate tasks, emit
 * `task:ready`, advance cooldowns) stay in cos.js as `spawnDequeuePriorityN(ctx)`
 * helpers — they're integration-level and pinned by source-order regression
 * tests — but every capacity/gate decision they make routes through here.
 *
 * Priority-tier order (pinned by the source-order regression test in
 * cos.test.js): 0 on-demand (bypasses pause) → 1 user → 2 auto-approved →
 * 3 idle review.
 */

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
 * The global/per-project caps carry the same hazard here; that is pre-existing.
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
  let spawned = 0;

  const admit = (task, ceiling, gateLocalEndpoint) => {
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
 * Priority 3 (idle-review) tier eligibility. The idle task only fires when the
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
