import { describe, it, expect } from 'vitest';
import { formatDurationMin, formatEventDateTime } from './formatters.js';

describe('formatDurationMin', () => {
  it('formats sub-hour, exact-hour, and hour+min durations', () => {
    expect(formatDurationMin(30)).toBe('30m');
    expect(formatDurationMin(60)).toBe('1h');
    expect(formatDurationMin(90)).toBe('1h 30m');
    expect(formatDurationMin(120)).toBe('2h');
  });

  it('returns empty string for null/undefined', () => {
    expect(formatDurationMin(null)).toBe('');
    expect(formatDurationMin(undefined)).toBe('');
  });

  it('does not prefix by default — existing callers stay unchanged', () => {
    expect(formatDurationMin(90)).toBe('1h 30m');
    expect(formatDurationMin(45)).toBe('45m');
  });

  it('prefixes with ~ when approximate (TaskItem estimate semantics)', () => {
    expect(formatDurationMin(30, { approximate: true })).toBe('~30m');
    expect(formatDurationMin(60, { approximate: true })).toBe('~1h');
    expect(formatDurationMin(210, { approximate: true })).toBe('~3h 30m');
  });

  it('tolerates a null options argument', () => {
    expect(formatDurationMin(90, null)).toBe('1h 30m');
  });
});

describe('formatEventDateTime', () => {
  // Local-time ISO (no trailing Z) so parsing is deterministic relative to
  // the test runtime's timezone.
  const sample = '2026-04-01T13:30:00';

  it('renders a timed event with short weekday + time', () => {
    expect(formatEventDateTime(sample)).toBe(
      new Date(sample).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    );
  });

  it('renders an all-day event as a full weekday + year date', () => {
    expect(formatEventDateTime(sample, { allDay: true })).toBe(
      new Date(sample).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    );
  });

  it('all-day and timed renderings differ', () => {
    expect(formatEventDateTime(sample, { allDay: true })).not.toBe(formatEventDateTime(sample));
  });

  it('tolerates a null options argument', () => {
    expect(formatEventDateTime(sample, null)).toBe(formatEventDateTime(sample));
  });

  it('passes malformed input straight through, like the original local formatter (no guard, by design)', () => {
    // The migration is deliberately behavior-identical: unparseable input
    // yields the raw toLocaleString result ("Invalid Date"), not an empty
    // string. Locks the no-guard decision so a future change does not re-add
    // a guard and silently alter the (unreachable) degenerate path.
    expect(formatEventDateTime('not-a-date')).toBe(
      new Date('not-a-date').toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    );
  });
});
