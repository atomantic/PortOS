import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
    user: { exists: true, grouped: { pending: [], in_progress: [], blocked: [] } },
    cos: mocks.cosTaskData,
  }),
  getUserTasks: async () => ({ exists: true, grouped: { pending: [] } }),
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
  getDueFeatureAgents: async () => [],
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
