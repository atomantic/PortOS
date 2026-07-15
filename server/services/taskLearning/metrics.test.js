import { describe, it, expect, vi, beforeEach } from 'vitest';

// Override ONLY loadLearningData so the getWindowedStats wrapper can be exercised
// without touching the real learning.json (repo rule: DB/file-backed tests must
// never mutate real data). Everything else in store.js stays the real
// implementation via importActual, so the pure telemetry tests below are
// unaffected.
vi.mock('./store.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, loadLearningData: vi.fn() };
});

import { buildTaskTelemetryContext, computeLatencySplit, recordFailureSignature, getWindowedStats, recordEnvironmentalFailure, ENVIRONMENTAL_ERROR_CATEGORIES } from './metrics.js';
import { loadLearningData } from './store.js';

// buildTaskTelemetryContext + recordFailureSignature are the pure telemetry
// enrichment core added for issue #2329. They take no I/O, so every branch is
// exercised directly against hand-built agent/task/data objects — no mocking of
// the learning-store persistence layer (which would risk the real learning.json).

const baseAgent = {
  id: 'agent-1',
  startedAt: '2026-07-09T10:00:00.000Z',
  completedAt: '2026-07-09T10:05:00.000Z', // +5min wall
  metadata: {
    providerId: 'claude',
    model: 'opus',
    modelTier: 'heavy',
    modelReason: 'complex task → heavy tier',
    executionMode: 'runner',
    phase: 'implementing',
    taskDescription: 'x'.repeat(42)
  },
  result: { success: true, duration: 250000 }
};

