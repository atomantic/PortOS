import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadLearningData: vi.fn(),
    loadDismissedRecommendations: vi.fn()
  };
});

import { loadLearningData, loadDismissedRecommendations } from './store.js';
import { getLearningInsights, getLearningSummary } from './insights.js';

const learningData = (overrides = {}) => ({
  lastUpdated: '2026-07-09T00:00:00Z',
  totals: { completed: 10, succeeded: 6, avgDurationMs: 60000 },
  byTaskType: {},
  errorPatterns: {},
  byModelTier: {},
  correlationWindow: [],
  failureSignatures: {},
  recentUnknownErrors: [],
  ...overrides
});

beforeEach(() => {
  vi.clearAllMocks();
  loadDismissedRecommendations.mockResolvedValue({});
});

describe('insights.getLearningInsights — failureSignatures consumption (issue #2333)', () => {
  it('surfaces the enriched failureSignatures summary in the insights view', async () => {
    loadLearningData.mockResolvedValue(learningData({
      failureSignatures: {
        'tool-error': {
          count: 4, lastOccurred: '2026-07-09T01:00:00Z',
          recent: [
            { provider: 'claude', model: 'opus', taskType: 'auto-fix', validationPassed: false, messageSnippet: 'a' },
            { provider: 'claude', model: 'opus', taskType: 'auto-fix', validationPassed: true, messageSnippet: 'b' }
          ]
        }
      }
    }));
    const view = await getLearningInsights();
    expect(view.insights.failureSignatures).toHaveLength(1);
    expect(view.insights.failureSignatures[0]).toMatchObject({
      category: 'tool-error',
      providers: [{ key: 'claude/opus', count: 2 }],
      validationMissed: 1
    });
  });

  it('emits a provider-attributed recommendation once a provider has >= 3 recent failures', async () => {
    const recent = Array.from({ length: 3 }, (_, i) => ({
      provider: 'codex', model: 'gpt', taskType: 'auto-fix', validationPassed: i === 0 ? false : null, messageSnippet: 'x'
    }));
    loadLearningData.mockResolvedValue(learningData({
      failureSignatures: { 'startup-failure': { count: 3, recent } }
    }));
    const view = await getLearningInsights();
    const rec = view.recommendations.find(r => r.id === 'failure-signature:startup-failure');
    expect(rec).toBeTruthy();
    expect(rec.message).toContain('codex/gpt');
    expect(rec.snapshot).toEqual({ kind: 'count', value: 3 });
  });

  it('does not emit a failure-signature recommendation below the 3-failure threshold', async () => {
    loadLearningData.mockResolvedValue(learningData({
      failureSignatures: {
        'tool-error': { count: 2, recent: [
          { provider: 'codex', model: 'gpt', taskType: 'auto-fix', validationPassed: null },
          { provider: 'codex', model: 'gpt', taskType: 'auto-fix', validationPassed: null }
        ] }
      }
    }));
    const view = await getLearningInsights();
    expect(view.recommendations.some(r => r.id?.startsWith('failure-signature:'))).toBe(false);
  });
});

describe('insights.getLearningInsights — standing learnings surfacing (issue #2443)', () => {
  it('surfaces recorded insights (newest first) with their origin preserved', async () => {
    loadLearningData.mockResolvedValue(learningData({
      insights: [
        { origin: 'user', message: 'older manual note', recordedAt: '2026-07-08T00:00:00Z' },
        { origin: 'auto-incident', category: 'timeout', taskType: 'auto-fix', recurrenceCount: 3, message: 'recurring failure', recordedAt: '2026-07-09T00:00:00Z' }
      ]
    }));
    const view = await getLearningInsights();
    expect(view.standingLearnings).toHaveLength(2);
    // Newest first.
    expect(view.standingLearnings[0].origin).toBe('auto-incident');
    expect(view.standingLearnings[0].recurrenceCount).toBe(3);
    expect(view.standingLearnings[1].origin).toBe('user');
  });

  it('returns an empty array when no insights have been recorded', async () => {
    loadLearningData.mockResolvedValue(learningData());
    const view = await getLearningInsights();
    expect(view.standingLearnings).toEqual([]);
  });
});

describe('insights.getLearningSummary — effective (windowed) rates (issue #2617)', () => {
  const ring = (results, now = Date.now()) =>
    results.map((s, i) => ({ t: new Date(now - (results.length - i) * 60000).toISOString(), s }));

  it('does not count a windowed-recovered type as skipped (no false "critical" alert)', async () => {
    // Lifetime 27% after a since-fixed bug, 15 recent successes → the
    // scheduler no longer skips it, so the dashboard/alert summary must not
    // claim it is skipped either.
    loadLearningData.mockResolvedValue(learningData({
      totals: { completed: 55, succeeded: 15, avgDurationMs: 60000 },
      byTaskType: {
        'recovered': {
          completed: 55, succeeded: 15, failed: 40, successRate: 27,
          recentOutcomes: ring(Array(15).fill(true))
        }
      }
    }));
    const summary = await getLearningSummary();
    expect(summary.skipped).toBe(0);
    expect(summary.healthy).toBe(1); // windowed 100% ≥ 70
    expect(summary.status).not.toBe('critical');
  });

  it('still counts a genuinely failing type as skipped', async () => {
    loadLearningData.mockResolvedValue(learningData({
      totals: { completed: 20, succeeded: 2, avgDurationMs: 60000 },
      byTaskType: {
        'still-broken': {
          completed: 20, succeeded: 2, failed: 18, successRate: 10,
          recentOutcomes: ring(Array(8).fill(false))
        }
      }
    }));
    const summary = await getLearningSummary();
    expect(summary.skipped).toBe(1);
    expect(summary.status).toBe('critical');
  });
});
