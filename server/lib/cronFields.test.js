import { describe, it, expect } from 'vitest';
import { cronWeekdayHours, expandCronField, matchesCronField } from './cronFields.js';

describe('matchesCronField', () => {
  it('reads the forms the scheduler actually stores', () => {
    expect(matchesCronField(7, '*')).toBe(true);
    expect(matchesCronField(7, '7')).toBe(true);
    expect(matchesCronField(7, '1-5')).toBe(false);
    expect(matchesCronField(3, '1-5')).toBe(true);
    expect(matchesCronField(8, '0,8,16')).toBe(true);
    expect(matchesCronField(9, '0,8,16')).toBe(false);
  });

  it('reads a step relative to the field minimum, not to zero', () => {
    // `*/15` on the minute field starts at 0; on a 1-based field it starts at 1,
    // which is why the walker passes `fieldMin` rather than assuming 0.
    expect(matchesCronField(15, '*/15', 0)).toBe(true);
    expect(matchesCronField(16, '*/15', 0)).toBe(false);
    expect(matchesCronField(3, '*/2', 1)).toBe(true);
    expect(matchesCronField(2, '*/2', 1)).toBe(false);
    // A bounded step stops at the end of its range.
    expect(matchesCronField(5, '1-5/2')).toBe(true);
    expect(matchesCronField(7, '1-5/2')).toBe(false);
  });
});

describe('expandCronField', () => {
  it('enumerates the values a field fires on', () => {
    expect(expandCronField('*/6', 0, 23)).toEqual([0, 6, 12, 18]);
    expect(expandCronField('1-3', 0, 23)).toEqual([1, 2, 3]);
    expect(expandCronField('30', 0, 59)).toEqual([30]);
  });
});

describe('cronWeekdayHours', () => {
  it('reports the weekday/hour cells a weekly expression occupies', () => {
    expect(cronWeekdayHours('0 9,21 * * 1')).toEqual({ days: [1], hours: [9, 21] });
  });

  it('normalizes cron Sunday 7 onto the JS 0 a planner indexes by', () => {
    expect(cronWeekdayHours('0 9 * * 7').days).toEqual([0]);
    // Both spellings in one field collapse to a single Sunday.
    expect(cronWeekdayHours('0 9 * * 0,7').days).toEqual([0]);
  });

  it('treats a date-restricted expression as occupying the whole week', () => {
    // The 1st of the month is a different weekday every month, so a planner
    // that believed the `*` weekday field would schedule straight into it.
    expect(cronWeekdayHours('0 4 1 * *').days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(cronWeekdayHours('0 4 * 3 1').days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('rejects anything that is not a 5-field expression', () => {
    expect(cronWeekdayHours('on-demand')).toBeNull();
    expect(cronWeekdayHours('0 9 * *')).toBeNull();
    expect(cronWeekdayHours(null)).toBeNull();
  });
});
