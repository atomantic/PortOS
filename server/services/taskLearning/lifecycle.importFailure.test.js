import { beforeEach, describe, expect, it, vi } from 'vitest';

const metricMocks = vi.hoisted(() => ({
  recordTaskCompletion: vi.fn(async () => {}),
  recalculateModelTierMetrics: vi.fn(async () => {}),
}));

vi.mock('./store.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { cosEvents: new EventEmitter(), emitLog: vi.fn() };
});
vi.mock('./metrics.js', () => metricMocks);
vi.mock('../taskTypeHooks.js', () => ({ declaresNoCommitCriterion: vi.fn(() => false) }));
vi.mock('../../lib/agentOutcome.js', () => ({ isAgentHandoff: vi.fn(() => false) }));
vi.mock('../agentChurn.js', async () => {
  throw new Error('simulated observer module evaluation failure');
});

import { cosEvents } from './store.js';
import { recordTaskCompletion } from './metrics.js';
import { initTaskLearning } from './lifecycle.js';

describe('agent:completed listener — churn observer import failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cosEvents.removeAllListeners();
  });

  it('owns a rejected lazy import when EventEmitter ignores the listener promise', async () => {
    const unhandledRejections = [];
    const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      initTaskLearning();
      cosEvents.emit('agent:completed', {
        status: 'completed',
        taskId: 'task-1',
        result: { success: true },
        metadata: { taskType: 'user', taskDescription: 'Example completion' },
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(recordTaskCompletion).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(/TaskLearning\/CoS churn: Failed to load churn observer/));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      errorLog.mockRestore();
    }
  });
});
