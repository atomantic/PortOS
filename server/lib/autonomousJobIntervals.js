/**
 * Autonomous-job cadence vocabulary (pure): picker rows, cadence → milliseconds resolver,
 * and the "this job has no clock" predicate.
 *
 * Lives in lib so the Zod boundary (`lib/cos/cosValidation.js`) can validate against it without
 * a lib → services import; `services/autonomousJobs/constants.js` re-exports it. SEPARATE
 * from the scheduled-task `INTERVAL_TYPES` in `services/taskScheduleConstants.js`; nothing
 * converts between the two.
 */

// Local, not imported from `fileUtils.js`: many route suites mock fileUtils exhaustively.
// The test asserts these equal fileUtils'.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const WEEK = 7 * DAY;

/** Cadence for a job that fires only via `POST /api/cos/jobs/:id/trigger`; distinct from `enabled: false`. */
export const ON_DEMAND_INTERVAL = 'on-demand';

/** Interval options for UI pickers. `ms: null` marks a cadence with no recurrence. */
export const INTERVAL_OPTIONS = [
  { value: 'hourly', label: 'Every Hour', ms: HOUR },
  { value: 'every-2-hours', label: 'Every 2 Hours', ms: 2 * HOUR },
  { value: 'every-4-hours', label: 'Every 4 Hours', ms: 4 * HOUR },
  { value: 'every-8-hours', label: 'Every 8 Hours', ms: 8 * HOUR },
  { value: 'daily', label: 'Daily', ms: DAY },
  { value: 'weekly', label: 'Weekly', ms: WEEK },
  { value: 'biweekly', label: 'Every 2 Weeks', ms: 2 * WEEK },
  { value: 'monthly', label: 'Monthly', ms: 30 * DAY },
  { value: ON_DEMAND_INTERVAL, label: 'On Demand', ms: null }
];

/** Every stored cadence; `custom` is not a picker row (the caller supplies `intervalMs`) but is legal. */
export const JOB_INTERVAL_VALUES = [...INTERVAL_OPTIONS.map(o => o.value), 'custom'];

const INTERVAL_MS_BY_VALUE = new Map(INTERVAL_OPTIONS.map(o => [o.value, o.ms]));

/**
 * Resolve a cadence string to milliseconds. Returns `null` (an explicit no-interval
 * sentinel, never `DAY` or `NaN`) for on-demand and for any unknown value, so a typo'd
 * cadence is never silently rescheduled.
 *
 * @param {string} interval
 * @param {number} [customMs] duration for the `custom` cadence
 * @returns {number|null} milliseconds, or null when the job has no recurrence
 */
export function resolveIntervalMs(interval, customMs) {
  if (interval === 'custom') return customMs || DAY;
  if (INTERVAL_MS_BY_VALUE.has(interval)) return INTERVAL_MS_BY_VALUE.get(interval);
  if (interval !== ON_DEMAND_INTERVAL) {
    console.warn(`⚠️ Unknown autonomous-job cadence '${interval}' — treating it as on-demand (no schedule)`);
  }
  return null;
}

/**
 * True when a job has nothing to fire on. Cron-mode jobs are never on-demand: their
 * schedule lives in `cronExpression`/`cronSchedule`, and they keep whatever `interval` they had.
 *
 * @param {Object} job
 * @returns {boolean}
 */
export function isOnDemandJob(job) {
  if (job?.cronExpression || job?.cronSchedule) return false;
  if (job?.interval === ON_DEMAND_INTERVAL) return true;
  return !Number.isFinite(job?.intervalMs);
}
