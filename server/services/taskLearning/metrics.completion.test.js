/**
 * metrics.completion.test.js
 *
 * Behavior of metrics.js (recordTaskCompletion folds, verdicts, environmental failures, tier recalculation). Split from taskLearning.test.js (#16214); shared mocks live in
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
import { SKIP_LEARNING_VERDICT } from '../../lib/learningVerdict.js';
import { clearLearningCache } from './store.js';
import { recordTaskCompletion, recalculateModelTierMetrics } from './metrics.js';
import { getLearningInsights } from './insights.js';

describe('TaskLearning - recordTaskCompletion routing accuracy', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    clearLearningCache();
    savedData = null;
    atomicWrite.mockImplementation(async (_path, data) => {
      savedData = data;
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
    atomicWrite.mockImplementation(async (_path, data) => {
      currentData = JSON.stringify(data);
      savedData = data;
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

  it('counts a clean exit that MISSED its declared criterion as a tier failure (#2344)', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    // Runner exit-code success, but the declared success criterion was not met
    // (e.g. agent finished clean yet committed nothing). The learning aggregates
    // must treat the validation verdict as authoritative — not the exit code.
    const agent = {
      metadata: { modelTier: 'heavy', taskDescription: 'Ship the fix' },
      result: { success: true, validationPassed: false, duration: 60000 }
    };
    const task = { description: 'Ship the fix', taskType: 'internal', metadata: {} };

    await recordTaskCompletion(agent, task);

    const routing = savedData.routingAccuracy['internal-task']['heavy'];
    expect(routing.succeeded).toBe(0);
    expect(routing.failed).toBe(1);
    expect(savedData.byModelTier['heavy'].succeeded).toBe(0);
    expect(savedData.byModelTier['heavy'].failed).toBe(1);
    expect(savedData.byTaskType['internal-task'].succeeded).toBe(0);
    expect(savedData.byTaskType['internal-task'].failed).toBe(1);
  });

  it('counts a non-zero exit that MET its declared criterion as a tier success (#2344)', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    // Runner reported failure, but a task-referencing commit was found — the
    // criterion was met, so the tier gets credit.
    const agent = {
      metadata: { modelTier: 'medium', taskDescription: 'Ship the fix' },
      result: { success: false, validationPassed: true, duration: 60000 }
    };
    const task = { description: 'Ship the fix', taskType: 'internal', metadata: {} };

    await recordTaskCompletion(agent, task);

    const routing = savedData.routingAccuracy['internal-task']['medium'];
    expect(routing.succeeded).toBe(1);
    expect(routing.failed).toBe(0);
  });
});

/**
 * The "don't record this run" channel (#4107). A programmatic-I/O output hook
 * that aborted BEFORE evaluating the agent's output (`no-app` / `app-not-found`,
 * e.g. the app was deleted mid-run) stamps SKIP_LEARNING_VERDICT rather than the
 * undeclared `null` — which used to fall back to the exit code and bank a free
 * success for the task type.
 */
describe('TaskLearning - skip-recording verdict (#4107)', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    clearLearningCache();
    savedData = null;
    atomicWrite.mockImplementation(async (_path, data) => {
      savedData = data;
    });
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));
  });

  const skipAgent = () => ({
    metadata: { modelTier: 'heavy', taskDescription: 'Study the app' },
    result: { success: true, validationPassed: SKIP_LEARNING_VERDICT, duration: 60000 }
  });
  const task = { description: 'Study the app', taskType: 'internal', metadata: {} };

  it('writes NOTHING at all for a skipped run', async () => {
    const returned = await recordTaskCompletion(skipAgent(), task);

    // The whole point: no persist, so no aggregate, window, or total moves.
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(savedData).toBeNull();
    expect(returned).toBeNull();
  });

  it('does not bank the exit code as a success for the task type', async () => {
    // The exact overcount #4107 fixes: exit 0 + a hook that never looked at the
    // output used to come out the other side as a recorded success.
    await recordTaskCompletion(skipAgent(), task);
    expect(savedData).toBeNull();

    // ...while an otherwise-identical run with the UNDECLARED sentinel still
    // records, so the skip can't have swallowed the ordinary null path.
    const undeclared = { ...skipAgent(), result: { success: true, validationPassed: null, duration: 60000 } };
    await recordTaskCompletion(undeclared, task);
    expect(atomicWrite).toHaveBeenCalledTimes(1);
    expect(savedData.byTaskType['internal-task'].succeeded).toBe(1);
    expect(savedData.byTaskType['internal-task'].failed).toBe(0);
  });

  it('does not blame the model either — a failing exit is skipped the same way', async () => {
    // `false` would have poisoned the #2329 failure-signature window with a
    // non-failure, so an aborted hook must not record a failure either.
    const failed = {
      ...skipAgent(),
      result: {
        success: false,
        validationPassed: SKIP_LEARNING_VERDICT,
        duration: 60000,
        errorAnalysis: { category: 'unknown', message: 'boom', origin: 'output-scan' }
      }
    };
    await recordTaskCompletion(failed, task);

    expect(atomicWrite).not.toHaveBeenCalled();
    expect(savedData).toBeNull();
  });

  it('still records a genuine criterion MISS as a failure (#2344 unchanged)', async () => {
    const missed = { ...skipAgent(), result: { success: true, validationPassed: false, duration: 60000 } };
    await recordTaskCompletion(missed, task);

    expect(atomicWrite).toHaveBeenCalledTimes(1);
    expect(savedData.byTaskType['internal-task'].succeeded).toBe(0);
    expect(savedData.byTaskType['internal-task'].failed).toBe(1);
    expect(savedData.byModelTier['heavy'].failed).toBe(1);
  });
});

