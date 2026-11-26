/**
 * Tests for cos.js internals around agent spawning: the real capacity tracker
 * (`createDequeueCapacity`, global / per-project / per-local-endpoint caps), the
 * local-endpoint slot resolvers, orphan recovery, and perpetual refill.
 *
 * `dequeueNextTask` / `forceSpawnTask` behavior (tier precedence, pause bypass,
 * saturated-pool short-circuit, Run-now refusals) is driven through the real
 * functions in cos.dequeueNextTask.test.js. The `admit` helper below only feeds
 * tasks to the real tracker; it carries no scheduler logic of its own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isPerpetualRefillCandidate, perpetualRefillPlan, resetOrphanedTasks } from './cos.js';
import { registerCosOrphanRecoveryHandlers } from '../bootHookRegistry.js';
import { firstLine } from './cosTaskStore.js';
import { retryHoldMetadata, RETRY_HOLD_GRACE_MS } from '../../lib/taskRetryHold.js';
import { canQueueImprovementTasks, DEFAULT_STATE } from './cosState.js';
import { createDequeueCapacity, countRunningAgentsByLocalEndpoint, isUserTaskRunnableUnattended } from './cosDequeue.js';
import { parseTasksMarkdown } from '../../lib/legacyTaskMarkdown.js';
import { storedForm } from '../../lib/cos/cosTaskRows.js';
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
import { PENDING_MERGE_SWEEP_INTERVAL_MS, MAX_PENDING_MERGE_TICKS } from '../prWatcher.js';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../../lib/persistent/persistentMind.js';

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
 * Offer `tasks` to the REAL capacity tracker in order and return the ones it
 * admitted. No tier logic lives here — tier precedence and pause handling are
 * driven through the real `dequeueNextTask` in cos.dequeueNextTask.test.js.
 * `committed` selects `canSpawnCommitted`, the variant the on-demand and idle
 * tiers use to opt out of the local-endpoint cap.
 */
function admit(capacity, tasks, { committed = false } = {}) {
  const admitted = [];
  for (const candidate of tasks) {
    if (capacity.spawned >= capacity.availableSlots) break;
    if (!(committed ? capacity.canSpawnCommitted(candidate) : capacity.canSpawn(candidate))) continue;
    capacity.trackSpawn(candidate);
    admitted.push(candidate);
  }
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

// resetOrphanedTasks reaches agentManagement (spied below) only through the handlers bootHooks.js registers at boot.
const loadAgentManagement = () => import('../agent/agentManagement.js');
registerCosOrphanRecoveryHandlers({
  cleanupOrphanedAgents: async (...args) => (await loadAgentManagement()).cleanupOrphanedAgents(...args),
  handleOrphanedTask: async (...args) => (await loadAgentManagement()).handleOrphanedTask(...args),
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
      idle: [],
    };
    const spawned = admit(capacity, Object.values(buckets).flat());
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

    const buckets = { onDemand: [], user: [task('task-user-1')], autoSystem: [], idle: [] };
    expect(admit(capacity, Object.values(buckets).flat())).toEqual([]);
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
      idle: [],
    };

    const spawned = admit(capacity, Object.values(buckets).flat());
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
      idle: [],
    };

    const spawned = admit(capacity, Object.values(buckets).flat());
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
      idle: [],
    };

    expect(admit(capacity, Object.values(buckets).flat())).toHaveLength(3);
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
      idle: [],
    };

    const spawned = admit(capacity, Object.values(buckets).flat());
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

