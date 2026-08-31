/**
 * Tests for cos.js — focused on the two hot-spot internals that gate every
 * agent spawn but have no full-function test sibling:
 *
 * 1. `evaluateTasks` priority ordering — Priority 0 (on-demand) > Priority 1
 *    (user) > Priority 2 (auto-approved system) > Priority 3 (mission /
 *    feature agent) > Priority 4 (idle review). Within a priority bucket
 *    tasks are taken in the order they appear in TASKS.md (the parser sorts
 *    nothing for the pending slice — file order is the tie-breaker).
 *
 * 2. `dequeueNextTask` capacity guards — global `maxConcurrentAgents` cap
 *    and per-project `maxConcurrentAgentsPerProject` cap. The function must
 *    short-circuit when no slots are available and must skip tasks whose
 *    project bucket is already saturated even if the global slot count
 *    permits one more spawn.
 *
 * `evaluateTasks` and `dequeueNextTask` are 250+ LOC each and pull in 40+
 * imported helpers (loadState, getAllTasks, addTask, getActiveApps, mission
 * generation, taskSchedule, etc.). Mocking the full graph would be a brittle
 * test of mocks rather than logic, so we exercise the *real* capacity/gate
 * exports the scheduler uses — `createDequeueCapacity`, `isMissionTierEligible`,
 * `isIdleTierEligible` from cosDequeue.js (issue #2530) — through a thin drain
 * harness. Only the tier-ordering loop glue is local; every capacity and
 * eligibility decision routes through the same helpers `dequeueNextTask` calls,
 * so a guard-logic regression fails here instead of only in production.
 *
 * A source-level regression check at the bottom asserts the priority order
 * and the capacity-guard early return are still in place in `cos.js`, so a
 * future refactor that reorders priorities or removes the
 * `availableSlots <= 0` short-circuit flips a clear red flag.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { firstLine, isPerpetualRefillCandidate, perpetualRefillPlan } from './cos.js';
import { canQueueImprovementTasks, DEFAULT_STATE } from './cosState.js';
import { createDequeueCapacity, countRunningAgentsByLocalEndpoint, isMissionTierEligible, isIdleTierEligible } from './cosDequeue.js';
import {
  createLocalEndpointSlotContext,
  cloudSwarmThreadCapacity,
  localEndpointOfProvider,
  providerBaseUrl,
  reserveLocalEndpointSpawn,
  acquireLocalEndpointProviderSlot,
  pendingLocalEndpointSpawns,
  __resetLocalEndpointSpawnReservations,
  readEndpointCapacity,
} from './cosLocalEndpointSlots.js';
import { PENDING_MERGE_SWEEP_INTERVAL_MS, MAX_PENDING_MERGE_TICKS } from './prWatcher.js';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../lib/persistentMind.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COS_SRC = readFileSync(join(__dirname, 'cos.js'), 'utf-8');
// The task-generation engine (evaluateTasks + the improvement/idle generators
// + applyPlanIdMetadata) was extracted to cosTaskGenerator.js (issue-741). The
// spawn-side scheduler (dequeueNextTask, tryImmediateSpawn, the tasks:changed
// listener) stays in cos.js. Source-level guards below read each invariant from
// whichever module now owns it.
const GEN_SRC = readFileSync(join(__dirname, 'cosTaskGenerator.js'), 'utf-8');
const SCHED_SRC = readFileSync(join(__dirname, 'cosJobScheduler.js'), 'utf-8');
// The pure capacity tracker + mission/idle tier-eligibility predicates that
// dequeueNextTask (and these tests) call live in cosDequeue.js (issue #2530).
const DEQ_SRC = readFileSync(join(__dirname, 'cosDequeue.js'), 'utf-8');

// ─── Real capacity/gate exports driven by a thin harness ───────────────────

/**
 * Build the REAL per-cycle capacity tracker (`createDequeueCapacity` from
 * cosDequeue.js) from a fixture state — the same tracker `dequeueNextTask`
 * constructs. Exposes `availableSlots`, `perProjectLimit`, `spawnProjectCounts`,
 * and the `canSpawn`/`trackSpawn` closure the scheduler enforces. `spawned` is a
 * live numeric getter (not an array), so the drain harness below keeps its own
 * `admitted` list of the task objects it let through.
 */
function makeCapacityTracker(state, agentsByProject = {}) {
  return createDequeueCapacity(state, { agentsByProject });
}

/**
 * Thin drain harness modelling the priority-bucket loop in `dequeueNextTask`.
 * The five buckets are drained in this exact order:
 *
 *   0. onDemand    — explicit user requests (highest, bypasses pause)
 *   1. user        — user-authored pending tasks
 *   2. autoSystem  — auto-approved system / improvement tasks
 *   3. mission     — proactive mission tasks (only when eligible)
 *   4. idle        — generated idle-review task (only when eligible)
 *
 * Only the ordering/glue is local: every capacity decision routes through the
 * real `capacity.canSpawn`/`trackSpawn`, and the mission/idle fences use the
 * real `isMissionTierEligible` / `isIdleTierEligible` predicates the scheduler
 * calls. Within a bucket, iteration order is the source array order (file order
 * for parsed TASKS.md; arrival order for the on-demand queue) — the loop does
 * NOT re-sort by priorityValue.
 *
 * Idle gating is stricter than mission's: `isIdleTierEligible` requires
 * `spawned === 0`, so ANY earlier spawn (autoSystem or mission) suppresses idle
 * on the same cycle. Tests run with auto-run in `execute` and proactive/idle
 * enabled so the tier predicates reduce to the pending-user + spawned gates.
 */
function priorityDequeue(buckets, capacity, { paused = false } = {}) {
  const admitted = [];
  const hasPendingUserTasks = (buckets.user || []).length > 0;
  // No daily budget in these fixtures, so the autonomous ceiling equals the
  // global slot count.
  const ceiling = capacity.availableSlots;

  const drain = (bucketName) => {
    // Priorities 0, 3 and 4 opt OUT of the local-endpoint cap, exactly as
    // production does: a denial there DISCARDS an already-committed task (a
    // cleared on-demand request, an `in_progress` mission sub-task, a bound
    // app-review marker) instead of deferring it, so they emit and let the
    // spawner chokepoint hold.
    const committed = ['onDemand', 'mission', 'idle'].includes(bucketName);
    for (const task of buckets[bucketName] || []) {
      if (capacity.spawned >= capacity.availableSlots) return;
      if (!(committed ? capacity.canSpawnCommitted(task) : capacity.canSpawn(task))) continue;
      capacity.trackSpawn(task);
      admitted.push({ ...task, _bucket: bucketName });
    }
  };

  // Priority 0 (on-demand) drains even when paused.
  drain('onDemand');
  // Global pause stops every autonomous/scheduled/user tier below.
  if (paused) return admitted;

  drain('user');
  drain('autoSystem');

  if (isMissionTierEligible({
    spawned: capacity.spawned, ceiling, hasPendingUserTasks,
    proactiveMode: true, autonomyMode: 'execute'
  })) drain('mission');

  if (isIdleTierEligible({
    spawned: capacity.spawned, hasPendingUserTasks,
    idleReviewEnabled: true, autonomyMode: 'execute'
  })) drain('idle');

  return admitted;
}

// ─── Fixture helpers ───────────────────────────────────────────────────────

function makeState({ maxConcurrentAgents = 3, maxConcurrentAgentsPerProject = null, runningAgents = [] } = {}) {
  return {
    config: { maxConcurrentAgents, maxConcurrentAgentsPerProject },
    agents: Object.fromEntries(runningAgents.map((a, i) => [`agent-${i}`, a])),
  };
}

function makeRunningAgent(app = '_self') {
  return { status: 'running', metadata: { taskApp: app, app } };
}

const task = (id, priority = 'MEDIUM', { app } = {}) => ({
  id,
  priority,
  status: 'pending',
  metadata: app !== undefined ? { app } : {},
});

// ─── evaluateTasks: priority ordering ──────────────────────────────────────

describe('evaluateTasks — priority ordering', () => {
  it('drains buckets in order: onDemand > user > autoSystem > mission > idle', () => {
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [task('task-onDemand-1')],
      user: [task('task-user-1')],
      autoSystem: [task('sys-auto-1')],
      // Mission/idle should be SKIPPED here because user bucket is non-empty
      // (matches production line 795 `hasPendingUserTasks` gate).
      mission: [task('sys-mission-1')],
      idle: [task('sys-idle-1')],
    };

    const spawned = priorityDequeue(buckets, capacity);

    // Order is: onDemand, user, autoSystem (mission/idle blocked by user-pending gate)
    expect(spawned.map(t => t.id)).toEqual([
      'task-onDemand-1',
      'task-user-1',
      'sys-auto-1',
    ]);
    expect(spawned.map(t => t._bucket)).toEqual(['onDemand', 'user', 'autoSystem']);
  });

  it('when globally paused, only the on-demand bucket drains (manual Run bypasses pause)', () => {
    // A global pause stops scheduled/autonomous/user spawning, but an explicit
    // user "Run" pushes an on-demand request that must still fire. Mirrors the
    // production gate: Priority 0 (on-demand) is processed, then `if (paused) return;`.
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [task('task-onDemand-1')],
      user: [task('task-user-1')],
      autoSystem: [task('sys-auto-1')],
      mission: [task('sys-mission-1')],
      idle: [task('sys-idle-1')],
    };

    const spawned = priorityDequeue(buckets, capacity, { paused: true });

    // Only the on-demand request spawns; everything else stays paused.
    expect(spawned.map(t => t.id)).toEqual(['task-onDemand-1']);
    expect(spawned.map(t => t._bucket)).toEqual(['onDemand']);
  });

  it('mission + idle fire only when there are NO pending user tasks', () => {
    // Idle is fenced behind `spawned === 0` in production (cos.js:2480), so
    // when autoSystem and mission are both non-empty, idle does NOT fire.
    // This test pins the user-pending gate; the next test pins the idle
    // `spawned === 0` gate.
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [], // ← critical: no pending user tasks
      autoSystem: [task('sys-auto-1')],
      mission: [task('sys-mission-1')],
      idle: [task('sys-idle-1')],
    };

    const spawned = priorityDequeue(buckets, capacity);
    // autoSystem + mission spawn; idle is SUPPRESSED because earlier buckets
    // already produced spawns (mirrors cos.js:2480 `spawned === 0` guard).
    expect(spawned.map(t => t._bucket)).toEqual(['autoSystem', 'mission']);
  });

  it('idle fires only when nothing else has spawned (spawned === 0 gate, cos.js:2480)', () => {
    // When autoSystem and mission are both empty AND no user-pending, idle
    // gets to run. This is the only path through which the idle bucket
    // actually drains in production.
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [],
      autoSystem: [],
      mission: [],
      idle: [task('sys-idle-1')],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t._bucket)).toEqual(['idle']);
  });

  it('idle suppressed when only autoSystem spawned (no user, no mission)', () => {
    // Pin the asymmetry: even a SINGLE autoSystem spawn is enough to suppress
    // idle on the same cycle. This is the production behavior at cos.js:862
    // (`tasksToSpawn.length === 0`) and cos.js:2480 (`spawned === 0`).
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [],
      autoSystem: [task('sys-auto-1')],
      mission: [],
      idle: [task('sys-idle-1')],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t._bucket)).toEqual(['autoSystem']);
  });

  it('within a single bucket, file/arrival order wins (no in-bucket priority re-sort)', () => {
    // The dequeue loop does NOT sort by priorityValue at this layer. The
    // parsed-tasks slice preserves file order, so a HIGH task placed AFTER
    // a LOW task in TASKS.md is taken AFTER the LOW task. This is the
    // documented contract: callers using `addTask({ position: 'top' })` are
    // expected to control ordering at write time.
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [
        task('task-low-first', 'LOW'),
        task('task-high-second', 'HIGH'),
        task('task-critical-third', 'CRITICAL'),
      ],
      autoSystem: [],
      mission: [],
      idle: [],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t.id)).toEqual([
      'task-low-first',
      'task-high-second',
      'task-critical-third',
    ]);
  });

  it('stops issuing spawns once availableSlots is exhausted (cross-bucket)', () => {
    // Only 2 free slots — onDemand fills slot 1, user fills slot 2, the rest
    // of the queues are left untouched.
    const state = makeState({ maxConcurrentAgents: 2 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [task('task-onDemand-1')],
      user: [task('task-user-1'), task('task-user-2')],
      autoSystem: [task('sys-auto-1')],
      mission: [],
      idle: [],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned).toHaveLength(2);
    expect(spawned.map(t => t.id)).toEqual(['task-onDemand-1', 'task-user-1']);
  });

  it('returns no spawns when buckets are empty (idle queue)', () => {
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);
    const buckets = { onDemand: [], user: [], autoSystem: [], mission: [], idle: [] };
    expect(priorityDequeue(buckets, capacity)).toEqual([]);
  });
});

// ─── dequeueNextTask: capacity guards ──────────────────────────────────────

describe('dequeueNextTask — capacity guards', () => {
  it('returns zero spawns when running agents already saturate the global cap', () => {
    // 3-slot cap, 3 already running — no headroom.
    const state = makeState({
      maxConcurrentAgents: 3,
      runningAgents: [makeRunningAgent(), makeRunningAgent(), makeRunningAgent()],
    });
    const capacity = makeCapacityTracker(state);
    expect(capacity.availableSlots).toBe(0);

    const buckets = {
      onDemand: [task('task-onDemand-1')],
      user: [task('task-user-1')],
      autoSystem: [],
      mission: [],
      idle: [],
    };
    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned).toEqual([]);
  });

  it('returns zero spawns when running agents OVER-saturate the cap (>= guard, not ==)', () => {
    // Defensive: if some path registered more agents than the cap (e.g. a
    // config change shrunk the cap below current load), availableSlots goes
    // negative — the guard must still block, not let `< 0` slip through as
    // "infinite slots".
    const state = makeState({
      maxConcurrentAgents: 2,
      runningAgents: [makeRunningAgent(), makeRunningAgent(), makeRunningAgent()],
    });
    const capacity = makeCapacityTracker(state);
    expect(capacity.availableSlots).toBeLessThan(0);

    const buckets = { onDemand: [], user: [task('task-user-1')], autoSystem: [], mission: [], idle: [] };
    expect(priorityDequeue(buckets, capacity)).toEqual([]);
  });

  it('respects per-project cap: project saturated → task skipped, other-project task still fills', () => {
    // Global cap 5, but per-project cap 1. App "alpha" already has 1
    // running agent, so its pending user task must be skipped. The pending
    // task for app "beta" should still spawn (different bucket of the
    // per-project counter).
    const state = makeState({
      maxConcurrentAgents: 5,
      maxConcurrentAgentsPerProject: 1,
      runningAgents: [makeRunningAgent('alpha')],
    });
    const agentsByProject = { alpha: 1 };
    const capacity = makeCapacityTracker(state, agentsByProject);

    const buckets = {
      onDemand: [],
      user: [
        task('task-alpha-1', 'HIGH', { app: 'alpha' }),
        task('task-beta-1', 'MEDIUM', { app: 'beta' }),
      ],
      autoSystem: [],
      mission: [],
      idle: [],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t.id)).toEqual(['task-beta-1']);
  });

  it('per-project cap counts in-batch spawns too (not just pre-existing runners)', () => {
    // Per-project cap 2, none running. Three user tasks all on app "alpha".
    // First two must spawn, third must be skipped (in-batch spawn count
    // pushed alpha to the per-project cap).
    const state = makeState({
      maxConcurrentAgents: 10,
      maxConcurrentAgentsPerProject: 2,
    });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [
        task('task-alpha-1', 'HIGH', { app: 'alpha' }),
        task('task-alpha-2', 'HIGH', { app: 'alpha' }),
        task('task-alpha-3', 'HIGH', { app: 'alpha' }),
      ],
      autoSystem: [],
      mission: [],
      idle: [],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t.id)).toEqual(['task-alpha-1', 'task-alpha-2']);
    expect(capacity.spawnProjectCounts.alpha).toBe(2);
  });

  it('per-project cap defaults to global cap when null/0', () => {
    // When maxConcurrentAgentsPerProject is null, production lines 638 +
    // 2334 fall through to the global cap, so the per-project guard is
    // effectively disabled.
    const state = makeState({
      maxConcurrentAgents: 3,
      maxConcurrentAgentsPerProject: null,
    });
    const capacity = makeCapacityTracker(state);
    expect(capacity.perProjectLimit).toBe(3);

    const buckets = {
      onDemand: [],
      user: [
        task('task-alpha-1', 'HIGH', { app: 'alpha' }),
        task('task-alpha-2', 'HIGH', { app: 'alpha' }),
        task('task-alpha-3', 'HIGH', { app: 'alpha' }),
      ],
      autoSystem: [],
      mission: [],
      idle: [],
    };

    expect(priorityDequeue(buckets, capacity)).toHaveLength(3);
  });

  it('null app metadata buckets into the `_self` project key (PortOS work)', () => {
    // PortOS-on-itself tasks have no app metadata. The `_self` bucket is a
    // sentinel that prevents app-less tasks from bypassing the per-project
    // cap (which is a real production guarantee — see line 659).
    const state = makeState({
      maxConcurrentAgents: 5,
      maxConcurrentAgentsPerProject: 1,
    });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [
        task('task-self-1', 'HIGH'),
        task('task-self-2', 'HIGH'),
      ],
      autoSystem: [],
      mission: [],
      idle: [],
    };

    const spawned = priorityDequeue(buckets, capacity);
    expect(spawned.map(t => t.id)).toEqual(['task-self-1']);
    expect(capacity.spawnProjectCounts._self).toBe(1);
  });
});

