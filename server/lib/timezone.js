/**
 * Timezone utilities for scheduling
 *
 * All scheduling runs in the user's configured timezone.
 * The server process uses TZ=UTC, so all Date operations are UTC internally.
 * These helpers convert between UTC and the user's local timezone.
 */

import { getSettings } from '../services/settings.js'

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// Cache Intl.DateTimeFormat instances per timezone — these are expensive to construct
// but safe to reuse since they're stateless formatters.
const formatterCache = new Map()

function getFormatter(timezone) {
  let fmt = formatterCache.get(timezone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false
    })
    formatterCache.set(timezone, fmt)
  }
  return fmt
}

/**
 * Get the user's configured timezone, falling back to system timezone.
 * @returns {Promise<string>} IANA timezone string (e.g., 'America/Los_Angeles')
 */
export async function getUserTimezone() {
  const settings = await getSettings()
  const tz = settings.timezone
  if (tz) {
    // Validate the configured timezone; fall back to system timezone if invalid
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    } catch {
      console.error(`❌ Invalid configured timezone "${tz}", falling back to system default`)
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Get local date/time parts for a UTC Date in the given timezone.
 * @param {Date} utcDate - Date object (interpreted as UTC since TZ=UTC)
 * @param {string} timezone - IANA timezone string
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, dayOfWeek: number }}
 */
export function getLocalParts(utcDate, timezone) {
  const parts = {}
  for (const { type, value } of getFormatter(timezone).formatToParts(utcDate)) {
    parts[type] = value
  }
  return {
    year: parseInt(parts.year),
    month: parseInt(parts.month),
    day: parseInt(parts.day),
    hour: parts.hour === '24' ? 0 : parseInt(parts.hour),
    minute: parseInt(parts.minute),
    dayOfWeek: WEEKDAY_MAP[parts.weekday] ?? 0
  }
}

/**
 * Get the UTC offset (in ms) for a timezone at a given UTC time.
 * Positive = ahead of UTC (e.g., +9h for Tokyo), negative = behind (e.g., -7h for PDT).
 * @param {Date} utcDate - Reference UTC date
 * @param {string} timezone - IANA timezone string
 * @returns {number} Offset in milliseconds
 */
export function getUtcOffsetMs(utcDate, timezone) {
  const utcStr = utcDate.toLocaleString('en-US', { timeZone: 'UTC' })
  const localStr = utcDate.toLocaleString('en-US', { timeZone: timezone })
  return new Date(localStr).getTime() - new Date(utcStr).getTime()
}

/**
 * Find the next UTC timestamp where the local time in `timezone` matches HH:MM.
 * @param {number} afterMs - UTC timestamp to search after
 * @param {number} hours - Target hour (0-23) in local timezone
 * @param {number} minutes - Target minute (0-59) in local timezone
 * @param {string} timezone - IANA timezone string
 * @returns {number} UTC timestamp
 */
export function nextLocalTime(afterMs, hours, minutes, timezone) {
  // Start from the after point, find what the current local time is
  const ref = new Date(afterMs)
  const local = getLocalParts(ref, timezone)

  // Compute desired vs current in minutes-since-midnight
  const desiredMin = hours * 60 + minutes
  const currentMin = local.hour * 60 + local.minute

  // How many minutes until the target time?
  let deltaMin = desiredMin - currentMin
  if (deltaMin < 0) deltaMin += 1440 // wrap to next day

  const candidate = afterMs + deltaMin * 60_000
  // DST transitions can shift the result by up to ±60 min — verify and nudge if needed.
  const check = getLocalParts(new Date(candidate), timezone)
  const checkMin = check.hour * 60 + check.minute
  if (checkMin !== desiredMin) {
    return candidate + (desiredMin - checkMin) * 60_000
  }
  return candidate
}

/**
 * Get today's date string (YYYY-MM-DD) in the user's timezone.
 * @param {string} timezone - IANA timezone string
 * @returns {string}
 */
export function todayInTimezone(timezone) {
  const parts = getLocalParts(new Date(), timezone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// HH:MM time-window primitives
//
// Two consumers validate "HH:MM" (24h) strings with deliberately different
// strictness, so both regexes live here as the single source of truth:
//   - HHMM_RE (lenient): tolerates a single-digit hour ("9:00") as well as
//     the zero-padded form. Used by voice quiet-hours (routes/voice.js via
//     proactiveSpeech.js), which has always accepted single-digit hours.
//   - HHMM_STRICT_RE: requires a zero-padded hour ("09:00"). Used by the
//     dashboard activateWindow validator (services/dashboardLayouts.js) and
//     mirrored client-side in client/src/utils/timeWindow.js — keep all three
//     in sync (each has a parity test against the literal pattern).
// ---------------------------------------------------------------------------
export const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/
export const HHMM_STRICT_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// Parse "HH:MM" → minutes-from-midnight. Lenient (accepts single-digit hours)
// so callers can validate strictness separately at their boundary. Returns
// null for malformed input so the caller can fall through or error.
export function parseHHMM(s) {
  if (typeof s !== 'string') return null
  const m = s.match(HHMM_RE)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

// Half-open [start, end) window-inclusion check against minutes-from-midnight.
// Handles the overnight case (start > end, e.g. 22:00 → 07:00) by wrapping.
// start === end is an empty window → never matches. Malformed bounds → false
// (caller treats as "window off"). Shared by voice quiet-hours and mirrored
// client-side for dashboard time-windowed layout auto-activation.
export function isWithinTimeWindow({ start, end, nowMinutes }) {
  const s = parseHHMM(start)
  const e = parseHHMM(end)
  if (s === null || e === null) return false
  if (s === e) return false
  if (s < e) return nowMinutes >= s && nowMinutes < e
  // Overnight wrap: in-window if at-or-after start OR before end.
  return nowMinutes >= s || nowMinutes < e
}