describe('TaskLearning - environmental failures (#2618)', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    clearLearningCache();
    savedData = null;
    atomicWrite.mockImplementation(async (_path, data) => {
      savedData = data;
    });
  });

  const makeFailedAgent = (category, tier = 'heavy') => ({
    metadata: { modelTier: tier, taskDescription: 'Fix UI' },
    result: {
      success: false,
      duration: 30000,
      errorAnalysis: { category, message: `provider says ${category}` }
    }
  });
  const task = { description: 'Fix UI', taskType: 'user', metadata: {} };

  it('keeps a rate-limit failure out of every success-rate aggregate and counts it separately', async () => {
    const baseline = makeLearningData();
    readFile.mockResolvedValue(JSON.stringify(baseline));

    await recordTaskCompletion(makeFailedAgent('rate-limit'), task);

    // byTaskType untouched — same counters/rate as the baseline, no recency sample.
    expect(savedData.byTaskType['user-task']).toMatchObject({
      completed: baseline.byTaskType['user-task'].completed,
      succeeded: baseline.byTaskType['user-task'].succeeded,
      failed: baseline.byTaskType['user-task'].failed,
      successRate: baseline.byTaskType['user-task'].successRate
    });
    expect(savedData.byTaskType['user-task'].recentOutcomes).toBeUndefined();
    // byModelTier untouched — the heavy tier bucket is not even initialized.
    expect(savedData.byModelTier['heavy']).toBeUndefined();
    // routingAccuracy untouched.
    expect(savedData.routingAccuracy?.['user-task']).toBeUndefined();
    // totals untouched — the overall rate is an aggregate too.
    expect(savedData.totals).toMatchObject({
      completed: baseline.totals.completed,
      succeeded: baseline.totals.succeeded,
      failed: baseline.totals.failed
    });
    // Correlation window untouched — an outage grades no routing prediction.
    expect(savedData.correlationWindow ?? []).toEqual([]);

    // ...but the event stays visible in the separate environmental record.
    expect(savedData.environmentalFailures['rate-limit']).toMatchObject({
      count: 1,
      taskTypes: { 'user-task': 1 }
    });
    expect(savedData.environmentalFailures['rate-limit'].lastOccurred).toEqual(expect.any(String));
  });

  it('still records errorPatterns and failureSignatures for environmental categories (diagnostics)', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    await recordTaskCompletion(makeFailedAgent('billing-error'), task);

    expect(savedData.errorPatterns['billing-error']).toMatchObject({
      count: 1,
      taskTypes: { 'user-task': 1 }
    });
    expect(savedData.failureSignatures['billing-error'].count).toBe(1);
    expect(savedData.failureSignatures['billing-error'].recent[0]).toMatchObject({
      taskType: 'user-task',
      messageSnippet: 'provider says billing-error'
    });
  });

  it('never creates a byTaskType bucket for a type whose only history is an outage', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    const freshTask = { description: '[auto-fix] investigate the crash', taskType: 'internal', metadata: {} };
    await recordTaskCompletion(makeFailedAgent('startup-failure'), freshTask);

    expect(savedData.byTaskType['auto-fix']).toBeUndefined();
    expect(savedData.environmentalFailures['startup-failure'].taskTypes['auto-fix']).toBe(1);
  });

  it('accumulates environmental counts across completions', async () => {
    let currentData = JSON.stringify(makeLearningData());
    readFile.mockImplementation(async () => currentData);
    atomicWrite.mockImplementation(async (_path, data) => {
      currentData = JSON.stringify(data);
      savedData = data;
    });

    await recordTaskCompletion(makeFailedAgent('rate-limit'), task);
    await recordTaskCompletion(makeFailedAgent('rate-limit'), task);
    await recordTaskCompletion(makeFailedAgent('auth'), task);

    expect(savedData.environmentalFailures['rate-limit'].count).toBe(2);
    expect(savedData.environmentalFailures['auth'].count).toBe(1);
    expect(savedData.totals.failed).toBe(makeLearningData().totals.failed);
  });

  it('leaves a timeout failure counting against the aggregates exactly as today', async () => {
    const baseline = makeLearningData();
    readFile.mockResolvedValue(JSON.stringify(baseline));

    await recordTaskCompletion(makeFailedAgent('timeout', 'light'), task);

    // timeout is deliberately NOT environmental — it can be genuine task/model signal.
    expect(savedData.byTaskType['user-task'].failed).toBe(baseline.byTaskType['user-task'].failed + 1);
    expect(savedData.byModelTier['light'].failed).toBe(1);
    expect(savedData.routingAccuracy['user-task']['light'].failed).toBe(1);
    expect(savedData.totals.failed).toBe(baseline.totals.failed + 1);
    expect(savedData.environmentalFailures).toBeUndefined();
  });

  it('loads a learning.json without the environmentalFailures key cleanly (back-compat)', async () => {
    // makeLearningData has no environmentalFailures key — the additive key is
    // initialized on first environmental recording, and a plain success write
    // round-trips the file without fabricating one.
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    const agent = {
      metadata: { modelTier: 'heavy', taskDescription: 'Fix UI' },
      result: { success: true, duration: 30000 }
    };
    await recordTaskCompletion(agent, task);

    expect(savedData.environmentalFailures).toBeUndefined();
    expect(savedData.byTaskType['user-task'].succeeded)
      .toBe(makeLearningData().byTaskType['user-task'].succeeded + 1);
  });

  it('surfaces environmentalFailures via getLearningInsights, sorted by count', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData({
      environmentalFailures: {
        'auth': { count: 2, lastOccurred: '2026-07-01T00:00:00.000Z', taskTypes: { 'user-task': 2 } },
        'rate-limit': { count: 7, lastOccurred: '2026-07-02T00:00:00.000Z', taskTypes: { 'user-task': 4, 'auto-fix': 3 } }
      }
    })));

    const insights = await getLearningInsights();

    expect(insights.insights.environmentalFailures).toEqual([
      { category: 'rate-limit', count: 7, lastOccurred: '2026-07-02T00:00:00.000Z', affectedTypes: ['user-task', 'auto-fix'] },
      { category: 'auth', count: 2, lastOccurred: '2026-07-01T00:00:00.000Z', affectedTypes: ['user-task'] }
    ]);
  });

  it('surfaces an empty environmentalFailures list for a learning.json that predates the key', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));
    const insights = await getLearningInsights();
    expect(insights.insights.environmentalFailures).toEqual([]);
  });
});

