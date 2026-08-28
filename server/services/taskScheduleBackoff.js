/** Consecutive-failure backoff and auto-park state for scheduled task types. */

import { cosEvents, emitLog } from './cosEvents.js';
import { loadSchedule, updateSchedule } from './taskScheduleStore.js';
import {
  FAILURE_BACKOFF_BASE_MS,
  FAILURE_BACKOFF_CAP_MS,
  FAILURE_PARK_THRESHOLD
} from './taskScheduleConstants.js';

export { FAILURE_BACKOFF_BASE_MS, FAILURE_BACKOFF_CAP_MS, FAILURE_PARK_THRESHOLD };

const FAILURE_LEDGER_FIELDS = [
  'consecutiveFailures',
  'lastFailureAt',
  'lastErrorCategory',
  'failureParkedAt',
  'failureParkReason'
];

export function computeFailureBackoffMs(consecutiveFailures, baseMs = FAILURE_BACKOFF_BASE_MS, capMs = FAILURE_BACKOFF_CAP_MS) {
  const n = Number(consecutiveFailures) || 0;
  if (n <= 0) return 0;
  return Math.min(baseMs * Math.pow(2, n), capMs);
}
const executionKey = (taskType) => taskType.startsWith('task:') ? taskType : `task:${taskType}`;

const ensureExecutionRecord = (schedule, taskType, appId) => {
  const key = executionKey(taskType);
  if (!schedule.executions[key]) schedule.executions[key] = { lastRun: null, count: 0, perApp: {} };
  const top = schedule.executions[key];
  if (!appId) return top;
  if (!top.perApp) top.perApp = {};
  if (!top.perApp[appId]) top.perApp[appId] = { lastRun: null, count: 0 };
  return top.perApp[appId];
};

const resolveExecutionRecord = (schedule, taskType, appId) => {
  const top = schedule.executions[executionKey(taskType)];
  return top ? ((appId ? top.perApp?.[appId] : top) || null) : null;
};

// ============================================================
// Type-level consecutive-failure ledger (#2616)
// ============================================================

/** Dedup / notification key for a type+app failure park. */
function failureParkKeyFor(taskType, appId) {
  return appId ? `${taskType}:${appId}` : taskType;
}

/** Delete every failure-ledger field from a record. Returns true if any changed. */
export function clearFailureLedgerFields(record) {
  if (!record) return false;
  let changed = false;
  for (const field of FAILURE_LEDGER_FIELDS) {
    if (record[field] !== undefined) { delete record[field]; changed = true; }
  }
  return changed;
}

/**
 * Remove any lingering auto-park notification for a now-unparked type+app so the
 * bell stops showing a stale "parked" warning AND a later re-park can re-notify
 * (the `exists` dedup in notifyTaskTypeFailurePark keys on this same field, and
 * scans read notifications too). Best-effort — lazy-imported, never throws out.
 */
export async function clearTaskTypeFailureParkNotification(taskType, appId) {
  const { removeByMetadata } = await import('./notifications.js');
  await removeByMetadata('failureParkKey', failureParkKeyFor(taskType, appId)).catch(() => {});
}

/**
 * Surface a user-facing notification when a task type auto-parks. Lazy-imports
 * the notifications service so taskSchedule has no static dependency on it (and
 * so the failure path stays free of that I/O until a park actually fires).
 * Deduped per type+app so a re-park after a manual retry doesn't spam the bell.
 */
async function notifyTaskTypeFailurePark(taskType, appId, record) {
  const { addNotification, exists, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('./notifications.js');
  const dedupeKey = failureParkKeyFor(taskType, appId);
  if (await exists(NOTIFICATION_TYPES.AGENT_WARNING, 'failureParkKey', dedupeKey)) return;
  const scope = appId ? `app ${appId}` : 'global';
  const category = record.failureParkReason || record.lastErrorCategory || 'unknown';
  await addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    title: `Scheduled task "${taskType}" auto-parked after ${record.consecutiveFailures} failures`,
    description: `The "${taskType}" scheduled task (${scope}) failed ${record.consecutiveFailures} times in a row (last error: ${category}). It is parked and will not re-queue until you retry it or change its config.`,
    priority: PRIORITY_LEVELS.HIGH,
    link: '/cos/schedule',
    metadata: {
      taskType,
      appId: appId || null,
      failureParkKey: dedupeKey,
      consecutiveFailures: record.consecutiveFailures,
      lastErrorCategory: category
    }
  });
}

