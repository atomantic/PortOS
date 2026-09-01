/**
 * Timezone utilities for scheduling
 *
 * All scheduling runs in the user's configured timezone.
 * The server process uses TZ=UTC, so all Date operations are UTC internally.
 * These helpers convert between UTC and the user's local timezone.
 */

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
 *
 * Callers doing DST-safe midnight anchoring (`anchorLocalMidnightUtc` below)
 * re-sample this at their candidate instant because the offset can change
 * between the approximate UTC time and the target local boundary.
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
 * Get the date string (YYYY-MM-DD) for an instant in the user's timezone —
 * "today" by default, or a caller-supplied instant. Pass the SAME instant a
 * writer stamped into its `timestamp`/`startedAt` so the day key and the instant
 * can't land on different days across a midnight boundary (issue #2681).
 * @param {string} timezone - IANA timezone string
 * @param {Date} [atDate] - instant to key (defaults to now)
 * @returns {string}
 */
export function todayInTimezone(timezone, atDate = new Date()) {
  const parts = getLocalParts(atDate, timezone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

const DAY_MS = 24 * 60 * 60 * 1000
const LOCAL_DAY_SEARCH_RADIUS_MS = 36 * 60 * 60 * 1000

function parseIsoDay(dayStr) {
  const normalized = String(dayStr || '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized)
  if (!match || Number(match[1]) === 0) return null
  const utcMs = Date.parse(`${normalized}T00:00:00Z`)
  if (!Number.isFinite(utcMs) || new Date(utcMs).toISOString().slice(0, 10) !== normalized) return null
  const [, year, month, day] = match.map(Number)
  return { normalized, utcMs, ordinal: year * 10_000 + month * 100 + day }
}

function localDayOrdinalAt(utcMs, timezone) {
  const { year, month, day } = getLocalParts(new Date(utcMs), timezone)
  return year * 10_000 + month * 100 + day
}

function findLocalDayBoundary(parsed, tz) {
  // Keep the common path cheap: offset refinement lands exactly on midnight
  // for ordinary days and transitions that happen later in the day.
  const firstOffset = getUtcOffsetMs(new Date(parsed.utcMs), tz)
  const candidate = parsed.utcMs - firstOffset
  const refinedOffset = getUtcOffsetMs(new Date(candidate), tz)
  const refined = parsed.utcMs - refinedOffset
  const refinedParts = getLocalParts(new Date(refined), tz)
  const refinedOrdinal = refinedParts.year * 10_000 + refinedParts.month * 100 + refinedParts.day
  if (
    refinedOrdinal === parsed.ordinal
    && refinedParts.hour === 0
    && refinedParts.minute === 0
    && localDayOrdinalAt(refined - 1, tz) < parsed.ordinal
  ) {
    return refined
  }

  // Midnight-offset arithmetic can oscillate across a transition that occurs
  // at 00:00. Local calendar dates remain ordered across UTC instants, so find
  // the first instant whose local date is not before the requested date.
  let low = parsed.utcMs - LOCAL_DAY_SEARCH_RADIUS_MS
  let high = parsed.utcMs + LOCAL_DAY_SEARCH_RADIUS_MS
  if (localDayOrdinalAt(low, tz) >= parsed.ordinal || localDayOrdinalAt(high, tz) < parsed.ordinal) return NaN
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2)
    if (localDayOrdinalAt(mid, tz) < parsed.ordinal) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * UTC timestamp (ms) of the first instant belonging to the `YYYY-MM-DD`
 * local day in `tz`. This is normally local midnight. When a timezone jumps
 * forward at 00:00 and midnight does not exist, it is the first representable
 * instant on that date rather than an instant from the previous local day.
 * @param {string} dayStr - Local day as `YYYY-MM-DD`
 * @param {string} tz - IANA timezone string
 * @returns {number} UTC timestamp (ms), or `NaN` for an invalid or skipped date
 */
export function anchorLocalMidnightUtc(dayStr, tz) {
  const parsed = parseIsoDay(dayStr)
  if (!parsed) return NaN
  const boundary = findLocalDayBoundary(parsed, tz)
  return Number.isFinite(boundary) && localDayOrdinalAt(boundary, tz) === parsed.ordinal
    ? boundary
    : NaN
}

/**
 * The user's current local calendar day expressed as UTC ISO bounds — the
 * shared "today's events" query window (calendar agenda route, voice
 * calendar_today tool). `startDate` is local midnight; `endDate` is
 * 23:59:59.999 later.
 * @param {string} timezone - IANA timezone string
 * @param {Date} [atDate] - instant to key (defaults to now)
 * @returns {{ date: string, startDate: string, endDate: string }}
 */
export function localDayWindowUtc(timezone, atDate = new Date()) {
  const date = todayInTimezone(timezone, atDate)
  const startMs = anchorLocalMidnightUtc(date, timezone)
  const range = localDayRangeUtc(date, timezone)
  const endMs = range?.end?.getTime()
  return {
    date,
    startDate: new Date(startMs).toISOString(),
    // The inclusive end is derived from the next local-day boundary, so a
    // 23-hour or 25-hour DST day cannot leak into or omit the adjacent date.
    endDate: new Date(Number.isFinite(endMs) ? endMs - 1 : startMs + DAY_MS - 1).toISOString(),
  }
}

/**
 * UTC `[start, end)` instants that bound a local calendar day (`YYYY-MM-DD`)
 * in `timezone`. The end is the next local date's boundary rather than a
 * fixed 24 hours after the start, preserving 23- and 25-hour DST days.
 * This remains separate from `localDayWindowUtc`, whose inclusive end serves
 * callers with a different boundary contract.
 *
 * @param {string} dateStr - Local day as `YYYY-MM-DD`
 * @param {string} timezone - IANA timezone string
 * @returns {{ start: Date, end: Date } | null}
 */
export function localDayRangeUtc(dateStr, timezone) {
  const parsed = parseIsoDay(dateStr)
  if (!parsed) return null
  const startMs = anchorLocalMidnightUtc(parsed.normalized, timezone)
  // A timezone can skip a complete calendar date when it crosses the date
  // line. That is not a valid local-day range, even though the next boundary
  // is well-defined for the preceding day's end.
  if (!Number.isFinite(startMs) || localDayOrdinalAt(startMs, timezone) !== parsed.ordinal) return null

  // ISO arithmetic avoids Date.UTC's special 1900 offset for years 00–99.
  const nextDate = new Date(parsed.utcMs + DAY_MS).toISOString().slice(0, 10)
  const nextParsed = parseIsoDay(nextDate)
  const endMs = nextParsed ? findLocalDayBoundary(nextParsed, timezone) : NaN
  if (!Number.isFinite(endMs)) return null
  return { start: new Date(startMs), end: new Date(endMs) }
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
