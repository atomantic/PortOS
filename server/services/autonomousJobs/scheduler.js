/**
 * Autonomous Jobs — scheduling.
 *
 * Computes which jobs are due to run now (`getDueJobs`), the single next-due job
 * (`getNextDueJob`), and the interval-string ⇄ milliseconds mapping used when
 * creating/updating jobs and rendering the UI's interval picker.
 */

import { addLocalDays, getLocalParts, nextLocalTime } from '../../lib/timezone.js'
import { effectiveScheduleAnchor, nearestLocalTime, nextAnchoredFireTime } from '../../lib/scheduleAnchor.js'
import { getUserTimezone } from '../userTimezone.js'
import { parseCronToNextRun, parseRecurrenceToNextRun } from '../eventScheduler.js'
import { DAY, HOUR, isOnDemandJob } from './constants.js'
import { loadJobs } from './store.js'

// Reads enabled jobs straight from the store. Scheduler intentionally does NOT
// import from crud.js — doing so created a scheduler→crud→scheduler cycle.
async function getEnabledJobs() {
  const data = await loadJobs()
  return data.jobs.filter(j => j.enabled)
}

/**
 * Check if today is a weekday (Monday-Friday) in the user's timezone.
 * @param {string} timezone - IANA timezone string
 * @returns {boolean}
 */
function isWeekday(timezone) {
  const local = getLocalParts(new Date(), timezone)
  return local.dayOfWeek >= 1 && local.dayOfWeek <= 5
}

/**
 * Get jobs that are due to run
 * @returns {Promise<Array>} Due jobs with reason
 */
async function getDueJobs() {
  const enabledJobs = await getEnabledJobs()
  const now = Date.now()
  const timezone = await getUserTimezone()
  const due = []

  for (const job of enabledJobs) {
    // Cron-mode jobs: compute next run from cron expression
    if (job.cronSchedule || job.cronExpression) {
      const from = job.lastRun ? new Date(job.lastRun) : new Date(now)
      const next = job.cronSchedule
        ? parseRecurrenceToNextRun(job.cronSchedule, from, timezone)
        : parseCronToNextRun(job.cronExpression, from, timezone)
      if (!next || next.getTime() > now) continue

      due.push({
        ...job,
        reason: job.lastRun ? 'cron-due' : 'never-run',
        overdueBy: now - next.getTime()
      })
      continue
    }

    // On-demand jobs have no clock — they run only via POST /jobs/:id/trigger.
    // Without this guard the interval comparison below reads a null intervalMs
    // as 0 and reports the job due on every sweep.
    if (isOnDemandJob(job)) continue

    // Interval-mode jobs
    const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0
    const timeSinceLastRun = now - lastRun

    // An anchored job is due on its anchor day, which can precede
    // lastRun + intervalMs (a late run must not move the weekday).
    if (effectiveScheduleAnchor(job)) {
      const fireAt = nextIntervalJobFireTime(job, timezone)
      if (fireAt == null || fireAt > now) continue
      if (job.weekdaysOnly && !isWeekday(timezone)) continue
      due.push({
        ...job,
        reason: job.lastRun ? `${job.interval}-due` : 'never-run',
        overdueBy: now - fireAt
      })
      continue
    }

    if (timeSinceLastRun >= job.intervalMs) {
      if (job.scheduledTime) {
        const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/)
        if (!match) continue // skip jobs with invalid scheduledTime format
        const hours = Number(match[1])
        const minutes = Number(match[2])
        // Compute today's scheduled UTC time in a DST-safe way.
        // nextLocalTime finds the next occurrence AFTER the reference point.
        // By searching from (now - 24h), we get today's occurrence if we haven't passed it yet,
        // or yesterday's occurrence if we have. We then verify the candidate is on today's local date.
        const nowFloored = now - (now % 60_000)
        const localNow = getLocalParts(new Date(nowFloored), timezone)
        let targetUtc = nextLocalTime(nowFloored - DAY, hours, minutes, timezone)
        const targetLocal = getLocalParts(new Date(targetUtc), timezone)
        // If the candidate landed on yesterday's date, advance to today's occurrence
        if (targetLocal.day !== localNow.day || targetLocal.month !== localNow.month || targetLocal.year !== localNow.year) {
          targetUtc = nextLocalTime(targetUtc + 1, hours, minutes, timezone)
        }
        if (now < targetUtc) continue
        if (lastRun >= targetUtc) continue
      }

      if (job.weekdaysOnly && !isWeekday(timezone)) continue

      due.push({
        ...job,
        reason: job.lastRun ? `${job.interval}-due` : 'never-run',
        overdueBy: timeSinceLastRun - job.intervalMs
      })
    }
  }

  due.sort((a, b) => b.overdueBy - a.overdueBy)

  return due
}

/**
 * The cron a job fires on: its own `cronExpression`, or a synthesized daily
 * (`M H * * *`) / weekday (`M H * * 1-5`) cron for a daily or weekdaysOnly
 * job with a `scheduledTime`. Shared by the armed timer (cosJobScheduler) and
 * computeNextJobRun so both pick the same path. Weekly/biweekly/sub-daily
 * interval jobs return null and use nextIntervalJobFireTime.
 * @param {Object} job
 * @returns {string|null}
 */
