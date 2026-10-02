import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dueFeatureAgents: [], featureAgentPending: [], userPending: [],
  state: null,
  cosTaskData: null,
  emit: vi.fn(),
  emitLog: vi.fn(),
  recordDecision: vi.fn(async () => {}),
  cooldownAppId: null,
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: (...args) => mocks.emit(...args), on: vi.fn(), off: vi.fn() },
  emitLog: (...args) => mocks.emitLog(...args),
}));
vi.mock('./cosState.js', async (importActual) => ({
  ...(await importActual()),
  isDaemonRunning: () => true,
  loadState: async () => mocks.state,
  saveState: async () => {},
  withStateLock: async (fn) => fn(),
}));
vi.mock('./cosTaskStore.js', async (importActual) => ({
  ...(await importActual()),
  getAllTasks: async () => ({
    user: { exists: true, grouped: { pending: mocks.userPending, in_progress: [], blocked: [] } },
    cos: mocks.cosTaskData,
  }),
  getUserTasks: async () => ({ exists: true, grouped: { pending: mocks.userPending } }),
  getCosTasks: async () => mocks.cosTaskData,
}));
vi.mock('./onDemandDrain.js', () => ({
  drainOnDemandRequests: async () => ({ schedule: {
    tasks: {
      enabled: { enabled: true },
      disabled: { enabled: false },
    },
  } }),
}));
vi.mock('./domainUsage.js', async (importActual) => ({
  ...(await importActual()),
  getDomainBudgetStatus: async () => ({ exceeded: null, budget: {}, usage: {} }),
}));
vi.mock('./instanceIdentity.js', async (importActual) => ({
  ...(await importActual()),
  ensureInstanceId: async () => 'instance-a',
}));
vi.mock('./decisionLog.js', async (importActual) => ({
  ...(await importActual()),
  recordDecision: (...args) => mocks.recordDecision(...args),
}));
vi.mock('./appActivity.js', async (importActual) => ({
  ...(await importActual()),
  isAppOnCooldown: async (appId) => appId === mocks.cooldownAppId,
}));
vi.mock('./prWatcher.js', async (importActual) => ({
  ...(await importActual()),
  sweepPendingMergePrs: async () => ({ merged: 0, escalated: 0, timedOut: 0 }),
}));
vi.mock('./cosLocalEndpointSlots.js', async (importActual) => ({
  ...(await importActual()),
  buildLocalEndpointSlotContext: async () => ({
    endpointForAgent: () => null,
    resolveLocalEndpoint: () => null,
    limit: Infinity,
  }),
}));
vi.mock('./featureAgents.js', async (importActual) => ({
  ...(await importActual()),
  getDueFeatureAgents: async () => [...mocks.dueFeatureAgents],
  setCurrentAgent: async (...args) => { mocks.featureAgentPending.push(args); },
}));

const { evaluateTasks } = await import('./cosTaskGenerator.js');
const { dequeueNextTask } = await import('./cos.js');

const ordinaryTask = (id, analysisType) => ({
  id,
  status: 'pending',
  approvalRequired: false,
  metadata: { analysisType },
});

const investigationTask = () => ({
  id: 'investigation',
  description: '[Auto] Investigate agent failure: provider setup',
  status: 'pending',
  approvalRequired: true,
  metadata: { isInvestigation: true },
});

const engines = [
  ['evaluateTasks', () => evaluateTasks()],
  ['dequeueNextTask', () => dequeueNextTask()],
];

const readyIds = () => mocks.emit.mock.calls
  .filter(([event]) => event === 'task:ready')
  .map(([, task]) => task.id);

const dryRunIds = () => mocks.emitLog.mock.calls
  .filter(([, message]) => message.startsWith('[dry-run] CoS auto-run would spawn system task:'))
  .map(([, message]) => message.split(': ').at(-1));

function resetFixtures(mode = 'execute') {
  mocks.state = {
    paused: false,
    agents: {},
    stats: {},
    config: {
      maxConcurrentAgents: 4,
      maxConcurrentAgentsPerProject: 4,
      appReviewCooldownMs: 0,
      autoApproveInvestigations: true,
      idleReviewEnabled: false,
      domainAutonomy: { cos: mode },
    },
  };
  mocks.cosTaskData = {
    exists: true,
    autoApproved: [],
    awaitingApproval: [],
    grouped: { pending: [], blocked: [] },
  };
  mocks.cooldownAppId = null;
  mocks.dueFeatureAgents = [];
  mocks.featureAgentPending = [];
  mocks.userPending = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFixtures();
});