describe('dequeueNextTask — task ownership beyond registered agents (#11847)', () => {
  it('never admits an in-flight spawn, and still counts it against the global slots', () => {
    // 4-slot cap: 1 running agent + 2 spawns in flight (no agent record yet)
    // leaves one real slot, which the queued task — not the in-flight ones — gets.
    const state = makeState({ maxConcurrentAgents: 4, runningAgents: [makeRunningAgent()] });
    const capacity = createDequeueCapacity(state, { inFlightTaskIds: new Set(['spawning-a', 'spawning-b']) });
    expect(capacity.availableSlots).toBe(1);

    const buckets = {
      onDemand: [],
      user: [task('spawning-a'), task('spawning-b'), task('queued-c'), task('queued-d')],
      autoSystem: [],
      idle: [],
    };
    expect(admit(capacity, Object.values(buckets).flat()).map(t => t.id)).toEqual(['queued-c']);
  });

  it('admits nothing when running agents plus in-flight spawns fill maxConcurrentAgents', () => {
    const state = makeState({ maxConcurrentAgents: 2, runningAgents: [makeRunningAgent()] });
    const capacity = createDequeueCapacity(state, { inFlightTaskIds: ['spawning-a'] });
    expect(capacity.availableSlots).toBe(0);
    expect(admit(capacity, [task('queued-b')])).toEqual([]);
  });

  it('does not double-count an in-flight spawn whose agent is already running', () => {
    const state = makeState({
      maxConcurrentAgents: 3,
      runningAgents: [{ ...makeRunningAgent(), taskId: 'spawning-a' }],
    });
    const capacity = createDequeueCapacity(state, { inFlightTaskIds: ['spawning-a'] });
    expect(capacity.availableSlots).toBe(2);
  });

  it('admits a task id at most once per cycle across tiers', () => {
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = createDequeueCapacity(state, {});
    const buckets = {
      onDemand: [task('dup-1')],
      user: [task('dup-1'), task('user-2')],
      autoSystem: [task('dup-1'), task('user-2'), task('sys-3')],
      idle: [],
    };
    expect(admit(capacity, Object.values(buckets).flat()).map(t => t.id)).toEqual(['dup-1', 'user-2', 'sys-3']);
    expect(capacity.spawnedTaskIds).toEqual(['dup-1', 'user-2', 'sys-3']);
    expect(capacity.spawned).toBe(3);
  });
});

