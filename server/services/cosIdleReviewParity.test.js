import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: null,
  interval: null, localEndpoint: null, requestsAfterPriority0: false, requestReads: 0,
  cosTaskData: null,
  emit: vi.fn(),
  emitLog: vi.fn(),
  recordDecision: vi.fn(async () => {}),
  apps: [], requests: [], activity: {}, cards: {}, persisted: [], executions: [], perpetualDispatches: [],
  noWork: false, budget: { exceeded: null, budget: {}, usage: {} }, preflightInputs: [], hookInputs: [], userTasks: [],
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
    user: { exists: true, grouped: { pending: mocks.userTasks, in_progress: [], blocked: [] } },
    cos: mocks.cosTaskData,
  }),
  getUserTasks: async () => ({ exists: true, grouped: { pending: mocks.userTasks } }),
  getCosTasks: async () => mocks.cosTaskData,
  addTask: async (task) => { mocks.persisted.push(task); return task; },
}));
vi.mock('./domainUsage.js', async (importActual) => ({
  ...(await importActual()),
  getDomainBudgetStatus: async () => mocks.budget,
}));
vi.mock('./instanceIdentity.js', async (importActual) => ({
  ...(await importActual()),
  ensureInstanceId: async () => 'instance-a',
}));
vi.mock('./decisionLog.js', async (importActual) => ({
  ...(await importActual()),
  recordDecision: (...args) => mocks.recordDecision(...args),
}));
vi.mock('./apps.js', async (importActual) => ({
  ...(await importActual()),
  getActiveApps: async () => mocks.apps,
  getAppTaskTypeOverrides: async () => ({}),
}));
vi.mock('./appActivity.js', async (importActual) => ({
  ...(await importActual()),
  loadAppActivity: async () => ({ apps: mocks.activity }),
  isAppOnCooldown: async (appId) => !!mocks.activity[appId]?.cooldown,
  getNextAppForReview: async (apps) => apps.find((app) => !mocks.activity[app.id]?.cooldown && !mocks.activity[app.id]?.activeAgentId) || null,
  markIdleReviewStarted: async () => {},
  markAppReviewCooldown: async (appId) => { mocks.activity[appId] = { ...mocks.activity[appId], cooldown: true }; },
  bindAppReviewAgent: async (appId, id) => { mocks.activity[appId] = { ...mocks.activity[appId], activeAgentId: id }; },
  updateAppActivity: async () => {},
}));
vi.mock('./taskSchedule.js', async (importActual) => ({
  ...(await importActual()),
  loadSchedule: async () => ({ tasks: { 'code-quality': { enabled: true } } }),
  getOnDemandRequests: async () => {
    mocks.requestReads++;
    return mocks.requestsAfterPriority0 && mocks.requestReads === 1 ? [] : [...mocks.requests];
  },
  clearOnDemandRequest: async (id) => { mocks.requests = mocks.requests.filter((r) => r.id !== id); },
  applyOnDemandRunResets: async () => true,
  recordExecution: async (type, appId) => { mocks.executions.push({ type, appId }); },
  recordPerpetualDispatch: async (...args) => { mocks.perpetualDispatches.push(args); },
  getTaskInterval: async () => mocks.interval,
  recordPerpetualStall: async () => {},
  getPerpetualDrainState: async () => ({ signature: null, dispatchCount: 0 }),
  getNextTaskType: async () => ({ taskType: 'code-quality', reason: 'scheduled' }),
}));
vi.mock('./preflightTaskCard.js', async (importActual) => ({
  ...(await importActual()),
  startPreflightCard: async ({ requestId }) => { mocks.cards[`preflight-${requestId}`] ??= { outcome: 'waiting' }; },
  reportPreflightStep: async () => {},
  preflightReporter: (cardId) => ({ cardId }),
  finishPreflightDispatch: async (cardId, taskId) => {
    if (cardId && mocks.cards[cardId]?.outcome === 'waiting') {
      mocks.cards[cardId] = { outcome: taskId ? 'handed-off' : 'nothing-to-do', taskId: taskId ?? null };
    }
  },
}));
vi.mock('./prReviewerPipeline.js', async (importActual) => ({
  ...(await importActual()),
  runPrReviewerSecurityPreflight: async (_type, _app, _metadata, target, _schedule, options) => {
    mocks.preflightInputs.push({ target, progress: options.progress });
    return { skipped: mocks.noWork };
  },
}));
vi.mock('./taskPromptService.js', () => ({ getTaskPrompt: async () => 'Review Example App', getStagePrompt: async () => 'Review Example App' }));
vi.mock('./taskTypeHooks.js', async (importActual) => ({
  ...(await importActual()),
  getTaskInputHook: async () => async (args) => { mocks.hookInputs.push(args); return { prompt: 'Review Example App' }; },
}));
vi.mock('./taskLearning.js', async (importActual) => ({
  ...(await importActual()),
  getTaskTypeConfidence: async () => ({ autoApprove: true }),
}));
vi.mock('./cosTaskPreStepBlocks.js', async (importActual) => ({
  ...(await importActual()),
  applyPerpetualDrainCap: async () => ({ skip: false }),
  buildImprovementTaskDescription: async ({ promptTemplate }) => promptTemplate,
}));
vi.mock('./perpetualWork.js', () => ({
  detectActionableWork: async () => ({ actionable: true, signature: ['example-work'], count: 1 }),
}));
vi.mock('./taskDataInputs.js', () => ({ resolveTaskDataInputs: async () => [], appendTaskDataInputs: (description) => description }));
vi.mock('./prWatcher.js', async (importActual) => ({
  ...(await importActual()),
  sweepPendingMergePrs: async () => ({ merged: 0, escalated: 0, timedOut: 0 }),
}));
vi.mock('./cosLocalEndpointSlots.js', async (importActual) => ({
  ...(await importActual()),
  buildLocalEndpointSlotContext: async () => ({
    endpointForAgent: () => mocks.localEndpoint,
    resolveLocalEndpoint: () => mocks.localEndpoint,
    limit: 1,
  }),
}));
vi.mock('./featureAgents.js', async (importActual) => ({
  ...(await importActual()),
  getDueFeatureAgents: async () => [],
}));

