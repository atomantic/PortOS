/** Schedule eligibility, dependency gates and due-task selection. */

import { TASK_READINESS_REASON } from '../lib/taskReadinessReasons.js';
import { safeDate } from '../lib/fileUtils.js';
import {
  getAppById,
  isTaskTypeEnabledForApp,
  getAppTaskTypeInterval,
  getAppTaskTypeIntervalMs
} from './apps.js';
import { getLocalParts } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';
import { parseCronToNextRun } from './eventScheduler.js';
import { INTERVAL_TYPES, isCronExpression, resolveAppOverrideCadence } from './taskScheduleConstants.js';
import { TASK_INPUT_PATHS, requiresInstallWideTarget } from './taskScheduleRegistry.js';
import { loadSchedule, resolveExecutionRecord } from './taskScheduleStore.js';
import { inputsUnchangedSince } from './taskInputGate.js';
import { isInstanceFeatureEnabled } from './instanceFeatures.js';
import { computeFailureBackoffMs } from './taskScheduleBackoff.js';
import { parkedUntilMs } from './taskSchedulePerpetual.js';

export const createFeatureGate = () => {
  const enabledByFeature = new Map();
  return async (interval) => {
    const featureId = interval?.feature;
    if (!featureId) return true;
    if (!enabledByFeature.has(featureId)) {
      enabledByFeature.set(featureId, isInstanceFeatureEnabled(featureId));
    }
    return enabledByFeature.get(featureId);
  };
};

// True when the task declares input paths and none changed since its last clean run.
export async function inputsUnchangedForTask(taskType, appId, schedule) {
  const inputPaths = TASK_INPUT_PATHS[taskType];
  const lastCleanHead = inputPaths && appId ? resolveExecutionRecord(schedule, taskType, appId)?.lastCleanHead : null;
  if (!lastCleanHead) return false;
  const app = await getAppById(appId).catch(() => null);
  return inputsUnchangedSince({ repoPath: app?.repoPath, lastCleanHead, inputPaths });
}

/**
 * Check if all runAfter dependencies have completed since this task's last run.
 * Returns { satisfied, pending } where pending lists unfinished dependency task types.
 *
 * Dependencies that are disabled — either globally (missing from the schedule or
 * `enabled: false`) — or use an on-demand interval are skipped, since they will
 * not run automatically and would otherwise block the dependent task indefinitely.
 * A scheduled per-app override keeps its dependency gate active.
 */
async function checkRunAfterDeps(schedule, taskType, appId = null, featureEnabled = createFeatureGate()) {
  const interval = schedule.tasks[taskType];
  const deps = interval?.runAfter;
  if (!deps || deps.length === 0) return { satisfied: true, pending: [] };

  const key = `task:${taskType}`;
  const execution = schedule.executions[key] || { lastRun: null, perApp: {} };
  const ownLastRun = safeDate(appId ? execution.perApp[appId]?.lastRun : execution.lastRun);

  const pending = [];
  for (const dep of deps) {
    const depConfig = schedule.tasks[dep];
    if (!depConfig || !depConfig.enabled) continue;
    if (!(await featureEnabled(depConfig))) continue;
    if (appId && !(await isTaskTypeEnabledForApp(appId, dep))) continue;
    // Same resolver the readiness check uses, so a dependency an app pins to
    // its own cadence is judged on THAT cadence — an app-level cron on a
    // globally on-demand dep is a real gate, not a skippable manual task.
    const depInterval = appId ? await getAppTaskTypeInterval(appId, dep) : null;
    if (resolveAppOverrideCadence({ interval: depInterval }, depConfig).type === INTERVAL_TYPES.ON_DEMAND) continue;

    const depKey = `task:${dep}`;
    const depExec = schedule.executions[depKey] || { lastRun: null, perApp: {} };
    const depLastRun = safeDate(appId ? depExec.perApp[appId]?.lastRun : depExec.lastRun);

    // Dependency must have run after this task's last run (i.e., within the current cycle)
    if (depLastRun <= ownLastRun) {
      pending.push(dep);
    }
  }

  return { satisfied: pending.length === 0, pending };
}