describe('buildTaskTelemetryContext', () => {
  it('captures execution context, latency, and no failure signature on success', () => {
    const ctx = buildTaskTelemetryContext(baseAgent, {
      description: 'x'.repeat(42),
      taskType: 'user',
      createdAt: '2026-07-09T09:59:30.000Z' // 30s before startedAt
    });

    expect(ctx.success).toBe(true);
    expect(ctx.failureSignature).toBeNull();
    expect(ctx.executionContext).toEqual({
      provider: 'claude',
      model: 'opus',
      modelTier: 'heavy',
      taskType: 'user-task',
      component: 'runner',
      inputChars: 42,
      routingReason: 'complex task → heavy tier'
    });
    expect(ctx.latency).toEqual({
      wallMs: 300000, // 5 min
      queueMs: 30000, // 30s
      executionMs: 250000,
      // All three legs measured from real timestamps/duration.
      source: { wall: 'measured', queue: 'measured', execution: 'measured' }
    });
  });

  it('builds a structured failure signature (category, snippet, position) on failure', () => {
    const agent = {
      ...baseAgent,
      metadata: { ...baseAgent.metadata, phase: 'testing' },
      result: {
        success: false,
        duration: 120000,
        errorAnalysis: { category: 'test-failure', message: 'Tests failed: 3 assertions' }
      }
    };
    const ctx = buildTaskTelemetryContext(agent, { taskType: 'internal', description: 'run tests' });

    expect(ctx.success).toBe(false);
    expect(ctx.failureSignature).toEqual({
      category: 'test-failure',
      messageSnippet: 'Tests failed: 3 assertions',
      failurePosition: 'testing'
    });
    expect(ctx.executionContext.taskType).toBe('internal-task');
  });

  it('falls back to errorAnalysis.details for the snippet and truncates to 200 chars', () => {
    const longDetails = 'e'.repeat(500);
    const agent = {
      ...baseAgent,
      result: {
        success: false,
        duration: 1000,
        errorAnalysis: { category: 'unknown', details: longDetails }
      }
    };
    const ctx = buildTaskTelemetryContext(agent, {});
    expect(ctx.failureSignature.messageSnippet).toHaveLength(200);
  });

  it('uses explicit null sentinels — never fabricates — for absent data', () => {
    // Bare agent: no metadata, no timestamps, no duration.
    const ctx = buildTaskTelemetryContext({ result: { success: false } }, {});
    expect(ctx.executionContext).toEqual({
      provider: null,
      model: null,
      modelTier: null,
      taskType: 'external/untyped', // sandboxed fallback, no longer the blind 'unknown' (#2333)
      component: null,
      inputChars: null, // null, not 0 — description absent, not empty
      routingReason: null
    });
    expect(ctx.latency).toEqual({
      wallMs: null, queueMs: null, executionMs: null,
      source: { wall: null, queue: null, execution: null }
    });
    expect(ctx.failureSignature).toEqual({
      category: null,
      messageSnippet: null,
      failurePosition: null
    });
  });

  it('distinguishes an empty-string description (0 chars) from an absent one (null)', () => {
    const emptyDescAgent = { ...baseAgent, metadata: { ...baseAgent.metadata, taskDescription: '' } };
    expect(buildTaskTelemetryContext(emptyDescAgent, { description: '' }).executionContext.inputChars).toBe(0);
    // Neither task.description nor metadata.taskDescription → null
    const noDescAgent = { ...baseAgent, metadata: { ...baseAgent.metadata, taskDescription: undefined } };
    expect(buildTaskTelemetryContext(noDescAgent, {}).executionContext.inputChars).toBeNull();
  });

  it('derives the queue leg from wall − compute when the task carries no createdAt (#2329)', () => {
    // baseAgent: wall 300000, compute (duration) 250000, and NO createdAt.
    // Rather than leaving queue null, the split falls back to wall − compute
    // and marks it derived so it is never confused with a measured value.
    const ctx = buildTaskTelemetryContext(baseAgent, { description: 'no createdAt', taskType: 'user' });
    expect(ctx.latency.wallMs).toBe(300000); // wall still derivable from agent timestamps
    expect(ctx.latency.queueMs).toBe(50000); // 300000 − 250000
    expect(ctx.latency.source).toEqual({ wall: 'measured', queue: 'derived', execution: 'measured' });
  });

  it('harvests a failure signature for a previously-untyped task via the classification hook (#2333)', () => {
    // A failing task with no recognized type token: previously taskType would be
    // 'unknown' and bypass structured learning. Now the classifier maps the
    // free-form description to a concrete domain and the failure is captured.
    const agent = {
      ...baseAgent,
      metadata: { ...baseAgent.metadata, phase: 'diagnosing' },
      result: {
        success: false,
        duration: 5000,
        errorAnalysis: { category: 'tool-error', message: 'ripgrep not found' }
      }
    };
    const ctx = buildTaskTelemetryContext(agent, { description: 'investigate the failing deploy' });
    expect(ctx.executionContext.taskType).toBe('auto-fix'); // classified, not 'unknown'
    expect(ctx.failureSignature).toEqual({
      category: 'tool-error',
      messageSnippet: 'ripgrep not found',
      failurePosition: 'diagnosing'
    });

    // The harvested signature lands in the normalized telemetry schema.
    const data = { failureSignatures: {} };
    recordFailureSignature(data, ctx);
    expect(data.failureSignatures['tool-error'].count).toBe(1);
    expect(data.failureSignatures['tool-error'].recent[0]).toMatchObject({
      taskType: 'auto-fix',
      messageSnippet: 'ripgrep not found',
      failurePosition: 'diagnosing'
    });
  });

  it('surfaces the success-criteria validation boolean with a null sentinel default (#2344)', () => {
    // No validationPassed on the result → null sentinel (no criterion declared),
    // never conflated with a false.
    const ctx = buildTaskTelemetryContext(baseAgent, { taskType: 'user' });
    expect(ctx.validationPassed).toBeNull();

    // Explicit true/false pass through unchanged — distinct from result.success.
    const passed = buildTaskTelemetryContext(
      { ...baseAgent, result: { success: true, duration: 1000, validationPassed: true } }, {});
    expect(passed.validationPassed).toBe(true);

    // "ran clean but produced nothing": success true yet criterion missed.
    const missed = buildTaskTelemetryContext(
      { ...baseAgent, result: { success: true, duration: 1000, validationPassed: false } }, {});
    expect(missed.success).toBe(true);
    expect(missed.validationPassed).toBe(false);

    // A non-boolean (e.g. undefined-shaped) validation value never leaks through.
    const bogus = buildTaskTelemetryContext(
      { ...baseAgent, result: { success: false, duration: 1, validationPassed: 'nope' } }, {});
    expect(bogus.validationPassed).toBeNull();
  });

  it('does NOT harvest a failure signature for a commit-found run (success:false, validationPassed:true) (#2344)', () => {
    // Runner exit non-zero, but the declared criterion WAS met (commit found).
    // The validation verdict is authoritative — no failure signature is built, so
    // a fulfilled run can't poison the #2329 failure-signal window that routing
    // consumes.
    const agent = {
      ...baseAgent,
      result: {
        success: false,
        duration: 2000,
        validationPassed: true,
        errorAnalysis: { category: 'test-failure', message: 'exit 1 but committed' }
      }
    };
    const ctx = buildTaskTelemetryContext(agent, { taskType: 'internal' });
    expect(ctx.outcomeSuccess).toBe(true);
    expect(ctx.failureSignature).toBeNull();
    const data = { failureSignatures: {} };
    recordFailureSignature(data, ctx);
    expect(data.failureSignatures).toEqual({});
  });

  it('exposes a validation-authoritative outcomeSuccess distinct from runner success (#2344)', () => {
    // Clean exit, criterion missed → outcome is a failure.
    const missed = buildTaskTelemetryContext(
      { ...baseAgent, result: { success: true, duration: 1, validationPassed: false } }, {});
    expect(missed.success).toBe(true);
    expect(missed.outcomeSuccess).toBe(false);
    // No criterion declared → outcomeSuccess mirrors runner success.
    const plain = buildTaskTelemetryContext({ ...baseAgent, result: { success: true, duration: 1 } }, {});
    expect(plain.outcomeSuccess).toBe(true);
  });

  it('carries the validation verdict into the harvested failure signature sample (#2344)', () => {
    const agent = {
      ...baseAgent,
      result: {
        success: false,
        duration: 2000,
        validationPassed: false,
        errorAnalysis: { category: 'test-failure', message: 'no commit produced' }
      }
    };
    const ctx = buildTaskTelemetryContext(agent, { description: 'fix the flaky test', taskType: 'internal' });
    const data = { failureSignatures: {} };
    recordFailureSignature(data, ctx);
    expect(data.failureSignatures['test-failure'].recent[0].validationPassed).toBe(false);
  });

  it('harvests failures even for the sandboxed external/untyped fallback (#2333)', () => {
    const agent = {
      ...baseAgent,
      result: {
        success: false,
        duration: 3000,
        errorAnalysis: { category: 'timeout', message: 'exceeded wall clock' }
      }
    };
    const ctx = buildTaskTelemetryContext(agent, { description: 'ship the quarterly widgets' });
    expect(ctx.executionContext.taskType).toBe('external/untyped');
    const data = { failureSignatures: {} };
    recordFailureSignature(data, ctx);
    expect(data.failureSignatures['timeout'].recent[0].taskType).toBe('external/untyped');
  });
});

