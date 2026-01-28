import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises and fs before importing the module
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn()
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}));

// Mock cos.js to avoid circular dependency
vi.mock('./cos.js', () => ({
  cosEvents: { on: vi.fn(), emit: vi.fn() },
  emitLog: vi.fn()
}));

import { readFile, writeFile } from 'fs/promises';
import { resetTaskTypeLearning, getSkippedTaskTypes } from './taskLearning.js';

const makeLearningData = (overrides = {}) => ({
  version: 1,
  lastUpdated: '2026-01-26T00:00:00.000Z',
  byTaskType: {
    'self-improve:ui': {
      completed: 200,
      succeeded: 10,
      failed: 190,
      totalDurationMs: 2000000,
      avgDurationMs: 10000,
      lastCompleted: '2026-01-25T00:00:00.000Z',
      successRate: 5
    },
    'user-task': {
      completed: 40,
      succeeded: 30,
      failed: 10,
      totalDurationMs: 4000000,
      avgDurationMs: 100000,
      lastCompleted: '2026-01-26T00:00:00.000Z',
      successRate: 75
    }
  },
  byModelTier: {
    'user-specified': {
      completed: 240,
      succeeded: 40,
      failed: 200,
      totalDurationMs: 6000000,
      avgDurationMs: 25000
    }
  },
  errorPatterns: {
    'server-error': {
      count: 190,
      taskTypes: { 'self-improve:ui': 185, 'user-task': 5 },
      lastOccurred: '2026-01-25T00:00:00.000Z'
    },
    'unknown': {
      count: 10,
      taskTypes: { 'self-improve:ui': 10 },
      lastOccurred: '2026-01-24T00:00:00.000Z'
    }
  },
  totals: {
    completed: 240,
    succeeded: 40,
    failed: 200,
    totalDurationMs: 6000000,
    avgDurationMs: 25000
  },
  ...overrides
});

describe('TaskLearning - resetTaskTypeLearning', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    savedData = null;
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
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
});

describe('TaskLearning - getSkippedTaskTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return task types with <30% success and 5+ attempts', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    const skipped = await getSkippedTaskTypes();

    expect(skipped).toHaveLength(1);
    expect(skipped[0].taskType).toBe('self-improve:ui');
    expect(skipped[0].successRate).toBe(5);
  });

  it('should not include task types with >= 30% success', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    const skipped = await getSkippedTaskTypes();

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
    writeFile.mockImplementation(async (_path, content) => {
      currentData = content;
    });

    await resetTaskTypeLearning('self-improve:ui');
    const skipped = await getSkippedTaskTypes();

    expect(skipped).toHaveLength(0);
  });
});
