// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compute30DayRollingAvg } from './ActivityBloodCorrelation.jsx';

describe('compute30DayRollingAvg', () => {
  it('starts 30 calendar days before the test day key', () => {
    const dailyData = [
      { date: '2026-02-12', steps: 1000 },
      { date: '2026-02-13', steps: 200 },
      { date: '2026-03-14', steps: 400 },
      { date: '2026-03-15', steps: 9000 },
    ];
    // Feb 13 through Mar 14 inclusive; the test day itself is excluded.
    expect(compute30DayRollingAvg(dailyData, '2026-03-15')).toBe(300);
  });
});
