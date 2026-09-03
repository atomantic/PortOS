/** Dependency-free task scheduling constants shared by registry and runtime modules. */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The cadence model is exactly two variants. `perpetual` is an ORTHOGONAL
 * boolean on the same record, not a type — so a task can be on-demand+perpetual
 * (drain whenever unparked) or cron+perpetual (a cron slot INITIATES a drain,
 * and the same expression gates the next attempt once it parks).
 */
export const INTERVAL_TYPES = {
  ON_DEMAND: 'on-demand',
  CRON: 'cron'
};

/**
 * Retired cadence types. Kept for the legacy decoder below (and migration 335)
 * so a schedule written by an older install — or by a peer machine still on the
 * previous release — normalizes instead of falling through as "unknown".
 */
export const LEGACY_INTERVAL_TYPES = {
  ROTATION: 'rotation',
  DAILY: 'daily',
  WEEKLY: 'weekly',
  ONCE: 'once',
  CUSTOM: 'custom',
  PERPETUAL: 'perpetual'
};

/** Conservative daily/weekly replacements for the retired named cadences. */
export const DEFAULT_DAILY_CRON = '0 7 * * *';
export const DEFAULT_WEEKLY_CRON = '0 7 * * 1';

export const WEEK = 7 * DAY_MS;
export const DEFAULT_PERPETUAL_RECHECK_MS = DAY_MS;
export const FAILURE_BACKOFF_BASE_MS = HOUR_MS;
export const FAILURE_BACKOFF_CAP_MS = DAY_MS;
export const FAILURE_PARK_THRESHOLD = 5;
export const ON_DEMAND_ORIGINS = { USER: 'user', REFILL: 'refill' };
export const isRefillRequest = (request) => request?.origin === ON_DEMAND_ORIGINS.REFILL;
const RECONCILE_DRAIN_TASK_TYPES = new Set(['branch-reconcile', 'issue-reconcile']);
export const isReconcileDrainTaskType = (taskType) => RECONCILE_DRAIN_TASK_TYPES.has(taskType);

/** A 5-field cron expression (the only string cadence the scheduler accepts). */
export function isCronExpression(value) {
  return typeof value === 'string' && value.trim().split(/\s+/).length === 5;
}

/**
 * Approximate a numeric interval as a 5-field cron expression. Used by the
 * `custom` → `cron` conversion (migration + runtime normalization) and by the
 * Layered Intelligence per-app cadence picker, which offers sub-daily slots the
 * named cadences never expressed.
 */
export function cronFromIntervalMs(intervalMs) {
  const ms = Number(intervalMs);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_DAILY_CRON;
  if (ms === WEEK) return DEFAULT_WEEKLY_CRON;
  if (ms >= DAY_MS) return DEFAULT_DAILY_CRON;
  if (ms >= HOUR_MS) {
    const hours = Math.round(ms / HOUR_MS);
    if (hours <= 1) return '0 * * * *';
    // Only an even divisor of 24 lays out evenly across a day; anything else
    // would fire twice around midnight, so clamp to the nearest usable step.
    const step = [2, 3, 4, 6, 8, 12].find((h) => h >= hours) || 12;
    return `0 */${step} * * *`;
  }
  const minutes = Math.min(59, Math.max(1, Math.round(ms / MINUTE_MS)));
  return `*/${minutes} * * * *`;
}

/** Every cadence value the system has ever accepted as a type name. */
export const isKnownIntervalType = (value) =>
  Object.values(INTERVAL_TYPES).includes(value) || Object.values(LEGACY_INTERVAL_TYPES).includes(value);

/**
 * Decode ANY historical cadence value into the two-variant model.
 *
 * Accepts a legacy type name, a raw cron expression, or a current type, and
 * returns `{ type, cronExpression, perpetual }` — `cronExpression` is null when
 * the decoded type is on-demand. `intervalMs` feeds the `custom` conversion.
 * Unknown/absent values decode to on-demand (never auto-running), which is the
 * safe default for a cadence we cannot read.
 */
export function decodeIntervalType(value, { intervalMs = null } = {}) {
  if (isCronExpression(value)) {
    return { type: INTERVAL_TYPES.CRON, cronExpression: value.trim(), perpetual: false };
  }
  switch (value) {
    case INTERVAL_TYPES.CRON:
      return { type: INTERVAL_TYPES.CRON, cronExpression: null, perpetual: false };
    case LEGACY_INTERVAL_TYPES.DAILY:
    case LEGACY_INTERVAL_TYPES.ROTATION:
      return { type: INTERVAL_TYPES.CRON, cronExpression: DEFAULT_DAILY_CRON, perpetual: false };
    case LEGACY_INTERVAL_TYPES.WEEKLY:
      return { type: INTERVAL_TYPES.CRON, cronExpression: DEFAULT_WEEKLY_CRON, perpetual: false };
    case LEGACY_INTERVAL_TYPES.CUSTOM:
      return { type: INTERVAL_TYPES.CRON, cronExpression: cronFromIntervalMs(intervalMs), perpetual: false };
    case LEGACY_INTERVAL_TYPES.PERPETUAL:
      return { type: INTERVAL_TYPES.ON_DEMAND, cronExpression: null, perpetual: true };
    default:
      // 'once', 'on-demand', and anything unrecognized.
      return { type: INTERVAL_TYPES.ON_DEMAND, cronExpression: null, perpetual: false };
  }
}

/**
 * Normalize a persisted task config IN PLACE onto the two-variant model.
 * Returns true when something changed, so callers (loadSchedule, the migration)
 * can decide whether the normalized shape needs persisting.
 *
 * A `perpetual: true` already on the record is preserved — the flag is
 * orthogonal, so it survives whatever the type decodes to.
 */
export function normalizeIntervalConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const decoded = decodeIntervalType(config.type, { intervalMs: config.intervalMs });
  const perpetual = config.perpetual === true || decoded.perpetual;
  // Keep an already-valid cron expression; only supply one when the decode had
  // to invent the cadence (a retired named type) or the stored one is unusable.
  const cronExpression = decoded.type === INTERVAL_TYPES.CRON
    ? (isCronExpression(config.cronExpression) ? config.cronExpression.trim() : decoded.cronExpression)
    : null;

  let changed = false;
  if (config.type !== decoded.type) { config.type = decoded.type; changed = true; }
  if (config.perpetual !== perpetual) { config.perpetual = perpetual; changed = true; }
  if ((config.cronExpression ?? null) !== (cronExpression ?? null)) {
    config.cronExpression = cronExpression;
    changed = true;
  }
  return changed;
}
