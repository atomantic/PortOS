import { describe, it, expect } from 'vitest';
import { computePostStreaks, computeUnifiedStreak, recordDayKey, withDerivedDayKeys, ymdShift } from './postStreak.js';

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

  it('keys legacy instants to the user-local day while preserving bare day labels', () => {
    // The pair crosses UTC midnight: it is still July 17 in Los Angeles, but July 17 and 18
    // in Tokyo. The same local boundary must drive both the streak and active-days tile.
    const legacy = [
      rec('2026-07-17T09:00:00.000Z'),
      rec('2026-07-18T02:00:00.000Z'),
    ];

    const behindUtc = computePostStreaks(legacy, '2026-07-18', 'America/Los_Angeles');
    expect(behindUtc).toMatchObject({ currentStreak: 1, longestStreak: 1, lastDate: '2026-07-17' });

    const aheadOfUtc = computePostStreaks(legacy, '2026-07-18', 'Asia/Tokyo');
    expect(aheadOfUtc).toMatchObject({ currentStreak: 2, longestStreak: 2, lastDate: '2026-07-18' });

    const bareLabels = computePostStreaks(
      [rec('2026-07-17'), rec('2026-07-18')],
      '2026-07-18',
      'America/Los_Angeles'
    );
    expect(bareLabels).toMatchObject({ currentStreak: 2, longestStreak: 2, lastDate: '2026-07-18' });
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

  it('re-derives day keys from record instants, not the stale stored `date` (#4168)', () => {
    // Written while the user lived in Los Angeles: 2026-07-17 22:00 PDT is
    // already 2026-07-18 in UTC. After the user moves the setting to UTC, the
    // frozen stored key would report a gap; the instant says otherwise.
    const sessions = [
      { date: '2026-07-16', startedAt: '2026-07-17T05:00:00.000Z', score: 80 },
      { date: '2026-07-17', startedAt: '2026-07-18T05:00:00.000Z', score: 90 },
    ];
    const training = [{ date: '2026-07-15', timestamp: '2026-07-16T05:00:00.000Z' }];

    const inUtc = computeUnifiedStreak(sessions, training, '2026-07-18', 'UTC');
    expect(inUtc).toEqual({ current: 3, longest: 3, lastActiveDate: '2026-07-18' });

    // Back in the original zone the same instants still key to the stored days.
    const inLa = computeUnifiedStreak(sessions, training, '2026-07-17', 'America/Los_Angeles');
    expect(inLa).toEqual({ current: 3, longest: 3, lastActiveDate: '2026-07-17' });
  });

  it('scores today off the re-derived day, not the stored one (#4168)', () => {
    const sessions = [{ date: '2026-07-17', startedAt: '2026-07-18T05:00:00.000Z', score: 91 }];
    expect(computePostStreaks(sessions, '2026-07-18', 'UTC')).toMatchObject({
      completedToday: true,
      todayScore: 91,
    });
  });
});

describe('recordDayKey / withDerivedDayKeys (#4168)', () => {
  it('prefers startedAt, then completedAt, then timestamp', () => {
    expect(recordDayKey({ date: '2000-01-01', startedAt: '2026-07-18T05:00:00.000Z', completedAt: '2026-07-19T05:00:00.000Z', timestamp: '2026-07-20T05:00:00.000Z' }, 'UTC')).toBe('2026-07-18');
    expect(recordDayKey({ date: '2000-01-01', completedAt: '2026-07-19T05:00:00.000Z', timestamp: '2026-07-20T05:00:00.000Z' }, 'UTC')).toBe('2026-07-19');
    expect(recordDayKey({ date: '2000-01-01', timestamp: '2026-07-20T05:00:00.000Z' }, 'UTC')).toBe('2026-07-20');
  });

  it('falls back to the stored date when no instant survives', () => {
    // Legacy records predate the timestamps — there is nothing to re-derive from,
    // so the authored day key stands rather than becoming null.
    expect(recordDayKey({ date: '2026-07-17' }, 'America/Los_Angeles')).toBe('2026-07-17');
    expect(recordDayKey({ date: '2026-07-17T22:00:00.000Z' }, 'Asia/Tokyo')).toBe('2026-07-18');
    expect(recordDayKey({ date: '2026-07-17', startedAt: 'not-a-date' }, 'UTC')).toBe('2026-07-17');
  });

  it('accepts an epoch-ms instant and rejects a non-record', () => {
    expect(recordDayKey({ timestamp: Date.UTC(2026, 6, 18, 5) }, 'UTC')).toBe('2026-07-18');
    expect(recordDayKey(null, 'UTC')).toBeNull();
    expect(recordDayKey({}, 'UTC')).toBeNull();
  });

  it('leaves the stored date alone without a timezone', () => {
    // No zone resolved ⇒ nothing to re-derive INTO. Absent must not collapse into
    // "UTC" and silently re-key a whole history.
    expect(recordDayKey({ date: '2026-07-17', startedAt: '2026-07-18T05:00:00.000Z' })).toBe('2026-07-17');
  });

  it('re-stamps a batch without mutating the inputs', () => {
    const records = [{ id: 'a', date: '2026-07-17', startedAt: '2026-07-18T05:00:00.000Z', score: 70 }];
    const derived = withDerivedDayKeys(records, 'UTC');
    expect(derived[0]).toEqual({ id: 'a', date: '2026-07-18', startedAt: '2026-07-18T05:00:00.000Z', score: 70 });
    expect(records[0].date).toBe('2026-07-17');
    expect(withDerivedDayKeys(null, 'UTC')).toEqual([]);
  });
});
