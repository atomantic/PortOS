import { describe, it, expect } from 'vitest';
import { computeRollingAverages } from './meatspaceNicotine.js';
import { getDateString } from '../lib/fileUtils.js';

describe('computeRollingAverages (nicotine)', () => {
  // Local calendar date, matching the function's own "today" derivation.
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return getDateString(d);
  };

  it('averages the 7-day window over exactly 7 calendar days', () => {
    // 10 mg on each of the last 8 days: today-7 must be excluded, so 70 mg / 7 = 10.
    const entries = [];
    for (let i = 0; i < 8; i++) {
      entries.push({ date: daysAgo(i), nicotine: { totalMg: 10 } });
    }
    const result = computeRollingAverages(entries);
    expect(result.avg7day).toBe(10);
    expect(result.weeklyTotal).toBe(70);
  });

  it('averages the 30-day window over exactly 30 calendar days', () => {
    // 3 mg on each of the last 31 days: today-30 must be excluded, so 90 mg / 30 = 3.
    const entries = [];
    for (let i = 0; i < 31; i++) {
      entries.push({ date: daysAgo(i), nicotine: { totalMg: 3 } });
    }
    const result = computeRollingAverages(entries);
    expect(result.avg30day).toBe(3);
  });
});
