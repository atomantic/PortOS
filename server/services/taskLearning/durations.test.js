import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only the persistence read; keep extractTaskType (a pure helper) real so
// the description→taskType resolution inside getTaskDurationEstimate is exercised
// end-to-end.
vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadLearningData: vi.fn() };
});

import { loadLearningData } from './store.js';
import { getTaskDurationEstimate, getAllTaskDurations } from './durations.js';

const baseData = (overrides = {}) => ({
  byTaskType: {},
  totals: { completed: 0, succeeded: 0, failed: 0, totalDurationMs: 0, avgDurationMs: 0 },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('durations.getTaskDurationEstimate', () => {
  it('classifies confidence by completion count for a matched type', async () => {
    loadLearningData.mockResolvedValue(baseData({
      byTaskType: {
        'self-improve:ui': { completed: 12, avgDurationMs: 60000, p80DurationMs: 90000, successRate: 80 },
      },
    }));
    const est = await getTaskDurationEstimate('[self-improvement] ui - tidy');
    expect(est.taskType).toBe('self-improve:ui');
    expect(est.estimatedDurationMin).toBe(1); // round(60000/60000)
    expect(est.p80DurationMs).toBe(90000);
    expect(est.confidence).toBe('high'); // >= 10
    expect(est.basedOn).toBe(12);
  });

  it('reports medium and low confidence at the tier boundaries', async () => {
    loadLearningData.mockResolvedValue(baseData({
      byTaskType: {
        'self-improve:ui': { completed: 5, avgDurationMs: 60000, successRate: 50 },
      },
    }));
    let est = await getTaskDurationEstimate('[self-improvement] ui');
    expect(est.confidence).toBe('medium'); // 5..9
    expect(est.p80DurationMs).toBe(60000); // falls back to avg when p80 absent

    loadLearningData.mockResolvedValue(baseData({
      byTaskType: {
        'self-improve:ui': { completed: 3, avgDurationMs: 60000, successRate: 50 },
      },
    }));
    est = await getTaskDurationEstimate('[self-improvement] ui');
    expect(est.confidence).toBe('low'); // 2..4
  });

  it('falls back to overall totals when the type has < 2 completions', async () => {
    loadLearningData.mockResolvedValue(baseData({
      byTaskType: { 'self-improve:ui': { completed: 1, avgDurationMs: 1000 } },
      totals: { completed: 6, succeeded: 3, failed: 3, totalDurationMs: 1200000, avgDurationMs: 200000 },
    }));
    const est = await getTaskDurationEstimate('[self-improvement] ui');
    expect(est.taskType).toBe('all');
    expect(est.confidence).toBe('low');
    expect(est.estimatedDurationMin).toBe(3); // round(200000/60000)
    expect(est.successRate).toBe(50); // round(3/6*100)
  });

  it('returns the none sentinel when there is not enough data anywhere', async () => {
    loadLearningData.mockResolvedValue(baseData({
      totals: { completed: 2, succeeded: 1, failed: 1, totalDurationMs: 100, avgDurationMs: 50 },
    }));
    const est = await getTaskDurationEstimate('something brand new');
    expect(est).toEqual({
      estimatedDurationMs: null, estimatedDurationMin: null,
      confidence: 'none', basedOn: 0, taskType: null, successRate: null,
    });
  });
});

describe('durations.getAllTaskDurations', () => {
  it('includes every type with >= 1 completion plus an _overall row', async () => {
    loadLearningData.mockResolvedValue(baseData({
      byTaskType: {
        a: { completed: 3, avgDurationMs: 60000, p80DurationMs: 90000, maxDurationMs: 120000, successRate: 66 },
        b: { completed: 0, avgDurationMs: 5000 }, // skipped (0 completions)
      },
      totals: { completed: 5, succeeded: 4, failed: 1, totalDurationMs: 600000, avgDurationMs: 120000 },
    }));
    const out = await getAllTaskDurations();
    expect(out.a).toMatchObject({ avgDurationMin: 1, p80DurationMs: 90000, maxDurationMs: 120000, completed: 3 });
    expect(out.b).toBeUndefined();
    expect(out._overall).toMatchObject({ completed: 5, successRate: 80 }); // round(4/5*100)
  });

  it('returns an empty object when there is no completed history', async () => {
    loadLearningData.mockResolvedValue(baseData());
    expect(await getAllTaskDurations()).toEqual({});
  });
});
