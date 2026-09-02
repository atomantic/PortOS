/**
 * Event Scheduler Service
 *
 * Event-driven scheduling with cron expressions and timeout-safe timers.
 * Replaces setInterval with more robust scheduling.
 */

import { cosEvents } from './cosEvents.js'
import { getLocalParts } from '../lib/timezone.js'
import { recurrenceRuleSchema } from '../lib/recurrenceValidation.js'

// Maximum safe setTimeout value (2^31 - 1 ms, ~24.8 days)
const MAX_TIMEOUT = 2147483647

// Scheduled events storage
const scheduledEvents = new Map()

// Active timers
const activeTimers = new Map()

// Event history
const eventHistory = []
const MAX_HISTORY = 500

/**
 * Validate that all numeric values in a cron field fall within the allowed range
 * @param {string} expr - Cron field expression
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {boolean} - True if all values are within range
 */
function validateCronFieldRange(expr, min, max) {
  if (expr === '*') return true

  // Parse each comma-separated part, handling range (a-b) and step (*/n or a-b/n) syntax
  for (const part of expr.split(',')) {
    const [rangeExpr, stepStr] = part.split('/')
    // Validate step value if present
    if (stepStr !== undefined) {
      const step = Number(stepStr)
      if (isNaN(step) || step < 1) return false
    }
    // Skip wildcard base (e.g. */5)
    if (rangeExpr === '*') continue
    // Handle range (a-b) or single value
    const bounds = rangeExpr.split('-').map(Number)
    if (bounds.some(n => isNaN(n) || n < min || n > max)) return false
    // Validate range order
    if (bounds.length === 2 && bounds[0] > bounds[1]) return false
  }
  return true
}

// Maximum iterations for cron search loop (2 years in minutes, matches maxDate window)
const MAX_CRON_ITERATIONS = 1051920

/**
 * Walk a cron expression in either direction until a matching minute is found.
 *
 * @param {string} cronExpr - Cron expression
 * @param {Date} from - Starting point (default: now)
 * @param {string} timezone - IANA timezone for matching (default: 'UTC')
 * @param {Object} options - Walk options
 * @param {number} options.stepMs - Signed minute step; positive walks forward,
 *   negative walks backward
 * @param {Date|null} options.until - Optional exclusive forward search bound
 * @returns {Date|null} - Matching execution time, or null if invalid/no match
 */
