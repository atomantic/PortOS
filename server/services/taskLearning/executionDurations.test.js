/**
 * Execution-scoped duration buckets (issue #8001).
 *
 * The ETA used to average a task type across every provider, model and effort it
 * had ever run on, so a `self-improve:release-check` on a slow local model and the
 * same check on a fast cloud model shared one number that was wrong for both.
 * These tests pin the two halves of the fix at their real boundaries: what
 * `recordTaskCompletion` banks, and what `getTaskDurationEstimate` /
 * `getAllTaskDurations` hand back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./store.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    loadLearningData: vi.fn(),
    saveLearningData: vi.fn(async () => {}),
    emitLog: vi.fn()
  };
});

import { recordTaskCompletion } from './metrics.js';
import { getTaskDurationEstimate, getAllTaskDurations } from './durations.js';
import { loadLearningData, saveLearningData, executionDurationKey, EXECUTION_EFFORT_NONE } from './store.js';

const emptyData = () => ({
  version: 2,
  byTaskType: {},
  byTaskTypeExecution: {},
  byModelTier: {},
  errorPatterns: {},
  failureSignatures: {},
  routingAccuracy: {},
  environmentalFailures: {},
  correlationWindow: [],
  totals: { completed: 0, succeeded: 0, failed: 0, totalDurationMs: 0, avgDurationMs: 0 }
});

const TASK = { id: 't1', description: '[self-improvement] release-check - verify the release', taskType: 'scheduled' };

const agentOn = ({ providerId = 'ollama', model = 'local-coder', effort = 'low', duration, errorCategory = null } = {}) => ({
  id: 'agent-x',
  startedAt: '2026-09-01T10:00:00.000Z',
  completedAt: '2026-09-01T10:10:00.000Z',
  metadata: {
    providerId,
    model,
    effort,
    modelTier: 'user-specified',
    taskDescription: TASK.description
  },
  result: {
    success: !errorCategory,
    duration,
    ...(errorCategory ? { errorAnalysis: { category: errorCategory, origin: 'provider' } } : {})
  }
});

/** Run N completions through the recorder against one accumulating data object. */
async function record(agents) {
  const data = emptyData();
  loadLearningData.mockResolvedValue(data);
  for (const agent of agents) await recordTaskCompletion(agent, TASK);
  // Every write lands on the same object the loader handed back.
  return saveLearningData.mock.calls.at(-1)?.[0] ?? data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordTaskCompletion — execution-scoped duration buckets', () => {
  it('keeps the same task type on two different models in two buckets', async () => {
    const data = await record([
      agentOn({ model: 'local-coder', duration: 600_000 }),
      agentOn({ model: 'local-coder', duration: 600_000 }),
      agentOn({ model: 'local-coder', duration: 600_000 }),
      agentOn({ providerId: 'claude', model: 'opus', duration: 60_000 }),
      agentOn({ providerId: 'claude', model: 'opus', duration: 60_000 }),
      agentOn({ providerId: 'claude', model: 'opus', duration: 60_000 })
    ]);

    const slow = executionDurationKey({ taskType: 'self-improve:release-check', providerId: 'ollama', model: 'local-coder', effort: 'low' });
    const fast = executionDurationKey({ taskType: 'self-improve:release-check', providerId: 'claude', model: 'opus', effort: 'low' });
    expect(Object.keys(data.byTaskTypeExecution)).toEqual([slow, fast]);
    expect(data.byTaskTypeExecution[slow].avgDurationMs).toBe(600_000);
    expect(data.byTaskTypeExecution[fast].avgDurationMs).toBe(60_000);

    // The whole point: two runs of ONE task type, two different estimates —
    // the single `byTaskType` average is 330s, which describes neither.
    expect(data.byTaskType['self-improve:release-check'].avgDurationMs).toBe(330_000);
    loadLearningData.mockResolvedValue(data);
    const onSlow = await getTaskDurationEstimate(TASK.description, { providerId: 'ollama', model: 'local-coder', effort: 'low' });
    const onFast = await getTaskDurationEstimate(TASK.description, { providerId: 'claude', model: 'opus', effort: 'low' });
    expect(onSlow.estimatedDurationMs).toBe(600_000);
    expect(onFast.estimatedDurationMs).toBe(60_000);
    expect(onSlow.basis).toBe('execution');
  });

  it('banks only successful durations, matching the byTaskType ETA rule', async () => {
    const data = await record([
      agentOn({ duration: 60_000 }),
      // A task-level failure: it counts as a completion and dents the rate, but a
      // long error loop must not drag the ETA up.
      { ...agentOn({ duration: 3_600_000 }), result: { success: false, duration: 3_600_000 } }
    ]);
    const key = executionDurationKey({ taskType: 'self-improve:release-check', providerId: 'ollama', model: 'local-coder', effort: 'low' });
    expect(data.byTaskTypeExecution[key]).toMatchObject({ completed: 2, succeeded: 1, failed: 1, avgDurationMs: 60_000 });
  });

  it('records no execution bucket for an environmental failure', async () => {
    const data = await record([agentOn({ duration: 900_000, errorCategory: 'rate-limit' })]);
    expect(data.byTaskTypeExecution, 'an outage must teach the estimator nothing').toEqual({});
    expect(data.byTaskType, 'the existing #2618 gate still holds too').toEqual({});
    expect(data.environmentalFailures['rate-limit'].count).toBe(1);
  });

  it('gives an absent effort its own sentinel bucket, never merged with a real level', async () => {
    const data = await record([
      agentOn({ effort: null, duration: 100_000 }),
      agentOn({ effort: 'high', duration: 900_000 })
    ]);
    const base = { taskType: 'self-improve:release-check', providerId: 'ollama', model: 'local-coder' };
    const none = executionDurationKey({ ...base, effort: null });
    expect(none).toMatch(new RegExp(`\\|${EXECUTION_EFFORT_NONE}$`));
    expect(data.byTaskTypeExecution[none].completed).toBe(1);
    expect(data.byTaskTypeExecution[executionDurationKey({ ...base, effort: 'high' })].completed).toBe(1);
  });

  it('skips the write when the run never recorded a provider or model', async () => {
    const data = await record([
      agentOn({ providerId: null, duration: 60_000 }),
      agentOn({ model: '', duration: 60_000 })
    ]);
    expect(data.byTaskTypeExecution, 'a partial key would merge unlike runs').toEqual({});
    expect(data.byTaskType['self-improve:release-check'].completed, 'the task-type bucket is unaffected').toBe(2);
  });
});

