/**
 * Brain Scheduler Service
 *
 * Manages scheduled jobs for the Brain feature:
 * - Daily digest generation (default 9:00 AM)
 * - Weekly review generation (default Sunday 4:00 PM)
 *
 * Handles catch-up logic for missed runs (max 1 per type)
 */

import * as storage from './brainStorage.js';
import { runDailyDigest, runWeeklyReview } from './brain.js';

let schedulerInterval = null;
let lastCheckTime = null;
const CHECK_INTERVAL_MS = 60000; // Check every minute
const FAILURE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown after failure

// Track failures to prevent retry spam
let lastDailyFailure = null;
let lastWeeklyFailure = null;

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
 * Check if it's time for daily digest
 */
function isDailyDigestTime(settings, now) {
  const { hours, minutes } = parseTime(settings.dailyDigestTime);
  return now.getHours() === hours && now.getMinutes() === minutes;
}

/**
 * Check if it's time for weekly review
 */
function isWeeklyReviewTime(settings, now) {
  const { hours, minutes } = parseTime(settings.weeklyReviewTime);
  const targetDay = DAY_MAP[settings.weeklyReviewDay];
  return now.getDay() === targetDay &&
         now.getHours() === hours &&
         now.getMinutes() === minutes;
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
function isDailyDigestMissed(settings, now) {
  // Respect cooldown after failure
  if (isInCooldown(lastDailyFailure, now)) return false;

  const { hours, minutes } = parseTime(settings.dailyDigestTime);

  // Create target time for today
  const todayTarget = new Date(now);
  todayTarget.setHours(hours, minutes, 0, 0);

  // Only consider catch-up if we're past today's target time
  if (now <= todayTarget) return false;

  // Never run before — catch up now
  if (!settings.lastDailyDigest) return true;

  // Last run was before today — catch up
  const lastRun = new Date(settings.lastDailyDigest);
  return lastRun.toDateString() !== now.toDateString();
}

/**
 * Check if weekly review was missed
 */
function isWeeklyReviewMissed(settings, now) {
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
async function checkSchedule() {
  const now = new Date();
  const settings = await storage.loadMeta();

  // Avoid running multiple times in the same minute
  const currentMinute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (lastCheckTime === currentMinute) return;
  lastCheckTime = currentMinute;

  // Check for daily digest
  if (isDailyDigestTime(settings, now)) {
    console.log('🧠 Scheduler: Running daily digest...');
    runDailyDigest().catch(err => {
      lastDailyFailure = new Date();
      console.error(`🧠 Scheduler: Daily digest failed: ${err.message}`);
    });
  } else if (isDailyDigestMissed(settings, now)) {
    console.log('🧠 Scheduler: Running missed daily digest (catch-up)...');
    runDailyDigest().catch(err => {
      lastDailyFailure = new Date();
      console.error(`🧠 Scheduler: Catch-up daily digest failed: ${err.message} (retry in 30min)`);
    });
  }

  // Check for weekly review
  if (isWeeklyReviewTime(settings, now)) {
    console.log('🧠 Scheduler: Running weekly review...');
    runWeeklyReview().catch(err => {
      lastWeeklyFailure = new Date();
      console.error(`🧠 Scheduler: Weekly review failed: ${err.message}`);
    });
  } else if (isWeeklyReviewMissed(settings, now)) {
    console.log('🧠 Scheduler: Running missed weekly review (catch-up)...');
    runWeeklyReview().catch(err => {
      lastWeeklyFailure = new Date();
      console.error(`🧠 Scheduler: Catch-up weekly review failed: ${err.message} (retry in 30min)`);
    });
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

/**
 * Stop the Brain scheduler
 */
export function stopBrainScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('🧠 Scheduler: Brain scheduler stopped');
  }
}

/**
 * Get scheduler status
 */
export async function getSchedulerStatus() {
  const settings = await storage.loadMeta();

  return {
    running: schedulerInterval !== null,
    checkIntervalMs: CHECK_INTERVAL_MS,
    dailyDigest: {
      scheduledTime: settings.dailyDigestTime,
      lastRun: settings.lastDailyDigest
    },
    weeklyReview: {
      scheduledDay: settings.weeklyReviewDay,
      scheduledTime: settings.weeklyReviewTime,
      lastRun: settings.lastWeeklyReview
    }
  };
}

/**
 * Manually trigger the next scheduled digest (for testing)
 */
export async function triggerNextDigest() {
  console.log('🧠 Scheduler: Manually triggering daily digest...');
  return runDailyDigest();
}

/**
 * Manually trigger the next scheduled review (for testing)
 */
export async function triggerNextReview() {
  console.log('🧠 Scheduler: Manually triggering weekly review...');
  return runWeeklyReview();
}
