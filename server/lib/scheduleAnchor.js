/**
 * Calendar anchor for multi-day autonomous-job cadences (#15395).
 *
 * An interval job keeps no weekday of its own: `lastRun + intervalMs` snapped to
 * the nearest `scheduledTime` inherits whatever day `lastRun` landed on, so one
 * run stamped more than ~12h after its slot moved a weekly job to the next
 * weekday for good. `scheduleAnchor` is the explicit calendar day (local weekday
 * 0-6 for weekly/biweekly, day of month 1-31 for monthly) a late run cannot move.
 *
 * Pure: the timezone is always an argument.
 */

import { getLocalParts, nextLocalTime } from './timezone.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Anchor semantics per cadence: a local weekday, or a day of the month. */
const ANCHOR_KIND_BY_INTERVAL = { weekly: 'weekday', biweekly: 'weekday', monthly: 'monthDay' }

/**
 * How early before `lastRun + intervalMs` the next anchor day may fall. A day
 * absorbs the clock-time gap; a month is 28-31 days against the 30-day
 * `intervalMs`, so it needs enough room that Feb 15 + 30d (Mar 17) still reaches Mar 15.
 */
const ANCHOR_SLACK_MS = { weekday: DAY, monthDay: 10 * DAY }

/**
 * Nearest local `HH:MM` instant to `targetMs`, optionally only those after
 * `afterMs`. The search starts `windowMs` before the target and compares two
 * consecutive occurrences: on a DST day they are 23h or 25h apart, so a one-sided
 * window could miss the nearer one, and DST nudging in `nextLocalTime` can move a
 * candidate by up to an hour.
 * @returns {number|undefined} UTC ms, undefined when no candidate is after `afterMs`
 */
export function nearestLocalTime(targetMs, hours, minutes, timezone, { windowMs = 13 * HOUR, afterMs = -Infinity } = {}) {
  const first = nextLocalTime(targetMs - windowMs, hours, minutes, timezone)
  const second = nextLocalTime(first + 60_000, hours, minutes, timezone)
  return [first, second]
    .filter(candidate => candidate > afterMs)
    .sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs))[0]
}

/**
 * Which kind of anchor a job can carry: `weekday`, `monthDay`, or null when the
 * job has no multi-day clock cadence (cron mode, sub-weekly/custom/on-demand
 * interval, or no valid `scheduledTime`).
 * @param {Object} job
 * @returns {'weekday'|'monthDay'|null}
 */
export function scheduleAnchorKind(job) {
  if (job?.cronExpression || job?.cronSchedule) return null
  if (!Number.isFinite(job?.intervalMs)) return null
  if (!HHMM.test(String(job?.scheduledTime ?? ''))) return null
  return scheduleAnchorKindForInterval(job?.interval)
}

/** The anchor kind a cadence supports, ignoring the rest of the job (the editors' picker). */
export function scheduleAnchorKindForInterval(interval) {
  return ANCHOR_KIND_BY_INTERVAL[interval] ?? null
}

/** @returns {boolean} whether `value` is a legal anchor for `kind` */
export function isValidScheduleAnchor(kind, value) {
  if (!Number.isInteger(value)) return false
  if (kind === 'weekday') return value >= 0 && value <= 6
  if (kind === 'monthDay') return value >= 1 && value <= 31
  return false
}

/** The anchor this job actually schedules by, or null when it has none (legacy behavior). */
export function effectiveScheduleAnchor(job) {
  const kind = scheduleAnchorKind(job)
  return kind && isValidScheduleAnchor(kind, job.scheduleAnchor) ? { kind, value: job.scheduleAnchor } : null
}

/** Whether the job can carry an anchor but has no valid one yet. */
export function needsScheduleAnchor(job) {
  const kind = scheduleAnchorKind(job)
  return kind !== null && !isValidScheduleAnchor(kind, job.scheduleAnchor)
}

/**
 * The anchor a job gets when the user has not picked one: the day of the
 * `scheduledTime` slot nearest its `lastRun` (or now when it never ran). Using the
 * nearest slot, not the raw stamp, keeps an on-time run's next fire time unchanged.
 * @returns {number|null} weekday 0-6, day of month 1-31, or null for an unanchorable job
 */
export function deriveScheduleAnchor(job, timezone) {
  const kind = scheduleAnchorKind(job)
  if (!kind) return null
  const [, hours, minutes] = job.scheduledTime.match(HHMM)
  const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : NaN
  const slot = nearestLocalTime(Number.isFinite(lastRun) ? lastRun : Date.now(), Number(hours), Number(minutes), timezone)
  const local = getLocalParts(new Date(slot), timezone)
  return kind === 'weekday' ? local.dayOfWeek : local.day
}

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()

const matchesAnchorDay = ({ kind, value }, local) =>
  kind === 'weekday' ? local.dayOfWeek === value : local.day === Math.min(value, daysInMonth(local.year, local.month))

/**
 * First `scheduledTime` on the anchor day later than `lastRun + intervalMs`
 * minus the cadence slack, so a run stamped late cannot carry the job to another
 * weekday. A monthly anchor beyond the month's length fires on its last day.
 * @param {Object} job - job with a valid `effectiveScheduleAnchor`
 * @param {string} timezone
 * @returns {number|null} UTC ms
 */
export function nextAnchoredFireTime(job, timezone) {
  const anchor = effectiveScheduleAnchor(job)
  const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : NaN
  if (!anchor || !Number.isFinite(lastRun)) return null
  const [, hours, minutes] = job.scheduledTime.match(HHMM)
  const after = lastRun + job.intervalMs - ANCHOR_SLACK_MS[anchor.kind]
  let candidate = nextLocalTime(after, Number(hours), Number(minutes), timezone)
  // Stepping 12h past the previous candidate always reaches the next day's slot
  // (slots are 23-25h apart), and DST nudging can never move it back before it.
  for (let day = 0; day < 70; day++) {
    if (candidate > after && matchesAnchorDay(anchor, getLocalParts(new Date(candidate), timezone))) return candidate
    candidate = nextLocalTime(candidate + 12 * HOUR, Number(hours), Number(minutes), timezone)
  }
  return null
}
