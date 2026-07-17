import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deriveFailureSignalAvoidance,
  getAdaptiveCooldownMultiplier,
  getSkippedTaskTypes,
  getTaskTypeConfidence,
  getTaskTypePriorityMultiplier,
  checkAndRehabilitateSkippedTasks,
  getSkippedTaskTypesWithStatus,
  suggestModelTier,
  getPerformanceSummary
} from './routing.js';
import { loadLearningData } from './store.js';
import { resetTaskTypeLearning } from './metrics.js';

// Stub ONLY the persistence + log surface of the store; every pure helper
// (computeEffectiveSuccessRate, computeWindowedStats, isSandboxedTaskType, …)
// stays real so the decision tests exercise the actual windowed-rate math.
vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadLearningData: vi.fn(), emitLog: vi.fn() };
});
vi.mock('./metrics.js', () => ({ resetTaskTypeLearning: vi.fn() }));

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

  it('ignores environmental-category signatures entirely (issue #2618)', () => {
    // An hour of provider rate-limiting piles samples into the 'rate-limit'
    // bucket; those must not reach avoidTiers through the signature signal.
    const data = {
      failureSignatures: {
        'rate-limit': { count: 5, recent: [sample(), sample(), sample(), sample(), sample()] }
      },
      routingAccuracy: {}
    };
    const out = deriveFailureSignalAvoidance(data, 'user-task');
    expect(out.avoidTiers).toEqual([]);
    expect(out.sampleCount).toBe(0);

    // Mixed buckets: only the non-environmental samples count.
    const mixed = {
      failureSignatures: {
        'rate-limit': { count: 3, recent: [sample(), sample(), sample()] },
        'test-failure': { count: 2, recent: [sample(), sample()] }
      },
      routingAccuracy: {}
    };
    const outMixed = deriveFailureSignalAvoidance(mixed, 'user-task');
    expect(outMixed.sampleCount).toBe(2); // below MIN_FAILURE_SAMPLES(3)
    expect(outMixed.avoidTiers).toEqual([]);
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

  it('respects a caller-supplied minFailureSamples bar (issue #2344 aggressiveness gate)', () => {
    // 3 unproven-tier failures: steered off at the aggressive default bar (3)...
    const data = dataWith([sample(), sample(), sample()]);
    expect(deriveFailureSignalAvoidance(data, 'user-task').avoidTiers).toContain('heavy');
    // ...but held back at the conservative bar (5) the routing gate uses until
    // the correlation-quality window proves the signal predicts outcomes.
    expect(deriveFailureSignalAvoidance(data, 'user-task', { minFailureSamples: 5 }).avoidTiers).toEqual([]);
    // Once enough failures accumulate, even the conservative bar steers off.
    const more = dataWith([sample(), sample(), sample(), sample(), sample()]);
    expect(deriveFailureSignalAvoidance(more, 'user-task', { minFailureSamples: 5 }).avoidTiers).toContain('heavy');
  });

  describe('age windowing (issue #2619)', () => {
    const NOW = Date.parse('2026-06-25T12:00:00.000Z');
    const at = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

    it('ignores failure samples older than the window (outage-era samples stop steering)', () => {
      // Three heavy-tier failures, all >30 days old — a since-fixed outage.
      const data = dataWith([
        sample({ recordedAt: at(40) }),
        sample({ recordedAt: at(45) }),
        sample({ recordedAt: at(50) })
      ]);
      const out = deriveFailureSignalAvoidance(data, 'user-task', { now: NOW });
      expect(out.sampleCount).toBe(0);
      expect(out.avoidTiers).toEqual([]);
    });

    it('still steers off a tier whose recent failures are within the window', () => {
      const data = dataWith([
        sample({ recordedAt: at(1) }),
        sample({ recordedAt: at(2) }),
        sample({ recordedAt: at(3) })
      ]);
      const out = deriveFailureSignalAvoidance(data, 'user-task', { now: NOW });
      expect(out.sampleCount).toBe(3);
      expect(out.avoidTiers).toContain('heavy');
    });

    it('counts only in-window samples toward the failure-sample bar', () => {
      // 2 fresh + 2 stale: below the aggressive bar (3) once the stale two drop.
      const data = dataWith([
        sample({ recordedAt: at(1) }),
        sample({ recordedAt: at(2) }),
        sample({ recordedAt: at(40) }),
        sample({ recordedAt: at(45) })
      ]);
      const out = deriveFailureSignalAvoidance(data, 'user-task', { now: NOW });
      expect(out.sampleCount).toBe(2);
      expect(out.avoidTiers).toEqual([]);
    });

    it('keeps an undated sample (unparseable recordedAt), mirroring computeWindowedStats', () => {
      const data = dataWith([
        sample(), // no recordedAt
        sample({ recordedAt: 'not-a-date' }),
        sample({ recordedAt: at(1) })
      ]);
      const out = deriveFailureSignalAvoidance(data, 'user-task', { now: NOW });
      expect(out.sampleCount).toBe(3);
      expect(out.avoidTiers).toContain('heavy');
    });

    it('disables the age filter when maxAgeMs is null/0 (back-compat with direct callers)', () => {
      const data = dataWith([
        sample({ recordedAt: at(40) }),
        sample({ recordedAt: at(45) }),
        sample({ recordedAt: at(50) })
      ]);
      expect(deriveFailureSignalAvoidance(data, 'user-task', { now: NOW, maxAgeMs: 0 }).avoidTiers).toContain('heavy');
    });
  });
});