describe('dequeueNextTask — per-local-endpoint agent cap (#4834)', () => {
  it('serializes two queued tasks that resolve to the SAME local endpoint', () => {
    // Global cap 5, nothing running: both tasks clear the global and
    // per-project guards. Only the local-endpoint slot separates them.
    const state = makeState({ maxConcurrentAgents: 5 });
    const { capacity, holds } = makeLocalSlotCapacity(state);

    const spawned = admit(capacity, [
      taskOnProvider('task-local-1', 'lmstudio-tui'),
      taskOnProvider('task-local-2', 'lmstudio-tui'),
    ]);

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

    const spawned = admit(capacity, [taskOnProvider('task-run-now', 'lmstudio-tui')], { committed: true });

    expect(spawned.map(t => t.id)).toEqual(['task-run-now']);
    expect(holds).toEqual([]);
  });

  it('does NOT suppress an idle task at a saturated endpoint', () => {
    // The idle tier commits before canSpawn and never persists: it has already
    // bound the app-review marker and advanced its 30-minute cooldown. A denial
    // would strand it; the chokepoint's hold at least releases the marker.
    const state = makeState({
      maxConcurrentAgents: 5,
      runningAgents: [makeRunningAgentOnProvider('lmstudio-tui')],
    });
    const { capacity } = makeLocalSlotCapacity(state);

    const spawned = admit(capacity, [taskOnProvider('idle-task', 'lmstudio-tui')], { committed: true });

    expect(spawned.map(t => t.id)).toEqual(['idle-task']);
  });

  it('keeps gating the deferrable user and auto-approved tiers at the same endpoint', () => {
    // The opt-out is scoped to the tiers whose denial is destructive. A task
    // from a persisted queue stays queued, which is a real defer — the next
    // cycle re-picks it once the endpoint frees up.
    const state = makeState({
      maxConcurrentAgents: 5,
      runningAgents: [makeRunningAgentOnProvider('lmstudio-tui')],
    });
    const { capacity } = makeLocalSlotCapacity(state);

    const spawned = admit(capacity, [taskOnProvider('deferrable-task', 'lmstudio-tui')]);

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

    const spawned = admit(capacity, [taskOnProvider('task-local-1', 'lmstudio-tui')]);

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

    const spawned = admit(capacity, [
      taskOnProvider('task-cloud', 'anthropic'),
      taskOnProvider('task-bare-cli', 'claude-cli'),
      taskOnProvider('task-cloud-2', 'anthropic'),
    ]);

    expect(spawned.map(t => t.id)).toEqual(['task-cloud', 'task-bare-cli', 'task-cloud-2']);
    expect(holds).toEqual([]);
  });

  it('runs two DISTINCT local endpoints in parallel', () => {
    // Keyed by endpoint, not by "is local" — two separate local servers each
    // get their own slot.
    const state = makeState({ maxConcurrentAgents: 5 });
    const { capacity } = makeLocalSlotCapacity(state);

    const spawned = admit(capacity, [
      taskOnProvider('task-lmstudio', 'lmstudio-tui'),
      taskOnProvider('task-ollama', 'ollama-local'),
    ]);

    expect(spawned.map(t => t.id)).toEqual(['task-lmstudio', 'task-ollama']);
  });

  it('honors a lifted limit (LOCAL_LLM_MAX_CONCURRENCY > 1)', () => {
    const state = makeState({ maxConcurrentAgents: 5 });
    const { capacity, holds } = makeLocalSlotCapacity(state, { limit: 2 });

    const spawned = admit(capacity, [
      taskOnProvider('task-local-1', 'lmstudio-tui'),
      taskOnProvider('task-local-2', 'lmstudio-tui'),
      taskOnProvider('task-local-3', 'lmstudio-tui'),
    ]);

    expect(spawned.map(t => t.id)).toEqual(['task-local-1', 'task-local-2']);
    expect(holds.map(h => h.taskId)).toEqual(['task-local-3']);
  });

  it('gates UNPINNED tasks by the ACTIVE provider endpoint', () => {
    // A task with no `metadata.provider` runs on the active provider — when
    // that is local, the cap applies to it too.
    const state = makeState({ maxConcurrentAgents: 5 });
    const { capacity } = makeLocalSlotCapacity(state, { activeProvider: LOCAL_TUI_PROVIDER });

    const spawned = admit(capacity, [
      taskOnProvider('task-unpinned-1'),
      taskOnProvider('task-unpinned-2'),
    ]);

    expect(spawned.map(t => t.id)).toEqual(['task-unpinned-1']);
  });

  it('falls back to the active provider for an UNKNOWN pinned id (mirrors spawn)', () => {
    // resolveAgentProviderAndModel logs and uses the active provider when the
    // pinned id is missing; the gate must predict the same landing spot.
    const state = makeState({ maxConcurrentAgents: 5 });
    const { capacity, holds } = makeLocalSlotCapacity(state, { activeProvider: LOCAL_TUI_PROVIDER });

    const spawned = admit(capacity, [
      taskOnProvider('task-local-1', 'lmstudio-tui'),
      taskOnProvider('task-ghost', 'deleted-provider'),
    ]);

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
    expect(admit(capacity, [
      taskOnProvider('task-a', 'lmstudio-tui'),
      taskOnProvider('task-b', 'lmstudio-tui'),
    ])).toHaveLength(2);
  });

  it('floors a 0/NaN limit at 1 rather than wedging the queue forever', () => {
    const state = makeState({ maxConcurrentAgents: 5 });
    const slots = createLocalEndpointSlotContext({ providers: ALL_PROVIDERS, activeProvider: CLOUD_PROVIDER, limit: 0 });
    const capacity = createDequeueCapacity(state, {
      localEndpointLimit: slots.limit,
      resolveLocalEndpoint: slots.resolveLocalEndpoint,
    });
    expect(capacity.localEndpointLimit).toBe(1);
    expect(admit(capacity, [
      taskOnProvider('task-a', 'lmstudio-tui'),
      taskOnProvider('task-b', 'lmstudio-tui'),
    ]).map(t => t.id)).toEqual(['task-a']);
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
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, 12)).toBe(13);
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, '12')).toBe(13);
  });

  it('does not lift the harness cap for a local inference endpoint', () => {
    expect(cloudSwarmThreadCapacity(LOCAL_TUI_PROVIDER, 12)).toBeNull();
  });

  it('does not override the harness outside a valid multi-worker swarm', () => {
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, 1)).toBeNull();
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, 2.5)).toBeNull();
    expect(cloudSwarmThreadCapacity(CLOUD_PROVIDER, 13)).toBeNull();
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

    const spawned = admit(capacity, [taskOnProvider('task-local-1', 'lmstudio-tui')]);
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
    // Run now is the recovery for an agent whose PTY died without a close
    // handler. Counting the task's own stale record would make that recovery
    // unreachable at a limit of 1.
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

