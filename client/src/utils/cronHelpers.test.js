import { describe, it, expect } from 'vitest';
import {
  parseSimpleCron, buildWeeklyCron, describeCron, WEEKDAYS,
  parseCronToRecurrence, buildCronFromRecurrence, describeRecurrence, summarizeAppSchedules,
} from './cronHelpers.js';

describe('parseSimpleCron', () => {
  it('parses a daily cron as every-day (no days)', () => {
    expect(parseSimpleCron('0 7 * * *')).toEqual({ days: [], time: '07:00' });
  });

  it('parses a single weekday with a non-zero minute', () => {
    expect(parseSimpleCron('30 9 * * 1')).toEqual({ days: [1], time: '09:30' });
  });

  it('parses a comma list of days, sorted and unique', () => {
    expect(parseSimpleCron('0 8 * * 5,1,1')).toEqual({ days: [1, 5], time: '08:00' });
  });

  it('expands a day range', () => {
    expect(parseSimpleCron('0 6 * * 1-5')).toEqual({ days: [1, 2, 3, 4, 5], time: '06:00' });
  });

  it('normalizes cron Sunday 7 to 0', () => {
    expect(parseSimpleCron('0 6 * * 7')).toEqual({ days: [0], time: '06:00' });
  });

  it('rejects interval/stepped crons the picker cannot represent', () => {
    expect(parseSimpleCron('*/15 * * * *')).toBeNull();
    expect(parseSimpleCron('0 */4 * * *')).toBeNull();
  });

  it('rejects day-of-month / month constraints', () => {
    expect(parseSimpleCron('0 0 1 * *')).toBeNull();
    expect(parseSimpleCron('0 0 * 6 *')).toBeNull();
  });

  it('rejects out-of-range and malformed values', () => {
    expect(parseSimpleCron('99 9 * * 1')).toBeNull();
    expect(parseSimpleCron('0 25 * * 1')).toBeNull();
    expect(parseSimpleCron('0 9 * * 8')).toBeNull();
    expect(parseSimpleCron('not a cron')).toBeNull();
    expect(parseSimpleCron('')).toBeNull();
  });
});

describe('buildWeeklyCron', () => {
  it('builds an every-day cron when no days are selected', () => {
    expect(buildWeeklyCron([], '07:00')).toBe('0 7 * * *');
  });

  it('builds a single-day cron', () => {
    expect(buildWeeklyCron([1], '09:30')).toBe('30 9 * * 1');
  });

  it('sorts multiple days', () => {
    expect(buildWeeklyCron([5, 1, 3], '08:00')).toBe('0 8 * * 1,3,5');
  });

  it('returns empty string for an unparseable time', () => {
    expect(buildWeeklyCron([1], '')).toBe('');
    expect(buildWeeklyCron([1], 'nope')).toBe('');
  });

  it('round-trips through parseSimpleCron', () => {
    const cron = buildWeeklyCron([2, 4], '14:15');
    expect(parseSimpleCron(cron)).toEqual({ days: [2, 4], time: '14:15' });
  });
});

describe('describeCron weekly cases', () => {
  it('describes a single weekday with a non-zero minute', () => {
    expect(describeCron('30 9 * * 1')).toBe('Mon at 09:30');
  });

  it('labels weekdays and weekends', () => {
    expect(describeCron('0 7 * * 1-5')).toBe('Weekdays at 07:00');
    expect(describeCron('0 6 * * 1,2,3,4,5')).toBe('Weekdays at 06:00');
    expect(describeCron('0 10 * * 0,6')).toBe('Weekends at 10:00');
    expect(describeCron('0 10 * * 6,0')).toBe('Weekends at 10:00');
  });
});

describe('WEEKDAYS', () => {
  it('is Sunday-first with cron-aligned values', () => {
    expect(WEEKDAYS.map(w => w.value)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(WEEKDAYS[0].label).toBe('Sun');
  });
});

describe('calendar recurrence helpers', () => {
  it('builds and describes an anchored every-two-weeks rule', () => {
    const rule = {
      frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2026-08-31',
    };
    expect(buildCronFromRecurrence(rule)).toBe('0 2 * * 1');
    expect(describeRecurrence(rule)).toBe('Every 2 weeks on Mon at 02:00');
  });

  it('parses a first-Thursday cron into the monthly weekday shape', () => {
    const rule = parseCronToRecurrence('0 19 1-7 * 4');
    expect(rule).toEqual({
      frequency: 'monthly-weekday', interval: 1, ordinal: 'first', weekday: 4, time: '19:00',
    });
    expect(buildCronFromRecurrence(rule)).toBe('0 19 1-7 * 4');
  });

  it('keeps last-weekday recurrence in the rich shape', () => {
    const rule = { frequency: 'monthly-weekday', interval: 1, ordinal: 'last', weekday: 4, time: '19:00' };
    expect(buildCronFromRecurrence(rule)).toBe('');
    expect(describeRecurrence(rule)).toBe('Last Thu of every month at 19:00');
  });

  it('keeps the interval in weekday-restricted daily descriptions', () => {
    expect(describeRecurrence({
      frequency: 'daily', interval: 2, weekdays: [1, 2, 3, 4, 5], time: '08:00'
    })).toBe('Every 2 days on Mon, Tue, Wed, Thu, Fri at 08:00');
  });
});
// @vitest-environment node

describe('summarizeAppSchedules', () => {
  it('returns null when a task has no per-app cadences of its own', () => {
    expect(summarizeAppSchedules(undefined)).toBeNull();
    expect(summarizeAppSchedules([])).toBeNull();
    expect(summarizeAppSchedules([{ appId: 'acme' }])).toBeNull();
  });

  it('names the shared cadence when every app runs the same expression', () => {
    expect(summarizeAppSchedules([
      { appId: 'acme', appName: 'Acme', cronExpression: '0 7 * * *', nextRunAt: '2026-01-02T07:00:00Z' },
      { appId: 'beta', appName: 'Beta', cronExpression: '0 7 * * *', nextRunAt: '2026-01-01T07:00:00Z' },
    ])).toMatchObject({
      count: 2,
      label: '2 apps · at 07:00',
      // Soonest across the apps, not the first one listed.
      nextRunAt: '2026-01-01T07:00:00Z',
    });
  });

  it('counts the schedules rather than inventing one cadence when they differ', () => {
    const summary = summarizeAppSchedules([
      { appId: 'acme', appName: 'Acme', cronExpression: '0 7 * * *' },
      { appId: 'beta', appName: 'Beta', cronExpression: '30 18 * * 1' },
    ]);
    expect(summary.label).toBe('2 apps · 2 schedules');
    expect(summary.detail.split('\n')).toEqual([
      'Acme — at 07:00 (0 7 * * *)',
      'Beta — Mon at 18:30 (30 18 * * 1)',
    ]);
    expect(summary.nextRunAt).toBeNull();
  });

  it('falls back to the app id when the server sent no name', () => {
    expect(summarizeAppSchedules([{ appId: 'acme', cronExpression: '0 7 * * *' }]).detail)
      .toBe('acme — at 07:00 (0 7 * * *)');
  });
});