function walkCron(cronExpr, from = new Date(), timezone = 'UTC', { stepMs, until = null } = {}) {
  if (!Number.isFinite(stepMs) || stepMs === 0) {
    throw new Error(`Cron walk requires a non-zero step: ${stepMs}`)
  }

  const parts = cronExpr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cronExpr}`)
  }

  const [minuteExpr, hourExpr, dayOfMonthExpr, monthExpr, dayOfWeekExpr] = parts

  // Validate cron field ranges before entering the search loop
  const fieldRanges = [
    [minuteExpr, 0, 59, 'minute'],
    [hourExpr, 0, 23, 'hour'],
    [dayOfMonthExpr, 1, 31, 'dayOfMonth'],
    [monthExpr, 1, 12, 'month'],
    [dayOfWeekExpr, 0, 7, 'dayOfWeek']
  ]
  for (const [expr, min, max, name] of fieldRanges) {
    if (!validateCronFieldRange(expr, min, max)) {
      console.error(`❌ Invalid cron ${name} field "${expr}" in expression: ${cronExpr}`)
      return null
    }
  }

  const direction = Math.sign(stepMs)
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  if (direction > 0) cursor.setMinutes(cursor.getMinutes() + 1)

  const boundary = new Date(from)
  boundary.setFullYear(boundary.getFullYear() + (direction > 0 ? 2 : -2))
  const maxDate = direction > 0 && until instanceof Date && until < boundary ? until : boundary

  const useLocal = timezone !== 'UTC'

  let iterations = 0
  while (direction > 0 ? cursor < maxDate : cursor > maxDate) {
    if (++iterations > MAX_CRON_ITERATIONS) {
      console.error(`❌ Cron search exceeded ${MAX_CRON_ITERATIONS} iterations for: ${cronExpr}`)
      return null
    }

    let month, day, dow, hour, minute
    if (useLocal) {
      const lp = getLocalParts(cursor, timezone)
      month = lp.month; day = lp.day; dow = lp.dayOfWeek; hour = lp.hour; minute = lp.minute
    } else {
      month = cursor.getMonth() + 1; day = cursor.getDate(); dow = cursor.getDay()
      hour = cursor.getHours(); minute = cursor.getMinutes()
    }

    // Normalize DOW: cron allows 7 for Sunday, but JS getDay() returns 0
    // Match both 0 and 7 representations for Sunday
    const dowMatches = matchesCronField(dow, dayOfWeekExpr, 0) ||
      (dow === 0 && matchesCronField(7, dayOfWeekExpr, 0))

    if (matchesCronField(month, monthExpr, 1) &&
        matchesCronField(day, dayOfMonthExpr, 1) &&
        dowMatches &&
        matchesCronField(hour, hourExpr, 0) &&
        matchesCronField(minute, minuteExpr, 0)) {
      return cursor
    }
    cursor.setTime(cursor.getTime() + stepMs)
  }

  return null
}

/**
 * Parse cron expression to next execution time.
 * @param {string} cronExpr - Cron expression
 * @param {Date} from - Starting point (default: now)
 * @param {string} timezone - IANA timezone for matching (default: 'UTC')
 * @param {Date|null} until - Optional exclusive search bound
 * @returns {Date|null} - Next execution time (UTC), or null if invalid/no match
 */
function parseCronToNextRun(cronExpr, from = new Date(), timezone = 'UTC', until = null) {
  return walkCron(cronExpr, from, timezone, { stepMs: 60 * 1000, until })
}

/**
 * Parse cron expression to most-recent past execution time (at or before `from`).
 *
 * Mirrors parseCronToNextRun but walks backwards. Used to detect missed cron slots
 * for catch-up logic when the daemon was down across a scheduled time.
 *
 * @param {string} cronExpr - Cron expression
 * @param {Date} from - Reference point; result will be <= from
 * @param {string} timezone - IANA timezone for matching
 * @returns {Date|null} - Previous execution time (UTC), or null if invalid/no match within 2 years
 */
function parseCronToPrevRun(cronExpr, from = new Date(), timezone = 'UTC') {
  return walkCron(cronExpr, from, timezone, { stepMs: -60 * 1000 })
}

const RECURRENCE_DAY = 24 * 60 * 60 * 1000

function localDaySerial(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / RECURRENCE_DAY
}

function parseAnchorDate(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null
  return { year, month, day, serial: date.getTime() / RECURRENCE_DAY, dayOfWeek: date.getUTCDay() }
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function localDateFromSerial(serial) {
  const date = new Date(serial * RECURRENCE_DAY)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    dayOfWeek: date.getUTCDay(),
    serial,
  }
}

function monthSerial(year, month) {
  return year * 12 + month - 1
}

function localMonthFromSerial(serial) {
  const year = Math.floor(serial / 12)
  return { year, month: serial - year * 12 + 1 }
}

/**
 * Resolve a local calendar date/time to its UTC instant. A short correction
 * loop handles ordinary timezone offsets and DST transitions without walking
 * every minute between `from` and the next sparse occurrence.
 */
function localDateTimeToUtc(date, time, timezone) {
  const [hour, minute] = time.split(':').map(Number)
  const targetMs = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  let candidate = new Date(targetMs)

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getLocalParts(candidate, timezone)
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    const deltaMs = targetMs - actualMs
    if (deltaMs === 0) return candidate
    candidate = new Date(candidate.getTime() + deltaMs)
  }

  // A local time skipped by a DST spring-forward has no exact UTC instant.
  return null
}

function weekdayOfMonth(year, month, weekday, ordinal) {
  const lastDay = daysInMonth(year, month)
  if (ordinal === 'last') {
    const lastWeekday = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay()
    return lastDay - ((lastWeekday - weekday + 7) % 7)
  }

  const ordinalNumber = { first: 1, second: 2, third: 3, fourth: 4 }[ordinal]
  if (!ordinalNumber) return null
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + (ordinalNumber - 1) * 7
  return day <= lastDay ? day : null
}

function findNextRecurrenceCandidate(rule, anchor, from, timezone, maxDate) {
  const reference = getLocalParts(from, timezone)
  const referenceSerial = localDaySerial(reference)
  const maxLocalParts = getLocalParts(new Date(maxDate.getTime() - 1), timezone)
  const maxSerial = localDaySerial(maxLocalParts)
  const isUsable = date => {
    if (!date || date.serial < anchor.serial || date.serial < referenceSerial || date.serial > maxSerial) return null
    const candidate = localDateTimeToUtc(date, rule.time, timezone)
    return candidate && candidate > from && candidate < maxDate ? candidate : null
  }

  if (rule.frequency === 'daily') {
    const firstSerial = Math.max(anchor.serial, referenceSerial)
    const firstIndex = Math.max(0, Math.ceil((firstSerial - anchor.serial) / rule.interval))
    for (let index = firstIndex; ; index += 1) {
      const serial = anchor.serial + index * rule.interval
      if (serial > maxSerial) return null
      const date = localDateFromSerial(serial)
      if (rule.weekdays.length && !rule.weekdays.includes(date.dayOfWeek)) continue
      const candidate = isUsable(date)
      if (candidate) return candidate
    }
  }

  if (rule.frequency === 'weekly') {
    const anchorWeek = anchor.serial - anchor.dayOfWeek
    const referenceWeek = referenceSerial - reference.dayOfWeek
    const firstWeek = Math.max(anchorWeek, referenceWeek)
    const firstIndex = Math.max(0, Math.ceil((firstWeek - anchorWeek) / (7 * rule.interval)))
    const weekdays = [...rule.weekdays].sort((a, b) => a - b)
    for (let index = firstIndex; ; index += 1) {
      const weekStart = anchorWeek + index * rule.interval * 7
      if (weekStart > maxSerial) return null
      for (const weekday of weekdays) {
        const date = localDateFromSerial(weekStart + weekday)
        const candidate = isUsable(date)
        if (candidate) return candidate
      }
    }
  }

  const anchorMonth = monthSerial(anchor.year, anchor.month)
  const referenceMonth = monthSerial(reference.year, reference.month)
  const firstMonth = Math.max(anchorMonth, referenceMonth)
  const firstIndex = Math.max(0, Math.ceil((firstMonth - anchorMonth) / rule.interval))
  const maxMonth = monthSerial(maxLocalParts.year, maxLocalParts.month)

  for (let index = firstIndex; ; index += 1) {
    const currentMonth = anchorMonth + index * rule.interval
    if (currentMonth > maxMonth) return null
    const { year, month } = localMonthFromSerial(currentMonth)
    const day = rule.frequency === 'monthly-date'
      ? (rule.dayOfMonth <= daysInMonth(year, month) ? rule.dayOfMonth : null)
      : weekdayOfMonth(year, month, rule.weekday, rule.ordinal)
    if (!day) continue
    const candidate = isUsable({
      year,
      month,
      day,
      dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
      serial: Date.UTC(year, month - 1, day) / RECURRENCE_DAY,
    })
    if (candidate) return candidate
  }
}

/**
 * Find the next local-calendar occurrence for an anchored recurrence rule.
 * Unlike cron, the interval is measured from the persisted local anchor, so
 * every two weeks remains every two weeks across month boundaries and DST.
 */
function parseRecurrenceToNextRun(rule, from = new Date(), timezone = 'UTC', until = null) {
  const parsed = recurrenceRuleSchema.safeParse(rule)
  if (!parsed.success) return null
  const normalized = parsed.data
  if (normalized.frequency === 'custom') return parseCronToNextRun(normalized.cron, from, timezone, until)

  const reference = getLocalParts(from, timezone)
  const parsedAnchor = parseAnchorDate(normalized.anchorDate)
  if (normalized.anchorDate && !parsedAnchor) return null
  const anchor = parsedAnchor || {
    year: reference.year,
    month: reference.month,
    day: reference.day,
    serial: localDaySerial(reference),
    dayOfWeek: reference.dayOfWeek,
  }
  const boundary = new Date(from)
  boundary.setFullYear(boundary.getFullYear() + 2)
  // The two-year search horizon is relative to `from`, but a persisted anchor
  // may intentionally begin farther in the future. Extend the horizon through
  // that anchor so a valid recurrence is not rejected merely because its first
  // occurrence lies beyond the runtime look-ahead window.
  if (parsedAnchor) {
    const anchorBoundary = new Date(Date.UTC(parsedAnchor.year, parsedAnchor.month - 1, parsedAnchor.day))
    anchorBoundary.setUTCFullYear(anchorBoundary.getUTCFullYear() + 2)
    if (anchorBoundary > boundary) boundary.setTime(anchorBoundary.getTime())
  }
  const maxDate = until instanceof Date && until < boundary ? until : boundary
  return findNextRecurrenceCandidate(normalized, anchor, from, timezone, maxDate)
}

/**
 * Check if a value matches a cron field expression
 * @param {number} value - Current value
 * @param {string} expr - Cron field expression
 * @returns {boolean} - True if matches
 */
function matchesCronField(value, expr, fieldMin = 0) {
  if (expr === '*') return true

  // Handle comma-separated values
  if (expr.includes(',')) {
    return expr.split(',').some(part => matchesCronField(value, part.trim(), fieldMin))
  }

  // Handle step values first (e.g., */5, 0/10, 1-5/2)
  if (expr.includes('/')) {
    const [rangeExpr, step] = expr.split('/')
    const stepNum = Number(step)
    let startNum = fieldMin
    let endNum = Infinity
    if (rangeExpr === '*') {
      startNum = fieldMin
    } else if (rangeExpr.includes('-')) {
      const [s, e] = rangeExpr.split('-').map(Number)
      startNum = s
      endNum = e
    } else {
      startNum = Number(rangeExpr)
    }
    return value >= startNum && value <= endNum && (value - startNum) % stepNum === 0
  }

  // Handle ranges (e.g., 1-5)
  if (expr.includes('-')) {
    const [start, end] = expr.split('-').map(Number)
    return value >= start && value <= end
  }

  // Direct value match
  return Number(expr) === value
}

/**
 * Create a timeout-safe timer
 * Handles values larger than MAX_TIMEOUT by chaining
 *
 * @param {Function} callback - Function to call
 * @param {number} delayMs - Delay in milliseconds
 * @param {string} eventId - Event identifier for tracking
 * @returns {Object} - Timer handle
 */
function createSafeTimer(callback, delayMs, eventId) {
  const clampedDelay = Math.min(delayMs, MAX_TIMEOUT)

  if (delayMs <= MAX_TIMEOUT) {
    // Simple case - use regular setTimeout
    const timerId = setTimeout(() => {
      activeTimers.delete(eventId)
      callback()
    }, clampedDelay)

    return { timerId, type: 'simple' }
  }

  // Chain timeouts for longer delays
  const remaining = delayMs - MAX_TIMEOUT
  const timerId = setTimeout(() => {
    // Schedule the next chunk
    const nextTimer = createSafeTimer(callback, remaining, eventId)
    activeTimers.set(eventId, nextTimer)
  }, MAX_TIMEOUT)

  return { timerId, type: 'chained', remaining }
}

/**
 * Schedule an event
 *
 * @param {Object} config - Event configuration
 * @param {string} config.id - Unique event identifier
 * @param {string} config.type - Event type (cron, interval, once)
 * @param {string} config.cron - Cron expression (for type: cron)
 * @param {Object} config.recurrence - Anchored calendar rule (for type: recurrence)
 * @param {number} config.intervalMs - Interval in ms (for type: interval)
 * @param {number} config.delayMs - Delay in ms (for type: once)
 * @param {Function} config.handler - Event handler function
 * @param {Object} config.metadata - Additional metadata
 * @returns {Object} - Scheduled event
 */
function schedule(config) {
  const { id, type, cron, recurrence, timezone, intervalMs, delayMs, handler, metadata = {} } = config

  if (!id || !type || !handler) {
    throw new Error('Event requires id, type, and handler')
  }

  // Cancel existing event with same ID
  if (scheduledEvents.has(id)) {
    cancel(id)
  }

  const event = {
    id,
    type,
    cron,
    recurrence,
    timezone: timezone || 'UTC',
    intervalMs,
    delayMs,
    handler,
    metadata,
    createdAt: Date.now(),
    nextRunAt: null,
    lastRunAt: null,
    runCount: 0,
    active: true
  }

  // Calculate next run time
  switch (type) {
    case 'cron':
      if (!cron) throw new Error('Cron type requires cron expression')
      event.nextRunAt = parseCronToNextRun(cron, new Date(), event.timezone)?.getTime() || null
      break

    case 'recurrence':
      if (!recurrence) throw new Error('Recurrence type requires recurrence rule')
      event.nextRunAt = parseRecurrenceToNextRun(recurrence, new Date(), event.timezone)?.getTime() || null
      break

    case 'interval':
      if (!intervalMs) throw new Error('Interval type requires intervalMs')
      event.nextRunAt = Date.now() + intervalMs
      break

    case 'once':
      if (!delayMs) throw new Error('Once type requires delayMs')
      event.nextRunAt = Date.now() + delayMs
      break

    default:
      throw new Error(`Unknown event type: ${type}`)
  }

  scheduledEvents.set(id, event)
  scheduleNextRun(event)

  console.log(`📅 Event scheduled: ${id} (${type}) - next run: ${event.nextRunAt ? new Date(event.nextRunAt).toISOString() : 'never'}`)
  cosEvents.emit('scheduler:scheduled', { id, type, nextRunAt: event.nextRunAt })

  return event
}

/**
 * Schedule the next run of an event
 * @param {Object} event - Event object
 */
function scheduleNextRun(event) {
  if (!event.active || !event.nextRunAt) return

  const delay = event.nextRunAt - Date.now()
  if (delay < 0) {
    // Already past - run immediately for non-recurring, or calculate next for recurring
    if (event.type === 'once') {
      runEventFloating(event)
      return
    }
    // Calculate next occurrence
    updateNextRunTime(event)
    scheduleNextRun(event)
    return
  }

  // Drop any handle this arm replaces (e.g. triggerNow re-arming ahead of the
  // pending deadline) so the old timeout can't fire a duplicate run later.
  clearPendingTimer(event.id)
  const timer = createSafeTimer(() => runEventFloating(event), delay, event.id)
  activeTimers.set(event.id, timer)
}

/**
 * Start a run without awaiting it, from a timer or another fire-and-forget path.
 * runEvent already swallows handler failures; this catch exists so a defect in
 * runEvent's own bookkeeping surfaces as one log line instead of an unhandled
 * rejection that can take the process down.
 * @param {Object} event - Event object
 */
function runEventFloating(event) {
  runEvent(event).catch(err => {
    console.error(`❌ Event ${event.id} run failed: ${err.message}`)
  })
}

/**
 * Clear an event's pending timeout and forget its handle.
 * @param {string} id - Event identifier
 */
function clearPendingTimer(id) {
  const timer = activeTimers.get(id)
  if (timer) clearTimeout(timer.timerId)
  activeTimers.delete(id)
}

/**
 * Stop an event and drop its pending timer handle.
 * @param {Object} event - Event object
 */
function deactivate(event) {
  event.active = false
  clearPendingTimer(event.id)
}

/**
 * Re-arm an event after a run.
 *
 * Runs from runEvent's `finally`, so a throw anywhere earlier in the run can
 * never leave a recurring schedule un-armed but still listed as active. A next
 * run time that cannot be computed (malformed cron, a recurrence with no
 * occurrence left in the search horizon) deactivates the event with an error
 * line naming the reason, rather than leaving the CoS Schedule tab showing an
 * armed schedule that will never fire again.
 *
 * @param {Object} event - Event object
 */
function rearm(event) {
  if (!event.active) return

  if (event.type === 'once') {
    deactivate(event)
    return
  }

  try {
    updateNextRunTime(event)
  } catch (err) {
    console.error(`❌ Event ${event.id} could not compute its next run (${err.message}) - schedule stopped`)
    deactivate(event)
    return
  }

  if (!event.nextRunAt) {
    console.error(`❌ Event ${event.id} has no next run time - schedule stopped`)
    deactivate(event)
    return
  }

  scheduleNextRun(event)
}

/**
 * Append one run to the bounded history ring.
 * @param {Object} event - Event object
 * @param {Object} result - Run outcome
 * @param {number} result.startTime - Run start timestamp
 * @param {boolean} result.success - Whether the handler completed
 * @param {string|null} result.error - Handler failure message, if any
 */
function recordEventHistory(event, { startTime, success, error }) {
  // push + truncate is faster than unshift + pop for large arrays
  eventHistory.push({
    eventId: event.id,
    type: event.type,
    runAt: startTime,
    duration: Date.now() - startTime,
    success,
    error
  })

  if (eventHistory.length > MAX_HISTORY) {
    eventHistory.splice(0, eventHistory.length - MAX_HISTORY)
  }
}

/**
 * Run an event
 * @param {Object} event - Event object
 */
async function runEvent(event) {
  const startTime = Date.now()

  event.lastRunAt = startTime
  event.runCount++

  let success = true
  let error = null

  try {
    await event.handler(event)
  } catch (err) {
    success = false
    error = err.message
    console.error(`⚠️ Event ${event.id} failed: ${err.message}`)
  } finally {
    recordEventHistory(event, { startTime, success, error })

    // A synchronous listener that throws must not cost the schedule its re-arm
    try {
      cosEvents.emit('scheduler:ran', { id: event.id, success, runCount: event.runCount })
    } catch (err) {
      console.error(`⚠️ Event ${event.id} scheduler:ran listener threw: ${err.message}`)
    }

    rearm(event)
  }
}

/**
 * Update the next run time for a recurring event
 * @param {Object} event - Event object
 */
function updateNextRunTime(event) {
  switch (event.type) {
    case 'cron':
      const nextDate = parseCronToNextRun(event.cron, new Date(), event.timezone || 'UTC')
      event.nextRunAt = nextDate?.getTime() || null
      break

    case 'recurrence':
      const nextRecurrence = parseRecurrenceToNextRun(event.recurrence, new Date(), event.timezone || 'UTC')
      event.nextRunAt = nextRecurrence?.getTime() || null
      break

    case 'interval':
      event.nextRunAt = Date.now() + event.intervalMs
      break

    case 'once':
      event.nextRunAt = null
      break
  }
}

/**
 * Cancel a scheduled event
 * @param {string} id - Event identifier
 * @returns {boolean} - True if event was found and cancelled
 */
function cancel(id) {
  const event = scheduledEvents.get(id)
  if (!event) return false

  event.active = false
  clearPendingTimer(id)

  scheduledEvents.delete(id)
  console.log(`📅 Event cancelled: ${id}`)
  cosEvents.emit('scheduler:cancelled', { id })

  return true
}

/**
 * Pause a scheduled event
 * @param {string} id - Event identifier
 * @returns {boolean} - True if event was found and paused
 */
function pause(id) {
  const event = scheduledEvents.get(id)
  if (!event) return false

  event.active = false
  clearPendingTimer(id)

  console.log(`⏸️ Event paused: ${id}`)
  return true
}

/**
 * Resume a paused event
 * @param {string} id - Event identifier
 * @returns {boolean} - True if event was found and resumed
 */
function resume(id) {
  const event = scheduledEvents.get(id)
  if (!event) return false

  event.active = true
  updateNextRunTime(event)
  scheduleNextRun(event)

  console.log(`▶️ Event resumed: ${id}`)
  return true
}

/**
 * Get all scheduled events
 * @returns {Array} - All scheduled events
 */
function getScheduledEvents() {
  return Array.from(scheduledEvents.values()).map(e => ({
    id: e.id,
    type: e.type,
    active: e.active,
    cron: e.cron,
    recurrence: e.recurrence,
    nextRunAt: e.nextRunAt,
    lastRunAt: e.lastRunAt,
    runCount: e.runCount,
    metadata: e.metadata
  }))
}

/**
 * Get event by ID
 * @param {string} id - Event identifier
 * @returns {Object|null} - Event or null
 */
function getEvent(id) {
  const event = scheduledEvents.get(id)
  if (!event) return null

  return {
    id: event.id,
    type: event.type,
    active: event.active,
    cron: event.cron,
    recurrence: event.recurrence,
    intervalMs: event.intervalMs,
    nextRunAt: event.nextRunAt,
    lastRunAt: event.lastRunAt,
    runCount: event.runCount,
    metadata: event.metadata
  }
}

/**
 * Get event history
 * @param {Object} options - Filter options
 * @returns {Array} - Event history
 */
function getHistory(options = {}) {
  // History is stored oldest-first; reverse for newest-first output
  let history = [...eventHistory].reverse()

  if (options.eventId) {
    history = history.filter(h => h.eventId === options.eventId)
  }

  if (options.success !== undefined) {
    history = history.filter(h => h.success === options.success)
  }

  const limit = options.limit || 50
  return history.slice(0, limit)
}

/**
 * Get scheduler statistics
 * @returns {Object} - Scheduler stats
 */
function getStats() {
  const events = Array.from(scheduledEvents.values())
  const recent = eventHistory.slice(-100).reverse()

  return {
    totalEvents: events.length,
    activeEvents: events.filter(e => e.active).length,
    activeTimers: activeTimers.size,
    byType: events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1
      return acc
    }, {}),
    totalRuns: eventHistory.length,
    recentSuccessRate: recent.length > 0
      ? ((recent.filter(h => h.success).length / recent.length) * 100).toFixed(1) + '%'
      : '100%'
  }
}

/**
 * Cancel all scheduled events
 * @returns {number} - Number of events cancelled
 */
function cancelAll() {
  const count = scheduledEvents.size

  for (const id of [...scheduledEvents.keys()]) {
    cancel(id)
  }

  return count
}

/**
 * Trigger an event immediately (for testing or manual runs)
 * @param {string} id - Event identifier
 * @returns {Promise<boolean>} - True if event was found and triggered
 */
async function triggerNow(id) {
  const event = scheduledEvents.get(id)
  if (!event) return false

  // Disarm before running: a long manual run must not have its own pending
  // deadline elapse underneath it and start a second, concurrent run.
  clearPendingTimer(id)
  await runEvent(event)
  return true
}

/**
 * Non-throwing predicate: can this scheduler actually parse+run the expression?
 * The single source of truth for "a cron value the scheduler will honor" — reuse
 * this instead of a regex so callers validate against the exact parser (5 fields,
 * valid numeric ranges) rather than a looser approximation.
 * @param {string} expr
 * @returns {boolean}
 */
function isValidCron(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return false;
  // parseCronToNextRun throws / returns null on an unparseable or out-of-range
  // expression; wrap it into a boolean here so callers don't need try/catch.
  try {
    return Boolean(parseCronToNextRun(expr));
  } catch {
    return false;
  }
}

/** Non-throwing predicate for the richer calendar recurrence path. */
function isValidRecurrence(rule) {
  if (!recurrenceRuleSchema.safeParse(rule).success) return false
  try {
    return Boolean(parseRecurrenceToNextRun(rule))
  } catch {
    return false
  }
}

export {
  schedule,
  cancel,
  pause,
  resume,
  getScheduledEvents,
  getEvent,
  getHistory,
  getStats,
  cancelAll,
  triggerNow,
  parseCronToNextRun,
  parseCronToPrevRun,
  parseRecurrenceToNextRun,
  isValidCron,
  isValidRecurrence,
  MAX_TIMEOUT
}