describe('legacy user-row admission', () => {
  // Read a legacy row the way migration 018 does, store it in the USER queue, and
  // return the approval flags the stored row carries.
  const healedUserRow = (line) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [parsed] = parseTasksMarkdown(`# Tasks\n\n## Pending\n${line}\n`);
    const healed = storedForm(parsed, 'user');
    warn.mockRestore();
    return { approvalRequired: healed.approvalRequired, autoApproved: healed.autoApproved };
  };

  it('admission predicate withholds a recovered row after a legacy round trip (#7300, #7367)', () => {
    // A user row parses auto-approved unless the parser took its RECOVERY path,
    // which cannot tell a genuine legacy row from a task-shaped sentence inside a
    // legacy multi-line description body. This tier otherwise spawns every pending
    // row, so without the predicate that sentence becomes an unattended agent run.
    const state = makeState({ maxConcurrentAgents: 5 });
    const capacity = makeCapacityTracker(state);

    const buckets = {
      onDemand: [],
      user: [
        { ...task('task-note'), autoApproved: false },
        // The same hold as it comes back OFF DISK. Round-tripped through the real
        // writer and parser rather than hand-stamped, because the defect (#7367)
        // was exactly there: the user file used to emit no flag, the recovered row
        // healed into an ordinary strict row, and the next read spawned an agent
        // from it. A hand-built fixture would have kept passing through all of it.
        { ...task('task-healed'), ...healedUserRow('- [ ] #task-healed | URGENT | legacy user row') },
        { ...task('task-real'), autoApproved: true },
        task('task-fieldless'),
      ],
      autoSystem: [],
      idle: [],
    };

    // `undefined` is not a hold — a row that never carried the field still runs,
    // so the guard narrows nothing that was already running.
    expect(admit(capacity, buckets.user.filter(isUserTaskRunnableUnattended)).map(t => t.id)).toEqual(['task-real', 'task-fieldless']);
  });
});