describe('TaskLearning - recalculateModelTierMetrics', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    clearLearningCache();
    savedData = null;
    atomicWrite.mockImplementation(async (_path, data) => {
      savedData = data;
    });
  });

  it('should rebuild byModelTier from routingAccuracy data', async () => {
    const data = makeLearningData({
      byModelTier: {
        heavy: {
          completed: 650, succeeded: 3, failed: 647,
          totalDurationMs: 19500000, avgDurationMs: 30000
        },
        medium: {
          completed: 200, succeeded: 150, failed: 50,
          totalDurationMs: 40000000, avgDurationMs: 200000
        }
      },
      byTaskType: {
        'user-task': {
          completed: 40, succeeded: 30, failed: 10,
          totalDurationMs: 4000000, avgDurationMs: 100000,
          successRate: 75
        },
        'internal-task': {
          completed: 20, succeeded: 18, failed: 2,
          totalDurationMs: 2000000, avgDurationMs: 100000,
          successRate: 90
        }
      },
      routingAccuracy: {
        'user-task': {
          medium: { succeeded: 25, failed: 5, lastAttempt: '2026-01-26T00:00:00.000Z' },
          low: { succeeded: 8, failed: 0, lastAttempt: '2026-01-26T00:00:00.000Z' }
        },
        'internal-task': {
          medium: { succeeded: 15, failed: 1, lastAttempt: '2026-01-26T00:00:00.000Z' }
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await recalculateModelTierMetrics();

    expect(result.recalculated).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);

    // heavy tier should be gone (not in routingAccuracy)
    expect(savedData.byModelTier.heavy).toBeUndefined();

    // medium tier should reflect routing accuracy: 25+15=40 succeeded, 5+1=6 failed
    expect(savedData.byModelTier.medium.completed).toBe(46);
    expect(savedData.byModelTier.medium.succeeded).toBe(40);
    expect(savedData.byModelTier.medium.failed).toBe(6);

    // low tier: 8 succeeded, 0 failed
    expect(savedData.byModelTier.low.completed).toBe(8);
    expect(savedData.byModelTier.low.succeeded).toBe(8);
    expect(savedData.byModelTier.low.failed).toBe(0);
  });

  it('should not save when nothing changes', async () => {
    const data = makeLearningData({
      byModelTier: {
        medium: { completed: 3, succeeded: 2, failed: 1, totalDurationMs: 300000, avgDurationMs: 100000 }
      },
      routingAccuracy: {
        'user-task': {
          medium: { succeeded: 2, failed: 1, lastAttempt: '2026-01-26T00:00:00.000Z' }
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await recalculateModelTierMetrics();

    expect(result.recalculated).toBe(false);
    expect(atomicWrite).not.toHaveBeenCalled();
  });

  it('should handle empty routingAccuracy', async () => {
    const data = makeLearningData({
      byModelTier: {
        heavy: { completed: 100, succeeded: 1, failed: 99, totalDurationMs: 100000, avgDurationMs: 1000 }
      },
      routingAccuracy: {}
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    const result = await recalculateModelTierMetrics();

    expect(result.recalculated).toBe(true);
    // All tiers should be cleared since no routing accuracy data exists
    expect(savedData.byModelTier).toEqual({});
  });

  it('should estimate durations from task type averages', async () => {
    const data = makeLearningData({
      byModelTier: {},
      byTaskType: {
        'user-task': {
          completed: 10, succeeded: 8, failed: 2,
          totalDurationMs: 1000000, avgDurationMs: 100000,
          successRate: 80
        }
      },
      routingAccuracy: {
        'user-task': {
          medium: { succeeded: 5, failed: 1, lastAttempt: '2026-01-26T00:00:00.000Z' }
        }
      }
    });
    readFile.mockResolvedValue(JSON.stringify(data));

    await recalculateModelTierMetrics();

    // 6 agents × 100000ms avg = 600000ms total, 600000/6 = 100000ms avg
    expect(savedData.byModelTier.medium.totalDurationMs).toBe(600000);
    expect(savedData.byModelTier.medium.avgDurationMs).toBe(100000);
  });
});

describe('TaskLearning - recordTaskCompletion aggregate folds', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    clearLearningCache();
    savedData = null;
    atomicWrite.mockImplementation(async (_path, data) => {
      savedData = data;
    });
  });

  const task = { description: 'Fix UI', taskType: 'user', metadata: {} };
  const failedAgent = (errorAnalysis, overrides = {}) => ({
    id: 'agent-fold',
    metadata: { modelTier: 'heavy', taskDescription: 'Fix UI' },
    result: { success: false, duration: 30000, errorAnalysis },
    ...overrides
  });

  it('folds a success into the model tier and totals with success-only ETA fields', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData({ byModelTier: {}, totals: { completed: 0, succeeded: 0, failed: 0, totalDurationMs: 0 } })));

    await recordTaskCompletion({ id: 'agent-ok', metadata: { modelTier: 'medium' }, result: { success: true, duration: 40000 } }, task);

    expect(savedData.byModelTier.medium).toEqual({
      completed: 1, succeeded: 1, failed: 0, totalDurationMs: 40000, successDurationMs: 40000, avgDurationMs: 40000
    });
    expect(savedData.totals).toMatchObject({
      completed: 1, succeeded: 1, failed: 0, totalDurationMs: 40000,
      successDurationMs: 40000, successMaxDurationMs: 40000, avgDurationMs: 40000, maxDurationMs: 40000
    });
    expect(savedData.routingAccuracy['user-task'].medium.lastAttempt).toEqual(expect.any(String));
  });

  it('falls back to the wall-minus-queue execution split for the recency sample when the runner stamped no duration', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));

    await recordTaskCompletion({
      id: 'agent-wall',
      startedAt: '2026-01-26T00:00:00.000Z',
      completedAt: '2026-01-26T00:02:00.000Z',
      metadata: { modelTier: 'medium' },
      result: { success: true }
    }, { ...task, createdAt: '2026-01-25T23:59:00.000Z' });

    expect(savedData.byTaskType['user-task'].recentOutcomes.at(-1)).toMatchObject({ s: true, d: 60000 });
  });

  it('counts an error pattern with its time and keeps a trimmed sample only for unknown failures', async () => {
    readFile.mockResolvedValue(JSON.stringify(makeLearningData({ errorPatterns: {} })));

    await recordTaskCompletion(failedAgent({ category: 'unknown', message: 'm'.repeat(300), details: 'd'.repeat(600) }), task);

    expect(savedData.errorPatterns.unknown).toEqual({ count: 1, taskTypes: { 'user-task': 1 }, lastOccurred: expect.any(String) });
    expect(savedData.recentUnknownErrors).toEqual([{
      taskType: 'user-task',
      message: 'm'.repeat(200),
      details: 'd'.repeat(500),
      agentId: 'agent-fold',
      recordedAt: expect.any(String)
    }]);

    clearLearningCache();
    readFile.mockResolvedValue(JSON.stringify(makeLearningData({ errorPatterns: {} })));
    await recordTaskCompletion(failedAgent({ category: 'timeout', message: 'slow' }), task);
    expect(savedData.recentUnknownErrors).toBeUndefined();
  });

  it('keeps only the last 20 unknown-error samples', async () => {
    const earlier = Array.from({ length: 20 }, (_, i) => ({ taskType: 'user-task', message: `old-${i}`, details: '', agentId: `a-${i}`, recordedAt: '2026-01-01T00:00:00.000Z' }));
    readFile.mockResolvedValue(JSON.stringify(makeLearningData({ recentUnknownErrors: earlier })));

    await recordTaskCompletion(failedAgent({ category: 'unknown', message: 'newest' }), task);

    expect(savedData.recentUnknownErrors).toHaveLength(20);
    expect(savedData.recentUnknownErrors[0].message).toBe('old-1');
    expect(savedData.recentUnknownErrors.at(-1).message).toBe('newest');
  });

  it('records a recurrence insight only when the category count lands on a milestone', async () => {
    // The fixture's `unknown` pattern sits at 10; a third occurrence of a fresh
    // category reaches the first milestone (3).
    readFile.mockResolvedValue(JSON.stringify(makeLearningData({
      errorPatterns: { timeout: { count: 2, taskTypes: { 'user-task': 2 }, lastOccurred: null } }
    })));
    await recordTaskCompletion(failedAgent({ category: 'timeout', message: 'slow' }), task);
    expect(savedData.insights).toEqual([expect.objectContaining({ origin: 'auto-incident', originatingAgentId: 'agent-fold' })]);

    clearLearningCache();
    readFile.mockResolvedValue(JSON.stringify(makeLearningData({
      errorPatterns: { timeout: { count: 3, taskTypes: { 'user-task': 3 }, lastOccurred: null } }
    })));
    await recordTaskCompletion(failedAgent({ category: 'timeout', message: 'slow' }), task);
    expect(savedData.insights ?? []).toEqual([]);
  });

  it('samples the correlation window only for routable tiers', async () => {
    for (const modelTier of [undefined, 'minimal']) {
      clearLearningCache();
      readFile.mockResolvedValue(JSON.stringify(makeLearningData()));
      await recordTaskCompletion({ id: `agent-${modelTier}`, metadata: { modelTier }, result: { success: true, duration: 1000 } }, task);
      expect(savedData.correlationWindow ?? []).toEqual([]);
    }

    clearLearningCache();
    readFile.mockResolvedValue(JSON.stringify(makeLearningData()));
    await recordTaskCompletion({ id: 'agent-heavy', metadata: { modelTier: 'heavy' }, result: { success: true, duration: 1000 } }, task);
    expect(savedData.correlationWindow).toEqual([expect.objectContaining({ taskType: 'user-task', tier: 'heavy', bad: false })]);
  });
});
