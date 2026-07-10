import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadLearningData: vi.fn() };
});

import { loadLearningData } from './store.js';
import { getPromptImprovementRecommendations, getAllPromptRecommendations } from './promptRecommendations.js';

const data = (overrides = {}) => ({ byTaskType: {}, errorPatterns: {}, ...overrides });

beforeEach(() => vi.clearAllMocks());

describe('promptRecommendations.getPromptImprovementRecommendations', () => {
  it('reports insufficient-data when the type is missing or under 3 completions', async () => {
    loadLearningData.mockResolvedValue(data());
    let rec = await getPromptImprovementRecommendations('absent-type');
    expect(rec.hasData).toBe(false);
    expect(rec.status).toBe('insufficient-data');

    loadLearningData.mockResolvedValue(data({
      byTaskType: { sparse: { completed: 2, failed: 1, successRate: 50, avgDurationMs: 1000 } },
    }));
    rec = await getPromptImprovementRecommendations('sparse');
    expect(rec.status).toBe('insufficient-data');
    expect(rec.message).toContain('2 completions');
  });

  it('flags a critical status with a major-revision suggestion under 30% success', async () => {
    loadLearningData.mockResolvedValue(data({
      byTaskType: { t: { completed: 10, failed: 8, successRate: 20, avgDurationMs: 60000 } },
    }));
    const rec = await getPromptImprovementRecommendations('t');
    expect(rec.status).toBe('critical');
    expect(rec.suggestions[0]).toMatchObject({ priority: 'high', type: 'major-revision' });
  });

  it('maps each success-rate band to the right status', async () => {
    const bands = [
      [40, 'needs-improvement'],
      [60, 'moderate'],
      [90, 'good'],
    ];
    for (const [successRate, status] of bands) {
      loadLearningData.mockResolvedValue(data({
        byTaskType: { t: { completed: 10, failed: 4, successRate, avgDurationMs: 60000 } },
      }));
      const rec = await getPromptImprovementRecommendations('t');
      expect(rec.status).toBe(status);
    }
  });

  it('derives error insights and prompt hints from task-specific error patterns', async () => {
    loadLearningData.mockResolvedValue(data({
      byTaskType: { t: { completed: 10, failed: 10, successRate: 20, avgDurationMs: 60000 } },
      errorPatterns: {
        'context-length': { taskTypes: { t: 5 } },
        'rate-limit': { taskTypes: { t: 5 } },
        'uncategorized-no-insight': { taskTypes: { t: 1 } },
      },
    }));
    const rec = await getPromptImprovementRecommendations('t');
    const insightMsgs = rec.errorInsights.map(i => i.message).join(' ');
    expect(insightMsgs).toMatch(/context length/);
    expect(insightMsgs).toMatch(/rate limiting/);
    // categories without a known insight/hint contribute nothing
    expect(rec.errorInsights).toHaveLength(2);
    expect(rec.promptHints.some(h => h.hint === 'Reduce scope of file analysis')).toBe(true);
  });

  it('adds a scope suggestion when the average duration exceeds 30 minutes', async () => {
    loadLearningData.mockResolvedValue(data({
      byTaskType: { t: { completed: 10, failed: 1, successRate: 90, avgDurationMs: 40 * 60000 } },
    }));
    const rec = await getPromptImprovementRecommendations('t');
    expect(rec.suggestions.some(s => s.type === 'scope')).toBe(true);
  });

  it('appends general hints based on task-type keywords', async () => {
    loadLearningData.mockResolvedValue(data({
      byTaskType: { 'self-improve:security-audit': { completed: 10, failed: 1, successRate: 90, avgDurationMs: 1000 } },
    }));
    const rec = await getPromptImprovementRecommendations('self-improve:security-audit');
    expect(rec.promptHints.some(h => h.hint === 'Add severity classification')).toBe(true);
  });

  it('consumes the enriched failureSignatures map for provider-attributed suggestions (issue #2333)', async () => {
    loadLearningData.mockResolvedValue(data({
      byTaskType: { t: { completed: 10, failed: 6, successRate: 40, avgDurationMs: 60000 } },
      failureSignatures: {
        'tool-error': {
          count: 4, lastOccurred: '2026-07-09T00:00:00Z',
          recent: [
            { taskType: 't', provider: 'claude', model: 'opus', validationPassed: false, messageSnippet: 'x' },
            { taskType: 't', provider: 'claude', model: 'opus', validationPassed: true, messageSnippet: 'y' },
            { taskType: 'other', provider: 'codex', model: 'gpt', validationPassed: false, messageSnippet: 'z' }
          ]
        }
      },
    }));
    const rec = await getPromptImprovementRecommendations('t');
    // Only the two 't' samples inform this task type's summary.
    expect(rec.failureSignatures).toHaveLength(1);
    expect(rec.failureSignatures[0].providers[0]).toEqual({ key: 'claude/opus', count: 2 });
    const sig = rec.suggestions.find(s => s.type === 'failure-signature');
    expect(sig).toBeTruthy();
    expect(sig.priority).toBe('high'); // a validation miss present → high
    expect(sig.message).toContain('claude/opus');
  });

  it('omits a failure-signature suggestion when a provider has fewer than 2 recent failures', async () => {
    loadLearningData.mockResolvedValue(data({
      byTaskType: { t: { completed: 10, failed: 6, successRate: 40, avgDurationMs: 60000 } },
      failureSignatures: {
        'tool-error': { count: 1, recent: [{ taskType: 't', provider: 'claude', model: 'opus', validationPassed: null }] }
      },
    }));
    const rec = await getPromptImprovementRecommendations('t');
    expect(rec.failureSignatures).toHaveLength(1);
    expect(rec.suggestions.some(s => s.type === 'failure-signature')).toBe(false);
  });
});

describe('promptRecommendations.getAllPromptRecommendations', () => {
  it('returns only types with >= 3 completions, sorted critical-first', async () => {
    loadLearningData.mockResolvedValue(data({
      byTaskType: {
        good: { completed: 10, failed: 1, successRate: 90, avgDurationMs: 1000 },
        broken: { completed: 10, failed: 9, successRate: 10, avgDurationMs: 1000 },
        tiny: { completed: 2, failed: 1, successRate: 50, avgDurationMs: 1000 },
      },
    }));
    const all = await getAllPromptRecommendations();
    // critical (priority 0) must sort first — regression guard against the
    // `priorityOrder[status] || 5` footgun that treated 0 as falsy and sorted
    // the most urgent recommendation last.
    expect(all.map(r => r.taskType)).toEqual(['broken', 'good']);
    expect(all[0].status).toBe('critical');
  });
});
