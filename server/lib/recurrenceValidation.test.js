import { describe, expect, it } from 'vitest';
import { recurrenceRuleSchema } from './recurrenceValidation.js';

describe('recurrenceRuleSchema', () => {
  it('accepts an anchored every-two-weeks rule', () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2026-08-31',
    }).success).toBe(true);
  });

  it('accepts an nth weekday rule', () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: 'monthly-weekday', ordinal: 'first', weekday: 4, time: '19:00',
    }).success).toBe(true);
  });

  it('rejects a weekly rule without a selected weekday', () => {
    expect(recurrenceRuleSchema.safeParse({ frequency: 'weekly', time: '02:00' }).success).toBe(false);
  });

  it('requires an anchor for multi-period calendar recurrences', () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: 'monthly-date', interval: 2, dayOfMonth: 1, time: '02:00',
    }).success).toBe(false);
  });

  it('requires a raw expression for custom recurrence', () => {
    expect(recurrenceRuleSchema.safeParse({ frequency: 'custom' }).success).toBe(false);
  });

  it('keeps interval limits aligned with the scheduler search horizon', () => {
    expect(recurrenceRuleSchema.safeParse({ frequency: 'weekly', interval: 53, weekdays: [1], time: '02:00' }).success).toBe(false);
    expect(recurrenceRuleSchema.safeParse({ frequency: 'monthly-date', interval: 13, dayOfMonth: 1, time: '02:00' }).success).toBe(false);
  });

  it('rejects an impossible anchor date instead of silently rebasing it', () => {
    expect(recurrenceRuleSchema.safeParse({
      frequency: 'weekly', interval: 2, weekdays: [1], time: '02:00', anchorDate: '2026-02-31',
    }).success).toBe(false);
  });
});