/**
 * Record a task-type FAILURE into the per-type ledger (per app + global).
 * Increments `consecutiveFailures`, stamps `lastFailureAt`/`lastErrorCategory`,
 * and auto-parks (+notifies) once the threshold is crossed. The auto-park is
 * indefinite — cleared only by a success, a manual retry, or a config change.
 */
export async function recordTaskTypeFailure(taskType, appId = null, { errorCategory = null } = {}) {
  const { record, justParked } = await updateSchedule(async (schedule) => {
    const record = ensureExecutionRecord(schedule, taskType, appId);
    record.consecutiveFailures = (Number(record.consecutiveFailures) || 0) + 1;
    record.lastFailureAt = new Date().toISOString();
    if (errorCategory) record.lastErrorCategory = errorCategory;

    let justParked = false;
    if (record.consecutiveFailures >= FAILURE_PARK_THRESHOLD && !record.failureParkedAt) {
      record.failureParkedAt = new Date().toISOString();
      record.failureParkReason = errorCategory || record.lastErrorCategory || 'unknown';
      justParked = true;
    }

    return { result: { record, justParked }, changed: true };
  });
  emitLog(
    justParked ? 'warn' : 'info',
    `Task type ${taskType}${appId ? ` (app ${appId})` : ''} failure #${record.consecutiveFailures}${justParked ? ' — AUTO-PARKED' : ''} (${errorCategory || 'unknown'})`,
    { taskType, appId, consecutiveFailures: record.consecutiveFailures, parked: justParked },
    '📅 TaskSchedule'
  );

  if (justParked) {
    cosEvents.emit('schedule:failure-parked', { taskType, appId, consecutiveFailures: record.consecutiveFailures, reason: record.failureParkReason });
    await notifyTaskTypeFailurePark(taskType, appId, record).catch((err) => {
      emitLog('warn', `Failure-park notification failed for ${taskType}: ${err.message}`, { taskType, appId }, '📅 TaskSchedule');
    });
  }
  return record;
}

/**
 * Record a task-type SUCCESS: reset the consecutive-failure ledger (and any
 * auto-park) for this type. No-op (no write) when the ledger is already clean.
 */
export async function recordTaskTypeSuccess(taskType, appId = null) {
  const { didChange, wasParked } = await updateSchedule(async (schedule) => {
    const record = resolveExecutionRecord(schedule, taskType, appId);
    const wasParked = !!record?.failureParkedAt;
    if (!clearFailureLedgerFields(record)) {
      return { result: { didChange: false, wasParked: false }, changed: false };
    }
    return { result: { didChange: true, wasParked }, changed: true };
  });
  if (!didChange) return false;
  emitLog('info', `Task type ${taskType}${appId ? ` (app ${appId})` : ''} succeeded — failure ledger reset`, { taskType, appId }, '📅 TaskSchedule');
  if (wasParked) await clearTaskTypeFailureParkNotification(taskType, appId);
  return true;
}

/**
 * Clear a task type's failure ledger + auto-park for a manual retry (unpark),
 * scoped to exactly the record being re-run: the per-app record when `appId` is
 * set (a per-app "Run now"), or the global (appId-less) record when null (a
 * global self-improvement "Run now"). Does NOT touch other apps' independent
 * ledgers — a global retrigger must not silently unpark an app whose failure
 * cause was never addressed. (The config-change unpark in updateTaskInterval,
 * which DOES reset every scope of the type, has its own inline clear.) Returns
 * true if anything was cleared.
 */
export async function clearTaskTypeFailurePark(taskType, appId = null) {
  const { cleared, wasParked } = await updateSchedule(async (schedule) => {
    const top = schedule.executions[executionKey(taskType)];
    if (!top) return { result: { cleared: false, wasParked: false }, changed: false };
    const record = appId ? top.perApp?.[appId] : top;
    const wasParked = !!record?.failureParkedAt;
    if (!clearFailureLedgerFields(record)) {
      return { result: { cleared: false, wasParked: false }, changed: false };
    }
    return { result: { cleared: true, wasParked }, changed: true };
  });
  if (!cleared) return false;
  // Prune the stale park notification (if any) so the bell clears and a later
  // re-park can re-notify.
  if (wasParked) await clearTaskTypeFailureParkNotification(taskType, appId);
  return true;
}