// ---------------------------------------------------------------------------
// Effective (windowed) success rate in decisions — issue #2617.
//
// The issue's failure scenario: a task type accrues 40 failures during a
// since-fixed bug, then succeeds 15 straight. Lifetime rate ≈ 27%, windowed
// rate = 100%. Every decision below must read the windowed rate once the ring
// has ≥5 windowed samples, and fall back to lifetime behavior when it doesn't.
// ---------------------------------------------------------------------------

// A recent outcome ring ending now, oldest first.
const ring = (results, now = Date.now()) =>
  results.map((s, i) => ({ t: new Date(now - (results.length - i) * 60000).toISOString(), s }));

// Lifetime-poor / recently-recovered bucket (the issue's scenario).
const recoveredMetrics = () => ({
  completed: 55, succeeded: 15, failed: 40, successRate: 27,
  lastCompleted: new Date().toISOString(),
  avgDurationMs: 60000,
  recentOutcomes: ring(Array(15).fill(true))
});

// Lifetime-poor bucket with a window too thin to trust (<5 samples) — must
// behave exactly as the lifetime rate dictates (acceptance criterion 2).
const thinWindowMetrics = () => ({
  completed: 55, succeeded: 15, failed: 40, successRate: 27,
  lastCompleted: new Date().toISOString(),
  recentOutcomes: ring([true, true, true])
});

// Still-broken bucket: poor lifetime AND poor recent window.
const stillFailingMetrics = () => ({
  completed: 20, succeeded: 2, failed: 18, successRate: 10,
  lastCompleted: new Date().toISOString(),
  recentOutcomes: ring(Array(8).fill(false))
});

const learningWith = (byTaskType) => ({
  byTaskType,
  routingAccuracy: {},
  failureSignatures: {},
  correlationWindow: [],
  totals: { completed: 0, succeeded: 0, failed: 0, totalDurationMs: 0, avgDurationMs: 0 }
});

