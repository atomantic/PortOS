import { describe, it, expect } from 'vitest';
import { deriveFailureSignalAvoidance } from './routing.js';

// deriveFailureSignalAvoidance is the pure "routing consumes the enriched
// failure signatures" core added for issue #2329. It takes learning data + a
// task type and returns a recency-weighted tier avoidance cross-referenced
// against routingAccuracy — no I/O, so every branch is exercised directly.

const sample = (over = {}) => ({
  modelTier: 'heavy', provider: 'claude', model: 'opus', taskType: 'user-task',
  messageSnippet: 'boom', failurePosition: 'testing', wallMs: 1000, executionMs: 900,
  ...over
});

const dataWith = (recent, routingAccuracy = {}) => ({
  failureSignatures: { 'test-failure': { count: recent.length, recent } },
  routingAccuracy
});

describe('deriveFailureSignalAvoidance (#2329)', () => {
  it('returns no avoidance below the minimum sample bar', () => {
    const data = dataWith([sample(), sample()]); // only 2 < MIN_FAILURE_SAMPLES(3)
    const out = deriveFailureSignalAvoidance(data, 'user-task');
    expect(out.avoidTiers).toEqual([]);
    expect(out.sampleCount).toBe(2);
  });

  it('flags an unproven tier with enough recent failures and attributes provider/model', () => {
    const data = dataWith([
      sample({ modelTier: 'heavy', provider: 'claude', model: 'opus' }),
      sample({ modelTier: 'heavy', provider: 'claude', model: 'opus' }),
      sample({ modelTier: 'heavy', provider: 'codex', model: 'gpt' })
    ]); // no routingAccuracy → tier is unproven (no success data)
    const out = deriveFailureSignalAvoidance(data, 'user-task');
    expect(out.avoidTiers).toContain('heavy');
    expect(out.dominant).toMatchObject({ tier: 'heavy', failures: 3, provider: 'claude', model: 'opus' });
  });

  it('does NOT flag a proven tier (>=80% in routingAccuracy) despite absolute failures', () => {
    // failureSignatures only records failures — a tier with 40 successes + 3
    // failures is fine and must keep its slot.
    const data = dataWith(
      [sample(), sample(), sample()],
      { 'user-task': { heavy: { succeeded: 40, failed: 3 } } } // ~93%
    );
    const out = deriveFailureSignalAvoidance(data, 'user-task');
    expect(out.avoidTiers).toEqual([]);
    // dominant is scoped to AVOIDED tiers only — a proven tier that isn't being
    // steered away from must never be reported as the dominant "avoided" tier.
    expect(out.dominant).toBeNull();
  });

  it('flags an unproven tier that is below the high-success threshold in routingAccuracy', () => {
    const data = dataWith(
      [sample(), sample(), sample()],
      { 'user-task': { heavy: { succeeded: 3, failed: 7 } } } // 30% < 80%
    );
    expect(deriveFailureSignalAvoidance(data, 'user-task').avoidTiers).toContain('heavy');
  });

  it('scopes samples to the requested task type', () => {
    const data = dataWith([
      sample({ taskType: 'other-task' }),
      sample({ taskType: 'other-task' }),
      sample({ taskType: 'other-task' })
    ]);
    const out = deriveFailureSignalAvoidance(data, 'user-task');
    expect(out.sampleCount).toBe(0);
    expect(out.avoidTiers).toEqual([]);
  });

  it('ignores non-routable learned tiers (minimal/low)', () => {
    const data = dataWith([
      sample({ modelTier: 'minimal' }),
      sample({ modelTier: 'low' }),
      sample({ modelTier: 'minimal' })
    ]);
    const out = deriveFailureSignalAvoidance(data, 'user-task');
    expect(out.sampleCount).toBe(0);
    expect(out.avoidTiers).toEqual([]);
  });

  it('tolerates a pre-#2329 learning file with no failureSignatures key', () => {
    const out = deriveFailureSignalAvoidance({ routingAccuracy: {} }, 'user-task');
    expect(out).toEqual({ avoidTiers: [], sampleCount: 0, dominant: null });
  });
});
