import { describe, it, expect } from 'vitest';
import { dayKeyInTimezone, todayKeyInTimezone, shiftDayKey, isValidTimezone } from './timezone.js';

describe('dayKeyInTimezone', () => {
  it('returns the local day for an instant whose UTC day is ahead of the local day', () => {
    // 2026-07-16T05:00Z = 2026-07-15 22:00 PDT — UTC day July 16, LA day July 15.
    const d = new Date('2026-07-16T05:00:00.000Z');
    expect(dayKeyInTimezone('America/Los_Angeles', d)).toBe('2026-07-15');
    expect(dayKeyInTimezone('UTC', d)).toBe('2026-07-16');
  });

  it('returns the local day for an instant whose local day is ahead of the UTC day', () => {
    // 2026-07-15T20:00Z = 2026-07-16 05:00 JST — UTC day July 15, Tokyo day July 16.
    const d = new Date('2026-07-15T20:00:00.000Z');
    expect(dayKeyInTimezone('Asia/Tokyo', d)).toBe('2026-07-16');
    expect(dayKeyInTimezone('UTC', d)).toBe('2026-07-15');
  });

  it('formats as zero-padded YYYY-MM-DD', () => {
    expect(dayKeyInTimezone('UTC', new Date('2026-01-05T12:00:00.000Z'))).toBe('2026-01-05');
  });

  it('falls back to the browser-local day for an invalid timezone (never throws)', () => {
    const d = new Date('2026-07-16T05:00:00.000Z');
    const browserLocal = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
    expect(dayKeyInTimezone('Not/A_Zone', d)).toBe(browserLocal);
    expect(dayKeyInTimezone('', d)).toBeTruthy();
  });
});

describe('todayKeyInTimezone', () => {
  it('returns today as a YYYY-MM-DD string in the given timezone', () => {
    expect(todayKeyInTimezone('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('shiftDayKey', () => {
  it('shifts by whole calendar days', () => {
    expect(shiftDayKey('2026-07-15', -7)).toBe('2026-07-08');
    expect(shiftDayKey('2026-07-15', 1)).toBe('2026-07-16');
    expect(shiftDayKey('2026-07-15', 0)).toBe('2026-07-15');
  });

  it('crosses month/year boundaries correctly', () => {
    expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is DST-safe: a 7-day shift across US spring-forward stays a whole day count', () => {
    // 2026 US DST begins 2026-03-08. Elapsed-hours math would drift here; calendar
    // day math does not — 7 days before the 15th is the 8th, exactly.
    expect(shiftDayKey('2026-03-15', -7)).toBe('2026-03-08');
  });
});

describe('isValidTimezone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });
  it('rejects invalid/empty values', () => {
    expect(isValidTimezone('Not/A_Zone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(undefined)).toBe(false);
  });
});