// `now` pins the clock for one scheduler tick so every app is judged against the
// same instant, however long earlier apps took to prepare (#11755).
async function evaluateTaskReadiness(taskType, appId, { featureEnabled, continuingPerpetualDrain, schedule: injected = null, now = Date.now() }) {
  if (appId && requiresInstallWideTarget(taskType)) {
    return { shouldRun: false, reason: TASK_READINESS_REASON.REQUIRES_INSTALL_WIDE_TARGET };
  }
  // `loadSchedule` is an uncached disk read plus a merge over every shipped
  // task default, and a caller building ONE status payload asks this question
  // dozens of times against the snapshot it already holds. Reading it again per
  // question would be both slower and less coherent — a mid-loop write would
  // make the payload describe two different schedules.
  const schedule = injected || await loadSchedule();
  const interval = schedule.tasks[taskType];

  if (!interval || !interval.enabled) {
    return { shouldRun: false, reason: TASK_READINESS_REASON.DISABLED };
  }
  if (!(await featureEnabled(interval))) {
    return { shouldRun: false, reason: TASK_READINESS_REASON.FEATURE_DISABLED, feature: interval.feature };
  }

  // The maintainer role owns recurring cadence; this card is its manual door.
  if (taskType === 'development-watchdog') return { shouldRun: false, reason: TASK_READINESS_REASON.ON_DEMAND_ONLY };

  // Fetch timezone once for reuse across weekday and cron checks
  const timezone = await getUserTimezone();

  // Weekday-only tasks skip weekends (timezone-aware)
  if (interval.weekdaysOnly) {
    const { dayOfWeek } = getLocalParts(new Date(now), timezone);
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return { shouldRun: false, reason: TASK_READINESS_REASON.WEEKDAY_ONLY };
    }
  }

  if (appId) {
    const enabledForApp = await isTaskTypeEnabledForApp(appId, taskType);
    if (!enabledForApp) {
      return { shouldRun: false, reason: TASK_READINESS_REASON.DISABLED_FOR_APP };
    }
  }

  // Determine the effective cadence: the app's own override outranks the task's
  // global one. `resolveAppOverrideCadence` owns the decode (a raw cron
  // expression, a retired named cadence written by an older install, or the
  // numeric `intervalMs` handler-backed tasks like layered-intelligence use for
  // sub-daily slots), so every surface that has to PREDICT an app's cadence —
  // getScheduleStatus, the Schedule Timeline — resolves it exactly the way this
  // dispatch gate does.
  const [appInterval, appIntervalMs] = appId
    ? await Promise.all([getAppTaskTypeInterval(appId, taskType), getAppTaskTypeIntervalMs(appId, taskType)])
    : [null, null];
  const appCadence = appId
    ? resolveAppOverrideCadence({ interval: appInterval, intervalMs: appIntervalMs }, interval)
    : null;
  const effectiveType = appCadence ? appCadence.type : interval.type;
  const effectiveCron = appCadence ? appCadence.cronExpression : (interval.cronExpression || null);
  // `perpetual` is a task-level global property — per-app rows override the
  // cadence only (see the issue's Out of Scope), so the global flag always wins.
  const isPerpetual = interval.perpetual === true;

  const key = `task:${taskType}`;
  const execution = schedule.executions[key] || { lastRun: null, count: 0, perApp: {} };

  // For per-app tracking, use app-specific execution data
  const appExecution = appId
    ? (execution.perApp[appId] || { lastRun: null, count: 0 })
    : execution;

  // Type-level failure auto-park (#2616): a type whose instances failed
  // FAILURE_PARK_THRESHOLD times in a row is parked for every cadence type
  // until a manual retry or config change clears the ledger. Checked before
  // the cadence switch so it short-circuits every type.
  if (appExecution.failureParkedAt) {
    return {
      shouldRun: false,
      reason: TASK_READINESS_REASON.FAILURE_PARKED,
      failureParkedAt: appExecution.failureParkedAt,
      failureParkReason: appExecution.failureParkReason || null,
      consecutiveFailures: Number(appExecution.consecutiveFailures) || 0
    };
  }

  const lastRun = appExecution.lastRun ? new Date(appExecution.lastRun).getTime() : 0;

  let result;

  // A perpetual task's park record is the drain's brake: the work-detector at
  // DISPATCH time writes `parkedUntil` when nothing is actionable, and this only
  // READS it (so readiness checks never do network I/O). Shared by both cadence
  // variants — an automatic on-demand drain is due whenever it is not parked; a
  // cron+perpetual task additionally needs a cron slot to initiate a drain.
  const perpetualParkResult = () => {
    const parkUntil = parkedUntilMs(appExecution);
    if (parkUntil && now < parkUntil) {
      return {
        shouldRun: false,
        reason: TASK_READINESS_REASON.PERPETUAL_PARKED,
        nextRunAt: new Date(parkUntil).toISOString(),
        parkReason: appExecution.parkReason || null,
        parkActionableCount: appExecution.parkActionableCount ?? null
      };
    }
    return parkUntil ? { shouldRun: true, reason: TASK_READINESS_REASON.PERPETUAL_RECHECK } : null;
  };

  switch (effectiveType) {
    case INTERVAL_TYPES.ON_DEMAND:
      // Drain-until-done when perpetual; otherwise a manual trigger is the only
      // way this ever runs.
      // Missing autoStart preserves existing automatic drains across upgrades.
      // Manual drains only refill after their own successful completion.
      result = isPerpetual && (interval.autoStart !== false || continuingPerpetualDrain)
        ? (perpetualParkResult() || { shouldRun: true, reason: TASK_READINESS_REASON.PERPETUAL_DRAIN })
        : { shouldRun: false, reason: TASK_READINESS_REASON.ON_DEMAND_ONLY };
      break;

    case INTERVAL_TYPES.CRON: {
      // A parked perpetual drain is gated by its park, not by the cron slot —
      // and once the park elapses it is due immediately (computePerpetualRecheckAt
      // already derived that instant from this very expression).
      if (isPerpetual) {
        const parked = perpetualParkResult();
        if (parked) { result = parked; break; }
        if (continuingPerpetualDrain) {
          result = { shouldRun: true, reason: TASK_READINESS_REASON.PERPETUAL_DRAIN };
          break;
        }
        // Unparked: the cron evaluation below decides whether to INITIATE a
        // drain. Once one is running, the completion-refill lane keeps it going
        // back-to-back regardless of subsequent ticks.
      }
      // Cron expression: per-app override (stored as the interval string) or global config
      const cronExpr = effectiveCron;
      if (!isCronExpression(cronExpr)) {
        result = { shouldRun: false, reason: TASK_READINESS_REASON.INVALID_CRON, cronExpression: cronExpr };
        break;
      }

      // Only the current scheduled minute is eligible. Replaying from lastRun
      // makes a schedule edit retroactively create missed work and lets hourly
      // improvement checks launch tasks before their next configured occurrence.
      // Keep lastRun as a lower bound to prevent a second run in the same minute.
      const minuteStart = Math.floor(now / 60_000) * 60_000;
      const fromDate = new Date(Math.max(lastRun || 0, minuteStart - 1));
      const nextRun = parseCronToNextRun(cronExpr, fromDate, timezone);
      if (!nextRun) {
        result = { shouldRun: false, reason: TASK_READINESS_REASON.INVALID_CRON, cronExpression: cronExpr };
        break;
      }
      if (now >= nextRun.getTime()) {
        result = { shouldRun: true, reason: TASK_READINESS_REASON.CRON_DUE, cronExpression: cronExpr, nextRunAt: nextRun.toISOString() };
      } else {
        result = { shouldRun: false, reason: TASK_READINESS_REASON.CRON_COOLDOWN, cronExpression: cronExpr,
          nextRunAt: nextRun.toISOString() };
      }
      break;
    }

    default:
      // Unreachable once normalized — an unreadable cadence must never auto-run.
      result = { shouldRun: false, reason: TASK_READINESS_REASON.ON_DEMAND_ONLY };
  }

  // Escalating failure backoff (#2616): a type with recent consecutive failures
  // (still below the park threshold) slows down — 2^n × base, capped — instead
  // of re-queuing every tick. Applies to every cadence type. Gated on
  // `lastFailureAt` so a never-failed type is unaffected; a success resets the
  // ledger via recordTaskTypeSuccess so the backoff lifts immediately.
  if (result.shouldRun) {
    const consecutiveFailures = Number(appExecution.consecutiveFailures) || 0;
    const lastFailure = appExecution.lastFailureAt ? new Date(appExecution.lastFailureAt).getTime() : 0;
    if (consecutiveFailures > 0 && lastFailure) {
      const backoffMs = computeFailureBackoffMs(consecutiveFailures);
      const sinceFailure = now - lastFailure;
      if (sinceFailure < backoffMs) {
        result = {
          shouldRun: false,
          reason: TASK_READINESS_REASON.FAILURE_COOLDOWN,
          consecutiveFailures,
          failureBackoffMs: backoffMs,
          nextRunIn: backoffMs - sinceFailure,
          nextRunAt: new Date(lastFailure + backoffMs).toISOString(),
          lastErrorCategory: appExecution.lastErrorCategory || null
        };
      }
    }
  }

  // If the task would run, check runAfter dependencies — blocked until all enabled deps have run since our last run.
  // Disabled deps (globally or for this app) are skipped, since they'll never run.
  if (result.shouldRun && interval.runAfter?.length > 0) {
    const depCheck = await checkRunAfterDeps(schedule, taskType, appId, featureEnabled);
    if (!depCheck.satisfied) {
      return { shouldRun: false, reason: TASK_READINESS_REASON.WAITING_ON_DEPENDENCIES, pendingDeps: depCheck.pending };
    }
  }

  if (result.shouldRun && await inputsUnchangedForTask(taskType, appId, schedule)) {
    return { shouldRun: false, reason: TASK_READINESS_REASON.INPUTS_UNCHANGED };
  }

  return result;
}

