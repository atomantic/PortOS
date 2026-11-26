/**
 * Scheduler entry points share the same task and capacity fixtures. The tests
 * observe task:ready dispatch, merge-sweep calls, and real tasks:changed wakes.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

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
  localEndpoint: null,
  sweep: vi.fn(async () => ({ merged: 0, escalated: 0, timedOut: 0 })),
  retryInvestigation: vi.fn(async () => {}),
}));

vi.mock('./cosState.js', async (importActual) => ({
  ...(await importActual()),
  isDaemonRunning: () => mocks.daemonRunning,
  ensureDirectories: async () => {},
  loadState: async () => structuredClone(mocks.state),
  saveState: async () => {},
  withStateLock: async (fn) => fn(),
}));
vi.mock('./cosTaskStore.js', async (importActual) => ({
  ...(await importActual()),
  getTaskById: async () => mocks.task,
  getUserTasks: async () => ({ exists: true, grouped: { pending: mocks.userPending } }),
  getAllTasks: async () => ({
    user: { exists: true, grouped: { pending: mocks.userPending } },
    cos: { exists: true, autoApproved: mocks.autoApproved, grouped: { pending: mocks.autoApproved, blocked: [] } },
  }),
  reconcileLegacyForgeMaintenanceTasks: async () => ({ recovered: 0, retired: 0 }),
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
    endpointForAgent: () => mocks.localEndpoint,
    resolveLocalEndpoint: () => mocks.localEndpoint,
    limit: 1,
  }),
  localEndpointCapacityError: vi.fn(async () => mocks.localCapacityError),
}));

vi.mock('../prWatcher.js', async original => ({ ...await original(), sweepPendingMergePrs: mocks.sweep }));
vi.mock('../investigationRetry.js', async original => ({ ...await original(), retryTasksResolvedByInvestigation: mocks.retryInvestigation }));
vi.mock('../investigationDependencyWait.js', () => ({
  bindInvestigationDependencyEvents: vi.fn(),
  reconcileInvestigationDependencies: vi.fn(async () => {}),
}));

const { evaluateTasks } = await import('./cosTaskGenerator.js');
const { maintenance } = await import('../../lib/maintenanceAdmission.js');
const { dequeueNextTask, forceSpawnTask, init } = await import('./cos.js');
const { cosEvents } = await import('./cosEvents.js');
const { setUseRunner, useRunner } = await import('../agent/agentState.js');

const originalUseRunner = useRunner;
const pendingTask = (id, metadata = {}) => ({
  id, status: 'pending', approvalRequired: false, taskType: 'user', metadata,
});
const readyIds = (emit) => emit.mock.calls.filter(([event]) => event === 'task:ready').map(([, task]) => task.id);

let emit;

beforeEach(() => {
  vi.clearAllMocks();
  setUseRunner(false);
  mocks.daemonRunning = true;
  mocks.drainCalls = 0;
  mocks.onDemand = [];
  mocks.userPending = [];
  mocks.autoApproved = [];
  mocks.task = pendingTask('task-run-now');
  mocks.resolution = { ok: true, provider: { id: 'cloud-cli', type: 'cli' } };
  mocks.localCapacityError = null;
  mocks.localEndpoint = null;
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

describe.each([['dequeueNextTask', dequeueNextTask], ['evaluateTasks', evaluateTasks]])('%s — behavior', (_name, run) => {
  it('admits tiers in precedence order: on-demand, then user, then auto-approved', async () => {
    mocks.onDemand = [pendingTask('od-1')];
    mocks.userPending = [pendingTask('user-1')];
    mocks.autoApproved = [pendingTask('sys-1', { analysisType: 'enabled' })];

    await run();

    expect(readyIds(emit)).toEqual(['od-1', 'user-1', 'sys-1']);
  });

  it('spends one slot budget across tiers, so a lower tier is cut when higher ones fill it', async () => {
    mocks.state.config.maxConcurrentAgents = 2;
    mocks.onDemand = [pendingTask('od-1')];
    mocks.userPending = [pendingTask('user-1'), pendingTask('user-2')];
    mocks.autoApproved = [pendingTask('sys-1', { analysisType: 'enabled' })];

    await run();

    expect(readyIds(emit)).toEqual(['od-1', 'user-1']);
  });

  it('a P0 on-demand request still fires while the daemon is globally paused; every lower tier is withheld', async () => {
    mocks.state.paused = true;
    mocks.onDemand = [pendingTask('od-1')];
    mocks.userPending = [pendingTask('user-1')];
    mocks.autoApproved = [pendingTask('sys-1', { analysisType: 'enabled' })];

    await run();

    expect(readyIds(emit)).toEqual(['od-1']);
  });

  it('short-circuits before any tier runs when running agents saturate the cap', async () => {
    mocks.state.config.maxConcurrentAgents = 1;
    mocks.state.agents = { 'agent-0': { status: 'running', metadata: {} } };
    mocks.onDemand = [pendingTask('od-1')];
    mocks.userPending = [pendingTask('user-1')];

    await run();

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

    await run();

    expect(mocks.drainCalls).toBe(0);
    expect(readyIds(emit)).toEqual([]);
  });

  it('lets an eligible user task use global capacity when the project cap is unset', async () => {
    delete mocks.state.config.maxConcurrentAgentsPerProject;
    mocks.state.agents = { busy: { status: 'running', metadata: { taskApp: 'example' } } };
    mocks.userPending = [pendingTask('user-1', { app: 'example' })];

    await run();

    expect(readyIds(emit)).toEqual(['user-1']);
  });

  it.each(['off', 'dry-run'])('allows user and on-demand work while autonomy is %s', async mode => {
    mocks.state.config.domainAutonomy.cos = mode;
    mocks.onDemand = [pendingTask('od-1')];
    mocks.userPending = [
      { ...pendingTask('held'), autoApproved: false },
      pendingTask('elsewhere', { targetInstanceId: 'instance-b' }),
      pendingTask('user-1'),
    ];
    mocks.autoApproved = [pendingTask('sys-1', { analysisType: 'enabled' })];

    await run();

    expect(readyIds(emit)).toEqual(['od-1', 'user-1']);
  });
});

describe('evaluateTasks pending merges', () => {
  it.each([
    ['execute', false, 1], ['execute', true, 0], ['off', false, 0], ['dry-run', false, 0],
  ])('in %s with pause=%s sweeps %i times even with a full agent pool', async (mode, paused, count) => {
    mocks.state.config.domainAutonomy.cos = mode;
    mocks.state.config.maxConcurrentAgents = 1;
    mocks.state.agents = { busy: { status: 'running' } };
    mocks.state.paused = paused;

    await evaluateTasks();

    expect(mocks.sweep).toHaveBeenCalledTimes(count);
    expect(readyIds(emit)).toEqual([]);
  });
});

describe('dequeueNextTask', () => {
  it('holds automatic local work when the endpoint is full while handing explicit work to the spawn gate', async () => {
    mocks.localEndpoint = 'http://localhost:11434';
    mocks.state.agents = { busy: { status: 'running' } };
    mocks.onDemand = [pendingTask('od-1')];
    mocks.userPending = [pendingTask('user-1')];
    mocks.autoApproved = [pendingTask('sys-1', { analysisType: 'enabled' })];

    await dequeueNextTask();

    expect(readyIds(emit)).toEqual(['od-1']);
  });

  it('does nothing while the daemon is stopped', async () => {
    mocks.daemonRunning = false;
    mocks.onDemand = [pendingTask('od-1')];

    await dequeueNextTask();

    expect(mocks.drainCalls).toBe(0);
    expect(readyIds(emit)).toEqual([]);
  });
});

describe('tasks:changed scheduler wake', () => {
  const drainCallbacks = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

  beforeAll(async () => { await init(); });

  it('starts the dequeue cycle before the immediate user spawn', async () => {
    const dequeueStarted = vi.spyOn(maintenance, 'held').mockReturnValue(true);
    try {
      cosEvents.emit('tasks:changed', { action: 'added', type: 'user', task: pendingTask('added') });
      await drainCallbacks();

      expect(dequeueStarted).toHaveBeenCalledOnce();
      expect(readyIds(emit)).toEqual(['added']);
      const dispatchedAt = emit.mock.calls.findIndex(([event]) => event === 'task:ready');
      expect(dequeueStarted.mock.invocationCallOrder[0]).toBeLessThan(emit.mock.invocationCallOrder[dispatchedAt]);
    } finally { dequeueStarted.mockRestore(); }
  });

  it('dispatches a task returned to pending by the requeue event', async () => {
    const task = pendingTask('released-retry');
    mocks.userPending = [task];

    cosEvents.emit('tasks:changed', { action: 'requeued', type: 'user', previousStatus: 'in_progress', task });

    await vi.waitFor(() => expect(readyIds(emit)).toEqual([task.id]));
    expect(mocks.drainCalls).toBe(1);
  });

  it.each(['added', 'approved', 'requeued'])('leaves a suppressed %s event to its caller', async action => {
    mocks.onDemand = [pendingTask('od-1')];
    cosEvents.emit('tasks:changed', { action, type: 'user', suppressDequeue: true, task: pendingTask('explicit') });
    await drainCallbacks();

    expect(mocks.drainCalls).toBe(0);
    expect(readyIds(emit)).toEqual([]);
  });

  it('only hands a transition into completed to the investigation retry service', async () => {
    const task = { id: 'investigation', status: 'completed', metadata: { isInvestigation: true } };
    cosEvents.emit('tasks:changed', { action: 'updated', previousStatus: 'in_progress', task });
    cosEvents.emit('tasks:changed', { action: 'updated', previousStatus: 'completed', task });
    await drainCallbacks();

    expect(mocks.retryInvestigation).toHaveBeenCalledExactlyOnceWith(task);
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