export function clockCronExpression(job) {
  if (job.cronExpression) return job.cronExpression
  if (!job.scheduledTime || !(job.interval === 'daily' || job.weekdaysOnly)) return null
  const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  return match ? `${Number(match[2])} ${Number(match[1])} * * ${job.weekdaysOnly ? '1-5' : '*'}` : null
}

/**
 * Next fire time of an interval-mode job: `lastRun + intervalMs`, snapped to the
 * `scheduledTime` (HH:MM, user timezone) occurrence NEAREST that moment, then
 * pushed off weekends for `weekdaysOnly`. The one implementation behind both the
 * armed timer (cosJobScheduler) and the stats preview (computeNextJobRun), so
 * they cannot drift.
 *
 * Nearest, not next: a run stamped a minute after HH:MM (script jobs stamp
 * `lastRun` after the handler finishes) would otherwise round up a whole day,
 * sliding a weekly job one weekday later every cycle. The search starts at
 * `nextDue - window` (half an interval, capped at 13h), so every candidate is
 * later than `lastRun` and hourly jobs still resolve to the next HH:MM. The cap
 * is 13h, not 12h, and two consecutive HH:MM occurrences are compared: on a DST
 * day they are 23h or 25h apart, so a one-sided 12h window could miss the nearer one.
 *
 * Nearest still lets one run stamped more than ~12h after its slot move the job
 * to the next weekday for good, so weekly/biweekly/monthly jobs carry a
 * `scheduleAnchor` (see lib/scheduleAnchor.js) that fixes the calendar day;
 * a job without a valid anchor keeps the nearest-slot behavior above.
 *
 * @param {Object} job - interval-mode job (finite `intervalMs`)
 * @param {string} timezone - IANA timezone for scheduledTime
 * @returns {number|null} UTC timestamp in milliseconds
 */
export function nextIntervalJobFireTime(job, timezone) {
  // Never run: due now. The timer fires an overdue job at once; projecting
  // lastRun = epoch 0 would publish a 1970 instant as the next run.
  if (!job.lastRun) return Date.now()

  const lastRun = new Date(job.lastRun).getTime()
  let nextDue = lastRun + job.intervalMs

  // An explicit calendar anchor wins over snapping to the nearest slot.
  const anchored = nextAnchoredFireTime(job, timezone)
  if (anchored != null) nextDue = anchored

  const match = !anchored && job.scheduledTime && String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  if (match) {
    const hours = Number(match[1])
    const minutes = Number(match[2])
    // 13h covers the 25h fall-back gap between local HH:MM instants. Only an
    // interval shorter than that narrows it, so the search still starts after lastRun.
    const windowMs = job.intervalMs > 13 * HOUR ? 13 * HOUR : job.intervalMs / 2
    const nearest = nearestLocalTime(nextDue, hours, minutes, timezone, { windowMs, afterMs: lastRun })
    if (nearest !== undefined) nextDue = nearest
  }

  if (job.weekdaysOnly && Number.isFinite(nextDue)) {
    const { dayOfWeek } = getLocalParts(new Date(nextDue), timezone)
    // Whole local days, so the local HH:MM survives a DST change over the weekend.
    if (dayOfWeek === 0) nextDue = addLocalDays(nextDue, 1, timezone) // Sunday → Monday
    if (dayOfWeek === 6) nextDue = addLocalDays(nextDue, 2, timezone) // Saturday → Monday
  }

  return Number.isFinite(nextDue) ? nextDue : null
}

/**
 * Compute one job's next scheduled timestamp.
 * @param {Object} job
 * @param {string} timezone
 * @returns {number|null} UTC timestamp in milliseconds
 */
export function computeNextJobRun(job, timezone) {
  const from = job.lastRun ? new Date(job.lastRun) : new Date()
  if (job.cronSchedule) return parseRecurrenceToNextRun(job.cronSchedule, from, timezone)?.getTime() ?? null

  // No recurrence to project forward from — the caller renders 'On demand'
  // rather than an arithmetic-on-null date.
  if (!job.cronExpression && isOnDemandJob(job)) return null

  const cronExpr = clockCronExpression(job)
  if (cronExpr) return parseCronToNextRun(cronExpr, from, timezone)?.getTime() ?? null

  return nextIntervalJobFireTime(job, timezone)
}

/**
 * Get the next job that will be due
 * @returns {Promise<Object|null>}
 */
async function getNextDueJob() {
  const enabledJobs = await getEnabledJobs()
  if (enabledJobs.length === 0) return null

  const timezone = await getUserTimezone()
  let earliest = null
  let earliestTime = Infinity

  for (const job of enabledJobs) {
    const nextDue = computeNextJobRun(job, timezone)
    if (nextDue == null) continue

    if (nextDue < earliestTime) {
      earliestTime = nextDue
      const isDue = Date.now() >= nextDue
      earliest = {
        jobId: job.id,
        jobName: job.name,
        nextDueAt: new Date(nextDue).toISOString(),
        scheduledTime: job.scheduledTime || null,
        isDue
      }
    }
  }

  return earliest
}

export { isWeekday, getDueJobs, getNextDueJob }
