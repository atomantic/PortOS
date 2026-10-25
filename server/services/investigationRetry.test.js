import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./cosTaskStore.js', () => ({
  getAllTasks: vi.fn(),
  reviveBlockedTask: vi.fn().mockResolvedValue({ id: 'ok' }),
  updateTask: vi.fn().mockResolvedValue({ id: 'ok' }),
}));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));

const { getAllTasks, reviveBlockedTask, updateTask } = await import('./cosTaskStore.js');
const { retryTasksResolvedByInvestigation } = await import('./investigationRetry.js');

const investigation = (metadata = {}) => ({
  id: 'sys-inv',
  status: 'completed',
  metadata: { isInvestigation: true, affectedTasks: ['task-1'], ...metadata },
});

const queues = ({ user = [], cos = [] } = {}) => ({ user: { tasks: user }, cos: { tasks: cos } });

describe('retryTasksResolvedByInvestigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviveBlockedTask.mockResolvedValue({ id: 'ok' });
    updateTask.mockResolvedValue({ id: 'ok' });
  });

  it('does not refund original budgets after a diagnostic-only system investigation', async () => {
    expect(await retryTasksResolvedByInvestigation(investigation({ preserveOriginalBudget: true })))
      .toEqual({ retried: [], skipped: [] });
    expect(getAllTasks).not.toHaveBeenCalled();
    expect(reviveBlockedTask).not.toHaveBeenCalled();
  });

  it('revives the blocked task the investigation was diagnosing, stamping the auto-retry budget', async () => {
    getAllTasks.mockResolvedValue(queues({
      user: [{ id: 'task-1', status: 'blocked', metadata: { blockedCategory: 'test-failure' } }]
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
      'user'
    );
  });

  it('routes an internal-queue task back to the internal file', async () => {
    getAllTasks.mockResolvedValue(queues({
      cos: [{ id: 'task-1', status: 'blocked', metadata: {} }]
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
      'user'
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
        { id: 'task-1', status: 'blocked', metadata: {} },
        { id: 'task-2', status: 'blocked', metadata: {} },
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
      user: [{ id: 'task-1', status: 'blocked', metadata: {} }]
    }));
    reviveBlockedTask.mockRejectedValue(new Error('disk on fire'));

    await expect(retryTasksResolvedByInvestigation(investigation())).resolves.toEqual({
      retried: [], skipped: []
    });
  });
});