describe('resetOrphanedTasks — latest run outcome (#12057)', () => {
  let taskStore;
  let agentManagement;
  const taskId = 'task-rerun';
  const older = {
    id: 'agent-older', taskId, status: 'completed', result: { success: true },
    startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z',
  };
  const latest = {
    id: 'agent-latest', taskId, status: 'completed', result: { success: false },
    startedAt: '2026-01-01T01:00:00Z', completedAt: '2026-01-01T01:01:00Z',
    metadata: { worktreePath: '/synthetic/resume-worktree', branch: 'resume-branch' },
  };

  beforeEach(async () => {
    const state = await import('./cosState.js');
    taskStore = await import('./cosTaskStore.js');
    const identity = await import('../instanceIdentity.js');
    agentManagement = await import('../agent/agentManagement.js');
    // Put the older run last in the map: chronology, not insertion order,
    // determines which run can settle this task.
    vi.spyOn(state, 'loadState').mockResolvedValue({ agents: { latest, older } });
    vi.spyOn(identity, 'ensureInstanceId').mockResolvedValue('synthetic-instance');
    vi.spyOn(taskStore, 'getAllTasks').mockResolvedValue({
      user: { grouped: { in_progress: [{ id: taskId, status: 'in_progress', metadata: {} }] } },
      cos: { grouped: {} },
    });
    vi.spyOn(taskStore, 'updateTask').mockResolvedValue({});
    vi.spyOn(agentManagement, 'handleOrphanedTask').mockResolvedValue({});
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T02:00:00Z'));
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])('leaves durable cleanup handoffs to verification during boot=%s', async bootRecovery => {
    taskStore.getAllTasks.mockResolvedValue({ user: { grouped: { in_progress: [{ id: taskId,
      status: 'in_progress', metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: latest.id } }] } }, cos: { grouped: {} } });
    await resetOrphanedTasks({ bootRecovery });
    expect(taskStore.updateTask).not.toHaveBeenCalled();
    expect(agentManagement.handleOrphanedTask).not.toHaveBeenCalled();
  });

  it('recovers the latest failed rerun despite an older successful run', async () => {
    await resetOrphanedTasks();

    expect(taskStore.updateTask).not.toHaveBeenCalled();
    expect(agentManagement.handleOrphanedTask).toHaveBeenCalledExactlyOnceWith(
      taskId, latest.id, taskStore.getTaskById,
      { agentMetadata: latest.metadata, agentStartedAt: latest.startedAt }
    );
  });

  it('completes a missed task update when the latest run succeeded', async () => {
    const state = await import('./cosState.js');
    state.loadState.mockResolvedValue({ agents: { latest: { ...latest, result: { success: true } }, older } });

    await resetOrphanedTasks();

    expect(taskStore.updateTask).toHaveBeenCalledExactlyOnceWith(taskId, { status: 'completed' }, 'user');
    expect(agentManagement.handleOrphanedTask).not.toHaveBeenCalled();
  });

  it('preserves active and capacity-waiting preflight cards before reaping an idle local orphan', async () => {
    const { beginPreflightActivity } = await import('../preflightActivity.js');
    const store = await import('../taskScheduleStore.js');
    const card = { id: 'preflight-demand-1', status: 'in_progress', description: 'Preparing', priority: 'HIGH', metadata: {
      machineLocal: true, preflight: { requestId: 'demand-1', taskType: 'branch-reconcile', phase: 'queued',
        updatedAt: '2026-01-01T01:00:00Z', steps: [{ key: 'queued', status: 'active' }] },
    } };
    let queue = [{ id: 'demand-1' }];
    vi.spyOn(store, 'updateSchedule').mockImplementation(async fn => (await fn({ onDemandRequests: queue })).result);
    vi.spyOn(taskStore, 'getTaskById').mockResolvedValue(card);
    taskStore.getAllTasks.mockResolvedValue({ user: { grouped: { in_progress: [] } }, cos: { grouped: { in_progress: [card] } } });
    const end = beginPreflightActivity(card.id);
    try {
      await resetOrphanedTasks();
      expect(taskStore.updateTask).not.toHaveBeenCalled();
    } finally { end(); }
    await resetOrphanedTasks();
    expect(taskStore.updateTask).not.toHaveBeenCalled();
    queue = [];
    await resetOrphanedTasks();
    expect(taskStore.updateTask).toHaveBeenCalledWith(card.id, expect.objectContaining({ status: 'completed' }), 'internal',
      expect.objectContaining({ expectedStatus: 'in_progress' }));
  });

  // A failed run's retry is held non-spawnable (#3373) while its worktree cleanup
  // resolves the resume pointer. A live hold must be left alone; a stale one (the
  // arming process died) is handed to handleOrphanedTask.
  describe('retry holds (#3373)', () => {
    const setHeld = async (metadata) => taskStore.getAllTasks.mockResolvedValue({
      user: { grouped: { in_progress: [{ id: taskId, status: 'in_progress', metadata }] } }, cos: { grouped: {} },
    });
    const now = Date.parse('2026-01-01T02:00:00Z');
    const failedLatest = { ...latest, result: { success: false } };

    it('skips a live hold', async () => {
      await setHeld(retryHoldMetadata(latest.id, now - 60_000));
      await resetOrphanedTasks();
      expect(agentManagement.handleOrphanedTask).not.toHaveBeenCalled();
      expect(taskStore.updateTask).not.toHaveBeenCalled();
    });

    it('recovers a stale hold through the orphan handler', async () => {
      await setHeld(retryHoldMetadata(latest.id, now - RETRY_HOLD_GRACE_MS - 1000));
      await resetOrphanedTasks();
      expect(agentManagement.handleOrphanedTask).toHaveBeenCalledExactlyOnceWith(
        taskId, latest.id, taskStore.getTaskById, expect.any(Object));
    });

    it('recovers a live hold immediately on the boot pass', async () => {
      await setHeld(retryHoldMetadata(latest.id, now - 1000));
      await resetOrphanedTasks({ bootRecovery: true });
      expect(agentManagement.handleOrphanedTask).toHaveBeenCalledExactlyOnceWith(
        taskId, latest.id, taskStore.getTaskById, expect.any(Object));
    });

    it('lets a recoverable hold bypass the recently-completed grace, but not an unheld task', async () => {
      const state = await import('./cosState.js');
      const justCompleted = { ...failedLatest, completedAt: new Date(now - 5000).toISOString() };
      state.loadState.mockResolvedValue({ agents: { latest: justCompleted } });

      await setHeld(retryHoldMetadata(latest.id, now - 1000));
      await resetOrphanedTasks({ bootRecovery: true });
      expect(agentManagement.handleOrphanedTask).toHaveBeenCalledTimes(1);

      agentManagement.handleOrphanedTask.mockClear();
      await setHeld({});
      await resetOrphanedTasks({ bootRecovery: true });
      expect(agentManagement.handleOrphanedTask).not.toHaveBeenCalled();
    });
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
    // the stored form flattens it to one line. Without first-line
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
      'claim-issue': { type: 'on-demand', perpetual: true, enabled: true },
      'claim-issue-disabled': { type: 'on-demand', perpetual: true, enabled: false },
      // A cron cadence carrying the same flag drains identically — the lane is
      // chosen by `perpetual`, never by the cadence type or the task's name.
      'branch-reconcile': { type: 'cron', cronExpression: '0 3 * * *', perpetual: true, enabled: true },
      'plan-task': { type: 'cron', cronExpression: '0 7 * * *', enabled: true },
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

  it('is true for an enabled cron-scheduled perpetual drain', () => {
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
      'claim-issue': { type: 'on-demand', perpetual: true, enabled: true },
      'claim-issue-disabled': { type: 'on-demand', perpetual: true, enabled: false },
      // A cron cadence carrying the same flag drains identically — the lane is
      // chosen by `perpetual`, never by the cadence type or the task's name.
      'branch-reconcile': { type: 'cron', cronExpression: '0 3 * * *', perpetual: true, enabled: true },
      'plan-task': { type: 'cron', cronExpression: '0 7 * * *', enabled: true },
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

  it('does not refill an app-less branch-reconcile drain (its completion has no repository target)', () => {
    expect(perpetualRefillPlan(agent({ taskAnalysisType: 'branch-reconcile', taskOnDemand: true, taskApp: null }), schedule))
      .toEqual({ lane: 'skip' });
  });

  it('routes a cron-scheduled perpetual drain to the on-demand lane when the run was manual', () => {
    expect(perpetualRefillPlan(
      agent({ taskAnalysisType: 'branch-reconcile', taskOnDemand: true, taskApp: 'app-1' }),
      schedule,
    )).toEqual({ lane: 'onDemand', taskType: 'branch-reconcile', appId: 'app-1' });
  });

  it('continues a manual branch sweep with recurring dispatch disabled, preserving other one-shot boundaries', () => {
    const oneShot = { tasks: { 'branch-reconcile': { enabled: true, perpetual: false } } };
    const manual = { taskAnalysisType: 'branch-reconcile', taskOnDemand: true, taskApp: 'app-1' };
    for (const taskOnDemandOrigin of ['user', 'refill']) {
      expect(perpetualRefillPlan(agent({ ...manual, taskOnDemandOrigin }), oneShot))
        .toEqual({ lane: 'onDemand', taskType: 'branch-reconcile', appId: 'app-1' });
    }
    for (const taskOnDemandOrigin of ['quota-burn', 'unknown']) {
      expect(perpetualRefillPlan(agent({ ...manual, taskOnDemandOrigin }), oneShot)).toEqual({ lane: 'skip' });
    }
    expect(perpetualRefillPlan(agent({ ...manual, taskOnDemand: false }), oneShot)).toEqual({ lane: 'skip' });
    oneShot.tasks['branch-reconcile'].enabled = false;
    expect(perpetualRefillPlan(agent(manual), oneShot)).toEqual({ lane: 'skip' });
  });

  it('a manual run with no app resolves appId to null (global on-demand re-issue)', () => {
    expect(perpetualRefillPlan(
      agent({ taskAnalysisType: 'claim-issue', taskOnDemand: true }),
      schedule,
    )).toEqual({ lane: 'onDemand', taskType: 'claim-issue', appId: null });
  });

  it('does not refill a run that was narrowed to one pull request', () => {
    expect(perpetualRefillPlan(
      agent({ taskAnalysisType: 'claim-issue', taskOnDemand: true, taskApp: 'app-42', taskTargetPullRequest: 17 }),
      schedule,
    )).toEqual({ lane: 'skip' });
  });

  it('does not refill a QUOTA BURN run — a burn invokes exactly one unit', () => {
    // The burn has its own continuation (quotaBurnRunner#onBurnAgentCompleted)
    // behind the window/reserve/cap ladder. Letting the perpetual drain refill
    // too would walk the whole backlog outside every one of those gates, on the
    // very subscription the plan was rationing.
    expect(perpetualRefillPlan(
      agent({ taskAnalysisType: 'claim-issue', taskApp: 'app-42', taskOnDemand: true, taskOnDemandOrigin: 'quota-burn' }),
      schedule,
    )).toEqual({ lane: 'skip' });
  });

  it('does not refill an UNKNOWN on-demand origin either — the lane allowlist fails closed', () => {
    // The rule is an allowlist, not a list of exclusions: an automated origin
    // added later must stop after one unit by default rather than silently
    // acquiring a human Run's drain.
    expect(perpetualRefillPlan(
      agent({ taskAnalysisType: 'claim-issue', taskOnDemand: true, taskOnDemandOrigin: 'some-future-automation' }),
      schedule,
    )).toEqual({ lane: 'skip' });
  });

  it('treats an unrecorded origin as a human Run (tasks queued before the field existed)', () => {
    expect(perpetualRefillPlan(
      agent({ taskAnalysisType: 'claim-issue', taskOnDemand: true, taskApp: 'app-42' }),
      schedule,
    )).toEqual({ lane: 'onDemand', taskType: 'claim-issue', appId: 'app-42' });
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

});

describe('pending-merge sweep cadence (#3630)', () => {
  it('maps MAX_PENDING_MERGE_TICKS back to wall-clock hours', () => {
    const hours = (PENDING_MERGE_SWEEP_INTERVAL_MS * MAX_PENDING_MERGE_TICKS) / (60 * 60 * 1000);
    expect(PENDING_MERGE_SWEEP_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(hours).toBe(6);
  });
});
