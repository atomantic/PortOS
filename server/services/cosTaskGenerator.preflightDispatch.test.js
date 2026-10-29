import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  drain: vi.fn(),
  finish: vi.fn(async () => null),
  finishDispatch: vi.fn(async () => null),
  recordDecision: vi.fn(async () => {}),
  userTasks: [],
}));

const state = {
  paused: false, agents: {}, stats: {},
  config: { maxConcurrentAgents: 2, maxConcurrentAgentsPerProject: 1, domainAutonomy: { cos: 'off' } },
};

vi.mock('./cosState.js', async original => ({
  ...await original(),
  isDaemonRunning: () => true,
  loadState: async () => state,
  saveState: async () => {},
  withStateLock: async fn => fn(),
}));
vi.mock('./cosTaskStore.js', async original => ({
  ...await original(),
  getAllTasks: async () => ({
    user: { grouped: { pending: mocks.userTasks, blocked: [] } },
    cos: { grouped: { pending: [], blocked: [] }, autoApproved: [] },
  }),
}));
vi.mock('./instanceIdentity.js', async original => ({ ...await original(), ensureInstanceId: async () => 'local' }));
vi.mock('./domainUsage.js', async original => ({ ...await original(), getDomainBudgetStatus: async () => ({}) }));
vi.mock('./decisionLog.js', async original => ({ ...await original(), recordDecision: (...args) => mocks.recordDecision(...args) }));
vi.mock('./onDemandDrain.js', () => ({ drainOnDemandRequests: (...args) => mocks.drain(...args) }));
vi.mock('./preflightTaskCard.js', async original => ({
  ...await original(),
  finishPreflightCard: (...args) => mocks.finish(...args),
  finishPreflightDispatch: (...args) => mocks.finishDispatch(...args),
}));

const { evaluateTasks } = await import('./cosTaskGenerator.js');
const { beginPreflightActivity, isPreflightActive } = await import('./preflightActivity.js');
const { cosEvents } = await import('./cosEvents.js');

const cardId = 'preflight-demand-test';
const task = { id: 'app-improve-demand-test', priority: 'HIGH', metadata: { app: 'example' } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userTasks = [];
  mocks.recordDecision.mockResolvedValue(undefined);
  mocks.drain.mockImplementation(async (_ctx, adapter) => {
    const endPreflight = beginPreflightActivity(cardId);
    adapter.emitSpawn(task);
    adapter.deferPreflightDispatch(task.id, { cardId, resultTaskId: task.id, endPreflight, persisted: true });
    return { schedule: { tasks: {} } };
  });
});

describe('periodic evaluator preflight dispatch boundary', () => {
  it('keeps preflight active until the task:ready listener receives the task', async () => {
    const listener = vi.fn(() => {
      expect(isPreflightActive(cardId)).toBe(true);
      expect(mocks.finishDispatch).not.toHaveBeenCalled();
    });
    cosEvents.on('task:ready', listener);
    try {
      await evaluateTasks();
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(task);
      expect(mocks.finishDispatch).toHaveBeenCalledExactlyOnceWith(cardId, task.id);
      expect(mocks.finish).not.toHaveBeenCalled();
      expect(isPreflightActive(cardId)).toBe(false);
    } finally { cosEvents.off('task:ready', listener); }
  });

  it('fails the card without a handoff when a later tier throws', async () => {
    mocks.userTasks = [{ id: 'user-waiting', metadata: { app: 'example' } }];
    mocks.recordDecision.mockImplementation(async () => {
      expect(isPreflightActive(cardId)).toBe(true);
      expect(mocks.finishDispatch).not.toHaveBeenCalled();
      throw new Error('decision store unavailable');
    });
    const listener = vi.fn();
    cosEvents.on('task:ready', listener);
    try {
      await expect(evaluateTasks()).rejects.toThrow('decision store unavailable');
      expect(listener).not.toHaveBeenCalled();
      expect(mocks.finishDispatch).not.toHaveBeenCalled();
      expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(cardId, expect.objectContaining({
        outcome: 'failed', reason: 'dispatch-interrupted', note: expect.stringContaining('Inspect the task'),
      }));
      expect(isPreflightActive(cardId)).toBe(false);
    } finally { cosEvents.off('task:ready', listener); }
  });

  it('does not claim a handoff when no listener receives the task', async () => {
    await evaluateTasks();
    expect(mocks.finishDispatch).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(cardId, expect.objectContaining({ outcome: 'failed', reason: 'dispatch-interrupted' }));
    expect(isPreflightActive(cardId)).toBe(false);
  });
});
