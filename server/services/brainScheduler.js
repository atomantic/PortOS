/**
 * Brain Scheduler Service
 *
 * Manages scheduled jobs for the Brain feature:
 * - Daily digest generation (default midnight)
 * - Weekly review generation (default Sunday midnight)
 *
 * Configured times are wall-clock times in the user's timezone (Settings > General),
 * not the server's TZ=UTC host time.
 *
 * Handles catch-up logic for missed runs (max 1 per type)
 */

import * as storage from './brainStorage.js';
import { runDailyDigest, runWeeklyReview, TOOL_FREE_REQUIRED } from './brain.js';
import { getUserTimezone } from './userTimezone.js';
import { getLocalParts, isLocalDay, todayInTimezone } from '../lib/timezone.js';

let schedulerInterval = null;
let lastCheckTime = null;
const CHECK_INTERVAL_MS = 60000; // Check every minute
const FAILURE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown after failure

// Track failures to prevent retry spam
let lastDailyFailure = null;
let lastWeeklyFailure = null;

// Track in-flight runs to prevent overlapping calls
let dailyRunning = false;
let weeklyRunning = false;

// At most one catch-up per type per boot (a failed catch-up is not retried
// until the next restart; the in-memory cooldown alone resets on restart).
let dailyCatchUpAttempted = false;
let weeklyCatchUpAttempted = false;

// Day name to number mapping
const DAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

/**
 * Parse time string (HH:MM) to hours and minutes
 */
function parseTime(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Check if it's time for daily digest. `parts` is the local wall clock in the
 * user's timezone (see getLocalParts), not the host's, which runs TZ=UTC.
 */
function isDailyDigestTime(settings, parts) {
  const { hours, minutes } = parseTime(settings.dailyDigestTime);
  return parts.hour === hours && parts.minute === minutes;
}

/**
 * Check if it's time for weekly review
 */
function isWeeklyReviewTime(settings, parts) {
  const { hours, minutes } = parseTime(settings.weeklyReviewTime);
  const targetDay = DAY_MAP[settings.weeklyReviewDay];
  return parts.dayOfWeek === targetDay &&
         parts.hour === hours &&
         parts.minute === minutes;
}

/**
 * Check if we're in cooldown after a failure
 */
function isInCooldown(lastFailure, now) {
  if (!lastFailure) return false;
  return (now.getTime() - lastFailure.getTime()) < FAILURE_COOLDOWN_MS;
}

/**
 * Check if daily digest was missed (should have run today but didn't)
 */
function isDailyDigestMissed(settings, now, parts, timezone) {
  // Don't re-trigger while already running
  if (dailyRunning || dailyCatchUpAttempted) return false;
  // Respect cooldown after failure
  if (isInCooldown(lastDailyFailure, now)) return false;

  const { hours, minutes } = parseTime(settings.dailyDigestTime);

  // Only consider catch-up once local wall-clock time is past today's target
  if (parts.hour * 60 + parts.minute <= hours * 60 + minutes) return false;

  // Never run before — catch up now
  if (!settings.lastDailyDigest) return true;

  // Last run was on an earlier local day — catch up
  return !isLocalDay(settings.lastDailyDigest, timezone, todayInTimezone(timezone, now));
}

/**
 * Check if weekly review was missed
 */
function isWeeklyReviewMissed(settings, now) {
  // Don't re-trigger while already running
  if (weeklyRunning || weeklyCatchUpAttempted) return false;
  // Respect cooldown after failure
  if (isInCooldown(lastWeeklyFailure, now)) return false;

  // Never run before — catch up now
  if (!settings.lastWeeklyReview) return true;

  const lastRun = new Date(settings.lastWeeklyReview);
  const daysSinceLastRun = Math.floor((now - lastRun) / (24 * 60 * 60 * 1000));

  // If more than 7 days since last run, we missed one
  return daysSinceLastRun > 7;
}

/**
 * Run the scheduler check
 */
// A provider that cannot run tool-free is a deliberate policy refusal (the user
// must pick another provider), not a defect, so it stays off stderr.
function logRunFailure(err, label, isCatchUp) {
  const refused = err.code === TOOL_FREE_REQUIRED;
  const log = refused ? console.log : console.error;
  log(`🧠 Scheduler: ${refused ? '🚫 ' : ''}${label} ${refused ? 'skipped' : 'failed'}: ${err.message}${isCatchUp ? ' (retry in 30min)' : ''}`);
}

async function checkSchedule() {
  const now = new Date();
  const settings = await storage.loadMeta();
  const timezone = await getUserTimezone();
  const parts = getLocalParts(now, timezone);

  // Avoid running multiple times in the same minute
  const currentMinute = `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}`;
  if (lastCheckTime === currentMinute) return;
  lastCheckTime = currentMinute;

  // Digests and reviews call an AI provider: run only when the user opted in.
  if (settings.scheduledReviewsEnabled !== true) return;

  // Check for daily digest
  if (!dailyRunning && (isDailyDigestTime(settings, parts) || isDailyDigestMissed(settings, now, parts, timezone))) {
    const isCatchUp = !isDailyDigestTime(settings, parts);
    console.log(`🧠 Scheduler: Running ${isCatchUp ? 'missed ' : ''}daily digest${isCatchUp ? ' (catch-up)' : ''}...`);
    dailyRunning = true;
    if (isCatchUp) dailyCatchUpAttempted = true;
    runDailyDigest()
      .catch(err => {
        lastDailyFailure = new Date();
        logRunFailure(err, `${isCatchUp ? 'Catch-up d' : 'D'}aily digest`, isCatchUp);
      })
      .finally(() => { dailyRunning = false; });
  }

  // Check for weekly review
  if (!weeklyRunning && (isWeeklyReviewTime(settings, parts) || isWeeklyReviewMissed(settings, now))) {
    const isCatchUp = !isWeeklyReviewTime(settings, parts);
    console.log(`🧠 Scheduler: Running ${isCatchUp ? 'missed ' : ''}weekly review${isCatchUp ? ' (catch-up)' : ''}...`);
    weeklyRunning = true;
    if (isCatchUp) weeklyCatchUpAttempted = true;
    runWeeklyReview()
      .catch(err => {
        lastWeeklyFailure = new Date();
        logRunFailure(err, `${isCatchUp ? 'Catch-up w' : 'W'}eekly review`, isCatchUp);
      })
      .finally(() => { weeklyRunning = false; });
  }
}

/**
 * Start the Brain scheduler
 */
export function startBrainScheduler() {
  if (schedulerInterval) {
    console.log('🧠 Scheduler: Already running');
    return;
  }

  console.log('🧠 Scheduler: Starting Brain scheduler...');

  // Run initial check
  checkSchedule().catch(err => {
    console.error(`🧠 Scheduler: Initial check failed: ${err.message}`);
  });

  // Set up interval
  schedulerInterval = setInterval(() => {
    checkSchedule().catch(err => {
      console.error(`🧠 Scheduler: Check failed: ${err.message}`);
    });
  }, CHECK_INTERVAL_MS);

  console.log('🧠 Scheduler: Brain scheduler started');
}
