import { describe, expect, it } from 'vitest';
import { hoursUntilReset, normalizeResetAt, parseHumanReset } from './quotaReset.js';

// The adapter-facing half: every provider adapter runs its CLI's reset string
// through this, so `resetsAt` is ISO 8601 on the wire and the Usage page can
// localize it instead of printing the CLI's own wording.
describe('parseHumanReset', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');

  it('reads the claude panel shape — an " at " separator and a glued meridiem', () => {
    expect(parseHumanReset('Jul 27 at 1:59pm', { now, timezone: 'America/Los_Angeles' }))
      .toBe('2026-07-27T20:59:00.000Z');
  });

  it('reads a bare hour, which states no minutes at all', () => {
    expect(parseHumanReset('Jul 27 at 2pm', { now, timezone: 'UTC' })).toBe('2026-07-27T14:00:00.000Z');
  });

  it('reads midnight and noon, the two a 12-hour clock gets wrong most often', () => {
    expect(parseHumanReset('Jul 27 at 12am', { now, timezone: 'UTC' })).toBe('2026-07-27T00:00:00.000Z');
    expect(parseHumanReset('Jul 27 at 12pm', { now, timezone: 'UTC' })).toBe('2026-07-27T12:00:00.000Z');
  });

  it('stamps a year-less date (the grok panel shape) with the year `now` falls in', () => {
    expect(parseHumanReset('August 10, 06:07', { now, timezone: 'UTC' })).toBe('2026-08-10T06:07:00.000Z');
  });

  it('passes an already-ISO instant through, so re-normalizing is a no-op', () => {
    expect(parseHumanReset('2026-07-27T12:00:00.000Z', { now })).toBe('2026-07-27T12:00:00.000Z');
  });

  // A zero-offset zone renders its longOffset as a bare "GMT", not "GMT+00:00",
  // so an offset parser that only accepts the signed form resolves every reset
  // in such a zone to null — and the Usage page silently loses its reset time
  // for anyone in the UK in winter, Iceland, or plain UTC.
  it('resolves a zone whose offset is exactly zero', () => {
    expect(parseHumanReset('Jan 27 at 2pm', { now: Date.parse('2026-01-26T12:00:00.000Z'), timezone: 'Europe/London' }))
      .toBe('2026-01-27T14:00:00.000Z');
    expect(parseHumanReset('Jul 27 at 2pm', { now, timezone: 'Atlantic/Reykjavik' }))
      .toBe('2026-07-27T14:00:00.000Z');
  });

  it('returns null for a missing or unreadable reset rather than guessing one', () => {
    expect(parseHumanReset(null, { now })).toBeNull();
    expect(parseHumanReset('', { now })).toBeNull();
    expect(parseHumanReset('  ', { now })).toBeNull();
    expect(parseHumanReset('not a date', { now })).toBeNull();
  });
});

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

  // In-tree adapters now hand this an ISO instant, so the cases below are the
  // BACKWARD-COMPAT path: a limit off an older federated peer still carries the
  // raw CLI string. Both shapes defeat a bare `Date.parse` — claude's " at " +
  // glued meridiem returns NaN (every window would read as "no reset time", so
  // the family never burns), and a year-less string resolves to 2001.
  it('parses the claude panel shape — " at " separator and a glued meridiem', () => {
    expect(normalizeResetAt({ resetsAt: 'Jul 27 at 1:59pm', timezone: 'America/Los_Angeles' }, { now }))
      .toEqual({ epochMs: Date.parse('2026-07-27T20:59:00.000Z'), source: 'parsed' });
    expect(normalizeResetAt({ resetsAt: 'Jul 27 at 11:19am', timezone: 'America/Los_Angeles' }, { now }))
      .toEqual({ epochMs: Date.parse('2026-07-27T18:19:00.000Z'), source: 'parsed' });
  });

  it('parses a claude reset on the hour, which states no minutes at all', () => {
    // `Jul 7 at 2pm` — the shape claudeCodeUsage's own parser fixture emits.
    expect(normalizeResetAt({ resetsAt: 'Jul 27 at 2pm', timezone: 'UTC' }, { now }).epochMs)
      .toBe(Date.parse('2026-07-27T14:00:00.000Z'));
    // Midnight and noon are the two the 12-hour clock gets wrong most often.
    expect(normalizeResetAt({ resetsAt: 'Jul 27 at 12am', timezone: 'UTC' }, { now }).epochMs)
      .toBe(Date.parse('2026-07-27T00:00:00.000Z'));
    expect(normalizeResetAt({ resetsAt: 'Jul 27 at 12pm', timezone: 'UTC' }, { now }).epochMs)
      .toBe(Date.parse('2026-07-27T12:00:00.000Z'));
  });

  it('stamps a year-less reset with the CURRENT year, not Date.parse\'s 2001 default', () => {
    // Grok: `August 10, 06:07`, no year, no zone stated.
    const { epochMs, source } = normalizeResetAt({ resetsAt: 'August 10, 06:07', timezone: 'UTC' }, { now });
    expect(source).toBe('parsed');
    expect(epochMs).toBe(Date.parse('2026-08-10T06:07:00.000Z'));
    expect(hoursUntilReset({ resetsAt: 'August 10, 06:07', timezone: 'UTC' }, { now })).toBeCloseTo(354.1, 0);
  });

  it('rolls a year-less reset that already passed to next year', () => {
    // Read on Dec 31, a "Jan 2" reset belongs to the coming year.
    const newYearsEve = Date.parse('2026-12-31T18:00:00.000Z');
    expect(normalizeResetAt({ resetsAt: 'Jan 2 at 9:00am', timezone: 'UTC' }, { now: newYearsEve }).epochMs)
      .toBe(Date.parse('2027-01-02T09:00:00.000Z'));
  });

  it('keeps a reset that just passed in the past rather than pushing it a year out', () => {
    const justPassed = normalizeResetAt({ resetsAt: 'Jul 26 at 11:30am', timezone: 'UTC' }, { now });
    expect(justPassed.epochMs).toBe(Date.parse('2026-07-26T11:30:00.000Z'));
    expect(hoursUntilReset({ resetsAt: 'Jul 26 at 11:30am', timezone: 'UTC' }, { now })).toBeCloseTo(-0.5, 5);
  });
});