/**
 * Check whether a task should initiate a scheduled run for an app or globally.
 */
export async function shouldRunTask(taskType, appId = null, { featureEnabled = createFeatureGate(), schedule = null, now = Date.now() } = {}) {
  return evaluateTaskReadiness(taskType, appId, { featureEnabled, continuingPerpetualDrain: false, schedule, now });
}

/**
 * Check whether an already-started perpetual drain should take another hop.
 * If asked to continue a non-perpetual type, its normal cadence remains in force.
 */
export async function shouldContinuePerpetualDrain(taskType, appId = null, { featureEnabled = createFeatureGate(), now = Date.now() } = {}) {
  return evaluateTaskReadiness(taskType, appId, { featureEnabled, continuingPerpetualDrain: true, now });
}

/**
 * Get all enabled task types that are due to run (optionally for a specific app)
 */
export async function getDueTasks(appId = null, { continuingTaskType = null, now = Date.now() } = {}) {
  const schedule = await loadSchedule();
  const due = [];
  const featureEnabled = createFeatureGate();

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!interval.enabled) continue;

    const checkTask = taskType === continuingTaskType
      ? shouldContinuePerpetualDrain
      : shouldRunTask;
    const check = await checkTask(taskType, appId, { featureEnabled, now });
    if (check.shouldRun) {
      due.push({ taskType, reason: check.reason, interval });
    }
  }

  return due;
}

