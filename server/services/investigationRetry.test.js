import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cos/cosTaskStore.js', () => ({
  getAllTasks: vi.fn(),
  reviveBlockedTask: vi.fn().mockResolvedValue({ id: 'ok' }),
  updateTask: vi.fn().mockResolvedValue({ id: 'ok' }),
}));
vi.mock('./cos/cosEvents.js', () => ({ emitLog: vi.fn() }));
const state = vi.hoisted(() => ({ agents: {}, trusted: true }));
vi.mock('./cos/cosState.js', () => ({ readAgentsStateForSafetyCheck: vi.fn(async () => ({ trusted: state.trusted, agents: state.agents })) }));

const { getAllTasks, reviveBlockedTask, updateTask } = await import('./cos/cosTaskStore.js');
const { retryTasksResolvedByInvestigation } = await import('./investigationRetry.js');

const investigation = (metadata = {}) => ({
  id: 'sys-inv',
  status: 'completed',
  metadata: { isInvestigation: true, affectedTasks: ['task-1'], ...metadata },
});

const queues = ({ user = [], cos = [] } = {}) => ({ user: { tasks: user }, cos: { tasks: cos } });
// A blocked task and the completed agent that last dispatched it. The block
// released the claim, so the spawn stamp and count are what the two still share.
const dispatchedTask = (id, taskType = 'user', metadata = {}) => {
  const agentId = `agent-${id}`;
  state.agents[agentId] = { id: agentId, taskId: id, status: 'completed', startedAt: 'start',
    metadata: { completionTaskDispatch: { taskId: id, taskType,
      expected: [['claimedBy', 'fixture'], ['claimedAt', 'claim'], ['lastSpawnedAt', 'spawn'], ['totalSpawnCount', 1]] } } };
  return { id, status: 'blocked', metadata: { ...metadata, totalSpawnCount: '1', lastSpawnedAt: 'spawn' } };
};

describe('retryTasksResolvedByInvestigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.agents = {};
    state.trusted = true;
    reviveBlockedTask.mockResolvedValue({ id: 'ok' });
    updateTask.mockResolvedValue({ id: 'ok' });
  });

  it('does not refund original budgets after a diagnostic-only system investigation', async () => {
    expect(await retryTasksResolvedByInvestigation(investigation({ preserveOriginalBudget: true })))
      .toEqual({ retried: [], skipped: [] });
    expect(getAllTasks).not.toHaveBeenCalled();
    expect(reviveBlockedTask).not.toHaveBeenCalled();
  });

  // The revive refunds the task's spawn budget, so only the completed run that is
  // still its latest dispatch may grant it.
  it.each([
    ['has no agent record', () => { state.agents = {}; }, {}],
    ['is still running', () => { state.agents['agent-task-1'].status = 'running'; }, {}],
    ['was superseded by a later dispatch', () => {}, { lastSpawnedAt: 'later-spawn', totalSpawnCount: '2' }],
    ['belongs to another task', () => { state.agents['agent-task-1'].taskId = 'task-other'; }, {}],
    ['cannot be read', () => { state.trusted = false; }, {}],
  ])('holds a blocked task with spawn history when its dispatch owner %s', async (_label, arrange, metadata) => {
    const task = dispatchedTask('task-1', 'user', { failureCount: '2' });
    arrange();
    getAllTasks.mockResolvedValue(queues({ user: [{ ...task, metadata: { ...task.metadata, ...metadata } }] }));
    expect(await retryTasksResolvedByInvestigation(investigation())).toEqual({ retried: [],
      skipped: [{ taskId: 'task-1', reason: 'dispatch-owner-unverified' }] });
    expect(reviveBlockedTask).not.toHaveBeenCalled();
  });

  it('continues a task with no charged spawn only under the inactive-owner fence', async () => {
    getAllTasks.mockResolvedValue(queues({ user: [{ id: 'task-1', status: 'blocked', metadata: {} }] }));
    expect((await retryTasksResolvedByInvestigation(investigation())).retried).toEqual(['task-1']);
    expect(reviveBlockedTask).toHaveBeenCalledWith('task-1', expect.anything(), 'user', expect.objectContaining({
      expectedStatus: 'blocked', recoveryOwner: { id: 'undispatched-investigation-retry', startedAt: null, requireInactive: true },
    }));
  });

  it('revives the blocked task the investigation was diagnosing, stamping the auto-retry budget', async () => {
    getAllTasks.mockResolvedValue(queues({
      user: [dispatchedTask('task-1', 'user', { blockedCategory: 'test-failure' })]
    }));

    const result = await retryTasksResolvedByInvestigation(investigation(), { now: 1_700_000_000_000 });

    expect(result.retried).toEqual(['task-1']);
    expect(reviveBlockedTask).toHaveBeenCalledWith(
      'task-1',
      {
        metadata: {
          autoRetryCount: 1,
          autoRetriedByInvestigation: 'sys-inv',
          autoRetriedAt: new Date(1_700_000_000_000).toISOString(),
        }
      },
      // Written back to the queue the task actually lives in — `getAllTasks`
      // returns raw tasks with no `taskType`, so this must come from the queue.
      'user', expect.objectContaining({ expectedStatus: 'blocked', expectedTask: expect.objectContaining({ metadata: expect.objectContaining({ blockedCategory: 'test-failure' }) }),
        recoveryOwner: { id: 'agent-task-1', startedAt: 'start', requireInactive: true } })
    );
  });

  it('routes an internal-queue task back to the internal file', async () => {
    getAllTasks.mockResolvedValue(queues({
      cos: [dispatchedTask('task-1', 'internal')]
    }));

    await retryTasksResolvedByInvestigation(investigation());

    expect(reviveBlockedTask.mock.calls[0][2]).toBe('internal');
  });

  it('is a no-op for a completed task that is not an investigation — no task file is even read', async () => {
    const result = await retryTasksResolvedByInvestigation({
      id: 'task-9', status: 'completed', description: 'Ordinary work', metadata: {}
    });

    expect(result).toEqual({ retried: [], skipped: [] });
    expect(getAllTasks).not.toHaveBeenCalled();
    expect(reviveBlockedTask).not.toHaveBeenCalled();
  });

  it('is a no-op for an investigation that has not completed', async () => {
    await retryTasksResolvedByInvestigation({ ...investigation(), status: 'in_progress' });
    expect(getAllTasks).not.toHaveBeenCalled();
  });

  // The reaper flips up to 50 investigations to `completed` per sweep with this
  // marker; each one reaching the file read would cost 100 discarded reads and
  // parses on the same tick the reaper is writing those very files.
  it('skips the file read entirely for an auto-expired completion', async () => {
    await retryTasksResolvedByInvestigation(investigation({ resolution: 'auto-expired' }));
    expect(getAllTasks).not.toHaveBeenCalled();
  });

  it('skips the file read entirely for an investigation that names no affected task', async () => {
    await retryTasksResolvedByInvestigation(investigation({ affectedTasks: [] }));
    expect(getAllTasks).not.toHaveBeenCalled();
  });

  it('says so on the task when the auto-retry budget runs out, rather than only in the log', async () => {
    getAllTasks.mockResolvedValue(queues({
      user: [{ id: 'task-1', status: 'blocked', metadata: { autoRetryCount: 2 } }]
    }));

    const result = await retryTasksResolvedByInvestigation(investigation());

    expect(result.retried).toEqual([]);
    expect(result.skipped).toEqual([{ taskId: 'task-1', reason: 'auto-retry-budget-exhausted' }]);
    expect(reviveBlockedTask).not.toHaveBeenCalled();
    // The task list would otherwise still show whatever failure blocked it two
    // retries ago, with nothing saying the loop gave up.
    expect(updateTask).toHaveBeenCalledWith(
      'task-1',
      { metadata: expect.objectContaining({ blockedCategory: 'auto-retry-exhausted' }) },
      'user', expect.objectContaining({ expectedStatus: 'blocked', expectedTask: expect.any(Object) })
    );
  });

  it('does not re-stamp a task already marked auto-retry-exhausted', async () => {
    getAllTasks.mockResolvedValue(queues({
      user: [{ id: 'task-1', status: 'blocked', metadata: { autoRetryCount: 2, blockedCategory: 'auto-retry-exhausted' } }]
    }));

    await retryTasksResolvedByInvestigation(investigation());

    expect(updateTask).not.toHaveBeenCalled();
  });

  it('keeps going when one revive fails — the other affected tasks still come back', async () => {
    getAllTasks.mockResolvedValue(queues({
      user: [
        dispatchedTask('task-1'),
        dispatchedTask('task-2'),
      ]
    }));
    reviveBlockedTask
      .mockResolvedValueOnce({ error: 'Task file not found' })
      .mockResolvedValueOnce({ id: 'task-2' });

    const result = await retryTasksResolvedByInvestigation(
      investigation({ affectedTasks: ['task-1', 'task-2'] })
    );

    expect(result.retried).toEqual(['task-2']);
  });

  it('does not throw when a revive rejects — it runs off an event listener', async () => {
    getAllTasks.mockResolvedValue(queues({
      user: [dispatchedTask('task-1')]
    }));
    reviveBlockedTask.mockRejectedValue(new Error('disk on fire'));

    await expect(retryTasksResolvedByInvestigation(investigation())).resolves.toEqual({
      retried: [], skipped: []
    });
  });
});
