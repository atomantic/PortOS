/**
 * reset.taskTypeLearning.test.js
 *
 * Behavior of reset.js (resetTaskTypeLearning). Split from taskLearning.test.js (#16214); shared mocks live in
 * taskLearning.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const fx = await vi.hoisted(() => import('./taskLearning.testFixtures.js'));
const { makeLearningData } = fx;

vi.mock('fs/promises', () => fx.fsPromisesFactory());
vi.mock('fs', () => fx.fsFactory());
// Mock cos.js to avoid circular dependency
vi.mock('../cos.js', () => ({}));
vi.mock('../cosEvents.js', () => fx.cosEventsFactory());
vi.mock('../../lib/fileUtils.js', () => fx.fileUtilsFactory());

import { readFile } from 'fs/promises';
import { atomicWrite } from '../../lib/fileUtils.js';
import { clearLearningCache } from './store.js';
import { resetTaskTypeLearning } from './reset.js';

describe('TaskLearning - resetTaskTypeLearning', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    clearLearningCache();
    savedData = null;
    atomicWrite.mockImplementation(async (_path, data) => {
      savedData = data;
    });
  });

  it('should return not-found when task type does not exist', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    const result = await resetTaskTypeLearning('nonexistent-type');

    expect(result.reset).toBe(false);
    expect(result.reason).toBe('task-type-not-found');
  });

  it('should remove the task type from byTaskType', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    const result = await resetTaskTypeLearning('self-improve:ui');

    expect(result.reset).toBe(true);
    expect(result.taskType).toBe('self-improve:ui');
    expect(savedData.byTaskType['self-improve:ui']).toBeUndefined();
    expect(savedData.byTaskType['user-task']).toBeDefined();
  });

  it('should subtract task type metrics from totals', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    await resetTaskTypeLearning('self-improve:ui');

    // Original totals: completed=240, succeeded=40, failed=200, totalDurationMs=6000000
    // self-improve:ui: completed=200, succeeded=10, failed=190, totalDurationMs=2000000
    // After reset: completed=40, succeeded=30, failed=10, totalDurationMs=4000000
    expect(savedData.totals.completed).toBe(40);
    expect(savedData.totals.succeeded).toBe(30);
    expect(savedData.totals.failed).toBe(10);
    expect(savedData.totals.totalDurationMs).toBe(4000000);
    expect(savedData.totals.avgDurationMs).toBe(100000); // 4000000 / 40
  });

  it('should clean up error patterns referencing the task type', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    await resetTaskTypeLearning('self-improve:ui');

    // server-error had 190 total (185 from ui, 5 from user-task) → should now have 5
    expect(savedData.errorPatterns['server-error'].count).toBe(5);
    expect(savedData.errorPatterns['server-error'].taskTypes['self-improve:ui']).toBeUndefined();
    expect(savedData.errorPatterns['server-error'].taskTypes['user-task']).toBe(5);

    // unknown had 10 total, all from ui → should be removed entirely
    expect(savedData.errorPatterns['unknown']).toBeUndefined();
  });

  it('should return previous metrics in result', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    const result = await resetTaskTypeLearning('self-improve:ui');

    expect(result.previousMetrics).toEqual({
      completed: 200,
      succeeded: 10,
      failed: 190,
      successRate: 5
    });
  });

  it('should handle totals going to zero gracefully', async () => {
    const data = makeLearningData({
      byTaskType: {
        'self-improve:ui': {
          completed: 100, succeeded: 5, failed: 95,
          totalDurationMs: 500000, avgDurationMs: 5000,
          lastCompleted: '2026-01-25T00:00:00.000Z', successRate: 5
        }
      },
      errorPatterns: {},
      totals: {
        completed: 100, succeeded: 5, failed: 95,
        totalDurationMs: 500000, avgDurationMs: 5000
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    await resetTaskTypeLearning('self-improve:ui');

    expect(savedData.totals.completed).toBe(0);
    expect(savedData.totals.avgDurationMs).toBe(0);
  });

  it('clamps successDurationMs to >= 0 when a drifted store would go negative', async () => {
    // Hand-edited / older store where the running total drifted below a single
    // task type's accumulated successDurationMs. Subtracting unclamped would go
    // negative and feed calculateDurationETA a negative avgDurationMs.
    const data = makeLearningData({
      byTaskType: {
        'self-improve:ui': {
          completed: 10, succeeded: 8, failed: 2,
          totalDurationMs: 50000, avgDurationMs: 5000,
          successDurationMs: 500000, successMaxDurationMs: 80000,
          lastCompleted: '2026-01-25T00:00:00.000Z', successRate: 80
        }
      },
      errorPatterns: {},
      totals: {
        completed: 10, succeeded: 8, failed: 2,
        totalDurationMs: 50000, avgDurationMs: 5000,
        successDurationMs: 100000, successMaxDurationMs: 80000
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    await resetTaskTypeLearning('self-improve:ui');

    // 100000 - 500000 would be -400000; the clamp pins it at 0.
    expect(savedData.totals.successDurationMs).toBe(0);
  });
});
