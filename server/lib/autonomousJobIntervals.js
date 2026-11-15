/**
 * Autonomous-job cadence vocabulary (pure).
 *
 * The interval-mode vocabulary for CoS autonomous jobs — the picker rows, the
 * cadence → milliseconds resolver, and the "this job has no clock" predicate.
 * Lives in lib rather than `services/autonomousJobs/constants.js` so the Zod
 * boundary (`lib/cosValidation.js`) can validate against the same list without
 * a lib → services import; the services constants module re-exports it, so
 * existing deep imports keep working.
 *
 * NOTE: this is a SEPARATE vocabulary from the scheduled-CoS-task
 * `INTERVAL_TYPES = { ON_DEMAND, CRON }` in `services/taskScheduleConstants.js`.
 * Nothing converts between the two.
 */

// Time units are declared locally rather than imported from `fileUtils.js`.
// This module is pulled in by `cosValidation.js` — i.e. by every route suite —
// and dozens of those suites mock fileUtils with an exhaustive factory, so an
// import here would make a missing `DAY`/`HOUR` on their mock a hard failure.
// `autonomousJobIntervals.test.js` asserts these still equal fileUtils'.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const WEEK = 7 * DAY;

/**
 * Cadence for a job that never fires on a clock — it runs only when a human (or
 * another feature) triggers it via `POST /api/cos/jobs/:id/trigger`. Distinct
 * from `enabled: false`, which also makes a job un-runnable.
 */
export const ON_DEMAND_INTERVAL = 'on-demand';

/**
 * Available interval options for UI pickers. `ms: null` marks a cadence with no
 * recurrence. `JOB_INTERVAL_OPTIONS` in `client/src/utils/cronHelpers.js`
 * imports this registry and projects its value/label fields for both pickers.
 */
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

/**
 * Every cadence string a persisted job may carry. `custom` is deliberately not
 * an INTERVAL_OPTIONS row (it has no fixed duration to label — the caller
 * supplies `intervalMs`), but it is a legal stored value.
 */
export const JOB_INTERVAL_VALUES = [...INTERVAL_OPTIONS.map(o => o.value), 'custom'];

const INTERVAL_MS_BY_VALUE = new Map(INTERVAL_OPTIONS.map(o => [o.value, o.ms]));

/**
 * Resolve a cadence string to milliseconds.
 *
 * Returns `null` — an explicit no-interval sentinel, never `DAY` and never
 * `NaN` — for the on-demand cadence and for any value outside the vocabulary.
 * The old `default: return DAY` fall-through silently rescheduled a typo'd
 * cadence as a daily job; every caller now handles the sentinel instead.
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
 * True when a job has nothing to fire on — the on-demand cadence, or a stored
 * job whose cadence resolved to the no-interval sentinel. Cron-mode jobs are
 * never on-demand: their schedule lives in `cronExpression`/`cronSchedule`, and
 * a job switched to cron mode keeps whatever `interval` it last had.
 *
 * @param {Object} job
 * @returns {boolean}
 */
export function isOnDemandJob(job) {
  if (job?.cronExpression || job?.cronSchedule) return false;
  if (job?.interval === ON_DEMAND_INTERVAL) return true;
  return !Number.isFinite(job?.intervalMs);
}
