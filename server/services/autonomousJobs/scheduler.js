/**
 * Autonomous Jobs — scheduling.
 *
 * Computes which jobs are due to run now (`getDueJobs`), the single next-due job
 * (`getNextDueJob`), and the interval-string ⇄ milliseconds mapping used when
 * creating/updating jobs and rendering the UI's interval picker.
 */

import { getUserTimezone, getLocalParts, nextLocalTime } from '../../lib/timezone.js'
import { parseCronToNextRun } from '../eventScheduler.js'
import { DAY } from './constants.js'
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
    if (job.cronExpression) {
      const from = job.lastRun ? new Date(job.lastRun) : new Date(now)
      const next = parseCronToNextRun(job.cronExpression, from, timezone)
      if (!next || next.getTime() > now) continue

      due.push({
        ...job,
        reason: job.lastRun ? 'cron-due' : 'never-run',
        overdueBy: now - next.getTime()
      })
      continue
    }

    // Interval-mode jobs
    const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0
    const timeSinceLastRun = now - lastRun

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

      // If job is weekdaysOnly, skip weekends
      if (job.weekdaysOnly && !isWeekday(timezone)) continue

      due.push({
        ...job,
        reason: job.lastRun ? `${job.interval}-due` : 'never-run',
        overdueBy: timeSinceLastRun - job.intervalMs
      })
    }
  }

  // Sort by overdue time (most overdue first)
  due.sort((a, b) => b.overdueBy - a.overdueBy)

  return due
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
    let nextDue

    if (job.cronExpression) {
      // Cron-mode: derive next due from cron expression
      const from = job.lastRun ? new Date(job.lastRun) : new Date()
      const next = parseCronToNextRun(job.cronExpression, from, timezone)
      if (!next) continue
      nextDue = next.getTime()
    } else {
      // Interval-mode
      const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0
      nextDue = lastRun + job.intervalMs

      // If job has scheduledTime, find next occurrence in user's timezone
      if (job.scheduledTime) {
        const match = String(job.scheduledTime).match(/^([01]\d|2[0-3]):([0-5]\d)$/)
        if (match) {
          const candidate = nextLocalTime(nextDue, Number(match[1]), Number(match[2]), timezone)
          if (candidate > nextDue) nextDue = candidate
        }
      }
    }

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
