import { describe, it, expect } from 'vitest';
import { selectDueDates } from './activityDigestScheduler.js';

const TODAY = '2026-07-08';
const parts = (hour, minute = 0) => ({ hour, minute });

describe('selectDueDates (scheduler time gating)', () => {
  const settings = (over = {}) => ({ runTime: '21:00', catchUpDays: 3, lastRunDate: '2026-07-07', ...over });

  it('does not draft today before the configured runTime', () => {
    // Last run yesterday → only today is due, but it is 15:00 (< 21:00).
    expect(selectDueDates(settings(), TODAY, parts(15))).toEqual([]);
  });

  it('drafts today once the runTime has passed', () => {
    expect(selectDueDates(settings(), TODAY, parts(21, 0))).toEqual([TODAY]);
    expect(selectDueDates(settings(), TODAY, parts(22, 30))).toEqual([TODAY]);
  });

  it('drafts past missed days immediately regardless of time-of-day', () => {
    // Server was off for days; it is only 09:00, but the completed past days run now.
    const dates = selectDueDates(settings({ lastRunDate: '2026-07-04' }), TODAY, parts(9));
    expect(dates).toEqual(['2026-07-05', '2026-07-06', '2026-07-07']); // today excluded (before 21:00)
  });

  it('includes today alongside past days once runTime passes', () => {
    const dates = selectDueDates(settings({ lastRunDate: '2026-07-04' }), TODAY, parts(21, 30));
    expect(dates).toEqual(['2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08']);
  });

  it('returns nothing when already drafted today', () => {
    expect(selectDueDates(settings({ lastRunDate: TODAY }), TODAY, parts(23))).toEqual([]);
  });
});