describe('getTaskDurationEstimate — cascade', () => {
  const identity = { providerId: 'ollama', model: 'local-coder', effort: 'low' };
  const bucket = (completed, avgDurationMs) => ({
    completed, succeeded: completed, failed: 0,
    totalDurationMs: avgDurationMs * completed,
    successDurationMs: avgDurationMs * completed,
    successMaxDurationMs: avgDurationMs,
    avgDurationMs, maxDurationMs: avgDurationMs, p80DurationMs: avgDurationMs, successRate: 100
  });
  const key = (effort) => executionDurationKey({ taskType: 'self-improve:release-check', ...identity, effort });

  const data = (byTaskTypeExecution, byTaskType = {}, totals = { completed: 0, succeeded: 0, failed: 0, avgDurationMs: 0 }) => ({
    ...emptyData(), byTaskTypeExecution, byTaskType, totals
  });

  it('answers from the exact provider/model/effort bucket once it has 3 completions', async () => {
    loadLearningData.mockResolvedValue(data(
      { [key('low')]: bucket(3, 500_000) },
      { 'self-improve:release-check': bucket(50, 90_000) }
    ));
    const est = await getTaskDurationEstimate(TASK.description, identity);
    expect(est).toMatchObject({ basis: 'execution', estimatedDurationMs: 500_000, basedOn: 3 });
  });

  it('falls outward to the provider+model rollup when this effort is still thin', async () => {
    // Two efforts, two samples each — neither reaches the bar alone, but the same
    // provider+model has four completions and is still far sharper than the
    // all-providers average.
    loadLearningData.mockResolvedValue(data(
      { [key('low')]: bucket(2, 400_000), [key('high')]: bucket(2, 600_000) },
      { 'self-improve:release-check': bucket(50, 90_000) }
    ));
    const est = await getTaskDurationEstimate(TASK.description, identity);
    expect(est).toMatchObject({ basis: 'provider-model', basedOn: 4 });
    // Re-derived from the RAW success totals, not an average of averages.
    expect(est.estimatedDurationMs).toBe(500_000);
  });

  it('ignores another provider/model at the same task type', async () => {
    loadLearningData.mockResolvedValue(data(
      { [executionDurationKey({ taskType: 'self-improve:release-check', providerId: 'claude', model: 'opus', effort: 'low' })]: bucket(9, 60_000) },
      { 'self-improve:release-check': bucket(50, 90_000) }
    ));
    const est = await getTaskDurationEstimate(TASK.description, identity);
    expect(est).toMatchObject({ basis: 'task-type', estimatedDurationMs: 90_000 });
  });

  it('falls to the task type, then to the overall average', async () => {
    loadLearningData.mockResolvedValue(data({}, { 'self-improve:release-check': bucket(2, 90_000) }));
    expect(await getTaskDurationEstimate(TASK.description, identity)).toMatchObject({ basis: 'task-type' });

    loadLearningData.mockResolvedValue(data(
      { [key('low')]: bucket(2, 400_000) },
      { 'self-improve:release-check': bucket(1, 90_000) },
      { completed: 6, succeeded: 3, failed: 3, avgDurationMs: 200_000 }
    ));
    expect(await getTaskDurationEstimate(TASK.description, identity)).toMatchObject({
      basis: 'overall', taskType: 'all', estimatedDurationMs: 200_000
    });
  });

  it('is unchanged for a legacy string-only call', async () => {
    // A rich execution bucket exists, but a caller that never named its run must
    // not silently start estimating from it.
    loadLearningData.mockResolvedValue(data(
      { [key('low')]: bucket(20, 500_000) },
      { 'self-improve:release-check': bucket(12, 90_000) }
    ));
    expect(await getTaskDurationEstimate(TASK.description)).toMatchObject({
      basis: 'task-type', estimatedDurationMs: 90_000, confidence: 'high', basedOn: 12
    });
  });
});

