import { describe, it, expect } from 'vitest';
import { aggregateAutoFixDiagnostics } from './autoFixMetrics.js';

// Build a task record carrying auto-fix diagnostics, mirroring the persisted
// shape (metadata.diagnostics + metadata.updatedAt) that #2335 writes.
function task({ id = 't', status = 'pending', tier = 4, strategy = 'escalate', category = 'unknown', observedAt, updatedAt }) {
  const diagnostics = {
    triggerEvent: 'AI_PROVIDER_EXECUTION_FAILED',
    target: 'Claude Code CLI (opus)',
    errorType: category,
    category,
    tier,
    fixStrategy: strategy,
    failureReason: 'boom',
  };
  if (observedAt) diagnostics.observedAt = observedAt;
  const metadata = { diagnostics };
  if (updatedAt) metadata.updatedAt = updatedAt;
  return { id, status, metadata };
}

const NOW = Date.parse('2026-07-09T12:00:00.000Z');

describe('aggregateAutoFixDiagnostics (issue #2328)', () => {
  it('returns an empty-but-sentinel shape when no tasks carry diagnostics', () => {
    const out = aggregateAutoFixDiagnostics(
      [{ id: 'x', status: 'completed', metadata: {} }, { id: 'y', status: 'pending', metadata: { diagnostics: 'not-an-object' } }],
      { now: NOW },
    );
    expect(out.total).toBe(0);
    expect(out.byTier).toEqual([]);
    expect(out.byCategory).toEqual([]);
    expect(out.trend).toEqual([]);
    // No denominator / no samples → null, NOT a fabricated 0.
    expect(out.overall.successRate).toBeNull();
    expect(out.timeToRecovery).toBeNull();
    expect(out.byStatus).toEqual({ pending: 0, in_progress: 0, blocked: 0, completed: 0 });
    expect(out.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it('ignores array-valued diagnostics (defensive) and non-diagnostics tasks', () => {
    const out = aggregateAutoFixDiagnostics([
      { id: 'a', status: 'completed', metadata: { diagnostics: ['nope'] } },
      task({ id: 'b', status: 'completed', tier: 1, strategy: 'config/env', category: 'auth-error' }),
    ], { now: NOW });
    expect(out.total).toBe(1);
  });

  it('breaks outcomes out by tier with per-tier success rate', () => {
    const out = aggregateAutoFixDiagnostics([
      task({ id: '1', status: 'completed', tier: 1, strategy: 'config/env', category: 'auth-error' }),
      task({ id: '2', status: 'pending', tier: 1, strategy: 'config/env', category: 'model-not-found' }),
      task({ id: '3', status: 'completed', tier: 3, strategy: 'constrained-agent-retry', category: 'rate-limit' }),
    ], { now: NOW });

    expect(out.total).toBe(3);
    expect(out.byStatus).toMatchObject({ completed: 2, pending: 1 });
    expect(out.overall).toMatchObject({ resolved: 2, open: 1 });
    expect(out.overall.successRate).toBeCloseTo(2 / 3);

    const t1 = out.byTier.find((t) => t.tier === 1);
    expect(t1).toMatchObject({ total: 2, resolved: 1, open: 1, strategy: 'config/env' });
    expect(t1.successRate).toBeCloseTo(0.5);
    expect(t1.label).toBe('config/env correction'); // resolved from the tier number

    const t3 = out.byTier.find((t) => t.tier === 3);
    expect(t3).toMatchObject({ total: 1, resolved: 1, successRate: 1 });
    // byTier is tier-ascending
    expect(out.byTier.map((t) => t.tier)).toEqual([1, 3]);
  });

  it('breaks outcomes out by failure category, most-frequent first', () => {
    const out = aggregateAutoFixDiagnostics([
      task({ id: '1', category: 'rate-limit', tier: 3 }),
      task({ id: '2', category: 'rate-limit', tier: 3 }),
      task({ id: '3', category: 'auth-error', tier: 1 }),
    ], { now: NOW });
    expect(out.byCategory[0]).toMatchObject({ category: 'rate-limit', total: 2 });
    expect(out.byCategory[1]).toMatchObject({ category: 'auth-error', total: 1 });
  });

  it('computes time-to-recovery only from completed tasks with both timestamps ordered', () => {
    const out = aggregateAutoFixDiagnostics([
      // 60s recovery
      task({ id: '1', status: 'completed', observedAt: '2026-07-09T10:00:00.000Z', updatedAt: '2026-07-09T10:01:00.000Z' }),
      // 120s recovery
      task({ id: '2', status: 'completed', observedAt: '2026-07-09T10:00:00.000Z', updatedAt: '2026-07-09T10:02:00.000Z' }),
      // completed but missing observedAt (legacy) → excluded from the sample
      task({ id: '3', status: 'completed', updatedAt: '2026-07-09T10:05:00.000Z' }),
      // pending → not a recovery
      task({ id: '4', status: 'pending', observedAt: '2026-07-09T10:00:00.000Z', updatedAt: '2026-07-09T10:03:00.000Z' }),
      // completed but updatedAt precedes observedAt (clock skew) → excluded
      task({ id: '5', status: 'completed', observedAt: '2026-07-09T10:02:00.000Z', updatedAt: '2026-07-09T10:00:00.000Z' }),
    ], { now: NOW });

    expect(out.timeToRecovery).toMatchObject({
      count: 2,
      minMs: 60000,
      maxMs: 120000,
      avgMs: 90000,
      medianMs: 90000,
    });
  });

  it('builds a daily success-rate trend keyed on the failure day', () => {
    const out = aggregateAutoFixDiagnostics([
      task({ id: '1', status: 'completed', observedAt: '2026-07-08T09:00:00.000Z' }),
      task({ id: '2', status: 'pending', observedAt: '2026-07-08T11:00:00.000Z' }),
      task({ id: '3', status: 'completed', observedAt: '2026-07-09T09:00:00.000Z' }),
    ], { now: NOW });

    expect(out.trend).toHaveLength(2);
    expect(out.trend[0]).toMatchObject({ date: '2026-07-08', total: 2, resolved: 1 });
    expect(out.trend[0].successRate).toBeCloseTo(0.5);
    expect(out.trend[1]).toMatchObject({ date: '2026-07-09', total: 1, resolved: 1, successRate: 1 });
    // ascending by date
    expect(out.trend.map((d) => d.date)).toEqual(['2026-07-08', '2026-07-09']);
  });

  it('falls back to updatedAt for the trend day when observedAt is absent', () => {
    const out = aggregateAutoFixDiagnostics([
      task({ id: '1', status: 'completed', updatedAt: '2026-07-07T09:00:00.000Z' }),
    ], { now: NOW });
    expect(out.trend).toEqual([{ date: '2026-07-07', total: 1, resolved: 1, successRate: 1 }]);
  });

  it('handles a non-array / empty input without throwing', () => {
    expect(aggregateAutoFixDiagnostics(null, { now: NOW }).total).toBe(0);
    expect(aggregateAutoFixDiagnostics(undefined, { now: NOW }).total).toBe(0);
  });
});
