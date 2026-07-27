import { describe, expect, it } from 'vitest';
import { hoursUntilReset, normalizeResetAt } from './quotaReset.js';

describe('quota reset normalization', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');

  it('keeps an ISO reset instant exact', () => {
    expect(normalizeResetAt({ resetsAt: '2026-07-27T12:00:00.000Z' }, { now }))
      .toEqual({ epochMs: Date.parse('2026-07-27T12:00:00.000Z'), source: 'iso' });
  });

  it('uses null as the explicit unknown sentinel', () => {
    expect(normalizeResetAt({ resetsAt: null }, { now })).toEqual({ epochMs: null, source: 'unknown' });
    expect(hoursUntilReset({ resetsAt: 'not a date' }, { now })).toBeNull();
  });

  it('parses a local provider reset when a timezone is supplied', () => {
    const result = normalizeResetAt({ resetsAt: 'July 27, 2026 08:00:00', timezone: 'America/Los_Angeles' }, { now });
    expect(result).toEqual({ epochMs: Date.parse('2026-07-27T15:00:00.000Z'), source: 'parsed' });
  });
});
