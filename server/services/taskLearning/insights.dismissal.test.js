/**
 * insights.dismissal.test.js
 *
 * Behavior of insights.js recommendation dismissal. Split from taskLearning.test.js (#16214); shared mocks live in
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
import { clearLearningCache } from './store.js';
import { dismissRecommendation, restoreRecommendation, clearDismissedRecommendations, getLearningInsights } from './insights.js';

describe('TaskLearning - recommendation dismissal', () => {
  let writes;

  // Route reads by file path so learning.json and dismissed-recommendations.json
  // can return different content within a single test.
  const setupFiles = ({ learning = {}, dismissed = {} } = {}) => {
    readFile.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('dismissed-recommendations.json')) {
        return JSON.stringify(dismissed);
      }
      return JSON.stringify(learning);
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearLearningCache();
    writes = {};
    atomicWrite.mockImplementation(async (filePath, data) => {
      writes[String(filePath)] = data;
    });
  });

  it('dismissRecommendation persists id with snapshot and timestamp', async () => {
    setupFiles();

    const result = await dismissRecommendation('error-pattern:unknown', { kind: 'count', value: 74 });

    expect(result).toEqual({ id: 'error-pattern:unknown', dismissed: true });
    const saved = Object.entries(writes).find(([p]) => p.endsWith('dismissed-recommendations.json'))?.[1];
    expect(saved).toBeDefined();
    expect(saved['error-pattern:unknown']).toMatchObject({
      snapshot: { kind: 'count', value: 74 }
    });
    expect(saved['error-pattern:unknown'].dismissedAt).toBeDefined();
  });

  it('restoreRecommendation removes the id from the dismissed map', async () => {
    setupFiles({
      dismissed: {
        'error-pattern:unknown': { dismissedAt: '2026-05-07T00:00:00.000Z', snapshot: { kind: 'count', value: 74 } }
      }
    });

    const result = await restoreRecommendation('error-pattern:unknown');

    expect(result).toEqual({ id: 'error-pattern:unknown', restored: true });
    const saved = Object.entries(writes).find(([p]) => p.endsWith('dismissed-recommendations.json'))?.[1];
    expect(saved['error-pattern:unknown']).toBeUndefined();
  });

  it('restoreRecommendation reports false when id was not dismissed', async () => {
    setupFiles({ dismissed: {} });

    const result = await restoreRecommendation('error-pattern:unknown');

    expect(result).toEqual({ id: 'error-pattern:unknown', restored: false });
  });

  it('clearDismissedRecommendations writes an empty map', async () => {
    setupFiles({
      dismissed: {
        'a': { dismissedAt: '2026-05-07T00:00:00.000Z' },
        'b': { dismissedAt: '2026-05-07T01:00:00.000Z' }
      }
    });

    const result = await clearDismissedRecommendations();

    expect(result).toEqual({ cleared: true });
    const saved = Object.entries(writes).find(([p]) => p.endsWith('dismissed-recommendations.json'))?.[1];
    expect(saved).toEqual({});
  });

  it('getLearningInsights filters dismissed rate-based recommendation permanently', async () => {
    const learning = makeLearningData({
      byTaskType: {
        // 100% success rate — would generate top-perf optimization recommendation
        'self-improve:accessibility': {
          completed: 50, succeeded: 50, failed: 0,
          totalDurationMs: 500000, avgDurationMs: 10000,
          lastCompleted: '2026-05-07T00:00:00.000Z', successRate: 100
        }
      },
      errorPatterns: {},
      byModelTier: {},
      totals: { completed: 50, succeeded: 50, failed: 0, totalDurationMs: 500000, avgDurationMs: 10000 }
    });
    setupFiles({
      learning,
      dismissed: {
        'top-perf:self-improve:accessibility': {
          dismissedAt: '2026-05-07T00:00:00.000Z',
          snapshot: { kind: 'rate', value: 100 }
        }
      }
    });

    const insights = await getLearningInsights();
    const ids = (insights.recommendations || []).map(r => r.id);
    expect(ids).not.toContain('top-perf:self-improve:accessibility');
  });

  it('getLearningInsights re-surfaces a count-based dismissal when the count grows past threshold', async () => {
    const learning = makeLearningData({
      byTaskType: {},
      errorPatterns: {
        'unknown': {
          count: 200, // grew significantly past the snapshot of 74
          taskTypes: { 'self-improve:ui': 200 },
          lastOccurred: '2026-05-08T00:00:00.000Z'
        }
      },
      byModelTier: {},
      totals: { completed: 200, succeeded: 0, failed: 200, totalDurationMs: 0, avgDurationMs: 0 }
    });
    setupFiles({
      learning,
      dismissed: {
        'error-pattern:unknown': {
          dismissedAt: '2026-04-01T00:00:00.000Z',
          snapshot: { kind: 'count', value: 74 }
        }
      }
    });

    const insights = await getLearningInsights();
    const ids = (insights.recommendations || []).map(r => r.id);
    expect(ids).toContain('error-pattern:unknown');
  });

  it('getLearningInsights keeps a count-based dismissal suppressed when count is unchanged', async () => {
    const learning = makeLearningData({
      byTaskType: {},
      errorPatterns: {
        'unknown': {
          count: 80, // only marginally higher than dismissal snapshot of 74
          taskTypes: { 'self-improve:ui': 80 },
          lastOccurred: '2026-05-08T00:00:00.000Z'
        }
      },
      byModelTier: {},
      totals: { completed: 80, succeeded: 0, failed: 80, totalDurationMs: 0, avgDurationMs: 0 }
    });
    setupFiles({
      learning,
      dismissed: {
        'error-pattern:unknown': {
          dismissedAt: '2026-04-01T00:00:00.000Z',
          snapshot: { kind: 'count', value: 74 }
        }
      }
    });

    const insights = await getLearningInsights();
    const ids = (insights.recommendations || []).map(r => r.id);
    expect(ids).not.toContain('error-pattern:unknown');
  });

  it('getLearningInsights gives every recommendation a stable id', async () => {
    const learning = makeLearningData({
      byTaskType: {
        'self-improve:accessibility': {
          completed: 50, succeeded: 50, failed: 0,
          totalDurationMs: 500000, avgDurationMs: 10000,
          lastCompleted: '2026-05-07T00:00:00.000Z', successRate: 100
        }
      },
      errorPatterns: {
        'unknown': { count: 74, taskTypes: { 'self-improve:ui': 74 }, lastOccurred: '2026-05-07T00:00:00.000Z' }
      },
      byModelTier: {},
      totals: { completed: 50, succeeded: 50, failed: 0, totalDurationMs: 500000, avgDurationMs: 10000 }
    });
    setupFiles({ learning, dismissed: {} });

    const insights = await getLearningInsights();
    expect(insights.recommendations.length).toBeGreaterThan(0);
    for (const rec of insights.recommendations) {
      expect(rec.id).toBeTruthy();
      expect(typeof rec.id).toBe('string');
    }
  });
});