describe('getAllTaskDurations — reserved keys', () => {
  it('publishes the execution maps under reserved keys, leaving task types top-level', async () => {
    const lowKey = executionDurationKey({ taskType: 'self-improve:release-check', providerId: 'ollama', model: 'local-coder', effort: 'low' });
    const highKey = executionDurationKey({ taskType: 'self-improve:release-check', providerId: 'ollama', model: 'local-coder', effort: 'high' });
    loadLearningData.mockResolvedValue({
      ...emptyData(),
      byTaskType: { 'self-improve:release-check': { completed: 4, avgDurationMs: 90_000, p80DurationMs: 90_000, maxDurationMs: 90_000, successRate: 100 } },
      byTaskTypeExecution: {
        [lowKey]: { completed: 2, succeeded: 2, totalDurationMs: 800_000, successDurationMs: 800_000, successMaxDurationMs: 400_000, avgDurationMs: 400_000, maxDurationMs: 400_000, p80DurationMs: 400_000, successRate: 100 },
        [highKey]: { completed: 2, succeeded: 2, totalDurationMs: 1_200_000, successDurationMs: 1_200_000, successMaxDurationMs: 600_000, avgDurationMs: 600_000, maxDurationMs: 600_000, p80DurationMs: 600_000, successRate: 100 }
      },
      totals: { completed: 4, succeeded: 4, failed: 0, totalDurationMs: 2_000_000, avgDurationMs: 500_000 }
    });

    const out = await getAllTaskDurations();
    expect(Object.keys(out).filter((k) => !k.startsWith('_')), 'only real task types are top-level')
      .toEqual(['self-improve:release-check']);
    expect(out._byExecution[lowKey]).toMatchObject({ avgDurationMs: 400_000, completed: 2 });
    expect(out._byExecutionProviderModel['self-improve:release-check|ollama|local-coder'])
      .toMatchObject({ avgDurationMs: 500_000, completed: 4 });
  });

  it('stays a bare empty payload on an install with no history', async () => {
    loadLearningData.mockResolvedValue(emptyData());
    expect(await getAllTaskDurations()).toEqual({});
  });
});
