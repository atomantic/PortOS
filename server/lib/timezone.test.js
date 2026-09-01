import { describe, it, expect, vi } from 'vitest'

// getUserTimezone/getTimezoneUpdatedAt read from settings.js; the pure helpers
// below don't touch settings, so mocking it only affects the getter tests.
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn()
}))

import { getSettings } from '../services/settings.js'
import { getLocalParts, getUtcOffsetMs, nextLocalTime, todayInTimezone, anchorLocalMidnightUtc, localDayWindowUtc, localDayRangeUtc, HHMM_RE, HHMM_STRICT_RE, parseHHMM, isWithinTimeWindow } from './timezone.js'
import { getTimezoneUpdatedAt } from '../services/userTimezone.js'

describe('timezone', () => {
  describe('getLocalParts', () => {
    it('returns UTC parts when timezone is UTC', () => {
      const date = new Date('2026-03-24T14:30:00Z')
      const parts = getLocalParts(date, 'UTC')
      expect(parts.year).toBe(2026)
      expect(parts.month).toBe(3)
      expect(parts.day).toBe(24)
      expect(parts.hour).toBe(14)
      expect(parts.minute).toBe(30)
      expect(parts.dayOfWeek).toBe(2) // Tuesday
    })

    it('converts UTC to Pacific time', () => {
      // March 24, 2026 14:00 UTC = March 24, 2026 07:00 PDT (UTC-7)
      const date = new Date('2026-03-24T14:00:00Z')
      const parts = getLocalParts(date, 'America/Los_Angeles')
      expect(parts.hour).toBe(7)
      expect(parts.day).toBe(24)
    })

    it('handles date boundary crossing', () => {
      // March 24, 2026 03:00 UTC = March 23, 2026 20:00 PDT (UTC-7)
      const date = new Date('2026-03-24T03:00:00Z')
      const parts = getLocalParts(date, 'America/Los_Angeles')
      expect(parts.hour).toBe(20)
      expect(parts.day).toBe(23)
    })

    it('handles hour 24 normalization', () => {
      // Intl can sometimes return hour 24 for midnight
      // Test with a known midnight time
      const date = new Date('2026-03-25T00:00:00Z')
      const parts = getLocalParts(date, 'UTC')
      expect(parts.hour).toBe(0)
    })
  })

  describe('getUtcOffsetMs', () => {
    it('returns 0 for UTC', () => {
      const date = new Date('2026-03-24T12:00:00Z')
      expect(getUtcOffsetMs(date, 'UTC')).toBe(0)
    })

    it('returns negative offset for US Pacific', () => {
      // PDT is UTC-7 in March
      const date = new Date('2026-03-24T12:00:00Z')
      const offset = getUtcOffsetMs(date, 'America/Los_Angeles')
      expect(offset).toBe(-7 * 60 * 60 * 1000) // -7 hours in ms
    })

    it('returns positive offset for Tokyo', () => {
      // JST is UTC+9 always
      const date = new Date('2026-03-24T12:00:00Z')
      const offset = getUtcOffsetMs(date, 'Asia/Tokyo')
      expect(offset).toBe(9 * 60 * 60 * 1000) // +9 hours in ms
    })
  })

  describe('nextLocalTime', () => {
    it('finds the next occurrence of a local time in UTC timezone', () => {
      const after = new Date('2026-03-24T10:00:00Z').getTime()
      const result = nextLocalTime(after, 14, 0, 'UTC')
      // Should be 14:00 UTC same day
      const resultDate = new Date(result)
      expect(resultDate.getUTCHours()).toBe(14)
      expect(resultDate.getUTCMinutes()).toBe(0)
      expect(resultDate.getUTCDate()).toBe(24)
    })

    it('returns same timestamp when afterMs exactly matches target time', () => {
      const after = new Date('2026-03-24T14:00:00Z').getTime()
      const result = nextLocalTime(after, 14, 0, 'UTC')
      expect(result).toBe(after)
    })

    it('wraps to next day if time has passed', () => {
      const after = new Date('2026-03-24T15:00:00Z').getTime()
      const result = nextLocalTime(after, 14, 0, 'UTC')
      // 14:00 has passed, should find 14:00 tomorrow
      const resultDate = new Date(result)
      expect(resultDate.getUTCHours()).toBe(14)
      expect(resultDate.getUTCDate()).toBe(25)
    })

    it('handles timezone offset correctly', () => {
      // At 2026-03-24 08:00 UTC, it's 01:00 PDT
      // Next 07:00 PDT = 14:00 UTC same day
      const after = new Date('2026-03-24T08:00:00Z').getTime()
      const result = nextLocalTime(after, 7, 0, 'America/Los_Angeles')
      const resultDate = new Date(result)
      const parts = getLocalParts(resultDate, 'America/Los_Angeles')
      expect(parts.hour).toBe(7)
      expect(parts.minute).toBe(0)
    })
  })

  describe('HH:MM regexes', () => {
    it('HHMM_RE (lenient) accepts both single- and zero-padded hours', () => {
      expect(HHMM_RE.test('9:00')).toBe(true)
      expect(HHMM_RE.test('09:00')).toBe(true)
      expect(HHMM_RE.test('23:59')).toBe(true)
      expect(HHMM_RE.test('24:00')).toBe(false)
      expect(HHMM_RE.test('12:60')).toBe(false)
    })

    it('HHMM_STRICT_RE requires a zero-padded hour', () => {
      expect(HHMM_STRICT_RE.test('09:00')).toBe(true)
      expect(HHMM_STRICT_RE.test('23:59')).toBe(true)
      expect(HHMM_STRICT_RE.test('9:00')).toBe(false)
      expect(HHMM_STRICT_RE.test('24:00')).toBe(false)
    })

    // Parity guard: the client mirror in client/src/utils/timeWindow.js and the
    // dashboard route mock both pin this exact source. Update all three together.
    it('HHMM_STRICT_RE has the documented canonical source', () => {
      expect(HHMM_STRICT_RE.source).toBe('^([01]\\d|2[0-3]):[0-5]\\d$')
    })
  })

  describe('parseHHMM', () => {
    it.each([
      ['00:00', 0],
      ['07:00', 420],
      ['22:00', 1320],
      ['23:59', 23 * 60 + 59],
      ['9:30', 9 * 60 + 30],
    ])('parses %s → %s', (s, expected) => {
      expect(parseHHMM(s)).toBe(expected)
    })

    it.each(['', '24:00', '12:60', 'abc', null, undefined, '12'])('rejects %s', (s) => {
      expect(parseHHMM(s)).toBeNull()
    })
  })

  describe('isWithinTimeWindow', () => {
    it('matches inside a same-day window (half-open)', () => {
      const win = { start: '09:00', end: '17:00' }
      expect(isWithinTimeWindow({ ...win, nowMinutes: 10 * 60 })).toBe(true)
      expect(isWithinTimeWindow({ ...win, nowMinutes: 9 * 60 })).toBe(true)
      expect(isWithinTimeWindow({ ...win, nowMinutes: 17 * 60 })).toBe(false)
      expect(isWithinTimeWindow({ ...win, nowMinutes: 8 * 60 })).toBe(false)
    })

    it('wraps overnight (start > end)', () => {
      const win = { start: '22:00', end: '07:00' }
      expect(isWithinTimeWindow({ ...win, nowMinutes: 23 * 60 })).toBe(true)
      expect(isWithinTimeWindow({ ...win, nowMinutes: 5 * 60 })).toBe(true)
      expect(isWithinTimeWindow({ ...win, nowMinutes: 14 * 60 })).toBe(false)
    })

    it('returns false for empty (start === end) or malformed bounds', () => {
      expect(isWithinTimeWindow({ start: '08:00', end: '08:00', nowMinutes: 8 * 60 })).toBe(false)
      expect(isWithinTimeWindow({ start: 'abc', end: '07:00', nowMinutes: 5 * 60 })).toBe(false)
    })
  })

  describe('todayInTimezone', () => {
    it('returns date string in YYYY-MM-DD format', () => {
      const result = todayInTimezone('UTC')
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('may differ from UTC date in offset timezones', () => {
      // At 2026-03-24 03:00 UTC, it's still March 23 in Pacific time
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-24T03:00:00Z'))

      const utcDate = todayInTimezone('UTC')
      const pdtDate = todayInTimezone('America/Los_Angeles')
      expect(utcDate).toBe('2026-03-24')
      expect(pdtDate).toBe('2026-03-23')

      vi.useRealTimers()
    })

    it('keys a caller-supplied instant (not a fresh Date) when atDate is passed', () => {
      // 2026-07-16T05:00Z = 2026-07-15 22:00 PDT. The passed instant, not "now",
      // must drive the day key so a writer's date + timestamp stay on one day.
      const instant = new Date('2026-07-16T05:00:00.000Z')
      expect(todayInTimezone('America/Los_Angeles', instant)).toBe('2026-07-15')
      expect(todayInTimezone('UTC', instant)).toBe('2026-07-16')
    })
  })

  describe('anchorLocalMidnightUtc (DST-safe local-midnight anchor)', () => {
    const localClock = (ms, tz) =>
      new Date(ms).toLocaleTimeString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })

    it('anchors a constant-offset day to local midnight (PDT midnight = 07:00 UTC)', () => {
      const anchor = anchorLocalMidnightUtc('2026-04-17', 'America/Los_Angeles')
      expect(anchor).toBe(Date.parse('2026-04-17T00:00:00Z') + 7 * 3600 * 1000)
      expect(localClock(anchor, 'America/Los_Angeles')).toBe('00:00')
    })

    it('uses the PRE-transition offset on a spring-forward day (midnight is still PST)', () => {
      // US DST starts 2026-03-08 at 02:00 local — midnight that day is still
      // PST (-8), even though most of the day runs PDT (-7). A single-pass
      // offset evaluated later in the day would shift the window by an hour.
      const anchor = anchorLocalMidnightUtc('2026-03-08', 'America/Los_Angeles')
      expect(anchor).toBe(Date.parse('2026-03-08T00:00:00Z') + 8 * 3600 * 1000)
      expect(localClock(anchor, 'America/Los_Angeles')).toBe('00:00')
    })

    it('anchors a fall-back day to the still-PDT midnight', () => {
      // US DST ends 2026-11-01 at 02:00 local — midnight that day is still PDT.
      const anchor = anchorLocalMidnightUtc('2026-11-01', 'America/Los_Angeles')
      expect(anchor).toBe(Date.parse('2026-11-01T00:00:00Z') + 7 * 3600 * 1000)
      expect(localClock(anchor, 'America/Los_Angeles')).toBe('00:00')
    })

    it('uses the first representable instant when a timezone skips midnight', () => {
      const anchor = anchorLocalMidnightUtc('2026-03-08', 'America/Havana')
      expect(anchor).toBe(Date.parse('2026-03-08T05:00:00Z'))
      expect(localClock(anchor, 'America/Havana')).toBe('01:00')
      expect(todayInTimezone('America/Havana', new Date(anchor - 1))).toBe('2026-03-07')
      expect(todayInTimezone('America/Havana', new Date(anchor))).toBe('2026-03-08')
    })

    it('handles timezones ahead of UTC', () => {
      const anchor = anchorLocalMidnightUtc('2026-04-17', 'Asia/Tokyo')
      expect(anchor).toBe(Date.parse('2026-04-17T00:00:00Z') - 9 * 3600 * 1000)
      expect(localClock(anchor, 'Asia/Tokyo')).toBe('00:00')
    })
  })

  describe('localDayWindowUtc', () => {
    it('bounds the current local day as UTC ISO strings', () => {
      // 2026-04-17T03:00Z is still 2026-04-16 evening in Los Angeles.
      const at = new Date('2026-04-17T03:00:00Z')
      const { date, startDate, endDate } = localDayWindowUtc('America/Los_Angeles', at)
      expect(date).toBe('2026-04-16')
      expect(startDate).toBe('2026-04-16T07:00:00.000Z')
      expect(endDate).toBe('2026-04-17T06:59:59.999Z')
    })

    it.each([
      ['2026-03-08T12:00:00Z', '2026-03-08', '2026-03-09T06:59:59.999Z'],
      ['2026-11-01T12:00:00Z', '2026-11-01', '2026-11-02T07:59:59.999Z'],
    ])('uses the next local-day boundary on the %s DST date', (at, date, endDate) => {
      const window = localDayWindowUtc('America/Los_Angeles', new Date(at))
      expect(window.date).toBe(date)
      expect(window.endDate).toBe(endDate)
    })
  })

  describe('localDayRangeUtc', () => {
    it('returns a 24h UTC window for a constant-offset local day', () => {
      const range = localDayRangeUtc('2026-07-04', 'America/Los_Angeles')
      expect(range.start.toISOString()).toBe('2026-07-04T07:00:00.000Z')
      expect(range.end.getTime() - range.start.getTime()).toBe(24 * 60 * 60 * 1000)
    })

    it.each([
      ['2026-03-08', '2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z', 23],
      ['2026-11-01', '2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z', 25],
    ])('preserves the %s DST day as a half-open %s → %s window', (date, start, end, hours) => {
      const range = localDayRangeUtc(date, 'America/Los_Angeles')
      expect(range.start.toISOString()).toBe(start)
      expect(range.end.toISOString()).toBe(end)
      expect(range.end.getTime() - range.start.getTime()).toBe(hours * 60 * 60 * 1000)
    })

    it('rejects malformed dates', () => {
      expect(localDayRangeUtc('not-a-date', 'UTC')).toBeNull()
      expect(localDayRangeUtc('2026-02-31', 'UTC')).toBeNull()
      expect(localDayRangeUtc('2026-13-01', 'UTC')).toBeNull()
    })

    it('trims surrounding whitespace before anchoring', () => {
      const range = localDayRangeUtc(' 2026-03-08 ', 'America/Los_Angeles')
      expect(range.start.toISOString()).toBe('2026-03-08T08:00:00.000Z')
      expect(range.end.toISOString()).toBe('2026-03-09T07:00:00.000Z')
    })

    it('rolls the end boundary over month and year edges', () => {
      const monthEdge = localDayRangeUtc('2026-01-31', 'UTC')
      expect(monthEdge.end.toISOString()).toBe('2026-02-01T00:00:00.000Z')
      const yearEdge = localDayRangeUtc('2026-12-31', 'UTC')
      expect(yearEdge.end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    })

    it('bounds a midnight-skipping DST day without including the prior date', () => {
      const range = localDayRangeUtc('2026-03-08', 'America/Havana')
      expect(range.start.toISOString()).toBe('2026-03-08T05:00:00.000Z')
      expect(range.end.toISOString()).toBe('2026-03-09T04:00:00.000Z')
      expect(range.end.getTime() - range.start.getTime()).toBe(23 * 60 * 60 * 1000)
    })

    it('handles years below 100 without Date.UTC\'s 1900 offset', () => {
      const range = localDayRangeUtc('0099-12-31', 'UTC')
      expect(range.start.toISOString()).toBe('0099-12-31T00:00:00.000Z')
      expect(range.end.toISOString()).toBe('0100-01-01T00:00:00.000Z')
    })

    it('rejects a calendar date skipped entirely by its timezone', () => {
      expect(localDayRangeUtc('2011-12-30', 'Pacific/Apia')).toBeNull()
      expect(Number.isNaN(anchorLocalMidnightUtc('2011-12-30', 'Pacific/Apia'))).toBe(true)
    })
  })

  describe('getTimezoneUpdatedAt (#2040)', () => {
    it('returns the stamped numeric timestamp when set', async () => {
      getSettings.mockResolvedValue({ timezone: 'UTC', timezoneUpdatedAt: 1700000000000 })
      expect(await getTimezoneUpdatedAt()).toBe(1700000000000)
    })

    it('returns null when the field is absent (unset sentinel — never gates)', async () => {
      getSettings.mockResolvedValue({ timezone: 'UTC' })
      expect(await getTimezoneUpdatedAt()).toBeNull()
    })

    it('returns null for a non-numeric or non-positive value', async () => {
      getSettings.mockResolvedValue({ timezoneUpdatedAt: '1700000000000' })
      expect(await getTimezoneUpdatedAt()).toBeNull()
      getSettings.mockResolvedValue({ timezoneUpdatedAt: 0 })
      expect(await getTimezoneUpdatedAt()).toBeNull()
    })
  })
})
