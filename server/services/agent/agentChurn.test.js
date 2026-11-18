import { describe, it, expect, vi } from 'vitest';
import {
  CHURN_WINDOW_MS,
  CHURN_MIN_RUNS,
  summarizeRecentRuns,
  computeChurn,
  observeAgentChurn
} from './agentChurn.js';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function ring({ n, now, durationMs = 90_000, gapMs = 10 * MIN, withDuration = true }) {
  return Array.from({ length: n }, (_, i) => {
    const sample = {
      t: new Date(now - (n - 1 - i) * gapMs).toISOString(),
      s: true
    };
    if (withDuration) sample.d = durationMs;
    return sample;
  });
}

describe('summarizeRecentRuns / computeChurn', () => {
  const now = Date.parse('2026-08-12T08:00:00.000Z');

  it('flags the last-night shape: many short-lived completions of the same task', () => {
    const recentOutcomes = ring({ n: 24, now, durationMs: 90_000, gapMs: 8 * MIN });
    const churn = computeChurn(recentOutcomes, { now });
    expect(churn.flagged).toBe(true);
    expect(churn.reason).toBe('short-lived-burst');
    expect(churn.windowCompleted).toBe(24);
    expect(churn.shortLivedCount).toBe(24);
    expect(churn.medianDurationMs).toBe(90_000);
  });

  it('flags a pre-instrumentation burst from completion spacing alone', () => {
    const recentOutcomes = ring({ n: 12, now, withDuration: false, gapMs: 10 * MIN });
    const churn = computeChurn(recentOutcomes, { now });
    expect(churn.flagged).toBe(true);
    expect(churn.reason).toBe('rapid-succession');
    expect(churn.shortLivedRatio).toBeNull();
    expect(churn.medianGapMs).toBe(10 * MIN);
  });

  it('does not flag a healthy drain of a few long runs', () => {
    const recentOutcomes = ring({ n: 3, now, durationMs: 25 * MIN, gapMs: 40 * MIN });
    expect(computeChurn(recentOutcomes, { now }).flagged).toBe(false);
  });

  it('does not flag many long runs (real work finishing, just busy)', () => {
    const recentOutcomes = ring({ n: 10, now, durationMs: 20 * MIN, gapMs: 30 * MIN });
    const churn = computeChurn(recentOutcomes, { now });
    expect(churn.flagged).toBe(false);
    expect(churn.windowCompleted).toBe(10);
    expect(churn.shortLivedRatio).toBe(0);
  });

  it('does not flag a thin window below the run-count floor', () => {
    const recentOutcomes = ring({ n: CHURN_MIN_RUNS - 1, now, durationMs: 30_000, gapMs: 5 * MIN });
    expect(computeChurn(recentOutcomes, { now }).flagged).toBe(false);
  });

  it('drops samples outside the burst window', () => {
    const recentOutcomes = [
      ...ring({ n: 20, now: now - CHURN_WINDOW_MS - HOUR, durationMs: 30_000, gapMs: 5 * MIN }),
      ...ring({ n: 2, now, durationMs: 30_000, gapMs: 5 * MIN })
    ];
    const stats = summarizeRecentRuns(recentOutcomes, { now });
    expect(stats.windowCompleted).toBe(2);
    expect(computeChurn(recentOutcomes, { now }).flagged).toBe(false);
  });

  it('treats an empty / missing ring as not-churning, with null duration sentinels', () => {
    const empty = computeChurn([], { now });
    expect(empty.flagged).toBe(false);
    expect(empty.medianDurationMs).toBeNull();
    expect(empty.shortLivedRatio).toBeNull();
    expect(computeChurn(undefined, { now }).flagged).toBe(false);
  });
});

describe('observeAgentChurn', () => {
  const now = Date.parse('2026-08-12T08:00:00.000Z');

  const burstRing = ring({ n: 20, now, durationMs: 80_000, gapMs: 8 * MIN });

  it('no-ops when the type is not churning', async () => {
    const park = vi.fn();
    const out = await observeAgentChurn(
      { result: { duration: 20 * MIN } },
      { metadata: { analysisType: 'branch-reconcile', app: 'app-1' } },
      {
        loadLearning: async () => ({ byTaskType: { 'self-improve:branch-reconcile': { recentOutcomes: ring({ n: 2, now, durationMs: 20 * MIN }) } } }),
        now: () => now,
        park
      }
    );
    expect(out.flagged).toBe(false);
    expect(park).not.toHaveBeenCalled();
  });

  it('parks a looping coordinator and keeps the signal local for Layered Intelligence', async () => {
    const park = vi.fn(async () => ({}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await observeAgentChurn(
      { result: { duration: 80_000 } },
      { metadata: { analysisType: 'branch-reconcile', app: 'app-1' } },
      {
        loadLearning: async () => ({ byTaskType: { 'self-improve:branch-reconcile': { recentOutcomes: burstRing } } }),
        now: () => now,
        park
      }
    );
    expect(out.flagged).toBe(true);
    expect(out.filed).toBe(false);
    expect(out.reason).toBe('local-metric');
    expect(out.parked).toBe(true);
    expect(park).toHaveBeenCalledWith('branch-reconcile', 'app-1', {
      reason: 'churn-detected',
      actionableCount: 20
    });
    // A coordinator the loop had to park is a workflow fault: stderr.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CoS churn: self-improve:branch-reconcile short-lived-burst'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CoS churn: parked branch-reconcile'));
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps a non-coordinator churn signal local without parking or filing', async () => {
    const park = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await observeAgentChurn(
      { result: { duration: 40_000 } },
      { metadata: { analysisType: 'claim-issue', app: 'app-1' } },
      {
        loadLearning: async () => ({ byTaskType: { 'self-improve:claim-issue': { recentOutcomes: burstRing } } }),
        now: () => now,
        park
      }
    );
    expect(out.flagged).toBe(true);
    expect(out.filed).toBe(false);
    expect(out.reason).toBe('local-metric');
    expect(out.parked).toBe(false);
    expect(park).not.toHaveBeenCalled();
    // Nothing acts on this signal, so it is an observation, not a fault: stdout.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('CoS churn: self-improve:claim-issue short-lived-burst'));
    expect(warn).not.toHaveBeenCalled();
  });
});
