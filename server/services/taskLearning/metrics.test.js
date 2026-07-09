import { describe, it, expect } from 'vitest';
import { buildTaskTelemetryContext, recordFailureSignature } from './metrics.js';

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
      executionMs: 250000
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
      taskType: 'unknown',
      component: null,
      inputChars: null, // null, not 0 — description absent, not empty
      routingReason: null
    });
    expect(ctx.latency).toEqual({ wallMs: null, queueMs: null, executionMs: null });
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

  it('leaves queueMs null when the task carries no createdAt', () => {
    const ctx = buildTaskTelemetryContext(baseAgent, { description: 'no createdAt', taskType: 'user' });
    expect(ctx.latency.queueMs).toBeNull();
    expect(ctx.latency.wallMs).toBe(300000); // wall still derivable from agent timestamps
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
