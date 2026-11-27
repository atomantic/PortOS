/**
 * routing.accuracy.test.js
 *
 * Behavior of routing.js accuracy and confidence views. Split from taskLearning.test.js (#16214); shared mocks live in
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
import { clearLearningCache } from './store.js';
import { summarizeRoutingAccuracy, getTaskTypeConfidence, summarizeConfidenceLevels } from './routing.js';

describe('TaskLearning - summarizeRoutingAccuracy', () => {
  it('should return routing accuracy matrix with misroutes', () => {
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
    const result = summarizeRoutingAccuracy(data);

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

  it('should return empty results when no routing data exists', () => {
    const result = summarizeRoutingAccuracy(makeLearningData());

    expect(result.matrix).toHaveLength(0);
    expect(result.misroutes).toHaveLength(0);
    expect(result.totalMisroutes).toBe(0);
  });

  it('should sort matrix tiers by success rate descending', () => {
    const data = makeLearningData({
      routingAccuracy: {
        'user-task': {
          light: { succeeded: 1, failed: 4, lastAttempt: '2026-01-25T00:00:00.000Z' },
          medium: { succeeded: 3, failed: 2, lastAttempt: '2026-01-25T00:00:00.000Z' },
          heavy: { succeeded: 9, failed: 1, lastAttempt: '2026-01-26T00:00:00.000Z' }
        }
      }
    });
    const result = summarizeRoutingAccuracy(data);

    const tiers = result.matrix[0].tiers;
    expect(tiers[0].tier).toBe('heavy');   // 90%
    expect(tiers[1].tier).toBe('medium');  // 60%
    expect(tiers[2].tier).toBe('light');   // 20%
  });

  it('reports the learned tier advice per task type, and omits it where history says nothing', () => {
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
        },
        'user-task': {
          medium: { succeeded: 2, failed: 0, lastAttempt: '2026-01-26T00:00:00.000Z' }
        }
      }
    });
    const result = summarizeRoutingAccuracy(data);
    const byType = Object.fromEntries(result.matrix.map((entry) => [entry.taskType, entry]));

    expect(byType['self-improve:ui'].suggestion.avoidTiers).toContain('light');
    expect(byType['user-task'].suggestion).toBeUndefined();
  });

  it('advises only pinnable tiers: retired thinking-level names map to their tier, user-specified never appears', () => {
    const outcome = { completed: 15, succeeded: 12, failed: 3, totalDurationMs: 1500000, avgDurationMs: 100000, successRate: 80 };
    const data = makeLearningData({
      byTaskType: { 'legacy-high': outcome, 'pinned-only': outcome },
      routingAccuracy: {
        'legacy-high': { high: { succeeded: 9, failed: 1, lastAttempt: '2026-01-26T00:00:00.000Z' } },
        'pinned-only': { 'user-specified': { succeeded: 9, failed: 1, lastAttempt: '2026-01-26T00:00:00.000Z' } }
      }
    });
    const result = summarizeRoutingAccuracy(data);
    const byType = Object.fromEntries(result.matrix.map((entry) => [entry.taskType, entry]));

    expect(byType['legacy-high'].suggestion.tier).toBe('heavy');
    expect(byType['pinned-only'].suggestion).toBeUndefined();
    // History is kept verbatim — only the advice is normalized.
    expect(byType['legacy-high'].tiers[0].tier).toBe('high');
  });
});

describe('TaskLearning - getTaskTypeConfidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLearningCache();
  });

  it('should return "new" tier for unknown task type with no data', async () => {
    const data = makeLearningData({ byTaskType: {} });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await getTaskTypeConfidence('unknown-type');
    expect(result.tier).toBe('new');
    expect(result.autoApprove).toBe(true);
    expect(result.completed).toBe(0);
    expect(result.successRate).toBeNull();
  });

  it('should return "new" tier when completed < minSamples (default 5)', async () => {
    const data = makeLearningData({
      byTaskType: { 'sparse-type': { completed: 3, succeeded: 3, failed: 0, successRate: 100 } }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await getTaskTypeConfidence('sparse-type');
    expect(result.tier).toBe('new');
    expect(result.autoApprove).toBe(true);
  });

  it('should return "high" tier when successRate >= 80 and enough samples', async () => {
    const data = makeLearningData({
      byTaskType: { 'reliable-type': { completed: 20, succeeded: 18, failed: 2, successRate: 90 } }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await getTaskTypeConfidence('reliable-type');
    expect(result.tier).toBe('high');
    expect(result.autoApprove).toBe(true);
    expect(result.successRate).toBe(90);
  });

  it('should return "medium" tier when successRate is between 50 and 80', async () => {
    const data = makeLearningData({
      byTaskType: { 'ok-type': { completed: 10, succeeded: 6, failed: 4, successRate: 60 } }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await getTaskTypeConfidence('ok-type');
    expect(result.tier).toBe('medium');
    expect(result.autoApprove).toBe(true);
  });

  it('should return "low" tier when successRate < 50 and enough samples', async () => {
    const data = makeLearningData({
      byTaskType: { 'flaky-type': { completed: 10, succeeded: 3, failed: 7, successRate: 30 } }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await getTaskTypeConfidence('flaky-type');
    expect(result.tier).toBe('low');
    expect(result.autoApprove).toBe(false);
  });

  it('should respect threshold overrides', async () => {
    const data = makeLearningData({
      byTaskType: { 'borderline': { completed: 10, succeeded: 7, failed: 3, successRate: 70 } }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    // With default thresholds (high=80), 70% is medium
    const defaultResult = await getTaskTypeConfidence('borderline');
    expect(defaultResult.tier).toBe('medium');

    clearLearningCache();
    readFile.mockResolvedValue(JSON.stringify(data));

    // With lowered highThreshold=60, 70% becomes high
    const overrideResult = await getTaskTypeConfidence('borderline', { highThreshold: 60 });
    expect(overrideResult.tier).toBe('high');
  });

  it('should respect minSamples override', async () => {
    const data = makeLearningData({
      byTaskType: { 'small-sample': { completed: 3, succeeded: 3, failed: 0, successRate: 100 } }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    // With minSamples=2, 3 completions is enough to classify
    const result = await getTaskTypeConfidence('small-sample', { minSamples: 2 });
    expect(result.tier).toBe('high');
    expect(result.autoApprove).toBe(true);
  });
});

describe('TaskLearning - summarizeConfidenceLevels', () => {
  it('should group task types into correct tiers', () => {
    const data = makeLearningData({
      byTaskType: {
        'high-type':   { completed: 10, succeeded: 9, failed: 1, successRate: 90 },
        'medium-type': { completed: 10, succeeded: 6, failed: 4, successRate: 60 },
        'low-type':    { completed: 10, succeeded: 3, failed: 7, successRate: 30 },
        'new-type':    { completed: 2,  succeeded: 2, failed: 0, successRate: 100 }
      }
    });
    const result = summarizeConfidenceLevels(data);
    expect(result.levels.high.map(t => t.taskType)).toContain('high-type');
    expect(result.levels.medium.map(t => t.taskType)).toContain('medium-type');
    expect(result.levels.low.map(t => t.taskType)).toContain('low-type');
    expect(result.levels.new.map(t => t.taskType)).toContain('new-type');
  });

  it('should return correct summary counts', () => {
    const data = makeLearningData({
      byTaskType: {
        'h1': { completed: 10, succeeded: 9, failed: 1, successRate: 90 },
        'h2': { completed: 10, succeeded: 8, failed: 2, successRate: 80 },
        'm1': { completed: 10, succeeded: 6, failed: 4, successRate: 60 },
        'l1': { completed: 10, succeeded: 3, failed: 7, successRate: 30 }
      }
    });
    const result = summarizeConfidenceLevels(data);
    expect(result.summary.high).toBe(2);
    expect(result.summary.medium).toBe(1);
    expect(result.summary.low).toBe(1);
    expect(result.summary.total).toBe(4);
    expect(result.summary.requireApproval).toBe(1);
  });

  it('should sort tiers by successRate descending', () => {
    const data = makeLearningData({
      byTaskType: {
        'a': { completed: 10, succeeded: 8, failed: 2, successRate: 80 },
        'b': { completed: 10, succeeded: 9, failed: 1, successRate: 90 },
        'c': { completed: 10, succeeded: 8, failed: 2, successRate: 80 }
      }
    });
    const result = summarizeConfidenceLevels(data);
    const highRates = result.levels.high.map(t => t.successRate);
    expect(highRates).toEqual([...highRates].sort((a, b) => b - a));
  });

  it('should reflect threshold overrides in returned thresholds', () => {
    const data = makeLearningData({ byTaskType: {} });
    const result = summarizeConfidenceLevels(data, { highThreshold: 90, lowThreshold: 60, minSamples: 3 });
    expect(result.thresholds).toEqual({ highThreshold: 90, lowThreshold: 60, minSamples: 3 });
  });

  it('should return empty levels when no task types exist', () => {
    const data = makeLearningData({ byTaskType: {} });
    const result = summarizeConfidenceLevels(data);
    expect(result.summary.total).toBe(0);
    expect(result.levels.high).toHaveLength(0);
    expect(result.levels.low).toHaveLength(0);
  });
});