// ─── dequeueNextTask: per-local-endpoint agent cap (issue #4834) ───────────
//
// A CoS agent runs a vendor CLI that opens its own connection to the local
// model server, so promptRunner's in-flight gate never sees it. These drive the
// REAL `createLocalEndpointSlotContext` resolvers through the REAL capacity
// tracker — the same pair `dequeueNextTask` wires together — so a regression in
// either half fails here.

// What the PROVIDER RECORD holds, vs the normalized SLOT KEY the cap is keyed
// by. They differ on purpose: host+port identifies the model server, so
// `localhost` and `127.0.0.1` on one port must share a single slot.
const LOCAL_URL = 'http://localhost:1234/v1';
const LOCAL_ENDPOINT = 'localhost:1234';
const OTHER_LOCAL_URL = 'http://127.0.0.1:11434';
const OTHER_LOCAL_ENDPOINT = 'localhost:11434';

// A TUI provider pointed at a local server is exactly the case #4834 exists
// for: PortOS launches the CLI, the CLI talks to the GPU directly.
const LOCAL_TUI_PROVIDER = { id: 'lmstudio-tui', type: 'tui', enabled: true, endpoint: LOCAL_URL };
const OTHER_LOCAL_PROVIDER = { id: 'ollama-local', type: 'api', enabled: true, endpoint: OTHER_LOCAL_URL };
// No recorded endpoint — PortOS cannot know where it points, so it stays ungated.
const BARE_CLI_PROVIDER = { id: 'claude-cli', type: 'cli', enabled: true, endpoint: null };
const CLOUD_PROVIDER = { id: 'anthropic', type: 'api', enabled: true, endpoint: 'https://api.anthropic.com/v1' };

const ALL_PROVIDERS = [LOCAL_TUI_PROVIDER, OTHER_LOCAL_PROVIDER, BARE_CLI_PROVIDER, CLOUD_PROVIDER];

/** A running agent stamped with the providerId agentLifecycle persists. */
function makeRunningAgentOnProvider(providerId, app = '_self') {
  return { status: 'running', metadata: { taskApp: app, app, providerId } };
}

/** A pending task pinned to a provider via `metadata.provider`. */
const taskOnProvider = (id, providerId) => ({
  id,
  priority: 'HIGH',
  status: 'pending',
  metadata: providerId === undefined ? {} : { provider: providerId },
});

/**
 * Build the capacity tracker the way `dequeueNextTask` does: real slot context
 * over the fixture provider list, real running-agent endpoint tally, real hold
 * callback (captured so tests can assert the queued-no-slot log fired).
 */
function makeLocalSlotCapacity(state, { activeProvider = CLOUD_PROVIDER, limit = 1, agentsByProject = {} } = {}) {
  const slots = createLocalEndpointSlotContext({ providers: ALL_PROVIDERS, activeProvider, limit });
  const holds = [];
  const capacity = createDequeueCapacity(state, {
    agentsByProject,
    localEndpointCounts: countRunningAgentsByLocalEndpoint(state.agents, slots.endpointForAgent),
    localEndpointLimit: slots.limit,
    resolveLocalEndpoint: slots.resolveLocalEndpoint,
    onLocalEndpointHold: (task, endpoint, running) => holds.push({ taskId: task.id, endpoint, running }),
  });
  return { capacity, holds, slots };
}

const userBuckets = (tasks) => ({ onDemand: [], user: tasks, autoSystem: [], mission: [], idle: [] });

describe('dequeueNextTask — per-local-endpoint agent cap (#4834)', () => {
  it('serializes two queued tasks that resolve to the SAME local endpoint', () => {
    // Global cap 5, nothing running: both tasks clear the global and
    // per-project guards. Only the local-endpoint slot separates them.
    const state = makeState({ maxConcurrentAgents: 5 });
    const { capacity, holds } = makeLocalSlotCapacity(state);

    const spawned = priorityDequeue(userBuckets([
      taskOnProvider('task-local-1', 'lmstudio-tui'),
      taskOnProvider('task-local-2', 'lmstudio-tui'),
    ]), capacity);

    expect(spawned.map(t => t.id)).toEqual(['task-local-1']);
    expect(holds).toEqual([{ taskId: 'task-local-2', endpoint: LOCAL_ENDPOINT, running: 1 }]);
    expect(capacity.spawnLocalEndpointCounts[LOCAL_ENDPOINT]).toBe(1);
  });

  it('does NOT suppress an explicit on-demand Run at a saturated endpoint', () => {
    // Priority 0 clears the request and binds the app-review marker BEFORE
    // canSpawn runs, and that branch is the only thing that persists the task —
    // so a denial here destroys the user's "Run" and strands the marker rather
    // than deferring it. The task must be admitted and held at the spawner
    // chokepoint instead, which leaves it pending and releases both side effects.
    const state = makeState({
      maxConcurrentAgents: 5,
      runningAgents: [makeRunningAgentOnProvider('lmstudio-tui')],
    });
    const { capacity, holds } = makeLocalSlotCapacity(state);

    const spawned = priorityDequeue({
      onDemand: [taskOnProvider('task-run-now', 'lmstudio-tui')],
      user: [],
      autoSystem: [],
      mission: [],
      idle: [],
    }, capacity);

    expect(spawned.map(t => t.id)).toEqual(['task-run-now']);
    expect(holds).toEqual([]);
  });

  it('does NOT suppress a mission or idle task at a saturated endpoint', () => {
    // Both tiers commit before canSpawn and never persist: Priority 3 has
    // already flipped the mission sub-task to `in_progress` (and only `pending`
    // sub-tasks are ever re-picked), Priority 4 has already bound the app-review
    // marker and advanced its 30-minute cooldown. A denial strands both; the
    // chokepoint's hold at least releases the marker.
    const state = makeState({
      maxConcurrentAgents: 5,
      runningAgents: [makeRunningAgentOnProvider('lmstudio-tui')],
    });
    const { capacity } = makeLocalSlotCapacity(state);

    const spawned = priorityDequeue({
      onDemand: [],
      user: [],
      autoSystem: [],
      mission: [taskOnProvider('mission-task', 'lmstudio-tui')],
      idle: [],
    }, capacity);

    expect(spawned.map(t => t.id)).toEqual(['mission-task']);
  });

  it.each(['user', 'autoSystem'])('keeps gating the deferrable %s tier at the same endpoint', (bucket) => {
    // The opt-out is scoped to the tiers whose denial is destructive. A task
    // from a persisted queue stays queued, which is a real defer — the next
    // cycle re-picks it once the endpoint frees up.
    const state = makeState({
      maxConcurrentAgents: 5,
      runningAgents: [makeRunningAgentOnProvider('lmstudio-tui')],
    });
    const { capacity } = makeLocalSlotCapacity(state);

    const spawned = priorityDequeue({
      onDemand: [], user: [], autoSystem: [], mission: [], idle: [],
      [bucket]: [taskOnProvider('deferrable-task', 'lmstudio-tui')],
    }, capacity);

    expect(spawned).toEqual([]);
  });

  it('counts an ALREADY-RUNNING agent against its local endpoint', () => {
    // One agent is live on the local TUI provider. A queued task for the same
    // endpoint must be held even though the global cap has room.
    const state = makeState({
      maxConcurrentAgents: 5,
      runningAgents: [makeRunningAgentOnProvider('lmstudio-tui')],
    });
    const { capacity, holds } = makeLocalSlotCapacity(state);

    const spawned = priorityDequeue(userBuckets([taskOnProvider('task-local-1', 'lmstudio-tui')]), capacity);

    expect(spawned).toEqual([]);
    expect(holds).toEqual([{ taskId: 'task-local-1', endpoint: LOCAL_ENDPOINT, running: 1 }]);
  });

  it('leaves cloud and endpoint-less providers unaffected', () => {
    // A cloud API provider and a CLI provider with NO recorded endpoint both
    // resolve to null. Neither is gated, so all three spawn concurrently even
    // though a local agent is already saturating its endpoint.
    const state = makeState({
      maxConcurrentAgents: 5,
      runningAgents: [makeRunningAgentOnProvider('lmstudio-tui')],
    });
    const { capacity, holds } = makeLocalSlotCapacity(state);

    const spawned = priorityDequeue(userBuckets([
      taskOnProvider('task-cloud', 'anthropic'),
      taskOnProvider('task-bare-cli', 'claude-cli'),
      taskOnProvider('task-cloud-2', 'anthropic'),
    ]), capacity);

    expect(spawned.map(t => t.id)).toEqual(['task-cloud', 'task-bare-cli', 'task-cloud-2']);
    expect(holds).toEqual([]);
  });

  it('runs two DISTINCT local endpoints in parallel', () => {
    // Keyed by endpoint, not by "is local" — two separate local servers each
    // get their own slot.
    const state = makeState({ maxConcurrentAgents: 5 });
    const { capacity } = makeLocalSlotCapacity(state);

    const spawned = priorityDequeue(userBuckets([
      taskOnProvider('task-lmstudio', 'lmstudio-tui'),
      taskOnProvider('task-ollama', 'ollama-local'),
    ]), capacity);

    expect(spawned.map(t => t.id)).toEqual(['task-lmstudio', 'task-ollama']);
  });

  it('honors a lifted limit (LOCAL_LLM_MAX_CONCURRENCY > 1)', () => {
    const state = makeState({ maxConcurrentAgents: 5 });
    const { capacity, holds } = makeLocalSlotCapacity(state, { limit: 2 });

    const spawned = priorityDequeue(userBuckets([
      taskOnProvider('task-local-1', 'lmstudio-tui'),
      taskOnProvider('task-local-2', 'lmstudio-tui'),
      taskOnProvider('task-local-3', 'lmstudio-tui'),
    ]), capacity);

    expect(spawned.map(t => t.id)).toEqual(['task-local-1', 'task-local-2']);
    expect(holds.map(h => h.taskId)).toEqual(['task-local-3']);
  });

  it('gates UNPINNED tasks by the ACTIVE provider endpoint', () => {
    // A task with no `metadata.provider` runs on the active provider — when
    // that is local, the cap applies to it too.
    const state = makeState({ maxConcurrentAgents: 5 });
    const { capacity } = makeLocalSlotCapacity(state, { activeProvider: LOCAL_TUI_PROVIDER });

    const spawned = priorityDequeue(userBuckets([
      taskOnProvider('task-unpinned-1'),
      taskOnProvider('task-unpinned-2'),
    ]), capacity);

    expect(spawned.map(t => t.id)).toEqual(['task-unpinned-1']);
  });

  it('falls back to the active provider for an UNKNOWN pinned id (mirrors spawn)', () => {
    // resolveAgentProviderAndModel logs and uses the active provider when the
    // pinned id is missing; the gate must predict the same landing spot.
    const state = makeState({ maxConcurrentAgents: 5 });
    const { capacity, holds } = makeLocalSlotCapacity(state, { activeProvider: LOCAL_TUI_PROVIDER });

    const spawned = priorityDequeue(userBuckets([
      taskOnProvider('task-local-1', 'lmstudio-tui'),
      taskOnProvider('task-ghost', 'deleted-provider'),
    ]), capacity);

    expect(spawned.map(t => t.id)).toEqual(['task-local-1']);
    expect(holds).toEqual([{ taskId: 'task-ghost', endpoint: LOCAL_ENDPOINT, running: 1 }]);
  });

  it('leaves the cap disabled when no limit is supplied', () => {
    // createDequeueCapacity's defaults must not gate anything — every existing
    // caller (and every test above this block) constructs it without the
    // local-endpoint options.
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = createDequeueCapacity(state, {});
    expect(capacity.localEndpointLimit).toBe(Infinity);
    expect(priorityDequeue(userBuckets([
      taskOnProvider('task-a', 'lmstudio-tui'),
      taskOnProvider('task-b', 'lmstudio-tui'),
    ]), capacity)).toHaveLength(2);
  });

  it('floors a 0/NaN limit at 1 rather than wedging the queue forever', () => {
    const state = makeState({ maxConcurrentAgents: 5 });
    const slots = createLocalEndpointSlotContext({ providers: ALL_PROVIDERS, activeProvider: CLOUD_PROVIDER, limit: 0 });
    const capacity = createDequeueCapacity(state, {
      localEndpointLimit: slots.limit,
      resolveLocalEndpoint: slots.resolveLocalEndpoint,
    });
    expect(capacity.localEndpointLimit).toBe(1);
    expect(priorityDequeue(userBuckets([
      taskOnProvider('task-a', 'lmstudio-tui'),
      taskOnProvider('task-b', 'lmstudio-tui'),
    ]), capacity).map(t => t.id)).toEqual(['task-a']);
  });
});

describe('countRunningAgentsByLocalEndpoint (#4834)', () => {
  const slots = createLocalEndpointSlotContext({ providers: ALL_PROVIDERS, activeProvider: CLOUD_PROVIDER });

  it('tallies only RUNNING agents, only on local endpoints', () => {
    const agents = {
      a: makeRunningAgentOnProvider('lmstudio-tui'),
      b: makeRunningAgentOnProvider('lmstudio-tui'),
      c: makeRunningAgentOnProvider('ollama-local'),
      d: makeRunningAgentOnProvider('anthropic'),      // cloud → not counted
      e: makeRunningAgentOnProvider('claude-cli'),     // no endpoint → not counted
      f: { status: 'completed', metadata: { providerId: 'lmstudio-tui' } },
    };
    expect(countRunningAgentsByLocalEndpoint(agents, slots.endpointForAgent)).toEqual({
      [LOCAL_ENDPOINT]: 2,
      [OTHER_LOCAL_ENDPOINT]: 1,
    });
  });

  it('ignores agents with no provider stamp (pre-upgrade records)', () => {
    const agents = { a: { status: 'running', metadata: {} }, b: { status: 'running' } };
    expect(countRunningAgentsByLocalEndpoint(agents, slots.endpointForAgent)).toEqual({});
  });
});

