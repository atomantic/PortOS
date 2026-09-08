/**
 * Cadence rules for Tribe care (#2032/#2060).
 *
 * These pin the SEMANTICS, not a copy: `client/src/lib/tribeCadence.js`
 * re-exports this module, so the Tribe page, the circle map, the proactive-alerts
 * check and the Care dashboard widget all run exactly this code.
 */
import { describe, it, expect } from 'vitest';
import { cadenceStatus, daysSinceDate, DEFAULT_CADENCE_DAYS, SOON_WINDOW_DAYS } from './tribeCadence.js';

// N days before today as a YYYY-MM-DD string, so the suite is date-independent.
// Built from LOCAL calendar fields — `daysSinceDate` parses the `YYYY-MM-DD` in
// local time, so `toISOString()` (UTC) would shift the date across the day
// boundary in the evening and make the elapsed-day math off-by-one.
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('tribeCadence — tuning constants', () => {
  it('exposes the defaults every surface reads', () => {
    expect(DEFAULT_CADENCE_DAYS).toBeGreaterThan(0);
    expect(SOON_WINDOW_DAYS).toBe(7);
  });
});

describe('tribeCadence — daysSinceDate', () => {
  it('returns null for anything that is not a parsable date', () => {
    for (const value of [null, undefined, '', 'garbage']) {
      expect(daysSinceDate(value)).toBeNull();
    }
  });

  it('counts elapsed local days', () => {
    expect(daysSinceDate(daysAgo(0))).toBe(0);
    expect(daysSinceDate(daysAgo(3))).toBe(3);
  });
});

describe('tribeCadence — cadence rules', () => {
  it('external members are excluded from care (never nagged)', () => {
    expect(cadenceStatus({ ring: 'external', lastContact: daysAgo(999), cadenceDays: 7 }))
      .toEqual({ state: 'external', daysRemaining: null, daysOverdue: 0 });
  });

  it('distinguishes missing (never contacted) from overdue', () => {
    const missing = cadenceStatus({ ring: 'core', lastContact: null, cadenceDays: 21 });
    expect(missing.state).toBe('missing');
    expect(missing.daysRemaining).toBeNull();
    expect(missing.daysOverdue).toBeNull(); // missing sorts above dated-overdue

    const overdue = cadenceStatus({ ring: 'support', lastContact: daysAgo(10), cadenceDays: 7 });
    expect(overdue.state).toBe('overdue');
    expect(overdue.daysOverdue).toBe(3);
  });

  it('treats <=7 days remaining as soon, >7 as steady', () => {
    expect(cadenceStatus({ ring: 'core', lastContact: daysAgo(14), cadenceDays: 21 }).state).toBe('soon');
    expect(cadenceStatus({ ring: 'core', lastContact: daysAgo(13), cadenceDays: 21 }).state).toBe('steady');
  });
});