const { evaluateTasks } = await import('./cosTaskGenerator.js');
const { dequeueNextTask } = await import('./cos.js');

const engines = [
  ['evaluateTasks', () => evaluateTasks({ initialStartup: true })],
  ['dequeueNextTask', () => dequeueNextTask({ ignoreTaskId: 'completed-task' })],
];
const readyTasks = () => mocks.emit.mock.calls.filter(([event]) => event === 'task:ready').map(([, task]) => task);
const app = (id = 'example-app') => ({ id, name: 'Example App' });
const request = () => ({ id: 'demand-1', appId: 'example-app', taskType: 'code-quality', targetPullRequest: { number: 42, repo: 'example/repo' } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = {
    paused: false, agents: {}, stats: {},
    config: { maxConcurrentAgents: 2, maxConcurrentAgentsPerProject: 1, appReviewCooldownMs: 0,
      idleReviewEnabled: true, improvementEnabled: true, domainAutonomy: { cos: 'execute' } },
  };
  mocks.cosTaskData = { exists: true, autoApproved: [], awaitingApproval: [], grouped: { pending: [], blocked: [] } };
  mocks.apps = [app()];
  mocks.requests = [];
  mocks.interval = { taskMetadata: { runInapplicableAudit: true } };
  mocks.localEndpoint = null;
  mocks.requestsAfterPriority0 = false;
  mocks.requestReads = 0;
  mocks.userTasks = [];
  mocks.activity = {};
  mocks.cards = {};
  mocks.persisted = [];
  mocks.executions = [];
  mocks.perpetualDispatches = [];
  mocks.noWork = false;
  mocks.budget = { exceeded: null, budget: {}, usage: {} };
  mocks.preflightInputs = [];
  mocks.hookInputs = [];
});