describe('recordFailureSignature', () => {
  const failureCtx = {
    success: false,
    failureSignature: { category: 'test-failure', messageSnippet: 'boom', failurePosition: 'testing' },
    executionContext: { provider: 'claude', model: 'opus', modelTier: 'heavy', taskType: 'user-task' },
    latency: { wallMs: 300000, executionMs: 250000 }
  };

  it('is additive/back-compat: seeds failureSignatures onto an OLD learning.json without the key', () => {
    // Simulates a pre-#2329 learning.json that has no failureSignatures field.
    const oldData = { version: 1, byTaskType: {}, errorPatterns: {}, totals: { completed: 0 } };
    expect(oldData.failureSignatures).toBeUndefined();

    const out = recordFailureSignature(oldData, failureCtx);

    expect(out).toBe(oldData); // mutates in place
    expect(out.failureSignatures['test-failure'].count).toBe(1);
    const sample = out.failureSignatures['test-failure'].recent[0];
    expect(sample).toMatchObject({
      messageSnippet: 'boom',
      failurePosition: 'testing',
      provider: 'claude',
      model: 'opus',
      modelTier: 'heavy',
      taskType: 'user-task',
      wallMs: 300000,
      executionMs: 250000
    });
    expect(sample.recordedAt).toBeTruthy();
    // Untouched legacy keys survive.
    expect(out.byTaskType).toEqual({});
    expect(out.totals.completed).toBe(0);
  });

  it('accumulates count and bounds recent samples to the last 10', () => {
    const data = { failureSignatures: {} };
    for (let i = 0; i < 15; i++) recordFailureSignature(data, failureCtx);
    const bucket = data.failureSignatures['test-failure'];
    expect(bucket.count).toBe(15);
    expect(bucket.recent).toHaveLength(10);
  });

  it('is a no-op on success or when the failure has no category', () => {
    const data = { failureSignatures: {} };
    recordFailureSignature(data, { success: true, failureSignature: null });
    recordFailureSignature(data, { failureSignature: { category: null, messageSnippet: 'x' } });
    expect(data.failureSignatures).toEqual({});
  });
});