describe('localEndpointOfProvider (#4834)', () => {
  it('resolves a local endpoint regardless of provider type', () => {
    expect(localEndpointOfProvider({ type: 'tui', endpoint: 'http://localhost:1234/v1' })).toBe('localhost:1234');
    expect(localEndpointOfProvider({ type: 'api', endpoint: 'http://127.0.0.1:11434' })).toBe('localhost:11434');
  });

  it('collapses every spelling of ONE local server onto a single slot key', () => {
    // Host+port identifies the model server; scheme, path and host spelling do
    // not. The shipped catalog already mixes spellings (`lmstudio` is seeded at
    // localhost:1234, everything else at 127.0.0.1), so keying on the raw string
    // would give one LM Studio process two independent caps — and let two agents
    // onto the same GPU, the exact OOM this issue exists to prevent.
    const spellings = [
      'http://localhost:1234/v1',
      'http://127.0.0.1:1234/v1',
      'http://127.0.0.1:1234',
      'https://localhost:1234/v1',
      'localhost:1234',
      '  http://0.0.0.0:1234/v1  ',
    ];
    for (const endpoint of spellings) {
      expect(localEndpointOfProvider({ endpoint }), endpoint).toBe('localhost:1234');
    }
  });

  it('keeps distinct local servers on distinct keys', () => {
    expect(localEndpointOfProvider({ endpoint: 'http://127.0.0.1:1234/v1' }))
      .not.toBe(localEndpointOfProvider({ endpoint: 'http://127.0.0.1:11434/v1' }));
  });

  it('returns null for a remote endpoint, a missing endpoint, or no provider', () => {
    expect(localEndpointOfProvider({ type: 'api', endpoint: 'https://api.anthropic.com/v1' })).toBeNull();
    expect(localEndpointOfProvider({ type: 'cli', endpoint: null })).toBeNull();
    expect(localEndpointOfProvider({ type: 'tui' })).toBeNull();
    expect(localEndpointOfProvider(null)).toBeNull();
  });

  it('never guesses from a model id — only the recorded endpoint counts', () => {
    // The issue is explicit: a TUI provider whose endpoint isn't recorded stays
    // ungated even when its model id names a local runtime.
    expect(localEndpointOfProvider({ type: 'tui', defaultModel: 'mtplx/local-qwen-27b', endpoint: null })).toBeNull();
  });
});

describe('cloudSwarmThreadCapacity', () => {
  it('reserves one root thread in addition to every configured cloud worker', () => {
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, 6)).toBe(7);
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, '6')).toBe(7);
  });

  it('does not lift the harness cap for a local inference endpoint', () => {
    expect(cloudSwarmThreadCapacity(LOCAL_TUI_PROVIDER, 6)).toBeNull();
  });

  it('does not override the harness outside a valid multi-worker swarm', () => {
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, 1)).toBeNull();
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, 2.5)).toBeNull();
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, 7)).toBeNull();
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, null)).toBeNull();
  });
});


describe('resolveLocalEndpoint — unavailable providers are not gated (#4834)', () => {
  // A saturated LOCAL provider that is currently unavailable (rate-limited,
  // cooling down, down) is not where the task lands: resolveAgentProviderAndModel
  // swaps it for a fallback, often a cloud one. Gating on it anyway would hold
  // the task behind a GPU it never touches — and nothing about that busy GPU
  // would ever clear the hold, so the task starves.
  const withAvailability = (available) => createLocalEndpointSlotContext({
    providers: ALL_PROVIDERS,
    activeProvider: CLOUD_PROVIDER,
    isAvailable: (id) => available.includes(id),
  });

  it('resolves to null when the pinned local provider is unavailable', () => {
    const slots = withAvailability(['anthropic']);
    expect(slots.resolveLocalEndpoint(taskOnProvider('t', 'lmstudio-tui'))).toBeNull();
  });

  it('still gates the same provider once it is available again', () => {
    const slots = withAvailability(['lmstudio-tui', 'anthropic']);
    expect(slots.resolveLocalEndpoint(taskOnProvider('t', 'lmstudio-tui'))).toBe(LOCAL_ENDPOINT);
  });

  it('resolves to null when the ACTIVE local provider is unavailable', () => {
    const slots = createLocalEndpointSlotContext({
      providers: ALL_PROVIDERS,
      activeProvider: LOCAL_TUI_PROVIDER,
      isAvailable: () => false,
    });
    expect(slots.resolveLocalEndpoint(taskOnProvider('t'))).toBeNull();
  });

  it('does not starve a queued task behind an unavailable local endpoint', () => {
    // End-to-end through the real tracker: one agent is running on the local
    // endpoint, but the provider has since gone unavailable, so the queued task
    // must dispatch (onto its fallback) instead of waiting forever.
    const state = makeState({
      maxConcurrentAgents: 5,
      runningAgents: [makeRunningAgentOnProvider('lmstudio-tui')],
    });
    const slots = withAvailability(['anthropic']);
    const capacity = createDequeueCapacity(state, {
      localEndpointCounts: countRunningAgentsByLocalEndpoint(state.agents, slots.endpointForAgent),
      localEndpointLimit: slots.limit,
      resolveLocalEndpoint: slots.resolveLocalEndpoint,
    });

    const spawned = priorityDequeue(userBuckets([taskOnProvider('task-local-1', 'lmstudio-tui')]), capacity);
    expect(spawned.map(t => t.id)).toEqual(['task-local-1']);
  });

  it('leaves a task with no resolvable provider ungated', () => {
    const slots = createLocalEndpointSlotContext({ providers: [], activeProvider: null });
    expect(slots.resolveLocalEndpoint(taskOnProvider('t'))).toBeNull();
    expect(slots.resolveLocalEndpoint(taskOnProvider('t', 'ghost'))).toBeNull();
  });
});

describe('local-endpoint spawn reservations (#4834)', () => {
  beforeEach(() => __resetLocalEndpointSpawnReservations());

  it('counts a reserved-but-not-yet-running spawn against the endpoint', () => {
    // The window between `task:ready` and the agent record reaching `running`
    // is several awaits wide. Without the reservation, a second dispatch inside
    // it reads a snapshot showing zero running agents and over-dispatches.
    expect(pendingLocalEndpointSpawns(LOCAL_ENDPOINT)).toBe(0);
    const release = reserveLocalEndpointSpawn(LOCAL_ENDPOINT);
    expect(pendingLocalEndpointSpawns(LOCAL_ENDPOINT)).toBe(1);
    release();
    expect(pendingLocalEndpointSpawns(LOCAL_ENDPOINT)).toBe(0);
  });

  it('is idempotent — a double release cannot free a slot twice', () => {
    // The spawner releases in a `finally`, so a throw plus the finally can call
    // it twice. A naive decrement would go negative and hand out a phantom slot.
    const first = reserveLocalEndpointSpawn(LOCAL_ENDPOINT);
    const second = reserveLocalEndpointSpawn(LOCAL_ENDPOINT);
    expect(pendingLocalEndpointSpawns(LOCAL_ENDPOINT)).toBe(2);
    first();
    first();
    first();
    expect(pendingLocalEndpointSpawns(LOCAL_ENDPOINT)).toBe(1);
    second();
    expect(pendingLocalEndpointSpawns(LOCAL_ENDPOINT)).toBe(0);
  });

  it('reserving a null endpoint is a no-op', () => {
    const release = reserveLocalEndpointSpawn(null);
    expect(pendingLocalEndpointSpawns(null)).toBe(0);
    expect(() => release()).not.toThrow();
  });

  it('gives a direct cloud provider call a no-op shared-capacity release', async () => {
    const claim = await acquireLocalEndpointProviderSlot(
      { id: 'cloud-api', endpoint: 'https://api.example.com/v1' },
      {},
      'persistent-mind-turn'
    );
    expect(claim.ok).toBe(true);
    expect(() => claim.release()).not.toThrow();
    expect(pendingLocalEndpointSpawns(LOCAL_ENDPOINT)).toBe(0);
  });

  it('keeps reservations per endpoint', () => {
    reserveLocalEndpointSpawn(LOCAL_ENDPOINT);
    reserveLocalEndpointSpawn(OTHER_LOCAL_ENDPOINT);
    expect(pendingLocalEndpointSpawns(LOCAL_ENDPOINT)).toBe(1);
    expect(pendingLocalEndpointSpawns(OTHER_LOCAL_ENDPOINT)).toBe(1);
  });
});

describe('endpointForAgent — stamped endpoint wins over the id lookup (#4834)', () => {
  const slots = createLocalEndpointSlotContext({ providers: ALL_PROVIDERS, activeProvider: CLOUD_PROVIDER });

  it('counts an agent whose provider record was deleted mid-run', () => {
    // Only `providerId` was persisted pre-#4834, so a deleted provider made a
    // still-running agent invisible to the cap — freeing a slot the GPU was
    // still holding. The stamped endpoint survives the deletion.
    const orphaned = { status: 'running', metadata: { providerId: 'deleted-provider', providerEndpoint: LOCAL_URL } };
    expect(slots.endpointForAgent(orphaned)).toBe(LOCAL_ENDPOINT);
    expect(countRunningAgentsByLocalEndpoint({ a: orphaned }, slots.endpointForAgent)).toEqual({ [LOCAL_ENDPOINT]: 1 });
  });

  it('prefers the stamp when the provider record was re-pointed mid-run', () => {
    // The agent is still talking to the endpoint it started on, not the one the
    // provider now names.
    const agent = { status: 'running', metadata: { providerId: 'ollama-local', providerEndpoint: LOCAL_URL } };
    expect(slots.endpointForAgent(agent)).toBe(LOCAL_ENDPOINT);
  });

  it('falls back to the id lookup for a pre-#4834 record with no stamp', () => {
    expect(slots.endpointForAgent({ status: 'running', metadata: { providerId: 'lmstudio-tui' } })).toBe(LOCAL_ENDPOINT);
    expect(slots.endpointForAgent({ status: 'running', metadata: { providerId: 'lmstudio-tui', providerEndpoint: null } })).toBe(LOCAL_ENDPOINT);
  });

  it('does NOT re-resolve when the stamp is REMOTE', () => {
    // The agent is talking to the cloud. If its provider record is re-pointed at
    // a local server mid-run, falling through to the id lookup would count this
    // cloud agent against that GPU — saturating an endpoint with zero agents on
    // it and holding every task behind it at the default limit of 1.
    const cloudAgent = {
      status: 'running',
      metadata: { providerId: 'lmstudio-tui', providerEndpoint: 'https://api.anthropic.com/v1' },
    };
    expect(slots.endpointForAgent(cloudAgent)).toBeNull();
    expect(countRunningAgentsByLocalEndpoint({ a: cloudAgent }, slots.endpointForAgent)).toEqual({});
  });
});

describe('resolveLocalEndpoint — follows the fallback swap (#4834)', () => {
  // An unavailable provider is not where the task lands, so the gate follows the
  // SAME getFallbackProvider spawn uses. Both directions matter: a cloud
  // fallback must ungate (or the task starves behind a GPU it never touches),
  // and a fallback on the same local server must stay gated (or the cap
  // disappears exactly when the endpoint is unhealthy — the shipped catalog has
  // four providers on 127.0.0.1:18021).
  const SAME_SERVER_SIBLING = { id: 'lmstudio-api', type: 'api', enabled: true, endpoint: 'http://127.0.0.1:1234' };

  const withFallback = (fallbackProvider) => createLocalEndpointSlotContext({
    providers: [...ALL_PROVIDERS, SAME_SERVER_SIBLING],
    activeProvider: CLOUD_PROVIDER,
    isAvailable: (id) => id !== 'lmstudio-tui',
    resolveFallback: () => fallbackProvider,
  });

  it('stays gated when the fallback lands on the SAME local server', () => {
    // Different provider record, different host spelling, same GPU.
    expect(withFallback(SAME_SERVER_SIBLING).resolveLocalEndpoint(taskOnProvider('t', 'lmstudio-tui')))
      .toBe(LOCAL_ENDPOINT);
  });

  it('ungates when the fallback is a cloud provider', () => {
    expect(withFallback(CLOUD_PROVIDER).resolveLocalEndpoint(taskOnProvider('t', 'lmstudio-tui'))).toBeNull();
  });

  it('gates on the FALLBACK endpoint when it is a different local server', () => {
    expect(withFallback(OTHER_LOCAL_PROVIDER).resolveLocalEndpoint(taskOnProvider('t', 'lmstudio-tui')))
      .toBe(OTHER_LOCAL_ENDPOINT);
  });

  it('ungates when no fallback resolves at all', () => {
    expect(withFallback(null).resolveLocalEndpoint(taskOnProvider('t', 'lmstudio-tui'))).toBeNull();
  });

  it('passes the task through so a task-level fallback pin is honored', () => {
    // getFallbackProvider's first tier reads metadata.fallbackProvider /
    // metadata.fallbackModel off the task; the context must hand them over.
    const seen = [];
    const slots = createLocalEndpointSlotContext({
      providers: ALL_PROVIDERS,
      activeProvider: CLOUD_PROVIDER,
      isAvailable: () => false,
      resolveFallback: (primaryId, providersMap, task) => { seen.push({ primaryId, task }); return null; },
    });
    slots.resolveLocalEndpoint({ id: 't', metadata: { provider: 'lmstudio-tui', fallbackProvider: 'ollama-local' } });

    expect(seen).toHaveLength(1);
    expect(seen[0].primaryId).toBe('lmstudio-tui');
    expect(seen[0].task.metadata.fallbackProvider).toBe('ollama-local');
  });
});

describe('readEndpointCapacity (#4834)', () => {
  beforeEach(() => __resetLocalEndpointSpawnReservations());

  const slots = createLocalEndpointSlotContext({ providers: ALL_PROVIDERS, activeProvider: CLOUD_PROVIDER, limit: 1 });
  const runningOn = (providerId, taskId) => ({ status: 'running', taskId, metadata: { providerId } });

  it('counts a running agent against its endpoint', () => {
    const capacity = readEndpointCapacity(LOCAL_ENDPOINT, { a: runningOn('lmstudio-tui', 'task-a') }, slots);
    expect(capacity).toMatchObject({ inFlight: 1, limit: 1, atCapacity: true });
  });

  it('excludes the dispatching task\'s OWN agent so Run-now can supersede a zombie', () => {
    // forceSpawnTask deliberately supersedes a `running` holder older than the
    // spawn grace — that is the documented recovery for an agent whose PTY died
    // without a close handler. Counting the zombie would make the one recovery
    // the route exists to provide unreachable at a limit of 1.
    const agents = { a: runningOn('lmstudio-tui', 'task-stuck') };
    expect(readEndpointCapacity(LOCAL_ENDPOINT, agents, slots, { ignoreTaskId: 'task-stuck' }).atCapacity).toBe(false);
    expect(readEndpointCapacity(LOCAL_ENDPOINT, agents, slots, { ignoreTaskId: 'other-task' }).atCapacity).toBe(true);
  });

  it('does not double-count a reservation whose agent already registered', () => {
    // registerAgent flips the record to `running` well before spawnAgentForTask
    // returns, so for the whole PTY-launch window the same agent is both in the
    // running tally and holding its reservation.
    reserveLocalEndpointSpawn(LOCAL_ENDPOINT, 'task-a');
    const agents = { a: runningOn('lmstudio-tui', 'task-a') };

    expect(readEndpointCapacity(LOCAL_ENDPOINT, agents, slots).inFlight).toBe(1);
  });

  it('still counts a reservation that has NOT registered yet', () => {
    reserveLocalEndpointSpawn(LOCAL_ENDPOINT, 'task-b');
    const agents = { a: runningOn('lmstudio-tui', 'task-a') };

    expect(readEndpointCapacity(LOCAL_ENDPOINT, agents, slots).inFlight).toBe(2);
  });

  it('counts an anonymous reservation (no task id) unconditionally', () => {
    reserveLocalEndpointSpawn(LOCAL_ENDPOINT, null);
    expect(readEndpointCapacity(LOCAL_ENDPOINT, {}, slots).inFlight).toBe(1);
  });

  it('ignores agents on other endpoints and non-running agents', () => {
    const agents = {
      a: runningOn('ollama-local', 'task-a'),
      b: runningOn('anthropic', 'task-b'),
      c: { status: 'completed', taskId: 'task-c', metadata: { providerId: 'lmstudio-tui' } },
    };
    expect(readEndpointCapacity(LOCAL_ENDPOINT, agents, slots).inFlight).toBe(0);
  });
});

