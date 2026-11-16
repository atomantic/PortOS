/**
 * routing.suggestModelTier.test.js
 *
 * Behavior of routing.js suggestModelTier with routing signals. Split from taskLearning.test.js (#16214); shared mocks live in
 * taskLearning.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const fx = await vi.hoisted(() => import('./taskLearning.testFixtures.js'));
const { makeLearningData, provenCorrelationWindow } = fx;

vi.mock('fs/promises', () => fx.fsPromisesFactory());
vi.mock('fs', () => fx.fsFactory());
// Mock cos.js to avoid circular dependency
vi.mock('../cos.js', () => ({}));
vi.mock('../cosEvents.js', () => fx.cosEventsFactory());
vi.mock('../../lib/fileUtils.js', () => fx.fileUtilsFactory());

import { readFile } from 'fs/promises';
import { clearLearningCache } from './store.js';
import { suggestModelTier } from './routing.js';

describe('TaskLearning - suggestModelTier with routing signals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLearningCache();
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

  it('steers off a freshly-failing tier even below the completions threshold (#2329)', async () => {
    // Only 4 completions — too few for a routingAccuracy-based tier suggestion —
    // but 3 recent failures on 'heavy' meet the failure-signal bar, so routing
    // still emits an avoidance-only suggestion instead of null.
    const data = makeLearningData({
      byTaskType: {
        'fresh-task': {
          completed: 4, succeeded: 1, failed: 3,
          totalDurationMs: 400000, avgDurationMs: 100000, successRate: 25
        }
      },
      routingAccuracy: {},
      correlationWindow: provenCorrelationWindow(),
      failureSignatures: {
        'test-failure': {
          count: 3,
          recent: [
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'fresh-task' },
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'fresh-task' },
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'fresh-task' }
          ]
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await suggestModelTier('fresh-task');
    expect(result).not.toBeNull();
    expect(result.suggested).toBeNull();
    expect(result.avoidTiers).toContain('heavy');
    expect(result.failureSignal).toMatchObject({ tier: 'heavy', failures: 3 });
  });

  it('still returns null below the completions threshold when there is no failure signal (#2329)', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData({
      byTaskType: {
        'quiet-task': { completed: 3, succeeded: 2, failed: 1, successRate: 66 }
      },
      routingAccuracy: {},
      failureSignatures: {}
    })));
    expect(await suggestModelTier('quiet-task')).toBeNull();
  });

  it('folds enriched failure signatures into avoidTiers even when routingAccuracy is quiet (#2329)', async () => {
    // Overall success is healthy (75%) and routingAccuracy carries no failing
    // tier — pre-#2329 this returned null. The failure signatures show three
    // recent 'heavy'-tier failures for this task type, so routing now emits an
    // avoidance-only suggestion that steers selection off 'heavy'.
    const data = makeLearningData({
      byTaskType: {
        'sig-task': {
          completed: 12, succeeded: 9, failed: 3,
          totalDurationMs: 1200000, avgDurationMs: 100000, successRate: 75
        }
      },
      routingAccuracy: {},
      correlationWindow: provenCorrelationWindow(),
      failureSignatures: {
        'test-failure': {
          count: 3,
          recent: [
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'sig-task' },
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'sig-task' },
            { modelTier: 'heavy', provider: 'codex', model: 'gpt', taskType: 'sig-task' }
          ]
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await suggestModelTier('sig-task');
    expect(result).not.toBeNull();
    expect(result.suggested).toBeNull();
    expect(result.avoidTiers).toContain('heavy');
    expect(result.failureSignal).toMatchObject({ tier: 'heavy', failures: 3, provider: 'claude' });
  });

  it('drops to avoidance-only when the tier it would pick is itself failure-flagged (#2329)', async () => {
    // routingAccuracy: heavy is failing (<40%) and 'medium' is the only 60-79%
    // "successful" alternative — but the failure signatures show 3 recent medium
    // failures too. Routing must NOT then suggest medium; it drops to avoidance-
    // only (suggested: null) so selection steers off both heavy and medium.
    const data = makeLearningData({
      byTaskType: {
        'flap-task': {
          completed: 20, succeeded: 9, failed: 11,
          totalDurationMs: 2000000, avgDurationMs: 100000, successRate: 45
        }
      },
      routingAccuracy: {
        'flap-task': {
          heavy: { succeeded: 1, failed: 9, lastAttempt: '2026-01-26T00:00:00.000Z' }, // 10%
          medium: { succeeded: 7, failed: 3, lastAttempt: '2026-01-26T00:00:00.000Z' } // 70% (unproven)
        }
      },
      correlationWindow: provenCorrelationWindow(),
      failureSignatures: {
        'test-failure': {
          count: 3,
          recent: [
            { modelTier: 'medium', provider: 'claude', model: 'sonnet', taskType: 'flap-task' },
            { modelTier: 'medium', provider: 'claude', model: 'sonnet', taskType: 'flap-task' },
            { modelTier: 'medium', provider: 'claude', model: 'sonnet', taskType: 'flap-task' }
          ]
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await suggestModelTier('flap-task');
    expect(result.suggested).toBeNull();
    expect(result.avoidTiers).toEqual(expect.arrayContaining(['heavy', 'medium']));
    expect(result.failureSignal).toMatchObject({ tier: 'medium', provider: 'claude', model: 'sonnet' });
  });

  it('holds avoidance back to the conservative bar until correlation is proven (#2344)', async () => {
    // 3 recent 'heavy' failures — enough for the AGGRESSIVE bar (3) — but the
    // correlation window is empty (unproven), so the #2344 gate applies the
    // conservative bar (5) and does NOT steer off 'heavy' yet.
    const fixture = (correlationWindow) => makeLearningData({
      byTaskType: {
        'gate-task': {
          completed: 12, succeeded: 9, failed: 3,
          totalDurationMs: 1200000, avgDurationMs: 100000, successRate: 75
        }
      },
      routingAccuracy: {},
      correlationWindow,
      failureSignatures: {
        'test-failure': {
          count: 3,
          recent: [
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'gate-task' },
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'gate-task' },
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'gate-task' }
          ]
        }
      }
    });

    // Unproven correlation (empty window) → no avoidance despite 3 failures.
    readFile.mockResolvedValue(JSON.stringify(fixture([])));
    clearLearningCache();
    expect(await suggestModelTier('gate-task')).toBeNull();

    // Proven correlation (>0.8, >= min samples) → the same 3 failures now steer.
    readFile.mockResolvedValue(JSON.stringify(fixture(provenCorrelationWindow())));
    clearLearningCache();
    const proven = await suggestModelTier('gate-task');
    expect(proven).not.toBeNull();
    expect(proven.avoidTiers).toContain('heavy');
  });

  it('does not let failure signatures condemn a proven tier (#2329)', async () => {
    // 'heavy' clears the high-success threshold in routingAccuracy, so the
    // proven-tier suggestion stands and its absolute failures never add it to
    // avoidTiers.
    const data = makeLearningData({
      byTaskType: {
        'proven-task': {
          completed: 20, succeeded: 18, failed: 2,
          totalDurationMs: 2000000, avgDurationMs: 100000, successRate: 90
        }
      },
      routingAccuracy: {
        'proven-task': {
          heavy: { succeeded: 18, failed: 2, lastAttempt: '2026-01-26T00:00:00.000Z' } // 90%
        }
      },
      failureSignatures: {
        'test-failure': {
          count: 3,
          recent: [
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'proven-task' },
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'proven-task' },
            { modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'proven-task' }
          ]
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await suggestModelTier('proven-task');
    expect(result.suggested).toBe('heavy');
    expect(result.avoidTiers).not.toContain('heavy');
  });

  it('should prefer the lightest tier when several clear the high-success threshold', async () => {
    // heavy has the marginally-higher success rate, but light also clears 80% —
    // we should route to light to avoid spending a heavier model for the same outcome.
    const data = makeLearningData({
      byTaskType: {
        'docs-task': {
          completed: 20, succeeded: 17, failed: 3,
          totalDurationMs: 2000000, avgDurationMs: 100000,
          successRate: 85
        }
      },
      routingAccuracy: {
        'docs-task': {
          light: { succeeded: 9, failed: 2, lastAttempt: '2026-01-26T00:00:00.000Z' }, // 82%
          heavy: { succeeded: 8, failed: 1, lastAttempt: '2026-01-25T00:00:00.000Z' }  // 89%
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await suggestModelTier('docs-task');

    expect(result).not.toBeNull();
    expect(result.suggested).toBe('light');
    expect(result.reason).toMatch(/lightest of 2 proven tiers/);
  });

  it('should rank routable thinking-level tier names by real cost, not as default-weight', async () => {
    // routingAccuracy keys can be thinking-level names (high/xhigh), not just
    // light/default/medium/heavy. xhigh (opus) is heavier than high (provider-
    // heavy). Both clear 80%, so we must pick high — an earlier bug ranked every
    // unmapped name at default-weight, which would have let xhigh win the tie.
    const data = makeLearningData({
      byTaskType: {
        'reason-task': {
          completed: 20, succeeded: 18, failed: 2,
          totalDurationMs: 2000000, avgDurationMs: 100000,
          successRate: 90
        }
      },
      routingAccuracy: {
        'reason-task': {
          high: { succeeded: 9, failed: 2, lastAttempt: '2026-01-26T00:00:00.000Z' },  // 82%
          xhigh: { succeeded: 10, failed: 1, lastAttempt: '2026-01-25T00:00:00.000Z' }  // 91%
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await suggestModelTier('reason-task');

    expect(result).not.toBeNull();
    expect(result.suggested).toBe('high');
  });

  it('should not suggest a non-routable local-preferred tier (minimal/low) — picks the lightest tier the runtime can run', async () => {
    // minimal/low resolve to a local model, but the learning→selection path
    // doesn't switch providers for them, so suggesting minimal would make the
    // selector fall through to the provider default. Even though minimal is the
    // cheapest by cost, it must be excluded so the proven `light` tier wins.
    const data = makeLearningData({
      byTaskType: {
        'local-task': {
          completed: 20, succeeded: 18, failed: 2,
          totalDurationMs: 2000000, avgDurationMs: 100000,
          successRate: 90
        }
      },
      routingAccuracy: {
        'local-task': {
          minimal: { succeeded: 10, failed: 1, lastAttempt: '2026-01-26T00:00:00.000Z' }, // 91%
          light: { succeeded: 9, failed: 2, lastAttempt: '2026-01-25T00:00:00.000Z' }      // 82%
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await suggestModelTier('local-task');

    expect(result).not.toBeNull();
    expect(result.suggested).toBe('light');
  });

  it('should not prefer an unknown tier name as the cheapest', async () => {
    // user-specified (and any future/unknown tier name) must rank as heaviest,
    // so it never wins the "lightest proven tier" tie over a known-light tier.
    const data = makeLearningData({
      byTaskType: {
        'pref-task': {
          completed: 20, succeeded: 18, failed: 2,
          totalDurationMs: 2000000, avgDurationMs: 100000,
          successRate: 90
        }
      },
      routingAccuracy: {
        'pref-task': {
          'user-specified': { succeeded: 10, failed: 1, lastAttempt: '2026-01-26T00:00:00.000Z' }, // 91%
          light: { succeeded: 9, failed: 2, lastAttempt: '2026-01-25T00:00:00.000Z' }              // 82%
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await suggestModelTier('pref-task');

    expect(result).not.toBeNull();
    expect(result.suggested).toBe('light');
  });
});
