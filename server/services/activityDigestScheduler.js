/**
 * Activity Digest Scheduler (#2155)
 *
 * Dedicated scheduler for the daily-log auto-drafts — patterned on
 * brainScheduler.js (time-of-day trigger + missed-day catch-up), NOT
 * taskSchedule.js (that's the CoS agent system).
 *
 * OFF by default: only runs when the user has enabled it in Settings →
 * Daily Log → Activity Digest (`enabled: true`). This is a sanctioned
 * scheduled automation per CLAUDE.md's AI policy — the user opted in and the
 * config UI names the provider/model. Until then it is entirely silent (no
 * provider calls, no journal writes). The `enabled` flag + provider/model are
 * re-read every tick so toggling them takes effect without a restart.
 *
 * Timing model:
 *   - Past days that were missed (server off, feature just enabled) are drafted
 *     immediately on the next tick — their day is already complete.
 *   - TODAY's draft waits until the configured evening `runTime`.
 */

import { getLocalParts, getUserTimezone, parseHHMM, todayInTimezone } from '../lib/timezone.js';
import { getSettings, computeCatchUpDates, runDigestForDate } from './activityDigest.js';

let schedulerInterval = null;
let running = false;
let lastFailure = null;
const CHECK_INTERVAL_MS = 60000; // Check every minute
const FAILURE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown after a failure

// True when the current local time (user's timezone) is at/after the configured
// runTime — the gate for drafting TODAY.
function isPastRunTime(runTime, parts) {
  const runMinutes = parseHHMM(runTime); // minutes-from-midnight, or null
  if (runMinutes === null) return false;
  const nowMinutes = parts.hour * 60 + parts.minute;
  return nowMinutes >= runMinutes;
}

function isInCooldown(now) {
  return lastFailure ? (now - lastFailure) < FAILURE_COOLDOWN_MS : false;
}

/**
 * Decide which dates to draft on this tick (pure given its inputs). Past days
 * (before `today`) run regardless of time-of-day; `today` only runs once the
 * runTime has passed.
 */
export function selectDueDates(settings, today, parts) {
  const due = computeCatchUpDates(settings, today);
  const past = due.filter((d) => d < today);
  const includeToday = due.includes(today) && isPastRunTime(settings.runTime, parts);
  return includeToday ? [...past, today] : past;
}

async function checkSchedule() {
  const settings = await getSettings();
  if (!settings.enabled) return;

  const now = Date.now();
  if (running || isInCooldown(now)) return;

  const timezone = await getUserTimezone();
  const parts = getLocalParts(new Date(now), timezone);
  const today = todayInTimezone(timezone);
  const dueDates = selectDueDates(settings, today, parts);
  if (dueDates.length === 0) return;

  running = true;
  console.log(`🗓️  Activity digest scheduler: drafting ${dueDates.length} day(s): ${dueDates.join(', ')}`);
  try {
    for (const date of dueDates) {
      // recordRun advances the scheduler cursor (lastRunDate) after each day so
      // a crash mid-catch-up resumes instead of re-drafting from the start.
      await runDigestForDate(date, { recordRun: true });
    }
  } catch (err) {
    lastFailure = Date.now();
    console.error(`🗓️  Activity digest scheduler run failed: ${err.message} (retry in 30min)`);
  } finally {
    running = false;
  }
}

/**
 * Start the activity-digest scheduler. Registers the interval unconditionally
 * (like brainScheduler); each tick no-ops when the feature is disabled, so a
 * user enabling it later doesn't need a restart.
 */
export function startActivityDigestScheduler() {
  if (schedulerInterval) {
    console.log('🗓️  Activity digest scheduler: already running');
    return;
  }
  console.log('🗓️  Activity digest scheduler: starting');
  // Initial check — wrapped so an early throw can't crash boot (runs outside
  // the request lifecycle).
  checkSchedule().catch((err) => console.error(`🗓️  Activity digest scheduler initial check failed: ${err.message}`));
  schedulerInterval = setInterval(() => {
    checkSchedule().catch((err) => console.error(`🗓️  Activity digest scheduler check failed: ${err.message}`));
  }, CHECK_INTERVAL_MS);
}

export function stopActivityDigestScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('🗓️  Activity digest scheduler: stopped');
  }
}