describe('computeLatencySplit (#2329)', () => {
  const S = '2026-07-09T10:00:00.000Z'; // startedAt
  const C = '2026-07-09T10:05:00.000Z'; // completedAt (+5min)
  const CREATED = '2026-07-09T09:59:30.000Z'; // 30s before start

  it('reports all three legs as measured when every source is present', () => {
    expect(computeLatencySplit({ startedAt: S, completedAt: C, createdAt: CREATED, durationMs: 250000 }))
      .toEqual({
        wallMs: 300000, queueMs: 30000, executionMs: 250000,
        source: { wall: 'measured', queue: 'measured', execution: 'measured' }
      });
  });

  it('derives the queue leg from wall − compute when createdAt is missing', () => {
    const out = computeLatencySplit({ startedAt: S, completedAt: C, durationMs: 250000 });
    expect(out.queueMs).toBe(50000);
    expect(out.source.queue).toBe('derived');
    expect(out.source.execution).toBe('measured');
  });

  it('derives the compute leg from wall − queue when the runner duration is missing', () => {
    const out = computeLatencySplit({ startedAt: S, completedAt: C, createdAt: CREATED, durationMs: undefined });
    expect(out.executionMs).toBe(270000); // 300000 − 30000
    expect(out.source.execution).toBe('derived');
    expect(out.source.queue).toBe('measured');
  });

  it('leaves a leg null (not fabricated) when wall itself is unmeasurable', () => {
    // No completedAt → no wall → nothing to split from.
    const out = computeLatencySplit({ startedAt: S, createdAt: CREATED, durationMs: 250000 });
    expect(out.wallMs).toBeNull();
    expect(out.executionMs).toBe(250000); // still measured directly
    expect(out.queueMs).toBe(30000); // measured directly
    expect(out.source).toEqual({ wall: null, queue: 'measured', execution: 'measured' });
  });

  it('does not derive a negative leg when compute exceeds wall', () => {
    // duration (400000) > wall (300000): can't derive a sane queue leg.
    const out = computeLatencySplit({ startedAt: S, completedAt: C, durationMs: 400000 });
    expect(out.queueMs).toBeNull();
    expect(out.source.queue).toBeNull();
  });

  it('keeps a measured 0 distinct from an absent leg', () => {
    // createdAt === startedAt → genuine 0ms queue, measured (not null, not derived).
    const out = computeLatencySplit({ startedAt: S, completedAt: C, createdAt: S, durationMs: 250000 });
    expect(out.queueMs).toBe(0);
    expect(out.source.queue).toBe('measured');
  });
});