describe.each(engines)('%s Priority-2 public boundary', (_name, run) => {
  it('skips an auto-approved task whose scheduled analysis type is disabled', async () => {
    mocks.cosTaskData.autoApproved = [
      ordinaryTask('disabled-task', 'disabled'),
      ordinaryTask('enabled-task', 'enabled'),
    ];

    await run();

    expect(readyIds()).toEqual(['enabled-task']);
  });

  it('admits a pending investigation when auto-approval is enabled', async () => {
    mocks.cosTaskData.grouped.pending = [investigationTask()];

    await run();

    expect(readyIds()).toEqual(['investigation']);
  });

  it('dry-run logs the same ids execute mode would emit', async () => {
    mocks.cosTaskData.autoApproved = [
      ordinaryTask('disabled-task', 'disabled'),
      ordinaryTask('enabled-task', 'enabled'),
    ];
    mocks.cosTaskData.grouped.pending = [investigationTask()];
    await run();
    const executeIds = readyIds();

    vi.clearAllMocks();
    resetFixtures('dry-run');
    mocks.cosTaskData.autoApproved = [
      ordinaryTask('disabled-task', 'disabled'),
      ordinaryTask('enabled-task', 'enabled'),
    ];
    mocks.cosTaskData.grouped.pending = [investigationTask()];
    await run();

    expect(readyIds()).toEqual([]);
    expect(dryRunIds()).toEqual(executeIds);
  });
});

const dueAgent = (id) => ({ id, name: `Agent ${id}`, description: 'example', appId: `app-${id}` });
const featureAgentIds = () => readyIds().filter(id => id.startsWith('fa-run-'));

describe.each(engines)('%s Priority-3.6 feature-agent tier', (_name, run) => {
  it('spawns a due feature agent and marks it pending so the next cycle skips it', async () => {
    mocks.dueFeatureAgents = [dueAgent('a')];

    await run();

    expect(featureAgentIds()).toHaveLength(1);
    expect(mocks.featureAgentPending).toEqual([['a', featureAgentIds()[0]]]);
  });

  it('runs after the auto-approved tier and stops at the free slots', async () => {
    mocks.state.config.maxConcurrentAgents = 2;
    mocks.state.config.maxConcurrentAgentsPerProject = 2;
    mocks.cosTaskData.autoApproved = [ordinaryTask('enabled-task', 'enabled')];
    mocks.dueFeatureAgents = [dueAgent('a'), dueAgent('b')];

    await run();

    const ids = readyIds();
    expect(ids[0]).toBe('enabled-task');
    expect(ids).toHaveLength(2);
    expect(featureAgentIds()).toHaveLength(1);
    expect(mocks.featureAgentPending).toHaveLength(1);
  });

  it.each(['pending-user', 'dry-run', 'off'])('does not spawn a due agent for %s', async (gate) => {
    mocks.dueFeatureAgents = [dueAgent('a')];
    if (gate === 'pending-user') {
      mocks.userPending = [{ id: 'user-waiting', status: 'pending', approvalRequired: true }];
    } else {
      mocks.state.config.domainAutonomy.cos = gate;
    }

    await run();

    expect(featureAgentIds()).toEqual([]);
    expect(mocks.featureAgentPending).toEqual([]);
  });
});

it('keeps cooldown decision logging in the evaluate adapter only', async () => {
  const blockedTask = { ...ordinaryTask('cooldown-task', 'enabled'), metadata: { analysisType: 'enabled', app: 'app-a' } };
  mocks.cooldownAppId = 'app-a';
  mocks.cosTaskData.autoApproved = [blockedTask];

  await evaluateTasks();

  expect(readyIds()).toEqual([]);
  expect(mocks.recordDecision).toHaveBeenCalledWith(
    'cooldown_active',
    expect.stringContaining('cooldown-task'),
    expect.objectContaining({ taskId: 'cooldown-task', appId: 'app-a' }),
  );

  vi.clearAllMocks();
  resetFixtures();
  mocks.cooldownAppId = 'app-a';
  mocks.cosTaskData.autoApproved = [blockedTask];

  await dequeueNextTask();

  expect(readyIds()).toEqual([]);
  expect(mocks.recordDecision).not.toHaveBeenCalled();
});
