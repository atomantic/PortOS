/**
 * CoS Dequeue — pure priority/capacity helpers (issue #2530)
 *
 * The spawn-side scheduler `dequeueNextTask` (in cos.js) fills open agent slots
 * by draining five priority tiers in order. This module holds the *pure*,
 * side-effect-free pieces of that decision — the per-cycle capacity tracker and
 * the mission/idle tier-eligibility predicates — so the scheduler and its unit
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
 * 3 mission → 4 idle review.
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
 */
export function createDequeueCapacity(state, { agentsByProject = {} } = {}) {
  const runningAgents = Object.values(state.agents).filter(a => a.status === 'running').length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;
  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;

  const spawnProjectCounts = { ...agentsByProject };
  let spawned = 0;

  const canSpawn = (task, ceiling = availableSlots) => {
    if (spawned >= ceiling) return false;
    const project = task.metadata?.app || '_self';
    return (spawnProjectCounts[project] || 0) < perProjectLimit;
  };

  const trackSpawn = (task) => {
    const project = task.metadata?.app || '_self';
    spawnProjectCounts[project] = (spawnProjectCounts[project] || 0) + 1;
    spawned++;
  };

  return {
    availableSlots,
    perProjectLimit,
    spawnProjectCounts,
    canSpawn,
    trackSpawn,
    // Live read of the running spawn count — a getter so callers always see the
    // current total after trackSpawn mutations rather than a stale snapshot.
    get spawned() { return spawned; },
  };
}

/**
 * Priority 3 (mission) tier eligibility. Mission tasks are speculative
 * autonomous spawns: they only run when there's autonomous headroom left this
 * cycle, no pending user tasks are waiting, proactive mode is on, AND the CoS
 * auto-run domain is in `execute` (off/dry-run withhold autonomous spawns).
 */
export function isMissionTierEligible({ spawned, ceiling, hasPendingUserTasks, proactiveMode, autonomyMode }) {
  return spawned < ceiling
    && !hasPendingUserTasks
    && !!proactiveMode
    && autonomyMode === 'execute';
}

/**
 * Priority 4 (idle-review) tier eligibility. The idle task only fires when the
 * daemon is COMPLETELY idle this cycle — nothing else spawned (`spawned === 0`),
 * no pending user tasks, idle review enabled, and CoS auto-run in `execute`.
 * The `spawned === 0` fence is stricter than mission's `< ceiling`: even a single
 * autonomous spawn suppresses idle on the same cycle.
 */
export function isIdleTierEligible({ spawned, hasPendingUserTasks, idleReviewEnabled, autonomyMode }) {
  return spawned === 0
    && !!idleReviewEnabled
    && !hasPendingUserTasks
    && autonomyMode === 'execute';
}
