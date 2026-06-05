import { describe, it, expect } from 'vitest';
import { computeGoalVelocity } from './goals.js';

describe('computeGoalVelocity', () => {
  it('returns null with fewer than two progress entries', () => {
    expect(computeGoalVelocity({ progressHistory: [] })).toBeNull();
    expect(computeGoalVelocity({ progressHistory: [{ date: '2026-01-01', value: 10 }] })).toBeNull();
    expect(computeGoalVelocity({})).toBeNull();
  });

  it('computes a positive percent-per-month from a valid history', () => {
    const v = computeGoalVelocity({
      progress: 30,
      progressHistory: [
        { date: '2026-01-01', value: 0 },
        { date: '2026-02-01', value: 30 },
      ],
    });
    expect(v).not.toBeNull();
    // 30 points over ~31 days ≈ one month → ~30%/month.
    expect(v.percentPerMonth).toBeGreaterThan(25);
    expect(v.trend).toBe('stable');
  });

  it('returns null when a progress entry has a malformed date (NaN guard)', () => {
    // A bad `progressHistory.date` makes the date subtraction NaN; without the
    // guard that yields NaN velocity / mis-ordered trend rather than a clean
    // "insufficient data" null.
    expect(computeGoalVelocity({
      progressHistory: [
        { date: 'not-a-date', value: 0 },
        { date: '2026-02-01', value: 30 },
      ],
    })).toBeNull();
  });
});
