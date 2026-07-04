import { describe, it, expect } from 'vitest';
import { computePostStreaks, computeUnifiedStreak, ymdShift } from './postStreak.js';

const rec = (date, score) => (score == null ? { date } : { date, score });

describe('computePostStreaks (shared helper)', () => {
  it('normalizes full-ISO record dates to the day prefix', () => {
    // Memory-practice entries store a full ISO timestamp, not YYYY-MM-DD.
    const r = computePostStreaks(
      [rec('2026-06-27T13:04:00.000Z'), rec('2026-06-28T09:00:00.000Z')],
      '2026-06-28'
    );
    expect(r.currentStreak).toBe(2);
    expect(r.lastDate).toBe('2026-06-28');
  });

  it('honors the grace window (today not done, yesterday done)', () => {
    const r = computePostStreaks([rec('2026-06-26'), rec('2026-06-27')], '2026-06-28');
    expect(r.completedToday).toBe(false);
    expect(r.currentStreak).toBe(2);
  });

  it('a gap breaks the current streak but longest survives', () => {
    const r = computePostStreaks(
      [rec('2026-06-20'), rec('2026-06-21'), rec('2026-06-22'), rec('2026-06-28')],
      '2026-06-28'
    );
    expect(r.currentStreak).toBe(1);
    expect(r.longestStreak).toBe(3);
  });
});

describe('computeUnifiedStreak (sessions OR training-log activity)', () => {
  it('session-only days count', () => {
    const r = computeUnifiedStreak(
      [rec('2026-06-27', 80), rec('2026-06-28', 90)],
      [],
      '2026-06-28'
    );
    expect(r).toEqual({ current: 2, longest: 2, lastActiveDate: '2026-06-28' });
  });

  it('practice-only days count (no scored session)', () => {
    // A Morse/memory practice day with NO scored session still extends the streak.
    const r = computeUnifiedStreak(
      [],
      [{ date: '2026-06-27' }, { date: '2026-06-28' }],
      '2026-06-28'
    );
    expect(r.current).toBe(2);
    expect(r.longest).toBe(2);
  });

  it('mixes sessions and practice on the same and different days', () => {
    // 26th: practice only, 27th: session only, 28th: both → 3 consecutive days.
    const r = computeUnifiedStreak(
      [rec('2026-06-27', 70), rec('2026-06-28', 88)],
      [{ date: '2026-06-26' }, { date: '2026-06-28T10:00:00.000Z' }],
      '2026-06-28'
    );
    expect(r.current).toBe(3);
    expect(r.lastActiveDate).toBe('2026-06-28');
  });

  it('is DST-safe across a spring-forward boundary', () => {
    // US DST 2026 begins 2026-03-08; day arithmetic must not drop/duplicate a day.
    const days = ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09'];
    const r = computeUnifiedStreak(days.map(d => rec(d, 50)), [], '2026-03-09');
    expect(r.current).toBe(4);
    expect(r.longest).toBe(4);
    // ymdShift steps exactly one calendar day even across the transition.
    expect(ymdShift('2026-03-08', -1)).toBe('2026-03-07');
    expect(ymdShift('2026-03-08', 1)).toBe('2026-03-09');
  });

  it('empty activity yields a zero streak', () => {
    expect(computeUnifiedStreak([], [], '2026-06-28')).toEqual({
      current: 0, longest: 0, lastActiveDate: null,
    });
  });
});
