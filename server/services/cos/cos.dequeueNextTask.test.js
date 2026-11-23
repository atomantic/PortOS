/**
 * Behavioral coverage for the two spawn entry points in cos.js:
 *
 *  - `dequeueNextTask` — P0 on-demand bypasses the global pause, a saturated
 *    pool short-circuits before any tier runs, and tiers drain in precedence
 *    order against one shared slot budget.
 *  - `forceSpawnTask` — "Run now" answers with an error (never a false
 *    `success`) and emits no `task:ready` for a stopped daemon, an unresolvable
 *    provider, or a full local endpoint.
 *
 * Drives the real functions; only the on-demand drain, the provider/endpoint
 * resolvers and the state/task readers are doubled. Own file because these
 * module-wide mocks would replace helpers cos.test.js exercises for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: null,
  daemonRunning: true,
  onDemand: [],
  userPending: [],
  autoApproved: [],
  drainCalls: 0,
  task: null,
  resolution: { ok: true, provider: { id: 'cloud-cli', type: 'cli' } },
  localCapacityError: null,
}));

vi.mock('./cosState.js', async (importActual) => ({
  ...(await importActual()),
  isDaemonRunning: () => mocks.daemonRunning,
  loadState: async () => structuredClone(mocks.state),
  saveState: async () => {},
  withStateLock: async (fn) => fn(),
}));
vi.mock('./cosTaskStore.js', async (importActual) => ({
  ...(await importActual()),
  getTaskById: async () => mocks.task,
  getUserTasks: async () => ({ exists: true, grouped: { pending: mocks.userPending } }),
  getCosTasks: async () => ({
    exists: true,
    autoApproved: mocks.autoApproved,
    awaitingApproval: [],
    grouped: { pending: mocks.autoApproved, blocked: [] },
  }),
}));
// Mirrors the shared drain's contract with its caller: stop at exhausted
// capacity, skip a denied task, emit an admitted one.
vi.mock('../onDemandDrain.js', () => ({
  drainOnDemandRequests: async (_ctx, deps) => {
    mocks.drainCalls += 1;
    for (const task of mocks.onDemand) {
      if (deps.capacityExhausted()) break;
      if (!deps.canSpawn(task)) continue;
      deps.emitSpawn(task);
    }
    return { schedule: { tasks: { enabled: { enabled: true } } } };
  },
}));
vi.mock('../domainUsage.js', async (importActual) => ({
  ...(await importActual()),
  getDomainBudgetStatus: async () => ({ exceeded: null, budget: {}, usage: {} }),
}));
vi.mock('../instanceIdentity.js', async (importActual) => ({
  ...(await importActual()),
  ensureInstanceId: async () => 'instance-a',
}));
vi.mock('../appActivity.js', async (importActual) => ({
  ...(await importActual()),
  isAppOnCooldown: async () => false,
}));
vi.mock('../featureAgents.js', async (importActual) => ({
  ...(await importActual()),
  getDueFeatureAgents: async () => [],
}));
vi.mock('../agent/agentProviderResolution.js', () => ({
  resolveAgentProviderAndModel: vi.fn(async () => mocks.resolution),
}));
vi.mock('./cosLocalEndpointSlots.js', async (importActual) => ({
  ...(await importActual()),
  buildLocalEndpointSlotContext: async () => ({
    endpointForAgent: () => null,
    resolveLocalEndpoint: () => null,
    limit: Infinity,
  }),
  localEndpointCapacityError: vi.fn(async () => mocks.localCapacityError),
}));

const { dequeueNextTask, forceSpawnTask } = await import('./cos.js');
const { cosEvents } = await import('./cosEvents.js');
const { setUseRunner, useRunner } = await import('../agent/agentState.js');

const originalUseRunner = useRunner;
const pendingTask = (id, metadata = {}) => ({
  id, status: 'pending', approvalRequired: false, taskType: 'user', metadata,
});
const readyIds = (emit) => emit.mock.calls.filter(([event]) => event === 'task:ready').map(([, task]) => task.id);

let emit;

beforeEach(() => {
  setUseRunner(false);
  mocks.daemonRunning = true;
  mocks.drainCalls = 0;
  mocks.onDemand = [];
  mocks.userPending = [];
  mocks.autoApproved = [];
  mocks.task = pendingTask('task-run-now');
  mocks.resolution = { ok: true, provider: { id: 'cloud-cli', type: 'cli' } };
  mocks.localCapacityError = null;
  mocks.state = {
    paused: false,
    agents: {},
    stats: {},
    config: {
      maxConcurrentAgents: 5,
      maxConcurrentAgentsPerProject: 5,
      appReviewCooldownMs: 0,
      idleReviewEnabled: false,
      domainAutonomy: { cos: 'execute' },
    },
  };
  emit = vi.spyOn(cosEvents, 'emit');
});

afterEach(() => {
  emit.mockRestore();
  setUseRunner(originalUseRunner);
});

describe('dequeueNextTask — behavior', () => {
  it('admits tiers in precedence order: on-demand, then user, then auto-approved', async () => {
    mocks.onDemand = [pendingTask('od-1')];
    mocks.userPending = [pendingTask('user-1')];
    mocks.autoApproved = [pendingTask('sys-1', { analysisType: 'enabled' })];

    await dequeueNextTask();

    expect(readyIds(emit)).toEqual(['od-1', 'user-1', 'sys-1']);
  });

  it('spends one slot budget across tiers, so a lower tier is cut when higher ones fill it', async () => {
    mocks.state.config.maxConcurrentAgents = 2;
    mocks.onDemand = [pendingTask('od-1')];
    mocks.userPending = [pendingTask('user-1'), pendingTask('user-2')];
    mocks.autoApproved = [pendingTask('sys-1', { analysisType: 'enabled' })];

    await dequeueNextTask();

    expect(readyIds(emit)).toEqual(['od-1', 'user-1']);
  });

  it('a P0 on-demand request still fires while the daemon is globally paused; every lower tier is withheld', async () => {
    mocks.state.paused = true;
    mocks.onDemand = [pendingTask('od-1')];
    mocks.userPending = [pendingTask('user-1')];
    mocks.autoApproved = [pendingTask('sys-1', { analysisType: 'enabled' })];

    await dequeueNextTask();

    expect(readyIds(emit)).toEqual(['od-1']);
  });

  it('short-circuits before any tier runs when running agents saturate the cap', async () => {
    mocks.state.config.maxConcurrentAgents = 1;
    mocks.state.agents = { 'agent-0': { status: 'running', metadata: {} } };
    mocks.onDemand = [pendingTask('od-1')];
    mocks.userPending = [pendingTask('user-1')];

    await dequeueNextTask();

    expect(mocks.drainCalls).toBe(0);
    expect(readyIds(emit)).toEqual([]);
  });

  it('short-circuits when the cap is over-saturated (shrunk below current load)', async () => {
    mocks.state.config.maxConcurrentAgents = 1;
    mocks.state.agents = {
      'agent-0': { status: 'running', metadata: {} },
      'agent-1': { status: 'running', metadata: {} },
    };
    mocks.userPending = [pendingTask('user-1')];

    await dequeueNextTask();

    expect(mocks.drainCalls).toBe(0);
    expect(readyIds(emit)).toEqual([]);
  });

  it('does nothing while the daemon is stopped', async () => {
    mocks.daemonRunning = false;
    mocks.onDemand = [pendingTask('od-1')];

    await dequeueNextTask();

    expect(mocks.drainCalls).toBe(0);
    expect(readyIds(emit)).toEqual([]);
  });
});

describe('forceSpawnTask — refusals emit no task:ready', () => {
  it('spawns a pending task when everything resolves (control)', async () => {
    const result = await forceSpawnTask('task-run-now');

    expect(result.error).toBeUndefined();
    expect(readyIds(emit)).toEqual(['task-run-now']);
  });

  it('refuses while the daemon is stopped', async () => {
    mocks.daemonRunning = false;

    const result = await forceSpawnTask('task-run-now');

    expect(result.error).toMatch(/daemon is stopped/);
    expect(readyIds(emit)).toEqual([]);
  });

  it('returns the provider-resolution error instead of a false success', async () => {
    mocks.resolution = { ok: false, error: 'Provider "api-only" has no file-writing harness' };

    const result = await forceSpawnTask('task-run-now');

    expect(result).toEqual({ error: 'Provider "api-only" has no file-writing harness' });
    expect(readyIds(emit)).toEqual([]);
  });

  it('refuses when the resolved provider\'s local endpoint is full', async () => {
    mocks.localCapacityError = 'Local endpoint localhost:1234 is at capacity (1/1)';

    const result = await forceSpawnTask('task-run-now');

    expect(result).toEqual({ error: 'Local endpoint localhost:1234 is at capacity (1/1)' });
    expect(readyIds(emit)).toEqual([]);
  });
});
