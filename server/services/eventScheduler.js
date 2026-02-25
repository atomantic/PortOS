/**
 * Event Scheduler Service
 *
 * Event-driven scheduling with cron expressions and timeout-safe timers.
 * Replaces setInterval with more robust scheduling.
 */

import { cosEvents } from './cosEvents.js'

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

// Maximum iterations for cron search loop (1 year in minutes)
const MAX_CRON_ITERATIONS = 525960

/**
 * Parse cron expression to next execution time
 * Supports: minute hour dayOfMonth month dayOfWeek
 *
 * Special values:
 * - '*' = any value
 * - 'number' = specific value
 * - 'start/step' = every step starting at start
 *
 * @param {string} cronExpr - Cron expression
 * @param {Date} from - Starting point (default: now)
 * @returns {Date|null} - Next execution time, or null if invalid/no match
 */
function parseCronToNextRun(cronExpr, from = new Date()) {
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

  // Simple implementation - find next matching time
  const next = new Date(from)
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1) // Start from next minute

  // Maximum search: 2 years
  const maxDate = new Date(from)
  maxDate.setFullYear(maxDate.getFullYear() + 2)

  let iterations = 0
  while (next < maxDate) {
    if (++iterations > MAX_CRON_ITERATIONS) {
      console.error(`❌ Cron search exceeded ${MAX_CRON_ITERATIONS} iterations for: ${cronExpr}`)
      return null
    }
    if (matchesCronField(next.getMonth() + 1, monthExpr) &&
        matchesCronField(next.getDate(), dayOfMonthExpr) &&
        matchesCronField(next.getDay(), dayOfWeekExpr) &&
        matchesCronField(next.getHours(), hourExpr) &&
        matchesCronField(next.getMinutes(), minuteExpr)) {
      return next
    }
    next.setMinutes(next.getMinutes() + 1)
  }

  return null // No match found within 2 years
}

/**
 * Check if a value matches a cron field expression
 * @param {number} value - Current value
 * @param {string} expr - Cron field expression
 * @returns {boolean} - True if matches
 */
function matchesCronField(value, expr) {
  if (expr === '*') return true

  // Handle comma-separated values
  if (expr.includes(',')) {
    return expr.split(',').some(part => matchesCronField(value, part.trim()))
  }

  // Handle ranges (e.g., 1-5)
  if (expr.includes('-')) {
    const [start, end] = expr.split('-').map(Number)
    return value >= start && value <= end
  }

  // Handle step values (e.g., */5 or 0/10)
  if (expr.includes('/')) {
    const [start, step] = expr.split('/')
    const startNum = start === '*' ? 0 : Number(start)
    const stepNum = Number(step)
    return (value - startNum) % stepNum === 0 && value >= startNum
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
 * @param {number} config.intervalMs - Interval in ms (for type: interval)
 * @param {number} config.delayMs - Delay in ms (for type: once)
 * @param {Function} config.handler - Event handler function
 * @param {Object} config.metadata - Additional metadata
 * @returns {Object} - Scheduled event
 */
function schedule(config) {
  const { id, type, cron, intervalMs, delayMs, handler, metadata = {} } = config

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
      event.nextRunAt = parseCronToNextRun(cron)?.getTime() || null
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
      runEvent(event)
      return
    }
    // Calculate next occurrence
    updateNextRunTime(event)
    scheduleNextRun(event)
    return
  }

  const timer = createSafeTimer(() => runEvent(event), delay, event.id)
  activeTimers.set(event.id, timer)
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
  }

  // Record in history (push + truncate is faster than unshift + pop for large arrays)
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

  // Emit completion
  cosEvents.emit('scheduler:ran', {
    id: event.id,
    success,
    runCount: event.runCount
  })

  // Schedule next run for recurring events
  if (event.active && event.type !== 'once') {
    updateNextRunTime(event)
    scheduleNextRun(event)
  } else if (event.type === 'once') {
    event.active = false
    activeTimers.delete(event.id)
  }
}

/**
 * Update the next run time for a recurring event
 * @param {Object} event - Event object
 */
function updateNextRunTime(event) {
  switch (event.type) {
    case 'cron':
      const nextDate = parseCronToNextRun(event.cron, new Date())
      event.nextRunAt = nextDate?.getTime() || null
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

  const timer = activeTimers.get(id)
  if (timer) {
    clearTimeout(timer.timerId)
    activeTimers.delete(id)
  }

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

  const timer = activeTimers.get(id)
  if (timer) {
    clearTimeout(timer.timerId)
    activeTimers.delete(id)
  }

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

  for (const id of scheduledEvents.keys()) {
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

  await runEvent(event)
  return true
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
  MAX_TIMEOUT
}