describe('localEndpointOfProvider — Ollama-backed CLI/TUI providers (#4834)', () => {
  // Four SHIPPED providers run against the local Ollama daemon with no
  // `endpoint` field at all. They are the archetype of this issue — PortOS
  // launches a vendor CLI that opens its own connection — so leaving them
  // ungated would make the cap inconsistent across providers of the same shape.
  it('reads the daemon from ANTHROPIC_BASE_URL when endpoint is unset', () => {
    expect(localEndpointOfProvider({
      id: 'claude-ollama-tui', type: 'tui', ollamaBacked: true,
      envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' },
    })).toBe('localhost:11434');
  });

  it('falls back to the default daemon for a bare ollamaBacked marker', () => {
    // opencode-ollama* keep their base inside an OPENCODE_CONFIG_CONTENT blob;
    // the marker alone means the default daemon (what the toolkit's own
    // ollamaBaseFromProvider does).
    expect(localEndpointOfProvider({
      id: 'opencode-ollama-tui', type: 'tui', ollamaBacked: true,
      envVars: { OPENCODE_CONFIG_CONTENT: '{}' },
    })).toBe('localhost:11434');
  });

  it('shares ONE slot with the api-type `ollama` provider on the same daemon', () => {
    const cli = localEndpointOfProvider({ id: 'claude-ollama', ollamaBacked: true, envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' } });
    const api = localEndpointOfProvider({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' });
    expect(cli).toBe(api);
  });

  it('does NOT localize a REMOTE Ollama daemon', () => {
    // The recorded base wins over the local default — an Ollama on another host
    // is not this machine's GPU.
    expect(localEndpointOfProvider({ id: 'remote-ollama', type: 'api', endpoint: 'http://192.0.2.10:11434' })).toBeNull();
    expect(localEndpointOfProvider({
      id: 'remote-claude-ollama', ollamaBacked: true,
      envVars: { ANTHROPIC_BASE_URL: 'http://192.0.2.10:11434' },
    })).toBeNull();
  });
});

describe('providerBaseUrl — the stamp source (#4834)', () => {
  it('returns the REMOTE base of an Ollama-backed CLI that has no endpoint', () => {
    // `localRuntimeForProvider` answers null for it (correctly — it is not this
    // box), and it records its daemon ONLY in envVars. Returning null here would
    // stamp an absent endpoint, and `endpointForAgent` reads absent as
    // "re-resolve by provider id" — so re-pointing that provider at a local URL
    // mid-run would start counting a remote agent against the local GPU.
    const remote = { id: 'remote-ollama-cli', ollamaBacked: true, envVars: { ANTHROPIC_BASE_URL: 'http://192.0.2.10:11434' } };
    expect(providerBaseUrl(remote)).toBe('http://192.0.2.10:11434');
    expect(localEndpointOfProvider(remote)).toBeNull();
  });

  it('prefers the resolved local runtime endpoint over the raw record', () => {
    const local = { id: 'claude-ollama', ollamaBacked: true, envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' } };
    expect(localEndpointOfProvider(local)).toBe('localhost:11434');
  });

  it('is null only when the record names no base at all', () => {
    expect(providerBaseUrl({ id: 'claude-cli', type: 'cli', endpoint: null })).toBeNull();
    expect(providerBaseUrl(null)).toBeNull();
  });

  it('keeps a cloud base so its agent is never re-resolved', () => {
    expect(providerBaseUrl(CLOUD_PROVIDER)).toBe('https://api.anthropic.com/v1');
    expect(localEndpointOfProvider(CLOUD_PROVIDER)).toBeNull();
  });
});

// ─── Source-level regression guards ────────────────────────────────────────
//
// These pin two structural invariants of the production code that the
// inline-copy tests can't catch on their own. If a future refactor moves
// the early-return out of `dequeueNextTask` or shuffles the priority order,
// these assertions flip red.

/**
 * Extract a function body from `src` starting at signature offset `fnStart`
 * by scanning braces (depth-tracked) until the matching closing `}`. This is
 * more robust than a fixed-length slice — large functions like
 * `dequeueNextTask` (~250 LOC) can grow past any chosen window and silently
 * drop priority markers, making ordering assertions pass on empty matches.
 *
 * Skips brace characters inside string literals (single/double quote AND
 * template literals, including nested `${...}` interpolations), regex
 * literals, and line/block comments so stray `{`/`}` characters don't
 * unbalance the scanner. `evaluateTasks` and `dequeueNextTask` both contain
 * template literals like `emitLog(`...${task.id}...`)` whose `${...}` braces
 * would otherwise be counted as structural braces.
 *
 * Regex disambiguation uses a "previous significant token" heuristic — a `/`
 * is a regex literal when the preceding non-whitespace token is not an
 * identifier/number/closing-bracket. This handles the patterns used in cos.js
 * (assignment, return, function-arg position) but isn't a full JS tokenizer;
 * if a future refactor introduces edge cases the source-level assertions
 * will fail loudly rather than silently miss matches.
 */
function extractFnBody(src, fnStart) {
  // Skip the parameter list before locating the body brace: a destructured /
  // defaulted param (e.g. `(state, data, { x = null } = {})`) contains `{`
  // braces, so the body `{` is the first one AFTER the signature's closing `)`,
  // not the first `{` after fnStart. Paren-match the signature first.
  const parenIdx = src.indexOf('(', fnStart);
  let searchFrom = fnStart;
  if (parenIdx !== -1) {
    let pdepth = 0;
    for (let j = parenIdx; j < src.length; j++) {
      if (src[j] === '(') pdepth++;
      else if (src[j] === ')') { pdepth--; if (pdepth === 0) { searchFrom = j + 1; break; } }
    }
  }
  const openIdx = src.indexOf('{', searchFrom);
  if (openIdx === -1) return '';
  let depth = 0;
  let i = openIdx;
  // Stack tracks nested template-literal `${...}` interpolation depth so the
  // scanner returns to template-string mode after a `}` closes an expression.
  const tplStack = [];
  // Last significant (non-whitespace, non-comment) character — used to decide
  // whether `/` starts a regex literal or is the division operator.
  let lastSig = '';
  const setLastSig = (c) => { if (!/\s/.test(c)) lastSig = c; };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    // Line comment — skip to newline
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i + 2);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    // Block comment — skip to closing */
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    // Regex literal — `/` is a regex start when not preceded by an
    // identifier/number/closing-paren/closing-bracket (i.e. when it can't be
    // the division operator). Skip to matching unescaped `/` (and flags).
    if (ch === '/' && !/[\w)\]]/.test(lastSig)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break; // unterminated regex — bail
        j++;
      }
      // Skip trailing flags (g/i/m/s/u/y)
      j++;
      while (j < src.length && /[gimsuy]/.test(src[j])) j++;
      i = j;
      lastSig = '/';
      continue;
    }
    // Single/double-quoted string — skip to matching unescaped quote
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) break;
        if (src[j] === '\n') break; // unterminated — bail
        j++;
      }
      i = j + 1;
      lastSig = ch;
      continue;
    }
    // Template literal — scan until backtick or `${`. On `${` push depth and
    // resume normal scanning until matching `}` (tracked via tplStack).
    if (ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') { j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          // Enter interpolation; resume outer loop, push template marker.
          tplStack.push(depth);
          i = j + 2;
          depth++; // the `{` of ${
          lastSig = '{';
          break;
        }
        j++;
      }
      if (j >= i) { // either closed the template or entered interpolation
        if (src[i] === undefined) break;
        if (tplStack.length === 0 || tplStack[tplStack.length - 1] !== depth - 1) {
          // We closed the template entirely (didn't enter interpolation).
          i = j;
          lastSig = '`';
        }
      }
      continue;
    }
    if (ch === '{') { depth++; setLastSig(ch); i++; continue; }
    if (ch === '}') {
      depth--;
      // If we just closed a template interpolation, resume template scan.
      if (tplStack.length > 0 && tplStack[tplStack.length - 1] === depth) {
        tplStack.pop();
        // Resume template literal scan from i+1
        let j = i + 1;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '`') { j++; break; }
          if (src[j] === '$' && src[j + 1] === '{') {
            tplStack.push(depth);
            j += 2;
            depth++;
            break;
          }
          j++;
        }
        i = j;
        lastSig = '`';
        continue;
      }
      if (depth === 0) return src.slice(fnStart, i + 1);
      setLastSig(ch);
      i++;
      continue;
    }
    setLastSig(ch);
    i++;
  }
  return src.slice(fnStart); // unbalanced — return rest of file
}