/**
 * Get the next task type to run (optionally for a specific app).
 * When `perpetualOnly` is true, return a due perpetual drain or null; never a
 * cron type that would mask it.
 */
export async function getNextTaskType(appId = null, { perpetualOnly = false, continuingTaskType = null, dueTasks = null } = {}) {
  dueTasks ??= await getDueTasks(appId, { continuingTaskType });

  const perpetualDue = dueTasks.filter(t => t.interval.perpetual === true);
  if (perpetualOnly) {
    return perpetualDue.length > 0
      ? { taskType: perpetualDue[0].taskType, reason: 'perpetual-drain' }
      : null;
  }

  // A user-pinned wall-clock schedule outranks a drain: a 9 AM cron must fire at
  // 9 AM even while a perpetual task is mid-backlog. A cron+perpetual task is
  // already gated by its own park, so it can sit in either bucket safely.
  const cronDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.CRON);
  if (cronDue.length > 0) {
    return { taskType: cronDue[0].taskType, reason: 'cron-due' };
  }

  // Perpetual tasks actively draining a backlog keep the app's single
  // improvement slot until their work-detector idles and they park.
  if (perpetualDue.length > 0) {
    return { taskType: perpetualDue[0].taskType, reason: 'perpetual-drain' };
  }

  // Everything else is on-demand: it runs only from an explicit trigger.
  return null;
}

export async function getAvailableOnDemandRequests(schedule, featureEnabled) {
  const requests = schedule.onDemandRequests || [];
  const availability = await Promise.all(requests.map((request) => (
    featureEnabled(schedule.tasks?.[request.taskType])
  )));
  return requests.filter((_request, index) => availability[index]);
}
