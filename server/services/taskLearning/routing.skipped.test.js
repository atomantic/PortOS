/**
 * routing.skipped.test.js
 *
 * Behavior of routing.js skip-candidate selection (findLowSuccessTaskTypes). Split from taskLearning.test.js (#16214); shared mocks live in
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
vi.mock('../cos/cos.js', () => ({}));
vi.mock('../cos/cosEvents.js', () => fx.cosEventsFactory());
vi.mock('../../lib/fileUtils.js', () => fx.fileUtilsFactory());

import { readFile } from 'fs/promises';
import { atomicWrite } from '../../lib/fileUtils.js';
import { clearLearningCache, loadLearningData } from './store.js';
import { resetTaskTypeLearning } from './reset.js';
import { findLowSuccessTaskTypes } from './routing.js';

describe('TaskLearning - findLowSuccessTaskTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLearningCache();
  });

  it('should return task types with <30% success and 5+ attempts', () => {
    const skipped = findLowSuccessTaskTypes(makeLearningData());

    expect(skipped).toHaveLength(1);
    expect(skipped[0].taskType).toBe('self-improve:ui');
    expect(skipped[0].successRate).toBe(5);
  });

  it('should not include task types with >= 30% success', () => {
    const skipped = findLowSuccessTaskTypes(makeLearningData());

    const userTask = skipped.find(s => s.taskType === 'user-task');
    expect(userTask).toBeUndefined();
  });

  it('should return empty after resetting a skipped type', async () => {
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

    // Track what was written so subsequent reads return updated data
    let currentData = JSON.stringify(data);
    readFile.mockImplementation(async () => currentData);
    atomicWrite.mockImplementation(async (_path, data) => {
      currentData = JSON.stringify(data);
    });

    await resetTaskTypeLearning('self-improve:ui');
    const skipped = findLowSuccessTaskTypes(await loadLearningData());

    expect(skipped).toHaveLength(0);
  });

  it('should clean up routingAccuracy data when resetting a task type', async () => {
    let savedData;
    atomicWrite.mockImplementation(async (_path, data) => {
      savedData = data;
    });

    const data = makeLearningData({
      routingAccuracy: {
        'self-improve:ui': {
          heavy: { succeeded: 2, failed: 8, lastAttempt: '2026-01-25T00:00:00.000Z' },
          medium: { succeeded: 0, failed: 5, lastAttempt: '2026-01-24T00:00:00.000Z' }
        },
        'user-task': {
          heavy: { succeeded: 10, failed: 2, lastAttempt: '2026-01-26T00:00:00.000Z' }
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    await resetTaskTypeLearning('self-improve:ui');

    expect(savedData.routingAccuracy['self-improve:ui']).toBeUndefined();
    expect(savedData.routingAccuracy['user-task']).toBeDefined();
  });

  it('should subtract from byModelTier when resetting a task type with routing data', async () => {
    let savedData;
    atomicWrite.mockImplementation(async (_path, data) => {
      savedData = data;
    });

    const data = makeLearningData({
      byModelTier: {
        heavy: {
          completed: 50,
          succeeded: 20,
          failed: 30,
          totalDurationMs: 500000,
          avgDurationMs: 10000
        },
        medium: {
          completed: 10,
          succeeded: 2,
          failed: 8,
          totalDurationMs: 100000,
          avgDurationMs: 10000
        }
      },
      routingAccuracy: {
        'self-improve:ui': {
          heavy: { succeeded: 5, failed: 15, lastAttempt: '2026-01-25T00:00:00.000Z' },
          medium: { succeeded: 0, failed: 5, lastAttempt: '2026-01-24T00:00:00.000Z' }
        },
        'user-task': {
          heavy: { succeeded: 10, failed: 2, lastAttempt: '2026-01-26T00:00:00.000Z' }
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    await resetTaskTypeLearning('self-improve:ui');

    // heavy: was 50 completed (20 succeeded, 30 failed), subtract 20 (5+15) from self-improve:ui
    expect(savedData.byModelTier.heavy.completed).toBe(30);
    expect(savedData.byModelTier.heavy.succeeded).toBe(15);
    expect(savedData.byModelTier.heavy.failed).toBe(15);
    // medium: was 10 completed, subtract 5 (0+5) from self-improve:ui
    expect(savedData.byModelTier.medium.completed).toBe(5);
    expect(savedData.byModelTier.medium.succeeded).toBe(2);
    expect(savedData.byModelTier.medium.failed).toBe(3);
    // user-task routing should be untouched
    expect(savedData.routingAccuracy['user-task']).toBeDefined();
  });

  it('should delete byModelTier entry when count reaches zero', async () => {
    let savedData;
    atomicWrite.mockImplementation(async (_path, data) => {
      savedData = data;
    });

    const data = makeLearningData({
      byModelTier: {
        'user-specified': {
          completed: 240,
          succeeded: 40,
          failed: 200,
          totalDurationMs: 6000000,
          avgDurationMs: 25000
        },
        medium: {
          completed: 5,
          succeeded: 0,
          failed: 5,
          totalDurationMs: 50000,
          avgDurationMs: 10000
        }
      },
      routingAccuracy: {
        'self-improve:ui': {
          medium: { succeeded: 0, failed: 5, lastAttempt: '2026-01-24T00:00:00.000Z' }
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    await resetTaskTypeLearning('self-improve:ui');

    // medium tier had 5 completed, all from self-improve:ui → should be deleted
    expect(savedData.byModelTier.medium).toBeUndefined();
    // user-specified should be untouched (no routing data for it)
    expect(savedData.byModelTier['user-specified']).toBeDefined();
  });
});