describe('cos.js source — priority + capacity invariants', () => {
  it('dequeueNextTask early-returns when availableSlots <= 0', () => {
    const fnStart = COS_SRC.indexOf('async function dequeueNextTask');
    expect(fnStart, 'dequeueNextTask must exist').toBeGreaterThan(-1);
    const fnBody = extractFnBody(COS_SRC, fnStart);

    // `if (availableSlots <= 0) return;` (line 2332) is the cheap guard
    // that prevents spawning when the global cap is at or beyond capacity.
    // Regex tolerates optional braces, optional semicolon, and optional
    // single-line block (`{ return; }`) so a formatting refactor doesn't
    // trip this behavioral check.
    expect(fnBody).toMatch(
      /if\s*\(\s*availableSlots\s*<=\s*0\s*\)\s*(?:\{\s*)?return\s*;?\s*(?:\})?/
    );
  });

  it('evaluateTasks short-circuits when availableSlots <= 0', () => {
    const fnStart = GEN_SRC.indexOf('export async function evaluateTasks');
    expect(fnStart, 'evaluateTasks must exist').toBeGreaterThan(-1);
    const fnBody = extractFnBody(GEN_SRC, fnStart);

    expect(fnBody).toMatch(/if\s*\(\s*availableSlots\s*<=\s*0\s*\)/);
  });

  it('dequeueNextTask orchestrates the spawnDequeuePriority* tiers in priority order', () => {
    // dequeueNextTask (cos.js) decomposes each priority tier into a named
    // `spawnDequeuePriorityN(ctx)` helper (issue #2530), mirroring evaluateTasks.
    // This pins that the orchestrator actually INVOKES each tier helper, in order
    // — an actual reorder of the dequeue logic is the only thing that fails it.
    //
    //   Priority 0 (onDemand)    — spawnDequeuePriority0OnDemand(ctx)
    //   Priority 1 (user)        — spawnDequeuePriority1UserTasks(ctx)
    //   Priority 2 (autoSystem)  — spawnDequeuePriority2AutoApproved(ctx)
    //   Priority 3 (mission)     — spawnDequeuePriority3Missions(ctx)
    //   Priority 4 (idle)        — spawnDequeuePriority4IdleReview(ctx)
    const fnBody = extractFnBody(COS_SRC, COS_SRC.indexOf('async function dequeueNextTask'));

    const onDemandIdx = fnBody.indexOf('spawnDequeuePriority0OnDemand(ctx)');
    const userIdx     = fnBody.indexOf('spawnDequeuePriority1UserTasks(ctx)');
    const autoSysIdx  = fnBody.indexOf('spawnDequeuePriority2AutoApproved(ctx)');
    const missionIdx  = fnBody.indexOf('spawnDequeuePriority3Missions(ctx)');
    const idleIdx     = fnBody.indexOf('spawnDequeuePriority4IdleReview(ctx)');

    expect(onDemandIdx, 'spawnDequeuePriority0OnDemand must be invoked').toBeGreaterThan(-1);
    expect(userIdx, 'spawnDequeuePriority1UserTasks must run after on-demand').toBeGreaterThan(onDemandIdx);
    expect(autoSysIdx, 'spawnDequeuePriority2AutoApproved must run after user tasks').toBeGreaterThan(userIdx);
    expect(missionIdx, 'spawnDequeuePriority3Missions must run after auto-approved').toBeGreaterThan(autoSysIdx);
    expect(idleIdx, 'spawnDequeuePriority4IdleReview must run after missions').toBeGreaterThan(missionIdx);
  });

  it('evaluateTasks orchestrates the spawnPriority* tiers in priority order', () => {
    // evaluateTasks (cosTaskGenerator.js) decomposes each priority tier into a
    // named helper (issue #1082). This pins that the orchestrator actually
    // INVOKES each tier helper, in order — so a helper carrying an autonomy/idle
    // fence can't drift out of the spawn path while the broader, module-scoped
    // gate guards below still match its (now-orphaned) fence text and pass green.
    const fnBody = extractFnBody(GEN_SRC, GEN_SRC.indexOf('export async function evaluateTasks'));

    const onDemandIdx = fnBody.indexOf('spawnPriority0OnDemand(ctx)');
    const userIdx     = fnBody.indexOf('spawnPriority1UserTasks(ctx)');
    const autoSysIdx  = fnBody.indexOf('spawnPriority2AutoApproved(ctx)');
    const queueIdx    = fnBody.indexOf('maybeQueueImprovementTasks(ctx)');
    const missionIdx  = fnBody.indexOf('spawnPriority3Missions(ctx)');
    const featureIdx  = fnBody.indexOf('spawnPriority36FeatureAgents(ctx)');
    const idleIdx     = fnBody.indexOf('spawnPriority4IdleReview(ctx)');

    expect(onDemandIdx, 'spawnPriority0OnDemand must be invoked').toBeGreaterThan(-1);
    expect(userIdx, 'spawnPriority1UserTasks must run after on-demand').toBeGreaterThan(onDemandIdx);
    expect(autoSysIdx, 'spawnPriority2AutoApproved must run after user tasks').toBeGreaterThan(userIdx);
    expect(queueIdx, 'maybeQueueImprovementTasks must run after auto-approved').toBeGreaterThan(autoSysIdx);
    expect(missionIdx, 'spawnPriority3Missions must run after improvement queueing').toBeGreaterThan(queueIdx);
    expect(featureIdx, 'spawnPriority36FeatureAgents must run after missions').toBeGreaterThan(missionIdx);
    expect(idleIdx, 'spawnPriority4IdleReview must run after feature agents').toBeGreaterThan(featureIdx);
  });

  it('on-demand (Priority 0) bypasses the global pause in BOTH engines', () => {
    // A global pause stops scheduled/autonomous/user spawning, but an explicit
    // user "Run" queues an on-demand request that must still fire. So in each
    // engine the pause gate must sit AFTER Priority 0, not at the top — moving it
    // back to the top is the regression this pins.
    const dequeueFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function dequeueNextTask'));
    const evalFn    = extractFnBody(GEN_SRC, GEN_SRC.indexOf('export async function evaluateTasks'));

    // dequeueNextTask: the `if (paused) return` gate appears AFTER the on-demand
    // tier (`spawnDequeuePriority0OnDemand`), and `paused` is NOT returned-on
    // before it.
    const dqOnDemandIdx = dequeueFn.indexOf('spawnDequeuePriority0OnDemand(ctx)');
    const dqPauseGateIdx = dequeueFn.search(/if\s*\(\s*paused\s*\)\s*return/);
    expect(dqOnDemandIdx, 'dequeueNextTask must invoke spawnDequeuePriority0OnDemand').toBeGreaterThan(-1);
    expect(dqPauseGateIdx, 'dequeueNextTask must keep an `if (paused) return` gate').toBeGreaterThan(-1);
    expect(dqPauseGateIdx, 'pause gate must come AFTER the on-demand tier').toBeGreaterThan(dqOnDemandIdx);

    // evaluateTasks: Priority 0 runs unconditionally; Priorities 1+ are wrapped in
    // an `if (!paused)` block that begins after spawnPriority0OnDemand.
    //
    // Anchor on the LAST `if (!paused)` preceding the user tier, not the first in
    // the function: `evaluateTasks` legitimately carries other pause-gated work
    // that runs before Priority 0 (the pending-merge sweep, which claims no agent
    // lane and so must not sit behind the slot gate). A plain `.search()` matched
    // that one instead and read as "the tier gate moved to the top" — a false
    // positive on the exact regression this pins.
    const evOnDemandIdx = evalFn.indexOf('spawnPriority0OnDemand(ctx)');
    const evUserIdx = evalFn.indexOf('spawnPriority1UserTasks(ctx)');
    const pauseGates = [...evalFn.matchAll(/if\s*\(\s*!\s*paused\s*\)/g)].map(m => m.index);
    const evPauseGateIdx = pauseGates.filter(i => i < evUserIdx).pop() ?? -1;
    expect(evOnDemandIdx, 'evaluateTasks must invoke spawnPriority0OnDemand').toBeGreaterThan(-1);
    expect(evUserIdx, 'evaluateTasks must invoke spawnPriority1UserTasks').toBeGreaterThan(-1);
    expect(evPauseGateIdx, 'evaluateTasks must gate the lower tiers on !paused').toBeGreaterThan(evOnDemandIdx);
    expect(evUserIdx, 'user/autonomous tiers must sit inside the !paused gate').toBeGreaterThan(evPauseGateIdx);
  });

  it('pending-merge sweep is gated on CoS auto-run being in execute mode', () => {
    // The sweep is the ONE tier in evaluateTasks that writes to a default branch
    // (git.mergePR). It deliberately sits ABOVE the agent-slot gate — a merge
    // claims no lane — which also puts it above `resolveAutonomyBudget`, so it
    // must read the auto-run mode itself. It shipped gated on `!paused` alone,
    // which meant `off` / `dry-run` still merged PRs, including on the boot-time
    // `evaluateTasks({ initialStartup: true })`.
    const evalFn = extractFnBody(GEN_SRC, GEN_SRC.indexOf('export async function evaluateTasks'));
    const sweepIdx = evalFn.indexOf('sweepPendingMergePrs()');
    expect(sweepIdx, 'evaluateTasks must invoke sweepPendingMergePrs').toBeGreaterThan(-1);

    // The gate is the `if (...)` immediately preceding the sweep call.
    const gateIdx = evalFn.lastIndexOf('if (', sweepIdx);
    const gate = evalFn.slice(gateIdx, sweepIdx);
    expect(gate, 'the merge sweep must stay gated on !paused').toMatch(/!\s*paused/);
    expect(gate, 'the merge sweep must also gate on auto-run being in execute mode')
      .toMatch(/getDomainMode\(\s*state\.config\s*,\s*'cos'\s*\)\s*===\s*'execute'/);

    // …and it must still run before the agent-slot early-return, or a full agent
    // roster wedges the merge queue (the reason it is not folded into the tiers).
    const slotGateIdx = evalFn.indexOf('if (availableSlots <= 0)');
    expect(slotGateIdx, 'evaluateTasks must keep its agent-slot gate').toBeGreaterThan(-1);
    expect(sweepIdx, 'the merge sweep must run before the agent-slot gate').toBeLessThan(slotGateIdx);
  });

  it('per-project cap defaults to global cap when unset', () => {
    // The fallback `state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents`
    // is the safety net for older state.json files that pre-date the
    // per-project cap. dequeueNextTask's capacity tracker was extracted to
    // `createDequeueCapacity` in cosDequeue.js (issue #2530), so the dequeue-side
    // fallback lives there now; evaluateTasks keeps its own inline copy.
    const dequeueFn = extractFnBody(DEQ_SRC, DEQ_SRC.indexOf('export function createDequeueCapacity'));
    const evalFn    = extractFnBody(GEN_SRC, GEN_SRC.indexOf('export async function evaluateTasks'));

    const pattern = /maxConcurrentAgentsPerProject\s*\|\|\s*state\.config\.maxConcurrentAgents/;
    expect(dequeueFn).toMatch(pattern);
    expect(evalFn).toMatch(pattern);
  });

  it('dequeueNextTask threads the local-endpoint cap into its capacity tracker (#4834)', () => {
    // The gate only works if the scheduler actually supplies the resolver and
    // the running-agent tally — a refactor that drops either option silently
    // reverts to unlimited local dispatch, which is what caused the accelerator
    // OOM in the first place. Read from the real function body so a stray
    // reference elsewhere in cos.js can't satisfy this.
    const dequeueFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function dequeueNextTask'));
    expect(dequeueFn).toMatch(/countRunningAgentsByLocalEndpoint\(/);
    expect(dequeueFn).toMatch(/resolveLocalEndpoint:/);
    expect(dequeueFn).toMatch(/localEndpointLimit:/);
  });

  it('tryImmediateSpawn does NOT re-implement the local-endpoint cap (#4834)', () => {
    // Its task is already persisted by `addTask`, so emitting and letting the
    // chokepoint hold produces exactly what an early return would. A local copy
    // would be a weaker duplicate — it can only see a running-agent snapshot,
    // not the in-flight reservations the authoritative gate also counts — so it
    // could pass a task the chokepoint then holds, for an extra provider fetch.
    const immediateFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function tryImmediateSpawn'));
    expect(immediateFn).not.toMatch(/resolveLocalEndpoint\(/);
    expect(immediateFn).not.toMatch(/countRunningAgentsByLocalEndpoint\(/);
  });

  it('subAgentSpawner holds at the chokepoint every task:ready emitter funnels through (#4834)', () => {
    // dequeueNextTask is only ONE of the emitters — evaluateTasks,
    // forceSpawnTask, the job scheduler and the Creative Director bridge all
    // reach the spawner directly. If the gate ever moves back to the scheduler
    // alone, those paths silently over-dispatch at the local GPU again.
    const SPAWNER_SRC = readFileSync(join(__dirname, 'subAgentSpawner.js'), 'utf-8');
    expect(SPAWNER_SRC, 'spawner must acquire a local-endpoint slot before spawning')
      .toMatch(/acquireLocalEndpointSpawnSlot\(/);
    // The reservation is only correct if it is released once the spawn settles;
    // a missing `finally` leaks the slot and wedges the endpoint forever.
    const listener = SPAWNER_SRC.slice(SPAWNER_SRC.indexOf("cosEvents.on('task:ready'"));
    expect(listener, 'the acquired slot must be released in a finally')
      .toMatch(/finally\s*\{\s*\n\s*localSlot\.release\(\);/);
    expect(listener, 'a task at capacity must be HELD (left pending), not failed')
      .toMatch(/holdTask\(task,\s*localSlot\.reason\)/);
  });

  it('agentLifecycle stamps the resolved endpoint onto the agent record (#4834)', () => {
    // Counting a running agent by provider id alone breaks when the provider is
    // edited or deleted while the agent still holds the GPU.
    const LIFECYCLE_SRC = readFileSync(join(__dirname, 'agentLifecycle.js'), 'utf-8');
    // Stamped through the SAME resolver the counter reads with, so writer and
    // reader cannot drift on where a CLI provider records its daemon.
    expect(LIFECYCLE_SRC).toMatch(/providerEndpoint:\s*providerBaseUrl\(provider\)/);
  });

  it('forceSpawnTask refuses synchronously when the local endpoint is full (#4834)', () => {
    // "Run now" returns before the spawn happens, so without its own check it
    // would answer { success: true } and toast "Spawning" for a task the
    // chokepoint immediately holds — the same lie the provider-resolution
    // pre-check directly above it exists to prevent. It must run AFTER
    // resolution so it reads the post-fallback provider.
    const forceFn = extractFnBody(COS_SRC, COS_SRC.indexOf('export async function forceSpawnTask'));
    expect(forceFn).toMatch(/localEndpointCapacityError\(resolution\.provider/);
    expect(forceFn.indexOf('resolveAgentProviderAndModel'))
      .toBeLessThan(forceFn.indexOf('localEndpointCapacityError'));
    expect(forceFn.indexOf('localEndpointCapacityError'))
      .toBeLessThan(forceFn.indexOf("cosEvents.emit('task:ready'"));
  });

  it('forceSpawnTask passes its task id so its own zombie agent is excluded (#4834)', () => {
    // The route deliberately supersedes a stale `running` holder — counting that
    // agent would make the recovery unreachable at a limit of 1. The exclusion
    // itself is driven directly in the `readEndpointCapacity` block above; what
    // that can't see is whether this caller opts into it.
    const forceFn = extractFnBody(COS_SRC, COS_SRC.indexOf('export async function forceSpawnTask'));
    expect(forceFn).toMatch(/localEndpointCapacityError\([^)]*taskId\)/);
  });

  it('the LIVE gate wires in the real availability + fallback resolvers (#4834)', () => {
    // The branch logic itself is driven directly above (`resolveLocalEndpoint —
    // follows the fallback swap`) through injected doubles. What no unit test
    // can reach is whether the PRODUCTION context injects the real ones — if it
    // ever passed its own approximation, the prediction would silently drift
    // from where spawn actually sends the task.
    const SLOTS_SRC = readFileSync(join(__dirname, 'cosLocalEndpointSlots.js'), 'utf-8');
    expect(SLOTS_SRC, 'must use the real provider-status predicate')
      .toMatch(/isAvailable:\s*isProviderAvailable/);
    expect(SLOTS_SRC, 'and the real fallback resolver spawn uses')
      .toMatch(/getFallbackProvider\(/);
  });

  it('the DESTRUCTIVE-denial tiers opt out of the local-endpoint cap (#4834)', () => {
    // Priorities 0, 3 and 4 each commit side effects before `canSpawn` and never
    // persist the task, so a denial DISCARDS it rather than deferring it: the
    // on-demand request is already cleared, the mission sub-task is already
    // flipped to `in_progress` (and only `pending` ones are ever re-picked), the
    // app-review marker is already bound. They emit and let the chokepoint hold.
    // Priorities 1 and 2 read from persisted queues, so skipping there is a
    // genuine defer — they keep the cap.
    for (const tier of ['spawnDequeuePriority0OnDemand', 'spawnDequeuePriority3Missions', 'spawnDequeuePriority4IdleReview']) {
      const body = extractFnBody(COS_SRC, COS_SRC.indexOf(`async function ${tier}`));
      expect(body, `${tier} must admit via canSpawnCommitted`).toMatch(/canSpawnCommitted\(/);
    }
    for (const tier of ['spawnDequeuePriority1UserTasks', 'spawnDequeuePriority2AutoApproved']) {
      const body = extractFnBody(COS_SRC, COS_SRC.indexOf(`async function ${tier}`));
      expect(body, `${tier} defers rather than discards — it must keep the cap`).not.toMatch(/canSpawnCommitted\(/);
    }
  });

  it('idle generator is fenced by spawned===0 / tasksToSpawn.length===0', () => {
    // Pin the strict-idle gate. If a refactor drops either fence, idle could
    // spawn alongside autoSystem/mission and double-load the agent pool.
    // dequeueNextTask's idle tier (spawnDequeuePriority4IdleReview) now routes
    // through the shared `isIdleTierEligible` predicate in cosDequeue.js
    // (issue #2530), whose body carries the `spawned === 0` fence.
    const idleTier = extractFnBody(COS_SRC, COS_SRC.indexOf('async function spawnDequeuePriority4IdleReview'));
    const idlePred = extractFnBody(DEQ_SRC, DEQ_SRC.indexOf('export function isIdleTierEligible'));
    // The generator engine's tiers are decomposed into named spawnPriority*
    // helpers (issue #1082), so its gate lives in `spawnPriority4IdleReview`
    // — scope to the whole cosTaskGenerator module (the engine).
    const evalFn    = GEN_SRC;

    expect(idleTier, 'idle tier must call the shared isIdleTierEligible predicate').toMatch(/isIdleTierEligible\(/);
    expect(idleTier, 'idle tier must pass state.config.idleReviewEnabled into the predicate').toMatch(/idleReviewEnabled:\s*state\.config\.idleReviewEnabled/);
    expect(idlePred, 'isIdleTierEligible must fence on spawned === 0 && idleReviewEnabled').toMatch(/spawned\s*===\s*0\s*&&\s*!!idleReviewEnabled/);
    expect(evalFn).toMatch(/tasksToSpawn\.length\s*===\s*0\s*&&\s*state\.config\.idleReviewEnabled/);
  });

  it('CoS auto-run domain gate (#711) fences autonomous spawns in BOTH engines', () => {
    // Per-domain autonomy: the `cos` guardrail must gate every AUTOMATIC internal
    // spawn path — not just the auto-approved loop. Both spawn engines
    // (dequeueNextTask in cos.js, evaluateTasks in cosTaskGenerator.js) must read
    // the cos mode and fence their mission / idle / auto-approved blocks on it,
    // or "off"/"dry-run" leaks autonomous agents through the un-gated engine.
    // dequeueNextTask resolves the cos mode in spawnDequeuePriority2AutoApproved
    // and fences its mission/idle tiers through the shared eligibility predicates
    // (issue #2530) — both still live in the cos.js module, so scope to it.
    const dequeueSrc = COS_SRC;
    // evaluateTasks resolves the mode in `resolveAutonomyBudget` and fences each
    // autonomous tier inside its spawnPriority* helper (issue #1082) — both still
    // live in the cosTaskGenerator module, so scope to the whole engine source.
    const evalFn    = GEN_SRC;

    for (const [name, fnBody] of [['dequeueNextTask (cos.js)', dequeueSrc], ['evaluateTasks (cosTaskGenerator)', evalFn]]) {
      expect(fnBody, `${name} must resolve the cos autonomy mode`).toMatch(/getDomainMode\(\s*state\.config\s*,\s*['"]cos['"]\s*\)/);
    }
    // evaluateTasks fences autonomous spawns inline on `cosAutonomyMode === 'execute'`.
    expect(evalFn, `evaluateTasks must fence autonomous spawns on cosAutonomyMode === 'execute'`).toMatch(/cosAutonomyMode\s*===\s*['"]execute['"]/);
    // dequeueNextTask's autonomous tiers gate through the shared predicates, which
    // enforce `autonomyMode === 'execute'` in cosDequeue.js; the auto-approved tier
    // withholds spawns unless the mode is execute (`cosAutonomyMode !== 'execute'`).
    expect(dequeueSrc, `dequeueNextTask must gate mission/idle via the eligibility predicates`).toMatch(/isMissionTierEligible\(/);
    expect(dequeueSrc, `dequeueNextTask must gate the idle tier via the eligibility predicate`).toMatch(/isIdleTierEligible\(/);
    expect(dequeueSrc, `dequeueNextTask auto-approved tier must withhold spawns unless mode is execute`).toMatch(/cosAutonomyMode\s*!==\s*['"]execute['"]/);
    expect(DEQ_SRC, `cosDequeue predicates must enforce autonomyMode === 'execute'`).toMatch(/autonomyMode\s*===\s*['"]execute['"]/);
  });

  it('CoS auto-run domain gate (#711) covers the scheduled-job + improvement-check timers', () => {
    // executeScheduledJob and the cos-improvement-check timer are a THIRD
    // autonomous spawn path (outside dequeueNextTask / evaluateTasks). They must
    // also respect the cos guardrail, or off/dry-run leaks scheduled-job agents
    // and keeps mutating COS-TASKS.md via queueEligibleImprovementTasks.
    const execFn = extractFnBody(SCHED_SRC, SCHED_SRC.indexOf('export async function executeScheduledJob'));
    expect(execFn, 'executeScheduledJob must read the cos autonomy mode').toMatch(/getDomainMode\(\s*state\.config\s*,\s*['"]cos['"]\s*\)/);
    expect(execFn, 'executeScheduledJob must fence on execute').toMatch(/cosAutonomyMode\s*!==\s*['"]execute['"]/);
    // The autonomy-skip branch must record a gate-skip (advances lastRun) BEFORE
    // re-registering — otherwise a past-due job re-registers with stale lastRun
    // and refires every 1s while off/dry-run. Pin that the skip branch calls
    // recordJobGateSkip ahead of registerSingleJobSchedule.
    const skipBranch = execFn.slice(execFn.indexOf("cosAutonomyMode !== 'execute'"));
    const recordIdx = skipBranch.indexOf('recordJobGateSkip');
    const reregIdx = skipBranch.indexOf('registerSingleJobSchedule');
    expect(recordIdx, 'autonomy-skip must call recordJobGateSkip').toBeGreaterThan(-1);
    expect(recordIdx, 'recordJobGateSkip must precede re-registration (no 1s refire loop)').toBeLessThan(reregIdx);
    // The improvement-check timer must gate its queueEligibleImprovementTasks
    // call on the shared canQueueImprovementTasks predicate (idle-review +
    // cos===execute), which encapsulates the auto-run domain gate.
    expect(SCHED_SRC, 'improvement-check timer must gate queueing via canQueueImprovementTasks')
      .toMatch(/if\s*\(\s*canQueueImprovementTasks\(\s*state\s*\)\s*\)/);
  });

  it('both on-demand loops dedupe the cooldown stamp per app via reviewStartedApps set', () => {
    // Multiple on-demand requests targeting the same app should advance its
    // cooldown only once per cycle — without the guard, each request rewrites
    // the same record. BOTH on-demand loops carry the duplication: the
    // startup/manual `evaluateTasks` loop AND the event-driven `dequeueNextTask`
    // loop (the common "Run Now" path). Pin (a) the set is declared and (b) the
    // cooldown stamp is gated on it in each.
    // Both engines' Priority-0 on-demand loops are now extracted helpers:
    // `spawnPriority0OnDemand` in cosTaskGenerator.js (issue #1082) and
    // `spawnDequeuePriority0OnDemand` in cos.js (issue #2530).
    for (const { fnName, src } of [
      { fnName: 'async function spawnPriority0OnDemand', src: GEN_SRC },
      { fnName: 'async function spawnDequeuePriority0OnDemand', src: COS_SRC },
    ]) {
      const fnBody = extractFnBody(src, src.indexOf(fnName));
      expect(
        fnBody,
        `${fnName} must declare a reviewStartedApps set to dedupe per-app marks`
      ).toMatch(/const\s+reviewStartedApps\s*=\s*new\s+Set\(/);
      expect(
        fnBody,
        `${fnName} must gate markAppReviewCooldown on !reviewStartedApps.has(targetApp.id)`
      ).toMatch(/if\s*\(\s*!\s*reviewStartedApps\.has\(\s*targetApp\.id\s*\)\s*\)/);
    }
  });

  it('on-demand loops defer bindAppReviewAgent until a task is produced (issue #978)', () => {
    // The phantom-active-agent bug: binding activeAgentId before the per-app
    // task generator runs strands the marker when the generator returns null.
    // Pin that both on-demand loops (a) advance the cooldown with
    // markAppReviewCooldown, NOT markAppReviewStarted, and (b) only bind the
    // active agent inside an `if (task)` guard after generation.
    for (const { fnName, src } of [
      { fnName: 'async function spawnPriority0OnDemand', src: GEN_SRC },
      { fnName: 'async function spawnDequeuePriority0OnDemand', src: COS_SRC },
    ]) {
      const fnBody = extractFnBody(src, src.indexOf(fnName));
      expect(
        fnBody,
        `${fnName} must advance cooldown via markAppReviewCooldown (not the conflated markAppReviewStarted)`
      ).toMatch(/markAppReviewCooldown\(\s*targetApp\.id\s*\)/);
      expect(
        fnBody,
        `${fnName} must NOT call markAppReviewStarted (conflates cooldown + bind, the #978 bug)`
      ).not.toMatch(/markAppReviewStarted\(/);
      expect(
        fnBody,
        `${fnName} must bind the active agent only after a task exists`
      ).toMatch(/if\s*\(\s*task\s*\)\s*\{\s*await\s+bindAppReviewAgent\(\s*targetApp\.id/);
    }
  });

  it('has NO handler-backed dispatch — every task type routes through the agent path', () => {
    // #2322 follow-up: layered-intelligence migrated OFF the handler-backed path
    // onto a normal agent task with programmatic-I/O hooks (taskTypeHooks.js). The
    // queue path no longer special-cases any type: there is no in-process handler
    // dispatch that bypasses the agent-spawn path, so a scheduled reasoning task is
    // a visible, TUI-capable agent like everything else.
    expect(GEN_SRC).not.toMatch(/dispatchHandlerBackedTask/);
    expect(GEN_SRC).not.toMatch(/runHandlerBackedTaskForApp/);
    expect(GEN_SRC).not.toMatch(/layeredIntelligenceHandler\.js/);

    // The generator runs a task type's optional buildTaskInput hook before dispatch
    // (the pre-agent programmatic slot LI's gather layer fills).
    expect(GEN_SRC).toMatch(/getTaskInputHook/);
  });

  it('queueEligibleImprovementTasks routes through generateManagedAppImprovementTaskForType', () => {
    // Regression guard: a 2026-05-21 incident saw two `plan-task` agents both
    // open PRs for the same PLAN.md slug because the queue path was writing
    // a one-line stub description with no `analysisType` / `planId`. The
    // agent it dispatched got the Phase 1-7 prompt (with in-flight scan)
    // stripped, picked the same slug as a sibling that already had an open
    // `claim/<slug>` PR, and produced a duplicate. The fix routes the queue
    // path through the shared generator so `applyPlanIdMetadata` runs and
    // the full prompt + planId metadata land on the queued task.
    const fnStart = GEN_SRC.indexOf('async function queueEligibleImprovementTasks');
    expect(fnStart, 'queueEligibleImprovementTasks must exist').toBeGreaterThan(-1);
    const fnBody = extractFnBody(GEN_SRC, fnStart);

    expect(
      fnBody,
      'queue path must call generateManagedAppImprovementTaskForType so applyPlanIdMetadata runs + the full prompt is used'
    ).toMatch(/generateManagedAppImprovementTaskForType\s*\(/);

    // Match the call shape, not the specific variable name — `task` could
    // legitimately be renamed (e.g. `queuedTask`) in a behavior-preserving
    // refactor. The contract being pinned is "raw:true addTask call to the
    // internal lane," not the identifier. The options object may carry siblings
    // beyond `raw:true` (e.g. `ignoreTaskId` for the perpetual refill), so don't
    // require `}` immediately after `raw: true`.
    expect(
      fnBody,
      'queue path must persist via addTask with raw:true so the enriched task object survives serialization'
    ).toMatch(/addTask\s*\(\s*\w+\s*,\s*['"]internal['"]\s*,\s*\{\s*raw:\s*true\b/);

    // The old buggy path called `getTaskDescription` to build a one-line
    // description and then passed app/context/approvalRequired fields to
    // addTask's non-raw constructor. Pin both as absent so we can't regress.
    expect(
      fnBody,
      'queue path must NOT use getTaskDescription (one-line stub bypasses prompt enrichment)'
    ).not.toMatch(/getTaskDescription\s*\(/);

    // The generator returns a multi-line `description` (the full Phase 1–7
    // prompt template). COS-TASKS.md serialization interpolates the whole
    // description onto a single `- [ ]` line and the parser only matches the
    // first line, so persisting a multi-line description corrupts the file
    // AND truncates the prompt on the next `dequeueNextTask` re-read. The
    // queue path must move the body to `metadata.prompt` (which IS
    // newline-escaped) so the agent prompt builder reconstitutes it on
    // dispatch. `prompt`, not `context` — the two were split in #4153 so a
    // multi-thousand-character agent payload is distinguishable from the
    // one-line human note. Pin both halves of the split.
    expect(
      fnBody,
      'queue path must move multi-line description body to metadata.prompt (survives markdown round-trip)'
    ).toMatch(/metadata\.prompt\s*=\s*\w+\.description/);
    expect(
      fnBody,
      'queue path must collapse description to a single line via firstLine()'
    ).toMatch(/\.description\s*=\s*firstLine\(/);

    // `getNextTaskType` falls back to ROTATION when nothing is time-due, and
    // the rotation pointer is derived from the `lastType` argument. The queue
    // path MUST thread the per-app `lastImprovementType` through, otherwise
    // every tick restarts the rotation at index 0 and starves every other
    // rotation type for the app. Mirrors the legacy direct-spawn caller.
    expect(
      fnBody,
      'queue path must pass the loaded lastType through to getNextTaskType so rotation advances'
    ).toMatch(/getNextTaskType\(app\.id,\s*\w+\s*(?:,|\))/);

    // appActivity helpers must come from the file-level static import (line ~23),
    // NOT a dynamic `await import('./appActivity.js')` *inside* the per-app
    // loop. Dynamic imports are cached but still add an extra microtask + a
    // promise allocation per iteration, and they hide the real dependency
    // graph at file scope.
    expect(
      fnBody,
      'queue path must not dynamically import ./appActivity.js inside the per-app loop'
    ).not.toMatch(/await\s+import\(['"]\.\/appActivity\.js['"]\)/);

    // The cooldown check + lastImprovementType lookup both come from the
    // same `data/app-activity.json` file. Before snapshotting, each app
    // paid two separate disk reads per tick (one via `isAppOnCooldown`, one
    // via `getAppActivityById`), so a 10-app install did 20 reads per
    // scheduler tick. The queue path must (a) call `loadAppActivity()`
    // exactly ONCE before the per-app loop and (b) drive the per-app
    // cooldown gate via the pure `isAppActivityOnCooldown` predicate
    // (which takes the per-app activity record from the snapshot), NOT
    // the async `isAppOnCooldown` (which re-reads the file).
    expect(
      fnBody,
      'queue path must hoist loadAppActivity() before the per-app loop'
    ).toMatch(/loadAppActivity\(\)/);
    expect(
      fnBody,
      'queue path must gate cooldown via the pure isAppActivityOnCooldown predicate, not the disk-reading isAppOnCooldown'
    ).toMatch(/isAppActivityOnCooldown\(/);
    expect(
      fnBody,
      'queue path must not call the disk-reading isAppOnCooldown per app'
    ).not.toMatch(/await\s+isAppOnCooldown\(/);

    // Perpetual (drain-until-done) picks must BYPASS the per-app review cooldown
    // — their work-detector park is the throttle, not the cooldown window. The
    // spawn-time `markAppReviewCooldown` stamp (on-demand manual trigger +
    // idle-review loop) writes `lastReviewedAt`, so without the bypass the
    // back-to-back refill after a perpetual completion reads its own app as
    // on-cooldown and stalls — a manually-triggered perpetual task then runs
    // once instead of continuing the drain. The bypass is implemented by
    // CONSTRAINING the pick to perpetual when the app is on cooldown: the
    // cooldown state is computed first and passed to getNextTaskType as
    // `perpetualOnly`, so in a MIXED schedule a due higher-priority cron/custom
    // type can't mask the perpetual drain (which would strand the whole app for
    // the window). Pin: (a) the cooldown is resolved BEFORE getNextTaskType, and
    // (b) getNextTaskType is asked for a perpetual-only pick gated on cooldown.
    const cooldownIdx = fnBody.indexOf('isAppActivityOnCooldown(');
    const nextTypeIdx = fnBody.indexOf('getNextTaskType(');
    expect(
      cooldownIdx,
      'queue path must compute cooldown via isAppActivityOnCooldown'
    ).toBeGreaterThan(-1);
    expect(
      cooldownIdx < nextTypeIdx,
      'cooldown must be resolved BEFORE getNextTaskType so it can constrain the pick to perpetual'
    ).toBe(true);
    expect(
      fnBody,
      'queue path must constrain the pick to perpetual when on cooldown (perpetualOnly gated on cooldown)'
    ).toMatch(/getNextTaskType\([^)]*\{\s*perpetualOnly:\s*onCooldown\s*\}/);
  });

  it('generateManagedAppImprovementTaskForType defers updateAppActivity until after gates', () => {
    // Regression guard: the rotation pointer + "Generating improvement task"
    // log must only advance when a real task is queued. The eager call at
    // the top of the function was tolerable when only the on-demand path
    // hit it (user explicitly picked the type), but now the per-tick queue
    // path routes through it too — so every plan-task skip (no available
    // slug), every precondition fail, and every reference-watch "no refs"
    // exit would silently rotate the pick + emit a misleading log. Pin
    // both the absence of the early call AND the presence of the gated
    // late call so a future refactor can't accidentally restore the
    // pre-gate ordering.
    //
    // Use sliceFn instead of extractFnBody because the function body
    // contains a `for (...) { try { ... } catch }` block and the
    // brace-balanced scanner doesn't always match the right closer when
    // there are template-literal braces nested inside.
    const fnStart = GEN_SRC.indexOf('async function generateManagedAppImprovementTaskForType');
    expect(fnStart, 'generateManagedAppImprovementTaskForType must exist').toBeGreaterThan(-1);
    const fnEnd = GEN_SRC.indexOf('\nasync function ', fnStart + 1);
    const fnBody = GEN_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

    // The updateAppActivity call must appear AFTER applyPlanIdMetadata —
    // otherwise a `planMeta.skipReason` early-return still rotates the pointer.
    const planMetaIdx = fnBody.indexOf('applyPlanIdMetadata(');
    const updateActivityIdx = fnBody.indexOf('updateAppActivity(app.id,');
    expect(planMetaIdx, 'applyPlanIdMetadata must appear in the function').toBeGreaterThan(-1);
    expect(updateActivityIdx, 'updateAppActivity must appear in the function').toBeGreaterThan(-1);
    expect(
      updateActivityIdx,
      'updateAppActivity must run after applyPlanIdMetadata so rotation only advances on a real queue'
    ).toBeGreaterThan(planMetaIdx);

    // The "(on-demand)" suffix on the generation log was misleading once
    // the queue path started routing through this function. Pin the suffix
    // as absent.
    expect(
      fnBody,
      'Generation log must not claim "(on-demand)" — function is shared by queue + on-demand callers'
    ).not.toMatch(/Generating improvement task[^`'"\n]*\(on-demand\)/);
  });

  it('applyPlanIdMetadata does NOT pre-stamp planId for self-claiming task types', () => {
    // Regression guard: `plan-task` agents pick (and claim) their own slug at
    // execution time, mirroring `/claim`. A dispatch-time pre-pick stamps a
    // slug before the agent creates its `claim/<slug>` branch (the real lock),
    // so two near-simultaneous dispatches both target the same first-available
    // item — the exact race behind the 2026-05-21 duplicate-PR incident. The
    // in-flight scan in applyPlanIdMetadata must stay (it gates dispatch), but
    // the planId stamp must be fenced behind PLAN_SELF_CLAIM_TASK_TYPES.
    expect(
      GEN_SRC,
      'plan-task must be registered as a self-claiming task type'
    ).toMatch(/PLAN_SELF_CLAIM_TASK_TYPES\s*=\s*new Set\(\[\s*'plan-task'\s*\]\)/);

    const fnStart = GEN_SRC.indexOf('async function applyPlanIdMetadata');
    expect(fnStart, 'applyPlanIdMetadata must exist').toBeGreaterThan(-1);
    const fnBody = extractFnBody(GEN_SRC, fnStart);

    // The planId stamp must be guarded so self-claiming types never pre-pick.
    expect(
      fnBody,
      'metadata.planId stamp must be fenced behind a PLAN_SELF_CLAIM_TASK_TYPES check'
    ).toMatch(/if\s*\(\s*!PLAN_SELF_CLAIM_TASK_TYPES\.has\(taskType\)\s*\)\s*\{\s*metadata\.planId\s*=/);

    // The gate (skipReason) machinery must still run — we only dropped the stamp.
    expect(
      fnBody,
      'applyPlanIdMetadata must still scan in-flight slugs to gate dispatch'
    ).toMatch(/findInProgressIds\(/);
  });

  it('tasks:changed listener schedules dequeueNextTask before the user tryImmediateSpawn', () => {
    // When task CRUD moved to cosTaskStore.js (issue-741), the addTask→
    // tryImmediateSpawn and approveTask→dequeueNextTask direct calls were
    // replaced by a `tasks:changed` listener here. The original sequence for a
    // user-added task was: emit tasks:changed (which queued dequeueNextTask via
    // this listener) FIRST, then addTask called setImmediate(tryImmediateSpawn).
    // dequeue fills open slots in priority order before the just-added task's
    // immediate-spawn attempt runs — so the order must stay dequeue-then-spawn.
    const onIdx = COS_SRC.indexOf("cosEvents.on('tasks:changed'");
    expect(onIdx, 'tasks:changed listener must exist').toBeGreaterThan(-1);
    const handler = COS_SRC.slice(onIdx, COS_SRC.indexOf('});', onIdx) + 3);

    const dequeueIdx = handler.indexOf('dequeueNextTask()');
    const spawnIdx = handler.indexOf('tryImmediateSpawn(');
    expect(dequeueIdx, 'listener must schedule dequeueNextTask').toBeGreaterThan(-1);
    expect(spawnIdx, 'listener must schedule tryImmediateSpawn').toBeGreaterThan(-1);
    expect(
      dequeueIdx,
      'dequeueNextTask must be scheduled before the user-task tryImmediateSpawn'
    ).toBeLessThan(spawnIdx);

    // tryImmediateSpawn is user-task-only, matching the pre-extraction guard.
    expect(handler).toMatch(/data\.type\s*===\s*'user'/);
  });

  it('tasks:changed listener leaves explicitly dispatched tasks to their caller', () => {
    const onIdx = COS_SRC.indexOf("cosEvents.on('tasks:changed'");
    const handler = COS_SRC.slice(onIdx, COS_SRC.indexOf('});', onIdx) + 3);

    expect(handler).toMatch(/if\s*\(data\.suppressDequeue\)\s*return/);
  });

  // The retry-hold release (#3373) and the orphan sweep both requeue via an
  // in_progress → pending flip, which cosTaskStore reports as 'requeued'. Without
  // a wake here the released retry idles until an unrelated event or timer.
  it('tasks:changed listener re-runs the dequeue on a requeued task', () => {
    const onIdx = COS_SRC.indexOf("cosEvents.on('tasks:changed'");
    const handler = COS_SRC.slice(onIdx, COS_SRC.indexOf('});', onIdx) + 3);
    expect(handler).toMatch(/data\.action\s*===\s*'requeued'/);
  });

  // A finished investigation is what releases the failure-blocked task(s) it was
  // diagnosing. Without this branch the fix lands and the work it unblocked never
  // runs — the task sits `blocked` until a human notices or the 14-day reaper
  // quietly auto-expires it.
  it('tasks:changed listener hands a completed task to the investigation auto-retry', () => {
    const onIdx = COS_SRC.indexOf("cosEvents.on('tasks:changed'");
    const handler = COS_SRC.slice(onIdx, COS_SRC.indexOf('});', onIdx) + 3);
    expect(handler).toMatch(/data\.task\?\.status\s*===\s*'completed'/);
    expect(handler).toMatch(/retryTasksResolvedByInvestigation\(data\.task\)/);
  });
});

// A failed run's retry is held non-spawnable (`in_progress` + marker) while its
// worktree cleanup resolves the resume pointer (#3373). The boot/health-check
// sweep walks in_progress tasks, so it must leave a LIVE hold alone — requeueing
// there would resolve the pointer against a branch mid-merge — and must hand a
// STALE one (the process that armed it died) to handleOrphanedTask, which
// finishes the transition.
describe('resetOrphanedTasks — retry holds (#3373)', () => {
  const sweepFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function resetOrphanedTasks'));

  it('skips a held task until its hold goes stale', () => {
    expect(sweepFn, 'the sweep must consult the retry hold')
      .toMatch(/const recoverHold = held && \(bootRecovery \|\| isStaleRetryHold\(task\.metadata\)\)/);
    expect(sweepFn, 'a live hold must skip the task').toMatch(/if \(held && !recoverHold\)/);
    const guardIdx = sweepFn.indexOf('const held = isRetryHeld(task.metadata)');
    const handlerIdx = sweepFn.indexOf('handleOrphanedTask(');
    expect(guardIdx, 'the hold guard must run before the orphan handler').toBeGreaterThan(-1);
    expect(guardIdx, 'the hold guard must run before the orphan handler').toBeLessThan(handlerIdx);
  });

  // Nothing can be mid-cleanup on the startup pass, so a hold left by the process
  // that died is recovered immediately rather than idling out its grace window.
  it('recovers a held task immediately on the boot pass', () => {
    expect(COS_SRC).toMatch(/resetOrphanedTasks\(\{\s*bootRecovery:\s*true\s*\}\)/);
    expect(sweepFn).toMatch(/bootRecovery\s*=\s*false/);
  });

  // The hold is armed AFTER completeAgent, so a crash-restart inside the 60s
  // recently-completed grace would otherwise skip exactly the task the boot pass
  // exists to recover, stranding it until the 15-minute periodic sweep.
  it('lets a recoverable hold bypass the recently-completed grace', () => {
    const holdIdx = sweepFn.indexOf('const recoverHold =');
    const graceIdx = sweepFn.indexOf('recentlyCompletedTaskIds.has(task.id)');
    expect(holdIdx, 'the hold must be evaluated before the recently-completed grace').toBeLessThan(graceIdx);
    expect(sweepFn).toMatch(/if \(!recoverHold && recentlyCompletedTaskIds\.has\(task\.id\)\)/);
  });
});

describe('forceSpawnTask — pre-validate provider before task:ready', () => {
  // The play button on a pending task calls forceSpawnTask, which emits
  // `task:ready`; the actual spawn happens asynchronously in a listener. If
  // provider/model resolution fails there (e.g. the task is pinned to an
  // `api`-type provider with no file-writing harness), the spawn bails
  // silently and the task stays `pending` — but the HTTP call had already
  // returned `{ success: true }` and the UI toasted "Spawning". Pin that
  // forceSpawnTask resolves the provider FIRST and returns the resolution
  // error (so the route surfaces a truthful 400) instead of emitting
  // `task:ready` on a doomed spawn.
  const forceFn = extractFnBody(COS_SRC, COS_SRC.indexOf('export async function forceSpawnTask'));

  it('calls resolveAgentProviderAndModel and returns its error', () => {
    expect(forceFn, 'forceSpawnTask must pre-resolve the provider/model')
      .toMatch(/resolveAgentProviderAndModel\(\s*task\s*\)/);
    expect(forceFn, 'forceSpawnTask must return the resolution error on failure')
      .toMatch(/if\s*\(\s*!\s*resolution\.ok\s*\)\s*\{\s*return\s*\{\s*error:\s*resolution\.error\s*\}/);
  });

  it('bails on a failed resolution BEFORE emitting task:ready', () => {
    const resolveIdx = forceFn.indexOf('resolveAgentProviderAndModel');
    const readyIdx = forceFn.indexOf("cosEvents.emit('task:ready'");
    expect(resolveIdx, 'resolution must happen in forceSpawnTask').toBeGreaterThan(-1);
    expect(readyIdx, 'forceSpawnTask must still emit task:ready on success').toBeGreaterThan(-1);
    expect(resolveIdx, 'provider resolution must precede the task:ready emit')
      .toBeLessThan(readyIdx);
  });

  // Same failure mode, two more sources of a doomed spawn. A stopped daemon was
  // never checked at all (only `paused` was), and in runner mode the spawn path
  // now HOLDS the task while the cos-runner app is down instead of failing it —
  // right for the autonomous queue, wrong for an explicit "Run now", which would
  // get `{ success: true }` and a "Spawning" toast for a task that quietly stays
  // pending. Both must answer with an actionable error instead.
  it('refuses to force-spawn while the daemon is stopped', () => {
    const stoppedIdx = forceFn.indexOf('!isDaemonRunning()');
    expect(stoppedIdx, 'forceSpawnTask must check that the daemon is running').toBeGreaterThan(-1);
    expect(stoppedIdx, 'the stopped check must precede the task:ready emit')
      .toBeLessThan(forceFn.indexOf("cosEvents.emit('task:ready'"));
  });

  it('refuses to force-spawn while the runner is holding', () => {
    const holdIdx = forceFn.indexOf('isRunnerHolding');
    expect(holdIdx, 'forceSpawnTask must consult the runner hold').toBeGreaterThan(-1);
    expect(holdIdx, 'the runner check must precede the task:ready emit')
      .toBeLessThan(forceFn.indexOf("cosEvents.emit('task:ready'"));
  });

  // spawnAgentForTask registers its agent as `running` BEFORE flipping the task
  // off `pending`, so the `status !== 'pending'` check above still passes for the
  // seconds between those two writes. Without a live-agent check, a "Run now"
  // landing there answers `{ success: true }` and toasts "Spawning" for a second
  // dispatch that withSpawnDedupGuard then silently drops.
  it('refuses a task a running agent already holds', () => {
    const holderIdx = forceFn.indexOf('agent.taskId === taskId');
    expect(holderIdx, 'forceSpawnTask must reject a task a running agent holds')
      .toBeGreaterThan(-1);
    expect(forceFn, 'the refusal must name the agent that holds it')
      .toContain('is already running this task');
    expect(holderIdx, 'the live-agent check must precede the task:ready emit')
      .toBeLessThan(forceFn.indexOf("cosEvents.emit('task:ready'"));
  });

  // ...but only while that agent is plausibly still mid-spawn. Outside the window,
  // a `pending` task carrying a `running` agent is a zombie record — and this
  // route never runs cleanupZombieAgents — so an unbounded refusal would turn the
  // task's own recovery action into a permanent no-op.
  it('bounds the refusal so a stale holder can still be superseded', () => {
    expect(forceFn, 'the holder refusal must be age-bounded')
      .toContain('SPAWN_CLAIM_GRACE_MS');
    expect(forceFn, 'a stale holder must fall through to the spawn, not return')
      .toMatch(/holderAgeMs < SPAWN_CLAIM_GRACE_MS/);
    expect(COS_SRC, 'the grace window must be defined').toMatch(/const SPAWN_CLAIM_GRACE_MS = /);
  });
});

describe('the runner-down hold — spawn-side gates', () => {
  // Dispatch holds a task while the cos-runner app is down (the `task:ready`
  // listener in subAgentSpawner.js, covered behaviorally in
  // subAgentSpawner.runnerHold.test.js). The dequeue must ALSO bail before its
  // priority tiers run: they drain on-demand requests, advance review cooldowns,
  // bind the synthetic app-review marker, and spend `capacity` — side effects a
  // downstream hold cannot take back.
  const dequeueFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function dequeueNextTask'));

  it('bails on the runner hold before doing any tier work', () => {
    const holdIdx = dequeueFn.indexOf('isRunnerHolding');
    expect(holdIdx, 'dequeueNextTask must consult the runner hold').toBeGreaterThan(-1);
    expect(holdIdx, 'the hold must be checked before capacity is computed')
      .toBeLessThan(dequeueFn.indexOf('createDequeueCapacity'));
  });

  it('gates the immediate user-task spawn on the same predicate', () => {
    const immediateFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function tryImmediateSpawn'));
    expect(immediateFn).toMatch(/isRunnerHolding/);
  });

  // Direct mode has no runner to be down; probing there would hold every spawn
  // on an install that never runs the cos-runner app.
  it('is a no-op in direct mode', () => {
    const holdFn = extractFnBody(COS_SRC, COS_SRC.indexOf('async function isRunnerHolding'));
    expect(holdFn).toMatch(/if\s*\(!useRunner\)\s*return false/);
  });
});

describe('addTask — first-line dedup', () => {
  it('returns the first non-empty trimmed line', () => {
    expect(firstLine('hello\nworld')).toBe('hello');
    expect(firstLine('\n\n  first  \nsecond')).toBe('first');
    expect(firstLine('single')).toBe('single');
  });

  it('returns empty string for null/undefined/empty input', () => {
    expect(firstLine(null)).toBe('');
    expect(firstLine(undefined)).toBe('');
    expect(firstLine('')).toBe('');
    expect(firstLine('\n\n\n')).toBe('');
  });

  it('multi-line and single-line descriptions with the same first line collide', () => {
    // Repro: handleOrphanedTask builds a multi-line description, but
    // generateTasksMarkdown flattens it to one line. Without first-line
    // normalization, addTask's dedup compares the full multi-line input to
    // the stored single line and never matches — producing N duplicate
    // [Auto-Fix] tasks, each spawning its own agent.
    const multi = '[Auto-Fix] Investigate repeated agent orphaning for task X\n\n**Last Orphaned Agent**: agent-aaa';
    const stored = '[Auto-Fix] Investigate repeated agent orphaning for task X';
    expect(firstLine(multi).toLowerCase()).toBe(firstLine(stored).toLowerCase());
  });

  // The addTask source-level regression guards (firstLine dedup + per-app
  // dedup scope) moved to cosTaskStore.test.js when addTask was extracted into
  // cosTaskStore.js. The firstLine behavioral tests above stay here because
  // cos.js still re-exports firstLine for backward compat.
});

// ─── Perpetual re-queue on completion (drain back-to-back) ─────────────────
//
// Perpetual schedules (e.g. claim-issue) are documented as "drain actionable
// work back-to-back (re-queue on completion)" (taskSchedule.js), but the only
// thing that queues them is the ~hourly cos-improvement-check timer — the
// agent:completed handler (dequeueNextTask) merely drains already-queued tasks
// and never regenerates perpetual work. A "ready" perpetual task doesn't even
// shorten that timer (cosJobScheduler only gates the delay on status:'scheduled'
// tasks), so when claim-issue is the only enabled schedule the next run waits up
// to MAX_CHECK_INTERVAL (1h) instead of spawning immediately after the prior one.
//
// `isPerpetualRefillCandidate` is the pure gate that lets the completion handler
// decide whether the just-finished agent belongs to a perpetual schedule that
// should be refilled right now.
describe('isPerpetualRefillCandidate — perpetual drain on completion', () => {
  const schedule = {
    tasks: {
      'claim-issue': { type: 'perpetual', enabled: true },
      'claim-issue-disabled': { type: 'perpetual', enabled: false },
      'branch-reconcile': { type: 'on-demand', enabled: true },
      'plan-task': { type: 'daily', enabled: true },
    },
  };
  const agentFor = (analysisType, key = 'taskAnalysisType') => ({
    metadata: analysisType == null ? {} : { [key]: analysisType },
  });

  it('is true for an enabled perpetual type matching the agent task', () => {
    expect(isPerpetualRefillCandidate(agentFor('claim-issue'), schedule)).toBe(true);
  });

  it('is false for a disabled perpetual type (toggled off after spawn)', () => {
    expect(isPerpetualRefillCandidate(agentFor('claim-issue-disabled'), schedule)).toBe(false);
  });

  it('is false for a non-perpetual schedule type', () => {
    expect(isPerpetualRefillCandidate(agentFor('plan-task'), schedule)).toBe(false);
  });

  it('is true for an enabled on-demand reconciliation drain', () => {
    expect(isPerpetualRefillCandidate(agentFor('branch-reconcile'), schedule)).toBe(true);
  });

  it('is false for an unknown / unscheduled type', () => {
    expect(isPerpetualRefillCandidate(agentFor('ghost-type'), schedule)).toBe(false);
  });

  it('reads the analysis type from metadata.analysisType and selfImprovementType fallbacks', () => {
    expect(isPerpetualRefillCandidate(agentFor('claim-issue', 'analysisType'), schedule)).toBe(true);
    expect(isPerpetualRefillCandidate(agentFor('claim-issue', 'selfImprovementType'), schedule)).toBe(true);
  });

  it('is false for missing agent / metadata / schedule (no throw)', () => {
    expect(isPerpetualRefillCandidate(null, schedule)).toBe(false);
    expect(isPerpetualRefillCandidate(agentFor(null), schedule)).toBe(false);
    expect(isPerpetualRefillCandidate(agentFor('claim-issue'), null)).toBe(false);
    expect(isPerpetualRefillCandidate(agentFor('claim-issue'), { tasks: null })).toBe(false);
  });
});

// `perpetualRefillPlan` chooses which lane a completed perpetual run continues
// in. The load-bearing case: a MANUAL "Run Now" drain (metadata.taskOnDemand)
// must continue in the user-initiated on-demand lane — gated on the master
// Improve flag, NOT canQueueImprovementTasks — so it keeps draining even when
// CoS auto-run is off/dry-run or idle-review is off (the postures in which the
// user reaches for "Run Now" and the manual run is allowed to START but the
// auto-run-gated queue lane would otherwise stall the drain after one item).
describe('perpetualRefillPlan — manual vs scheduled drain lane', () => {
  const schedule = {
    tasks: {
      'claim-issue': { type: 'perpetual', enabled: true },
      'claim-issue-disabled': { type: 'perpetual', enabled: false },
      'branch-reconcile': { type: 'on-demand', enabled: true },
      'plan-task': { type: 'daily', enabled: true },
    },
  };
  const agent = (metadata) => ({ metadata });

  it('routes a scheduled perpetual run to the auto-run-gated queue lane', () => {
    expect(perpetualRefillPlan(agent({ taskAnalysisType: 'claim-issue' }), schedule))
      .toEqual({ lane: 'queue' });
  });

  it('routes a MANUAL (on-demand) perpetual run to the on-demand lane, carrying type + app', () => {
    expect(perpetualRefillPlan(
      agent({ taskAnalysisType: 'claim-issue', taskOnDemand: true, taskApp: 'app-42' }),
      schedule,
    )).toEqual({ lane: 'onDemand', taskType: 'claim-issue', appId: 'app-42' });
  });

  it('routes an on-demand reconciliation drain to the on-demand lane', () => {
    expect(perpetualRefillPlan(
      agent({ taskAnalysisType: 'branch-reconcile', taskOnDemand: true, taskApp: 'app-1' }),
      schedule,
    )).toEqual({ lane: 'onDemand', taskType: 'branch-reconcile', appId: 'app-1' });
  });

  it('a manual run with no app resolves appId to null (global on-demand re-issue)', () => {
    expect(perpetualRefillPlan(
      agent({ taskAnalysisType: 'claim-issue', taskOnDemand: true }),
      schedule,
    )).toEqual({ lane: 'onDemand', taskType: 'claim-issue', appId: null });
  });

  it('skips a non-candidate even when it is marked on-demand (disabled / non-perpetual / unknown)', () => {
    expect(perpetualRefillPlan(agent({ taskAnalysisType: 'claim-issue-disabled', taskOnDemand: true }), schedule))
      .toEqual({ lane: 'skip' });
    expect(perpetualRefillPlan(agent({ taskAnalysisType: 'plan-task', taskOnDemand: true }), schedule))
      .toEqual({ lane: 'skip' });
    expect(perpetualRefillPlan(agent({ taskAnalysisType: 'ghost', taskOnDemand: true }), schedule))
      .toEqual({ lane: 'skip' });
  });

  it('resolves the on-demand type from the analysisType / selfImprovementType fallbacks', () => {
    expect(perpetualRefillPlan(agent({ analysisType: 'claim-issue', taskOnDemand: true }), schedule).lane)
      .toBe('onDemand');
    expect(perpetualRefillPlan(agent({ selfImprovementType: 'claim-issue', taskOnDemand: true }), schedule).lane)
      .toBe('onDemand');
  });

  it('never throws on missing agent / metadata / schedule', () => {
    expect(perpetualRefillPlan(null, schedule)).toEqual({ lane: 'skip' });
    expect(perpetualRefillPlan(agent({}), schedule)).toEqual({ lane: 'skip' });
    expect(perpetualRefillPlan(agent({ taskAnalysisType: 'claim-issue', taskOnDemand: true }), null))
      .toEqual({ lane: 'skip' });
  });
});

// Source-level guard: the agent:completed handler must wire the perpetual
// refill so completion drains back-to-back instead of waiting for the hourly
// improvement-check timer.
describe('cos.js source — agent:completed triggers perpetual refill', () => {
  it("the agent:completed listener invokes the perpetual refill path", () => {
    const onIdx = COS_SRC.indexOf("cosEvents.on('agent:completed'");
    expect(onIdx, 'agent:completed listener must exist').toBeGreaterThan(-1);
    const handlerSlice = COS_SRC.slice(onIdx, onIdx + 1200);
    expect(
      handlerSlice.includes('refillPerpetualForCompletedAgent'),
      'agent:completed handler must call refillPerpetualForCompletedAgent'
    ).toBe(true);
  });

  it('the refill passes the completed task id as ignoreTaskId (avoids the completeAgent-before-updateTask dedup race)', () => {
    // agent:completed fires before the completion flow's updateTask marks the task
    // done, so the just-finished task can still read as in_progress — both in the
    // snapshot AND on disk when queueEligible's addTask re-reads COS-TASKS.md. A
    // perpetual schedule regenerates an identical first-line per app, so without
    // excluding the completing task the refill is rejected as a duplicate and the
    // drain stalls. Pin the ignoreTaskId thread so a refactor can't reintroduce it.
    const fnIdx = COS_SRC.indexOf('async function refillPerpetualForCompletedAgent');
    expect(fnIdx, 'refillPerpetualForCompletedAgent must exist').toBeGreaterThan(-1);
    const fnSlice = COS_SRC.slice(fnIdx, fnIdx + 4600);
    expect(
      /queueEligibleImprovementTasks\(\s*state\s*,\s*cosTaskData\s*,\s*\{[\s\S]*?ignoreTaskId:\s*agent\?\.taskId[\s\S]*?\}\s*\)/.test(fnSlice),
      'refill must forward ignoreTaskId: agent?.taskId to queueEligibleImprovementTasks'
    ).toBe(true);
  });

  it('a MANUAL (on-demand) drain continues via triggerOnDemandTask under isImprovementEnabled, returning before the auto-run queue lane', () => {
    // The bug fixed here: a "Run Now" perpetual drain is allowed to START in a
    // posture where canQueueImprovementTasks is false (auto-run off/dry-run or
    // idle-review off), but the scheduled queue lane refuses to continue it —
    // stalling the drain after one item. The manual lane must instead re-issue an
    // on-demand request (scoped to the same type+app) under the same
    // isImprovementEnabled gate the manual trigger used, and RETURN before the
    // queueEligibleImprovementTasks path. Assert the ordering rather than the
    // absence of a keyword in a comment (fragile): Improve gate → re-issue →
    // return → (only then) the queue lane.
    const fnIdx = COS_SRC.indexOf('async function refillPerpetualForCompletedAgent');
    const fnSlice = COS_SRC.slice(fnIdx, fnIdx + 4600);
    expect(
      fnSlice.includes('const plan = perpetualRefillPlan(agent, schedule)'),
      'refill must resolve the lane via perpetualRefillPlan'
    ).toBe(true);
    expect(/plan\.lane === 'onDemand'/.test(fnSlice), 'refill must branch on the on-demand lane').toBe(true);

    const improveGateIdx = fnSlice.indexOf('if (!isImprovementEnabled(state)) return;');
    // `emit: false` avoids a redundant second dequeue; `origin: REFILL` marks the
    // re-issue as automated so the on-demand engines do NOT clear the drain's park /
    // convergence signature / dispatch counter on its behalf.
    const triggerMatch = /triggerOnDemandTask\(plan\.taskType, plan\.appId, \{\s*emit: false, origin: taskScheduleMod\.ON_DEMAND_ORIGINS\.REFILL\s*\}\)/.exec(fnSlice);
    const triggerIdx = triggerMatch ? triggerMatch.index : -1;
    const queueIdx = fnSlice.indexOf('queueEligibleImprovementTasks(state, cosTaskData');
    expect(improveGateIdx, 'manual lane must gate on isImprovementEnabled').toBeGreaterThan(-1);
    expect(triggerIdx, 'manual lane must re-issue via triggerOnDemandTask(plan.taskType, plan.appId, { emit: false, origin: ON_DEMAND_ORIGINS.REFILL })').toBeGreaterThan(-1);
    expect(queueIdx, 'scheduled queue lane must still exist').toBeGreaterThan(-1);
    // Improve gate precedes the re-issue; the manual lane returns before the queue lane.
    expect(improveGateIdx).toBeLessThan(triggerIdx);
    expect(triggerIdx).toBeLessThan(queueIdx);
    const returnAfterTrigger = fnSlice.indexOf('return;', triggerIdx);
    expect(returnAfterTrigger, 'manual lane must return before falling through to the queue lane').toBeGreaterThan(-1);
    expect(returnAfterTrigger).toBeLessThan(queueIdx);
  });

  it('the on-demand spawn engine marks generated tasks on-demand and forwards ignoreTaskId to addTask', () => {
    // For the manual continuation to be recognized on completion, the on-demand
    // engine must stamp metadata.onDemand; and the completion-triggered re-issue
    // must be dedup-safe against the still-in_progress completing task, so the
    // engine's addTask must forward the dequeue's ignoreTaskId.
    const engIdx = COS_SRC.indexOf('async function spawnDequeuePriority0OnDemand');
    expect(engIdx, 'spawnDequeuePriority0OnDemand must exist').toBeGreaterThan(-1);
    const engSlice = COS_SRC.slice(engIdx, engIdx + 6400);
    expect(
      /onDemand:\s*true/.test(engSlice),
      'on-demand engine must stamp metadata.onDemand: true before addTask'
    ).toBe(true);
    expect(
      /addTask\(\s*task\s*,\s*'internal'\s*,\s*\{[\s\S]*?raw:\s*true[\s\S]*?ignoreTaskId[\s\S]*?\}\s*\)/.test(engSlice),
      'on-demand engine must forward ignoreTaskId to addTask'
    ).toBe(true);
  });

  it('an unexpired park stops the refill BEFORE it re-issues the drain (#3848)', () => {
    // The invariant that was missing: park elapse was read only by the SCHEDULED
    // lane, so a drain that had just parked itself (idle detector / no-progress /
    // drain cap) was still re-issued on the very next completion — the park meant
    // nothing on the one lane that does the re-dispatching. A human "Run Now" is
    // unaffected: applyOnDemandRunResets clears the park for a USER-origin request
    // before this lane is ever reached.
    const fnIdx = COS_SRC.indexOf('async function refillPerpetualForCompletedAgent');
    const fnSlice = COS_SRC.slice(fnIdx, fnIdx + 4600);
    const parkIdx = fnSlice.indexOf('isPerpetualParkActive(plan.taskType, plan.appId)');
    const triggerIdx = fnSlice.indexOf('triggerOnDemandTask(plan.taskType, plan.appId');
    expect(parkIdx, 'refill must consult the type+app park before re-issuing').toBeGreaterThan(-1);
    expect(parkIdx).toBeLessThan(triggerIdx);
    const returnAfterPark = fnSlice.indexOf('return;', parkIdx);
    expect(returnAfterPark, 'a live park must return, not fall through to the re-issue').toBeLessThan(triggerIdx);
  });

  it('the refill only fires on a SUCCESSFUL completion (no back-to-back spin on failures)', () => {
    // Perpetual completions skip the per-app cooldown, so refilling after a failed
    // run would spin the daemon through repeated failures (the work-detector still
    // sees the same issue as actionable). The refill must bail on a non-success
    // result and let task-retry/backoff + the recheck cadence handle failures.
    const fnIdx = COS_SRC.indexOf('async function refillPerpetualForCompletedAgent');
    const fnSlice = COS_SRC.slice(fnIdx, fnIdx + 4600);
    expect(
      /if\s*\(\s*!agent\?\.result\?\.success\s*\)\s*return/.test(fnSlice),
      'refill must early-return when the completed agent did not succeed'
    ).toBe(true);
  });

  it('refill is sequenced BEFORE dequeue in the handler (perpetual task queued before slots fill)', () => {
    // If generic dequeue ran first (or concurrently), it could claim the just-
    // freed slot with idle/mission work before the perpetual task is queued,
    // breaking the back-to-back drain. The handler must chain refill → dequeue.
    const onIdx = COS_SRC.indexOf("cosEvents.on('agent:completed'");
    const handlerSlice = COS_SRC.slice(onIdx, onIdx + 1400);
    expect(
      /refillPerpetualForCompletedAgent\(agent\)[\s\S]*\.then\(\s*\(\)\s*=>\s*dequeueNextTask\(/.test(handlerSlice),
      'handler must run dequeueNextTask in a .then() AFTER the refill resolves'
    ).toBe(true);
    // Both generators on this continuation must skip the completing task, which
    // still reads pending/in_progress until updateTask settles it (#3179): the
    // refill excludes it via queueEligibleImprovementTasks, and the dequeue's
    // idle-review tier via this argument.
    expect(
      /dequeueNextTask\(\{\s*ignoreTaskId:\s*agent\?\.taskId\s*\}\)/.test(handlerSlice),
      'the post-refill dequeue must pass the completing task id as ignoreTaskId'
    ).toBe(true);
    // The old standalone `setImmediate(() => dequeueNextTask())` must be gone —
    // its presence would race the refill.
    expect(
      handlerSlice.includes('setImmediate(() => dequeueNextTask())'),
      'the unconditional pre-refill dequeue must be removed'
    ).toBe(false);
  });
});

// Shared autonomous-queuing gate (cosState.canQueueImprovementTasks). Extracted
// from three drift-prone copies (post-startup queue, improvement-check timer,
// perpetual drain refill). Queuing requires BOTH idle-review on AND the CoS
// auto-run domain in `execute`.
describe('canQueueImprovementTasks — autonomous queuing gate', () => {
  const cfg = (idleReviewEnabled, cos) => ({
    config: { idleReviewEnabled, domainAutonomy: { cos } },
  });

  it('is true only when idle-review is on AND cos auto-run is execute', () => {
    expect(canQueueImprovementTasks(cfg(true, 'execute'))).toBe(true);
  });

  it('is false when cos auto-run is off or dry-run', () => {
    expect(canQueueImprovementTasks(cfg(true, 'off'))).toBe(false);
    expect(canQueueImprovementTasks(cfg(true, 'dry-run'))).toBe(false);
  });

  it('is false when idle-review is disabled, regardless of cos mode', () => {
    expect(canQueueImprovementTasks(cfg(false, 'execute'))).toBe(false);
  });

  it('coerces a falsy/undefined idleReviewEnabled to a boolean false', () => {
    expect(canQueueImprovementTasks(cfg(undefined, 'execute'))).toBe(false);
  });
});

describe('persistent mind — default-off CoS state integration (#5064)', () => {
  it('adds no cold-bootstrap provider work to a fresh CoS state', () => {
    expect(DEFAULT_STATE.persistentMind).toMatchObject({
      schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
      mindId: 'cos-persistent-mind',
      enabled: false,
      started: false,
      status: 'disabled',
      queuedMessages: [],
      activeTurn: null,
    });
  });

  it('suspends and re-arms the mind when the CoS autonomy mode changes', () => {
    const updateFn = extractFnBody(COS_SRC, COS_SRC.indexOf('export async function updateConfig'));
    expect(updateFn).toMatch(/mode === 'execute'[\s\S]*handlePersistentMindGlobalResume\(\)/);
    expect(updateFn).toMatch(/handlePersistentMindGlobalPause\(`CoS autonomy changed to \$\{mode\}`\)/);
  });
});

describe('pending-merge sweep — own timer, not the evaluation cadence (#3630)', () => {
  // Evaluation is event-driven (cosState.js records that the periodic
  // evaluateTasks timer was removed), so the drain inside evaluateTasks fires
  // roughly once per restart. The cadence-bearing drain is a CoS interval job.
  const sweepBlock = COS_SRC.slice(
    COS_SRC.indexOf("id: 'cos-pending-merge-sweep'"),
    COS_SRC.indexOf("id: 'cos-pending-merge-sweep'") + 1400
  );

  it('registers a cos-pending-merge-sweep interval job alongside the other CoS timers', () => {
    expect(COS_SRC).toMatch(/id:\s*'cos-pending-merge-sweep'/);
    expect(sweepBlock).toMatch(/type:\s*'interval'/);
    expect(sweepBlock).toMatch(/sweepPendingMergePrs\(\)/);
  });

  it('drives the interval off PENDING_MERGE_SWEEP_INTERVAL_MS, not a local literal', () => {
    expect(sweepBlock).toMatch(/intervalMs:\s*PENDING_MERGE_SWEEP_INTERVAL_MS/);
    expect(COS_SRC).toMatch(/PENDING_MERGE_SWEEP_INTERVAL_MS\s*\}\s*=\s*await import\('\.\/prWatcher\.js'\)/);
  });

  it('gates the sweep on !paused AND cos auto-run === execute', () => {
    expect(sweepBlock).toMatch(/s\.paused\s*\|\|\s*getDomainMode\(s\.config,\s*'cos'\)\s*!==\s*'execute'/);
  });

  it('cancels the timer with the other CoS jobs on stop()', () => {
    const stopFn = extractFnBody(COS_SRC, COS_SRC.indexOf('export async function stop'));
    expect(stopFn).toMatch(/cancelEvent\('cos-health-check'\)/);
    expect(stopFn).toMatch(/cancelEvent\('cos-pending-merge-sweep'\)/);
  });

  it('keeps the opportunistic drain in evaluateTasks so the call site cannot be deleted silently', () => {
    const evalFn = extractFnBody(GEN_SRC, GEN_SRC.indexOf('export async function evaluateTasks'));
    expect(evalFn).toMatch(/sweepPendingMergePrs\(\)/);
    expect(evalFn).toMatch(/!paused && getDomainMode\(state\.config, 'cos'\) === 'execute'/);
  });

  it('does NOT re-couple the drain to the pr-watcher task type', () => {
    const watcherFn = extractFnBody(GEN_SRC, GEN_SRC.indexOf('async function resolvePrWatcherBlock'));
    expect(watcherFn).not.toMatch(/sweepPendingMergePrs\(/);
  });

  it('maps MAX_PENDING_MERGE_TICKS back to wall-clock hours', () => {
    const hours = (PENDING_MERGE_SWEEP_INTERVAL_MS * MAX_PENDING_MERGE_TICKS) / (60 * 60 * 1000);
    expect(PENDING_MERGE_SWEEP_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(hours).toBe(6);
  });
});

describe('CoS startup — single-flight recovery', () => {
  it('shares the full boot promise across concurrent start callers', () => {
    expect(COS_SRC).toMatch(/let daemonStartPromise = null/);
    expect(COS_SRC).toMatch(/daemonStartPromise = runStart\(\)\.finally\(\(\) => \{\s*daemonStartPromise = null;/);
    expect(COS_SRC).toMatch(/export function start\(\) \{[\s\S]*?return daemonStartPromise;\s*\}/);
  });
});
