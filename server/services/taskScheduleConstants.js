/** Dependency-free task scheduling constants shared by registry and runtime modules. */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const INTERVAL_TYPES = {
  ROTATION: 'rotation',
  DAILY: 'daily',
  WEEKLY: 'weekly',
  ONCE: 'once',
  ON_DEMAND: 'on-demand',
  CUSTOM: 'custom',
  CRON: 'cron',
  PERPETUAL: 'perpetual'
};

export const WEEK = 7 * DAY_MS;
export const DEFAULT_PERPETUAL_RECHECK_MS = DAY_MS;
export const FAILURE_BACKOFF_BASE_MS = HOUR_MS;
export const FAILURE_BACKOFF_CAP_MS = DAY_MS;
export const FAILURE_PARK_THRESHOLD = 5;
export const ON_DEMAND_ORIGINS = { USER: 'user', REFILL: 'refill' };
export const isRefillRequest = (request) => request?.origin === ON_DEMAND_ORIGINS.REFILL;
const RECONCILE_DRAIN_TASK_TYPES = new Set(['branch-reconcile', 'issue-reconcile']);
export const isReconcileDrainTaskType = (taskType) => RECONCILE_DRAIN_TASK_TYPES.has(taskType);