describe('windowed-rate decisions (issue #2617)', () => {
  beforeEach(() => {
    vi.mocked(loadLearningData).mockReset();
    vi.mocked(resetTaskTypeLearning).mockReset();
  });

  describe('getAdaptiveCooldownMultiplier', () => {
    it('no longer skips a recovered task type (windowed 100% beats lifetime 27%)', async () => {
      loadLearningData.mockResolvedValue(learningWith({ 'self-improve:x': recoveredMetrics() }));
      const out = await getAdaptiveCooldownMultiplier('self-improve:x');
      expect(out.skip).toBe(false);
      expect(out.multiplier).toBe(0.7); // windowed 100% → high-success branch
      expect(out.successRate).toBe(100);
      expect(out.rateSource).toBe('windowed');
    });

    it('keeps skipping when the window is too thin (lifetime fallback, acceptance criterion 2)', async () => {
      loadLearningData.mockResolvedValue(learningWith({ 'self-improve:x': thinWindowMetrics() }));
      const out = await getAdaptiveCooldownMultiplier('self-improve:x');
      expect(out.skip).toBe(true); // lifetime 27% < 30 with ≥5 completions
      expect(out.successRate).toBe(27);
      expect(out.rateSource).toBe('lifetime');
    });

    it('still skips a type whose recent window is also failing', async () => {
      loadLearningData.mockResolvedValue(learningWith({ 'self-improve:x': stillFailingMetrics() }));
      const out = await getAdaptiveCooldownMultiplier('self-improve:x');
      expect(out.skip).toBe(true);
      expect(out.rateSource).toBe('windowed');
    });
  });

  describe('getSkippedTaskTypes', () => {
    it('drops a recovered type from the skip list but keeps a still-failing one', async () => {
      loadLearningData.mockResolvedValue(learningWith({
        'recovered': recoveredMetrics(),
        'still-broken': stillFailingMetrics(),
        'thin-window': thinWindowMetrics()
      }));
      const skipped = await getSkippedTaskTypes();
      const types = skipped.map(s => s.taskType);
      expect(types).not.toContain('recovered');
      expect(types).toContain('still-broken');
      expect(types).toContain('thin-window'); // lifetime fallback still applies
    });
  });

  describe('getTaskTypeConfidence', () => {
    it('restores auto-approval for a recovered type (windowed rate gates the tier)', async () => {
      loadLearningData.mockResolvedValue(learningWith({ 'self-improve:x': recoveredMetrics() }));
      const out = await getTaskTypeConfidence('self-improve:x');
      expect(out.tier).toBe('high');
      expect(out.autoApprove).toBe(true);
      expect(out.successRate).toBe(100);
      expect(out.rateSource).toBe('windowed');
      expect(out.reason).toContain('recent success');
    });

    it('still requires approval when the window is too thin (lifetime fallback)', async () => {
      loadLearningData.mockResolvedValue(learningWith({ 'self-improve:x': thinWindowMetrics() }));
      const out = await getTaskTypeConfidence('self-improve:x');
      expect(out.tier).toBe('low');
      expect(out.autoApprove).toBe(false);
      expect(out.rateSource).toBe('lifetime');
    });

    it('keeps the null successRate sentinel for an unknown task type', async () => {
      loadLearningData.mockResolvedValue(learningWith({}));
      const out = await getTaskTypeConfidence('never-seen');
      expect(out.tier).toBe('new');
      expect(out.successRate).toBeNull();
    });
  });

  describe('getTaskTypePriorityMultiplier', () => {
    it('boosts a recovered type instead of demoting it', async () => {
      loadLearningData.mockResolvedValue(learningWith({ 'self-improve:x': recoveredMetrics() }));
      expect(await getTaskTypePriorityMultiplier('self-improve:x')).toBe(1.2);
    });

    it('demotes on the lifetime rate when the window is too thin', async () => {
      loadLearningData.mockResolvedValue(learningWith({ 'self-improve:x': thinWindowMetrics() }));
      expect(await getTaskTypePriorityMultiplier('self-improve:x')).toBe(0.9);
    });
  });

  describe('checkAndRehabilitateSkippedTasks', () => {
    it('resets a recovered type via the recovery path even though it is not idle (issue #2619)', async () => {
      // Poor lifetime (27%) but a clean recent window (100% over 15 samples) and
      // still running (lastCompleted just now). Pre-#2619 the idle gate left its
      // stale lifetime/duration/failure-signature data in place forever; now the
      // recovery path clears it regardless of idle time.
      loadLearningData.mockResolvedValue(learningWith({ 'recovered': recoveredMetrics() }));
      const out = await checkAndRehabilitateSkippedTasks();
      expect(out.count).toBe(1);
      expect(out.rehabilitated[0]).toMatchObject({ taskType: 'recovered', trigger: 'recovery' });
      expect(resetTaskTypeLearning).toHaveBeenCalledWith('recovered');
    });

    it('does not reset a poor-lifetime type whose recent window is still too thin to prove recovery (#2619)', async () => {
      // Same 27% lifetime, but only 3 recent samples — below the 5-sample
      // recovery bar — and not idle. Neither path should fire.
      loadLearningData.mockResolvedValue(learningWith({ 'thin': thinWindowMetrics() }));
      const out = await checkAndRehabilitateSkippedTasks();
      expect(out.count).toBe(0);
      expect(resetTaskTypeLearning).not.toHaveBeenCalled();
    });

    it('does not reset a healthy-lifetime type skipped by a recent failure burst (windowed-driven skip)', async () => {
      // 200 runs at 95% lifetime, then a transient outage: 6 recent failures →
      // windowed 0% → the type IS skipped. But the skip is windowed-driven, so
      // the destructive lifetime reset must NOT fire — the window self-heals.
      const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const healthy = {
        completed: 200, succeeded: 190, failed: 10, successRate: 95,
        lastCompleted: new Date(tenDaysAgo).toISOString(),
        recentOutcomes: ring(Array(6).fill(false), tenDaysAgo)
      };
      loadLearningData.mockResolvedValue(learningWith({ 'healthy-burst': healthy }));
      // Confirm it is indeed currently skipped…
      const skipped = await getSkippedTaskTypes();
      expect(skipped.map(s => s.taskType)).toContain('healthy-burst');
      // …but never rehabilitated/reset, and the status view says not eligible.
      const out = await checkAndRehabilitateSkippedTasks(7 * 24 * 60 * 60 * 1000);
      expect(out.count).toBe(0);
      expect(resetTaskTypeLearning).not.toHaveBeenCalled();
      const status = await getSkippedTaskTypesWithStatus(7 * 24 * 60 * 60 * 1000);
      expect(status[0]).toMatchObject({ taskType: 'healthy-burst', eligibleForRehabilitation: false });
    });

    it('still rehabilitates a genuinely skipped type past the grace period', async () => {
      const broken = stillFailingMetrics();
      // Push BOTH the ring and lastCompleted outside any recency concern for the
      // grace period; the ring stays in-window (30 days > 8 samples aged 10 days).
      const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
      broken.lastCompleted = new Date(tenDaysAgo).toISOString();
      broken.recentOutcomes = ring(Array(8).fill(false), tenDaysAgo);
      loadLearningData.mockResolvedValue(learningWith({ 'still-broken': broken }));
      const out = await checkAndRehabilitateSkippedTasks(7 * 24 * 60 * 60 * 1000);
      expect(out.count).toBe(1);
      expect(resetTaskTypeLearning).toHaveBeenCalledWith('still-broken');
    });
  });

  describe('suggestModelTier', () => {
    it('no longer suggests heavy for a recovered type (effective rate in the low-success fallback)', async () => {
      loadLearningData.mockResolvedValue(learningWith({ 'self-improve:x': recoveredMetrics() }));
      expect(await suggestModelTier('self-improve:x')).toBeNull();
    });

    it('still suggests heavy on the lifetime rate when the window is too thin', async () => {
      loadLearningData.mockResolvedValue(learningWith({ 'self-improve:x': thinWindowMetrics() }));
      const out = await suggestModelTier('self-improve:x');
      expect(out).toMatchObject({ suggested: 'heavy' });
      expect(out.reason).toContain('27%');
    });

    it('gates the all-time failing-tier branch on the recent window (populated routingAccuracy)', async () => {
      // The issue's scenario with REAL routing data: all 55 runs on one tier →
      // that tier's all-time routingAccuracy is 27% (<40 "failing"), which
      // pre-fix returned `heavy` before the effective-rate fallback ever ran.
      const data = learningWith({ 'self-improve:x': recoveredMetrics() });
      data.routingAccuracy = { 'self-improve:x': { default: { succeeded: 15, failed: 40 } } };
      loadLearningData.mockResolvedValue(data);
      expect(await suggestModelTier('self-improve:x')).toBeNull();
    });

    it('still escalates on failing tier data when the window is too thin (lifetime behavior preserved)', async () => {
      const data = learningWith({ 'self-improve:x': thinWindowMetrics() });
      data.routingAccuracy = { 'self-improve:x': { default: { succeeded: 15, failed: 40 } } };
      loadLearningData.mockResolvedValue(data);
      const out = await suggestModelTier('self-improve:x');
      expect(out).toMatchObject({ suggested: 'heavy' });
      expect(out.avoidTiers).toContain('default');
    });

    it('keeps tier-failure evidence when the failing tier failed RECENTLY (recovery may be on another tier)', async () => {
      // Task-wide window is healthy, but the `default` tier has fresh failure
      // samples in failureSignatures — the recent successes may all have run on
      // a different tier (the ring carries no tier identity), so the failing
      // tier must stay steered away from, not be cleared by task-wide recovery.
      const data = learningWith({ 'self-improve:x': recoveredMetrics() });
      data.routingAccuracy = { 'self-improve:x': { default: { succeeded: 0, failed: 10 } } };
      data.failureSignatures = {
        'tool-error': {
          count: 2,
          recent: [
            { taskType: 'self-improve:x', modelTier: 'default', recordedAt: new Date().toISOString() },
            { taskType: 'self-improve:x', modelTier: 'default', recordedAt: new Date().toISOString() }
          ]
        }
      };
      loadLearningData.mockResolvedValue(data);
      const out = await suggestModelTier('self-improve:x');
      expect(out).toMatchObject({ suggested: 'heavy' });
      expect(out.avoidTiers).toContain('default');
    });
  });

  describe('getPerformanceSummary', () => {
    it('classifies a recovered type as a top performer, not needs-attention/skipped', async () => {
      loadLearningData.mockResolvedValue(learningWith({
        'recovered': recoveredMetrics(),
        'still-broken': stillFailingMetrics()
      }));
      const summary = await getPerformanceSummary();
      expect(summary.topPerformers.map(e => e.taskType)).toContain('recovered');
      expect(summary.needsAttention.map(e => e.taskType)).not.toContain('recovered');
      expect(summary.skipped.map(e => e.taskType)).not.toContain('recovered');
      expect(summary.skipped.map(e => e.taskType)).toContain('still-broken');
    });

    it('pairs a windowed rate with its own sample count (evidence pairing for alerts/UI)', async () => {
      // Healthy lifetime (200 runs) hit by a 6-failure burst: the windowed 0%
      // must travel with windowedCompleted=6, not the 200 lifetime completions.
      loadLearningData.mockResolvedValue(learningWith({
        'healthy-burst': {
          completed: 200, succeeded: 190, failed: 10, successRate: 95,
          lastCompleted: new Date().toISOString(), avgDurationMs: 60000,
          recentOutcomes: ring(Array(6).fill(false))
        }
      }));
      const summary = await getPerformanceSummary();
      const entry = summary.needsAttention.find(e => e.taskType === 'healthy-burst');
      expect(entry).toMatchObject({ successRate: 0, rateSource: 'windowed', windowedCompleted: 6, completed: 200 });
    });
  });

  describe('confidence null sentinel', () => {
    it('preserves null (not a fabricated 0) for a bucket with no stored rate and a thin window', async () => {
      loadLearningData.mockResolvedValue(learningWith({
        'legacy': { completed: 6, lastCompleted: new Date().toISOString() } // no successRate field, no ring
      }));
      const out = await getTaskTypeConfidence('legacy');
      expect(out.successRate).toBeNull();
      expect(out.tier).toBe('low'); // comparisons treat the absent rate as 0
    });
  });
});
