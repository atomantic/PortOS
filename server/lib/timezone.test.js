import { describe, it, expect, vi } from 'vitest'
import { getLocalParts, getUtcOffsetMs, nextLocalTime, todayInTimezone } from './timezone.js'

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
  })
})
