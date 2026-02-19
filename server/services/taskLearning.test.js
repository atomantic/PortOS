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

// Mock fileUtils.js to use our mocked fs/promises
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const fsPromises = await import('fs/promises');
  const fs = await import('fs');
  return {
    readJSONFile: vi.fn(async (filePath, defaultValue) => {
      if (!fs.existsSync(filePath)) return defaultValue;
      const content = await fsPromises.readFile(filePath, 'utf-8');
      if (!content || !content.trim()) return defaultValue;
      return JSON.parse(content);
    })
  };
});

import { readFile, writeFile } from 'fs/promises';
import { resetTaskTypeLearning, getSkippedTaskTypes, recordTaskCompletion, getRoutingAccuracy, suggestModelTier } from './taskLearning.js';

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

  it('should clean up routingAccuracy data when resetting a task type', async () => {
    let savedData;
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
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
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
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
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
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

describe('TaskLearning - recordTaskCompletion routing accuracy', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    savedData = null;
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
    });
  });

  it('should record routing accuracy for successful task', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    const agent = {
      metadata: { modelTier: 'heavy', taskDescription: 'Fix some UI bugs' },
      result: { success: true, duration: 60000 }
    };
    const task = { description: 'Fix some UI bugs', taskType: 'user', metadata: {} };

    await recordTaskCompletion(agent, task);

    expect(savedData.routingAccuracy).toBeDefined();
    expect(savedData.routingAccuracy['user-task']).toBeDefined();
    expect(savedData.routingAccuracy['user-task']['heavy']).toBeDefined();
    expect(savedData.routingAccuracy['user-task']['heavy'].succeeded).toBe(1);
    expect(savedData.routingAccuracy['user-task']['heavy'].failed).toBe(0);
  });

  it('should record routing accuracy for failed task', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    const agent = {
      metadata: { modelTier: 'light', taskDescription: 'Fix UI' },
      result: { success: false, duration: 30000 }
    };
    const task = { description: 'Fix UI', taskType: 'user', metadata: {} };

    await recordTaskCompletion(agent, task);

    expect(savedData.routingAccuracy['user-task']['light'].succeeded).toBe(0);
    expect(savedData.routingAccuracy['user-task']['light'].failed).toBe(1);
    expect(savedData.routingAccuracy['user-task']['light'].lastAttempt).toBeDefined();
  });

  it('should accumulate routing accuracy across multiple completions', async () => {
    let currentData = JSON.stringify(makeLearningData());
    readFile.mockImplementation(async () => currentData);
    writeFile.mockImplementation(async (_path, content) => {
      currentData = content;
      savedData = JSON.parse(content);
    });

    const makeAgent = (tier, success) => ({
      metadata: { modelTier: tier, taskDescription: 'Test task' },
      result: { success, duration: 30000 }
    });
    const task = { description: 'Test task', taskType: 'user', metadata: {} };

    await recordTaskCompletion(makeAgent('medium', true), task);
    await recordTaskCompletion(makeAgent('medium', true), task);
    await recordTaskCompletion(makeAgent('medium', false), task);

    expect(savedData.routingAccuracy['user-task']['medium'].succeeded).toBe(2);
    expect(savedData.routingAccuracy['user-task']['medium'].failed).toBe(1);
  });
});

describe('TaskLearning - getRoutingAccuracy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return routing accuracy matrix with misroutes', async () => {
    const data = makeLearningData({
      routingAccuracy: {
        'self-improve:ui': {
          light: { succeeded: 1, failed: 9, lastAttempt: '2026-01-25T00:00:00.000Z' },
          heavy: { succeeded: 8, failed: 2, lastAttempt: '2026-01-26T00:00:00.000Z' }
        },
        'user-task': {
          medium: { succeeded: 15, failed: 3, lastAttempt: '2026-01-26T00:00:00.000Z' }
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await getRoutingAccuracy();

    expect(result.matrix).toHaveLength(2);
    expect(result.totalMisroutes).toBe(1); // self-improve:ui on light (10% success, 10 attempts)

    // Check misroutes
    expect(result.misroutes).toHaveLength(1);
    expect(result.misroutes[0].taskType).toBe('self-improve:ui');
    expect(result.misroutes[0].tier).toBe('light');
    expect(result.misroutes[0].successRate).toBe(10);

    // Check tier overview
    expect(result.tierOverview.length).toBeGreaterThan(0);
  });

  it('should return empty results when no routing data exists', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    const result = await getRoutingAccuracy();

    expect(result.matrix).toHaveLength(0);
    expect(result.misroutes).toHaveLength(0);
    expect(result.totalMisroutes).toBe(0);
  });

  it('should sort matrix tiers by success rate descending', async () => {
    const data = makeLearningData({
      routingAccuracy: {
        'user-task': {
          light: { succeeded: 1, failed: 4, lastAttempt: '2026-01-25T00:00:00.000Z' },
          medium: { succeeded: 3, failed: 2, lastAttempt: '2026-01-25T00:00:00.000Z' },
          heavy: { succeeded: 9, failed: 1, lastAttempt: '2026-01-26T00:00:00.000Z' }
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await getRoutingAccuracy();

    const tiers = result.matrix[0].tiers;
    expect(tiers[0].tier).toBe('heavy');   // 90%
    expect(tiers[1].tier).toBe('medium');  // 60%
    expect(tiers[2].tier).toBe('light');   // 20%
  });
});

describe('TaskLearning - suggestModelTier with routing signals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should suggest avoiding failing tiers', async () => {
    const data = makeLearningData({
      byTaskType: {
        'self-improve:ui': {
          completed: 20, succeeded: 8, failed: 12,
          totalDurationMs: 2000000, avgDurationMs: 100000,
          successRate: 40
        }
      },
      routingAccuracy: {
        'self-improve:ui': {
          light: { succeeded: 1, failed: 9, lastAttempt: '2026-01-25T00:00:00.000Z' },
          heavy: { succeeded: 7, failed: 3, lastAttempt: '2026-01-26T00:00:00.000Z' }
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await suggestModelTier('self-improve:ui');

    expect(result).not.toBeNull();
    expect(result.avoidTiers).toContain('light');
  });

  it('should suggest best performing tier when available', async () => {
    const data = makeLearningData({
      byTaskType: {
        'user-task': {
          completed: 15, succeeded: 12, failed: 3,
          totalDurationMs: 1500000, avgDurationMs: 100000,
          successRate: 80
        }
      },
      routingAccuracy: {
        'user-task': {
          medium: { succeeded: 9, failed: 1, lastAttempt: '2026-01-26T00:00:00.000Z' },
          heavy: { succeeded: 3, failed: 2, lastAttempt: '2026-01-25T00:00:00.000Z' }
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await suggestModelTier('user-task');

    expect(result).not.toBeNull();
    expect(result.suggested).toBe('medium'); // 90% success vs heavy at 60%
  });

  it('should return null when insufficient data', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData({
      byTaskType: {
        'new-task': { completed: 2, succeeded: 1, failed: 1, successRate: 50 }
      }
    })));

    const result = await suggestModelTier('new-task');
    expect(result).toBeNull();
  });
});
