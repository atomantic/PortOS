import { describe, it, expect } from 'vitest';
import {
  isValidCronExpression,
  findCronExpressionError,
  isValidCronField,
  isCronShaped,
  CRON_FIELD_BOUNDS,
} from './cronValidation.js';
import { parseCronToNextRun } from '../services/eventScheduler.js';

// Syntax/range only. Route-boundary behavior (which HTTP status, which store
// write) lives with the routes; these cases pin the vocabulary itself.
describe('cronValidation', () => {
  it('accepts wildcards, ranges, lists, and steps in every field', () => {
    for (const expr of [
      '* * * * *',
      '0 7 * * *',
      '*/15 * * * *',
      '0 9-17 * * 1-5',
      '0 9,12,15,18 * * *',
      '5-55/10 */2 1-28/7 1,6,12 1-5',
      '59 23 31 12 6',
    ]) {
      expect(findCronExpressionError(expr), expr).toBeNull();
    }
  });

  it('accepts both 0 and 7 as Sunday', () => {
    expect(isValidCronExpression('0 0 * * 0')).toBe(true);
    expect(isValidCronExpression('0 0 * * 7')).toBe(true);
    expect(isValidCronExpression('0 0 * * 0-7')).toBe(true);
    expect(isValidCronExpression('0 0 * * 8')).toBe(false);
  });

  it('rejects out-of-range values per field and names the offending field', () => {
    // One out-of-range case per field, using that field's own upper bound + 1.
    const overflow = [
      ['60 0 * * *', 'minute'],
      ['0 24 * * *', 'hour'],
      ['0 0 32 * *', 'dayOfMonth'],
      ['0 0 * 13 *', 'month'],
      ['0 0 * * 8', 'dayOfWeek'],
    ];
    for (const [expr, field] of overflow) {
      expect(findCronExpressionError(expr), expr).toContain(field);
    }
    // Below-minimum values, where the floor is 1 rather than 0.
    expect(isValidCronExpression('0 0 0 * *')).toBe(false);
    expect(isValidCronExpression('0 0 * 0 *')).toBe(false);
  });

  it('rejects the reported real-world regressions from #6634', () => {
    // Both were accepted by the old five-token save check and then silently
    // dropped by the scheduler, leaving an "enabled" schedule that never fired.
    expect(isValidCronExpression('99 9 * * *')).toBe(false);
    expect(isValidCronExpression('0 25 * * *')).toBe(false);
    expect(parseCronToNextRun('99 9 * * *', new Date('2026-01-01T00:00:00Z'), 'UTC')).toBeNull();
    expect(parseCronToNextRun('0 25 * * *', new Date('2026-01-01T00:00:00Z'), 'UTC')).toBeNull();
  });

  it('rejects malformed syntax that is still five tokens', () => {
    for (const expr of [
      'a * * * *',        // non-numeric
      '*/0 * * * *',      // zero step
      '*/x * * * *',      // non-numeric step
      '1/2/3 * * * *',    // two step separators
      '5-1 * * * *',      // inverted range
      '1-2-3 * * * *',    // two range separators
      '-5 * * * *',       // missing range start
      '1, * * * *',       // empty list entry
      '1.5 * * * *',      // non-integer
    ]) {
      expect(isValidCronExpression(expr), expr).toBe(false);
    }
  });

  it('rejects anything that is not a five-field string', () => {
    for (const value of ['* * * *', '* * * * * *', '', '   ', 'on-demand', null, undefined, 5, ['0 7 * * *']]) {
      expect(isValidCronExpression(value), String(value)).toBe(false);
    }
  });

  it('treats an expression with no occurrence in the search window as VALID syntax', () => {
    // A leap-day cron is syntactically valid, but the scheduler's bounded
    // two-year search finds nothing from 2024-03-01 (the next leap day is 2028). A
    // save boundary must not use that null as its invalidity signal — that
    // conflation is exactly what #6634 forbids.
    expect(isValidCronExpression('0 0 29 2 *')).toBe(true);
    expect(parseCronToNextRun('0 0 29 2 *', new Date('2024-03-01T00:00:00Z'), 'UTC')).toBeNull();
    // ...and the same expression DOES resolve when a leap day is in window.
    expect(parseCronToNextRun('0 0 29 2 *', new Date('2027-06-01T00:00:00Z'), 'UTC')).toBeInstanceOf(Date);
  });

  it('isCronShaped detects the five-token shape without judging validity', () => {
    expect(isCronShaped('99 9 * * *')).toBe(true);
    expect(isValidCronExpression('99 9 * * *')).toBe(false);
    expect(isCronShaped('on-demand')).toBe(false);
    expect(isCronShaped(null)).toBe(false);
  });

  it('isValidCronField enforces the bounds it is given', () => {
    const [minuteMin, minuteMax] = CRON_FIELD_BOUNDS[0];
    expect(isValidCronField('0-59', minuteMin, minuteMax)).toBe(true);
    expect(isValidCronField('0-60', minuteMin, minuteMax)).toBe(false);
    expect(isValidCronField('', minuteMin, minuteMax)).toBe(false);
  });
});