describe('getWindowedStats (issue #2460)', () => {
  beforeEach(() => { loadLearningData.mockReset(); });

  it('windows the task type ring and returns computeWindowedStats output', async () => {
    loadLearningData.mockResolvedValue({
      byTaskType: {
        'self-improve:ui': {
          recentOutcomes: [
            { t: '2026-07-10T00:00:00.000Z', s: false },
            { t: '2026-07-10T00:01:00.000Z', s: true },
            { t: '2026-07-10T00:02:00.000Z', s: true }
          ]
        }
      }
    });
    const stats = await getWindowedStats('self-improve:ui', { maxAgeMs: Infinity });
    expect(stats.windowedCompleted).toBe(3);
    expect(stats.windowedSucceeded).toBe(2);
    expect(stats.windowedSuccessRate).toBe(67);
  });

  it('returns the null-successRate sentinel for an absent task type', async () => {
    loadLearningData.mockResolvedValue({ byTaskType: {} });
    const stats = await getWindowedStats('does-not-exist');
    expect(stats.windowedCompleted).toBe(0);
    expect(stats.windowedSuccessRate).toBeNull();
  });

  it('honors an explicit maxCount window', async () => {
    const recentOutcomes = [];
    for (let i = 0; i < 10; i++) recentOutcomes.push({ t: `old-${i}`, s: false });
    for (let i = 0; i < 3; i++) recentOutcomes.push({ t: `new-${i}`, s: true });
    loadLearningData.mockResolvedValue({ byTaskType: { 'auto-fix': { recentOutcomes } } });
    const stats = await getWindowedStats('auto-fix', { maxCount: 3, maxAgeMs: Infinity });
    expect(stats.windowedCompleted).toBe(3);
    expect(stats.windowedSuccessRate).toBe(100);
  });
});

describe('ENVIRONMENTAL_ERROR_CATEGORIES (issue #2618)', () => {
  it('contains exactly the environmental/infrastructure categories', () => {
    expect([...ENVIRONMENTAL_ERROR_CATEGORIES].sort()).toEqual([
      'auth',
      'auth-error',
      'billing-error',
      'connection',
      'forbidden',
      'model-not-available',
      'rate-limit',
      'startup-failure',
      'usage-limit'
    ]);
  });

  it('deliberately excludes categories that can be genuine task/model signal', () => {
    // timeout: a task too big for its tier legitimately times out; unknown: could
    // be anything — excluding them from learning would blind routing to real signal.
    expect(ENVIRONMENTAL_ERROR_CATEGORIES.has('timeout')).toBe(false);
    expect(ENVIRONMENTAL_ERROR_CATEGORIES.has('unknown')).toBe(false);
    expect(ENVIRONMENTAL_ERROR_CATEGORIES.has('test-failure')).toBe(false);
    expect(ENVIRONMENTAL_ERROR_CATEGORIES.has(null)).toBe(false);
  });
});

describe('recordEnvironmentalFailure (issue #2618)', () => {
  it('initializes the additive key on data that predates it (back-compat)', () => {
    const data = {}; // old learning.json shape — no environmentalFailures key
    recordEnvironmentalFailure(data, { category: 'rate-limit', taskType: 'auto-fix' });

    expect(data.environmentalFailures['rate-limit'].count).toBe(1);
    expect(data.environmentalFailures['rate-limit'].lastOccurred).toEqual(expect.any(String));
    expect(data.environmentalFailures['rate-limit'].taskTypes).toEqual({ 'auto-fix': 1 });
  });

  it('accumulates counts and affected task types per category', () => {
    const data = {};
    recordEnvironmentalFailure(data, { category: 'rate-limit', taskType: 'auto-fix' });
    recordEnvironmentalFailure(data, { category: 'rate-limit', taskType: 'auto-fix' });
    recordEnvironmentalFailure(data, { category: 'rate-limit', taskType: 'user-task' });
    recordEnvironmentalFailure(data, { category: 'billing-error', taskType: 'user-task' });

    expect(data.environmentalFailures['rate-limit'].count).toBe(3);
    expect(data.environmentalFailures['rate-limit'].taskTypes).toEqual({ 'auto-fix': 2, 'user-task': 1 });
    expect(data.environmentalFailures['billing-error'].count).toBe(1);
  });

  it('is a no-op when the failure carries no category', () => {
    const data = {};
    recordEnvironmentalFailure(data, { category: null, taskType: 'auto-fix' });
    recordEnvironmentalFailure(data, {});
    expect(data.environmentalFailures).toBeUndefined();
  });
});