describe.each(engines)('%s idle admission public boundary', (name, run) => {
  it('retains a full project Run and later dispatches it once with the original scope and card', async () => {
    const originalRequest = request();
    mocks.requests = [originalRequest];
    mocks.state.agents = { ordinary: { status: 'running', metadata: { app: 'example-app' } } };
    await run();
    expect(mocks.requests).toEqual([originalRequest]);
    expect(readyTasks()).toEqual([]);
    expect(mocks.activity).toEqual({});
    expect(mocks.executions).toEqual([]);
    expect(mocks.cards['preflight-demand-1']).toEqual({ outcome: 'waiting' });

    mocks.state.agents = {};
    await run();
    const [task] = readyTasks();
    expect(readyTasks()).toHaveLength(1);
    expect(task.metadata).toMatchObject({ app: 'example-app', analysisType: 'code-quality', onDemand: true });
    expect(mocks.preflightInputs).toEqual([{ target: originalRequest.targetPullRequest, progress: { cardId: 'preflight-demand-1' } }]);
    expect(mocks.requests).toEqual([]);
    expect(mocks.cards['preflight-demand-1']).toEqual({ outcome: 'handed-off', taskId: task.id });
    await run();
    expect(readyTasks()).toHaveLength(1);
  });

  it('selects another eligible app without consuming the full project request', async () => {
    mocks.requests = [request()];
    mocks.apps.push(app('second-app'));
    mocks.state.agents = { ordinary: { status: 'running', metadata: { app: 'example-app' } } };
    await run();
    expect(readyTasks()).toHaveLength(1);
    expect(readyTasks()[0].metadata.app).toBe('second-app');
    expect(mocks.requests).toEqual([request()]);
    expect(mocks.activity['example-app']).toBeUndefined();
    expect(mocks.executions).toEqual([{ type: 'task:code-quality', appId: 'second-app' }]);
    expect(mocks.cards['preflight-demand-1'].outcome).toBe('waiting');
  });

  it('dispatches an eligible idle task once and carries completion ignoreTaskId into preparation', async () => {
    await run();
    expect(readyTasks()).toHaveLength(1);
    expect(mocks.activity['example-app']).toMatchObject({ cooldown: true, activeAgentId: expect.stringMatching(/^idle-review-/) });
    expect(mocks.hookInputs[0].ignoreTaskId).toBe(name === 'dequeueNextTask' ? 'completed-task' : null);
    await run();
    expect(readyTasks()).toHaveLength(1);
  });

  it('keeps the no-work cooldown without binding an active review marker', async () => {
    mocks.noWork = true;
    await run();
    expect(readyTasks()).toEqual([]);
    expect(mocks.activity['example-app']).toEqual({ cooldown: true });
    await run();
    expect(mocks.executions).toHaveLength(1);
  });

  it.each(['paused', 'off', 'dry-run', 'budget', 'global-full', 'pending-user', 'pending-system'])('leaves idle preparation untouched for %s', async (gate) => {
    if (gate === 'paused') mocks.state.paused = true;
    if (gate === 'off' || gate === 'dry-run') mocks.state.config.domainAutonomy.cos = gate;
    if (gate === 'budget') mocks.budget = { exceeded: 'actions', budget: { maxActionsPerDay: 1 }, usage: { actions: 1 } };
    if (gate === 'global-full') mocks.state.agents = { a: { status: 'running' }, b: { status: 'running' } };
    if (gate === 'pending-user') mocks.userTasks = [{ id: 'user-waiting', autoApproved: false, approvalRequired: true }];
    if (gate === 'pending-system') {
      mocks.cosTaskData.autoApproved = [{ id: 'held-system', metadata: { app: 'example-app' } }];
      mocks.state.agents = { ordinary: { status: 'running', metadata: { app: 'example-app' } } };
    }
    await run();
    expect(readyTasks()).toEqual([]);
    expect(mocks.activity).toEqual({});
    expect(mocks.executions).toEqual([]);
  });

  it.each([false, true])('closes the correct stolen card after late request preparation (no-work: %s)', async (noWork) => {
    mocks.requests = [request()];
    mocks.requestsAfterPriority0 = true;
    mocks.cards['preflight-demand-1'] = { outcome: 'waiting' };
    mocks.noWork = noWork;
    mocks.interval.perpetual = true;
    await run();
    expect(mocks.requests).toEqual([]);
    expect(mocks.preflightInputs).toEqual([{ target: request().targetPullRequest, progress: { cardId: 'preflight-demand-1' } }]);
    expect(mocks.cards['preflight-demand-1']).toEqual({
      outcome: noWork ? 'nothing-to-do' : 'handed-off', taskId: readyTasks()[0]?.id ?? null,
    });
    expect(mocks.perpetualDispatches).toHaveLength(noWork ? 0 : 1);
    if (!noWork) expect(mocks.perpetualDispatches[0]).toEqual(['code-quality', 'example-app', JSON.stringify({ taskType: 'code-quality', candidates: ['example-work'] })]);
    if (noWork) expect(mocks.activity['example-app'].activeAgentId).toBeUndefined();
  });

  it('hands committed idle work to the downstream hold when the local endpoint is full', async () => {
    mocks.localEndpoint = 'http://example.invalid/inference';
    mocks.state.agents = { ordinary: { taskId: 'running-task', status: 'running', metadata: { app: 'other-app' } } };
    await run();
    // The spawn chokepoint owns the durable hold/release; discarding here
    // would strand the synthetic marker and lose the prepared task.
    expect(readyTasks()).toHaveLength(1);
    expect(readyTasks()[0].metadata.app).toBe('example-app');
  });

  it('still dispatches explicit on-demand work while paused', async () => {
    mocks.state.paused = true;
    mocks.requests = [request()];
    await run();
    expect(readyTasks()).toHaveLength(1);
    expect(mocks.requests).toEqual([]);
    expect(mocks.cards['preflight-demand-1'].outcome).toBe('handed-off');
  });
});
