import { describe, it, expect } from 'vitest';
import { toUserDayKey, unionActiveDayKeys } from './activeDays.js';

// A fixed, obviously-fake timezone well behind UTC, so a late-UTC instant lands on the PREVIOUS
// local day and the re-keying is observable rather than a no-op.
const TZ = 'America/Los_Angeles';

describe('toUserDayKey', () => {
  it('takes a bare day label as authored', () => {
    // The health logs store only a day key — no instant survives to re-derive it from, so the
    // label is the best available answer and must not be shifted by the timezone.
    expect(toUserDayKey('2026-03-14', TZ)).toBe('2026-03-14');
    expect(toUserDayKey('2026-03-14', 'Pacific/Kiritimati')).toBe('2026-03-14');
  });

  it('re-keys a full ISO instant into the USER local day, not the UTC day', () => {
    // The load-bearing case: `split('T')[0]` on this value yields 2026-03-15 (the UTC day),
    // which files a 7pm-local practice on tomorrow.
    expect(toUserDayKey('2026-03-15T02:30:00.000Z', TZ)).toBe('2026-03-14');
    expect('2026-03-15T02:30:00.000Z'.split('T')[0]).toBe('2026-03-15');
  });

  it('keeps an instant that does not cross the boundary on its own day', () => {
    expect(toUserDayKey('2026-03-14T18:00:00.000Z', TZ)).toBe('2026-03-14');
  });

  it('re-keys forward for a timezone AHEAD of UTC', () => {
    // Same instant, a user in Tokyo: the local day is already the 15th.
    expect(toUserDayKey('2026-03-14T18:00:00.000Z', 'Asia/Tokyo')).toBe('2026-03-15');
  });

  it('returns null for values that are not days at all', () => {
    // Dropped, never coerced — a junk value that counted would invent a day the user never had.
    for (const junk of [null, undefined, '', 'someday', '2026-3-4', 42, {}, [], new Date()]) {
      expect(toUserDayKey(junk, TZ)).toBeNull();
    }
  });

  it('returns null for an unparseable timestamp rather than its literal prefix', () => {
    expect(toUserDayKey('not-a-date T nope', TZ)).toBeNull();
    expect(toUserDayKey('2026-13-45T99:99:99Z', TZ)).toBeNull();
  });
});

describe('unionActiveDayKeys', () => {
  it('counts a day logged in two domains exactly ONCE', () => {
    // The whole reason this is a union and not a sum of per-domain counts.
    const days = unionActiveDayKeys([
      ['2026-03-14', '2026-03-15'], // health logs
      ['2026-03-14'],               // POST sessions
      ['2026-03-14'],               // POST training
    ], TZ);

    expect(days).toEqual(['2026-03-14', '2026-03-15']);
    expect(days).toHaveLength(2); // NOT 4
  });

  it('de-dupes across the day-boundary normalization too', () => {
    // A health entry stamped 2026-03-14 and a legacy training entry whose UTC-day prefix reads
    // 2026-03-15 are the SAME local day. A `split('T')[0]` union would report two.
    const days = unionActiveDayKeys([
      ['2026-03-14'],
      ['2026-03-15T02:30:00.000Z'],
    ], TZ);

    expect(days).toEqual(['2026-03-14']);
  });

  it('returns an empty array on a brand-new install', () => {
    expect(unionActiveDayKeys([[], [], []], TZ)).toEqual([]);
    expect(unionActiveDayKeys([], TZ)).toEqual([]);
  });

  it('tolerates absent sources and absent values without inventing days', () => {
    expect(unionActiveDayKeys([null, undefined, ['2026-03-14', null, undefined, '']], TZ))
      .toEqual(['2026-03-14']);
    expect(unionActiveDayKeys(null, TZ)).toEqual([]);
  });

  it('returns the keys sorted ascending', () => {
    expect(unionActiveDayKeys([['2026-03-15', '2026-01-02'], ['2026-02-09']], TZ))
      .toEqual(['2026-01-02', '2026-02-09', '2026-03-15']);
  });

  it('unions the same records to a different total for a user in a different timezone', () => {
    // Pins that the day boundary is genuinely applied rather than decorative: two instants
    // four hours apart are one local day in Los Angeles and two in Tokyo.
    const sources = [['2026-03-14T14:00:00.000Z', '2026-03-14T18:00:00.000Z']];
    expect(unionActiveDayKeys(sources, TZ)).toHaveLength(1);
    expect(unionActiveDayKeys(sources, 'Asia/Tokyo')).toHaveLength(2);
  });
});
