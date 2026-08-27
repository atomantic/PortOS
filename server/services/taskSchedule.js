/**
 * Task Schedule Service (v2 - Unified)
 *
 * Manages configurable intervals for improvement tasks across all apps (including PortOS).
 * All task types live in a single `tasks` object — no more selfImprovement/appImprovement split.
 *
 * Interval types:
 * - 'rotation': Run as part of normal rotation (default)
 * - 'daily': Run once per day
 * - 'weekly': Run once per week
 * - 'once': Run once per app/globally then stop
 * - 'on-demand': Only run when manually triggered
 * - 'custom': Custom interval in milliseconds
 * - 'cron': Cron expression schedule
 * - 'perpetual': Drain actionable work back-to-back (re-queue on completion)
 *   until a programmatic work-detector reports nothing actionable, then PARK
 *   on a recheck cadence (`recheckCron` / `recheckIntervalMs`, default daily).
 *   See server/services/perpetualWork.js for the detector registry and the
 *   perpetual gate in cosTaskGenerator.generateManagedAppImprovementTaskForType.
 */

import { cosEvents, emitLog } from './cosEvents.js';
import { DAY, safeDate } from '../lib/fileUtils.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { getAdaptiveCooldownMultiplier } from './taskLearning.js';
import { isTaskTypeEnabledForApp, getAppTaskTypeInterval, getAppTaskTypeIntervalMs, getActiveApps, getAppTaskTypeOverrides, clearAllPrWatcherState } from './apps.js';
import { loadState, isImprovementEnabled } from './cosState.js';
import { getLocalParts } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';
import { parseCronToNextRun, parseCronToPrevRun } from './eventScheduler.js';
import { isAuditTaskType, defaultFileIssuesFor } from '../lib/auditCatalog.js';
import { DEFAULT_TASK_PROMPTS } from './taskPromptDefaults.js';
import {
  DEFAULT_PERPETUAL_RECHECK_MS,
  INTERVAL_TYPES,
  ON_DEMAND_ORIGINS,
  WEEK,
  isRefillRequest
} from './taskScheduleConstants.js';
import {
  DEFAULT_TASK_INTERVALS,
  INSTALL_WIDE_TASK_TYPES,
  MANAGED_AGENT_OPTIONS,
  getTaskTypeDescription,
  enforceBranchReconcileBatch,
  enforceManagedAgentOptions
} from './taskScheduleRegistry.js';
import { loadSchedule, updateSchedule } from './taskScheduleStore.js';
import { getTaskDataInputCatalog } from '../lib/taskDataInputCatalog.js';
import {
  clearFailureLedgerFields,
  clearTaskTypeFailurePark,
  clearTaskTypeFailureParkNotification,
  computeFailureBackoffMs
} from './taskScheduleBackoff.js';

export { PROMPT_VERSIONS, REFERENCE_WATCH_AUDITED_VERSION } from './taskPromptDefaults.js';
export {
  INTERVAL_TYPES, ON_DEMAND_ORIGINS, isRefillRequest
} from './taskScheduleConstants.js';
export {
  DEFAULT_BRANCHES_PER_AGENT, DEFAULT_TASK_INTERVALS, INSTALL_WIDE_TASK_TYPES,
  MANAGED_AGENT_OPTIONS, PERPETUAL_DRAIN_DISPATCH_CAP, SELF_IMPROVEMENT_TASK_TYPES,
  TASK_TYPE_DESCRIPTIONS, stripManagedAgentOptionsFromOverride
} from './taskScheduleRegistry.js';
export { loadSchedule } from './taskScheduleStore.js';
export {
  FAILURE_BACKOFF_BASE_MS, FAILURE_BACKOFF_CAP_MS, FAILURE_PARK_THRESHOLD,
  clearTaskTypeFailurePark, computeFailureBackoffMs, recordTaskTypeFailure,
  recordTaskTypeSuccess
} from './taskScheduleBackoff.js';
export { addTemplateTask, deleteTemplateTask, getTemplateTasks } from './taskScheduleTemplates.js';

/**
 * Get learning-adjusted interval for a task type
 */
async function getPerformanceAdjustedInterval(taskType, baseIntervalMs) {
  const taskTypeKey = `task:${taskType}`;

  const cooldownInfo = await getAdaptiveCooldownMultiplier(taskTypeKey).catch(() => ({
    multiplier: 1.0,
    reason: 'error-fallback',
    skip: false,
    successRate: null,
    completed: 0
  }));

  if (cooldownInfo.reason === 'insufficient-data' || cooldownInfo.reason === 'error-fallback') {
    // Also check legacy keys for migration period
    const legacyKeys = [`self-improve:${taskType}`, `app-improve:${taskType}`];
    for (const key of legacyKeys) {
      const legacyInfo = await getAdaptiveCooldownMultiplier(key).catch(() => null);
      if (legacyInfo && legacyInfo.reason !== 'insufficient-data' && legacyInfo.reason !== 'error-fallback') {
        const adjustedIntervalMs = Math.round(baseIntervalMs * legacyInfo.multiplier);
        return {
          adjustedIntervalMs,
          multiplier: legacyInfo.multiplier,
          reason: legacyInfo.reason,
          successRate: legacyInfo.successRate,
          dataPoints: legacyInfo.completed,
          skip: legacyInfo.skip,
          adjusted: legacyInfo.multiplier !== 1.0,
          recommendation: legacyInfo.recommendation
        };
      }
    }

    return {
      adjustedIntervalMs: baseIntervalMs,
      multiplier: 1.0,
      reason: cooldownInfo.reason,
      successRate: null,
      dataPoints: cooldownInfo.completed || 0,
      adjusted: false
    };
  }

  const adjustedIntervalMs = Math.round(baseIntervalMs * cooldownInfo.multiplier);

  if (cooldownInfo.multiplier !== 1.0) {
    const direction = cooldownInfo.multiplier < 1 ? 'decreased' : 'increased';
    const percentage = Math.abs(Math.round((1 - cooldownInfo.multiplier) * 100));
    emitLog('debug', `Learning: ${taskType} interval ${direction} by ${percentage}% (${cooldownInfo.successRate}% success rate)`, {
      taskType,
      multiplier: cooldownInfo.multiplier,
      successRate: cooldownInfo.successRate,
      dataPoints: cooldownInfo.completed
    }, '📊 TaskSchedule');
  }

  return {
    adjustedIntervalMs,
    multiplier: cooldownInfo.multiplier,
    reason: cooldownInfo.reason,
    successRate: cooldownInfo.successRate,
    dataPoints: cooldownInfo.completed,
    skip: cooldownInfo.skip,
    adjusted: cooldownInfo.multiplier !== 1.0,
    recommendation: cooldownInfo.recommendation
  };
}

// ============================================================
// Unified getters/setters (replace split self/app functions)
// ============================================================

export async function getTaskInterval(taskType) {
  const schedule = await loadSchedule();
  return schedule.tasks[taskType] || { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null };
}

export async function updateTaskInterval(taskType, settings) {
  const { task, unparkedScopes } = await updateSchedule(async (schedule) => {
    if (!schedule.tasks[taskType]) {
      schedule.tasks[taskType] = { type: INTERVAL_TYPES.ROTATION, enabled: false, providerId: null, model: null, createdAt: new Date().toISOString() };
    }

    // Normalize empty/whitespace prompts to null (treated as "use default")
    if ('prompt' in settings && typeof settings.prompt === 'string' && !settings.prompt.trim()) {
      settings.prompt = null;
    }
    // If user is setting a custom prompt, mark it so auto-upgrade won't overwrite it.
    // If user clears the prompt (null), remove the customized flag to resume defaults.
    if ('prompt' in settings) {
      settings.promptCustomized = settings.prompt != null;
    }

    schedule.tasks[taskType] = {
      ...schedule.tasks[taskType],
      ...settings
    };

    // Re-assert agent-managed taskMetadata fields after the merge so a PUT that
    // tries to flip them (UI bypass, hand-edited TASKS.md, direct API call)
    // gets the locked value back in its response.
    enforceManagedAgentOptions(taskType, schedule.tasks[taskType]);
    enforceBranchReconcileBatch(taskType, schedule.tasks[taskType]);

    // Config change unparks a failure-parked type (#2616): editing a type's
    // settings is an explicit "I've addressed the cause" signal, so clear the
    // consecutive-failure ledger + auto-park (global + every per-app record) so
    // the type gets a fresh start on its next tick. Track the scopes that were
    // actually parked so their stale notifications can be pruned after the save.
    const topExec = schedule.executions[`task:${taskType}`];
    const unparkedScopes = [];
    if (topExec) {
      if (topExec.failureParkedAt) unparkedScopes.push(null);
      clearFailureLedgerFields(topExec);
      for (const [id, rec] of Object.entries(topExec.perApp || {})) {
        if (rec.failureParkedAt) unparkedScopes.push(id);
        clearFailureLedgerFields(rec);
      }
    }

    // Globally disabling pr-watcher also drops its execution cooldown so a later
    // re-enable baselines on the very next tick rather than waiting out the prior
    // 30-min interval — otherwise PRs opened in that delayed window slip past the
    // firstRun baseline and are never dispatched. Paired with clearAllPrWatcherState
    // below (the per-app disable paths in apps.js do the same via resetExecutionHistory).
    if (taskType === 'pr-watcher' && settings.enabled === false) {
      delete schedule.executions['task:pr-watcher'];
    }

    // When the recheck cadence of a perpetual task changes, re-derive the
    // `parkedUntil` of any CURRENTLY-parked execution records (global + per-app)
    // from the new cadence — otherwise an already-parked task keeps waiting out
    // its old timestamp and the cadence control appears to do nothing until then.
    // Only recompute existing parks (never create one), and compute from now so a
    // shortened cadence takes effect on the next slot. A park whose timestamp has
    // ALREADY elapsed is left alone (#3590): an elapsed park is not cleared when it
    // expires — shouldRunTask reports `perpetual-recheck` and the dispatch gate
    // clears it — so it is a record that is DUE RIGHT NOW. Restamping it from a
    // lengthened cadence would silently push already-due work back into the future.
    const merged = schedule.tasks[taskType];
    if (merged.type === INTERVAL_TYPES.PERPETUAL && ('recheckCron' in settings || 'recheckIntervalMs' in settings)) {
      const exec = schedule.executions[`task:${taskType}`];
      if (exec) {
        const nowMs = Date.now();
        const records = [exec, ...Object.values(exec.perApp || {})];
        for (const rec of records) {
          if (parkedUntilMs(rec) > nowMs) {
            rec.parkedUntil = boundParkedUntil(await computePerpetualRecheckAt(merged), rec.parkNotLaterThan);
          }
        }
      }
    }

    return {
      result: { task: schedule.tasks[taskType], unparkedScopes },
      changed: true
    };
  });

  // Globally disabling pr-watcher clears every app's high-water mark, mirroring
  // the per-app disable clears in apps.js — so a later global re-enable
  // baselines silently instead of dispatching the backlog of PRs opened while
  // it was paused. (`enabled` arrives as a real boolean from the schedule route.)
  if (taskType === 'pr-watcher' && settings.enabled === false) {
    await clearAllPrWatcherState().catch((err) => {
      emitLog('warn', `pr-watcher global-disable state clear failed: ${err.message}`, {}, '📅 TaskSchedule');
    });
  }

  for (const scope of unparkedScopes) {
    await clearTaskTypeFailureParkNotification(taskType, scope);
  }

  emitLog('info', `Updated task interval for ${taskType}`, { taskType, settings }, '📅 TaskSchedule');
  cosEvents.emit('schedule:changed', { taskType, settings });

  return task;
}

/**
 * Record a task execution
 */
export async function recordExecution(taskType, appId = null) {
  return updateSchedule(async (schedule) => {
    const key = taskType.startsWith('task:') ? taskType : `task:${taskType}`;

    if (!schedule.executions[key]) {
      schedule.executions[key] = {
        lastRun: null,
        count: 0,
        perApp: {}
      };
    }

    schedule.executions[key].lastRun = new Date().toISOString();
    schedule.executions[key].count = (schedule.executions[key].count || 0) + 1;

    if (appId) {
      if (!schedule.executions[key].perApp[appId]) {
        schedule.executions[key].perApp[appId] = {
          lastRun: null,
          count: 0
        };
      }
      schedule.executions[key].perApp[appId].lastRun = new Date().toISOString();
      schedule.executions[key].perApp[appId].count++;
    }

    return { result: schedule.executions[key], changed: true };
  });
}

export async function getExecutionHistory(taskType) {
  const schedule = await loadSchedule();
  const key = taskType.startsWith('task:') ? taskType : `task:${taskType}`;
  return schedule.executions[key] || { lastRun: null, count: 0, perApp: {} };
}

// ============================================================
// Perpetual (drain-until-done) park state
// ============================================================

/**
 * Compute when a parked perpetual task should next re-probe its work-detector.
 * Prefers `recheckCron` (a 5-field cron string, evaluated in the user's
 * timezone) over `recheckIntervalMs`; falls back to DEFAULT_PERPETUAL_RECHECK_MS.
 * Returns an ISO timestamp string.
 */
export async function computePerpetualRecheckAt(interval, fromMs = Date.now()) {
  const cron = interval?.recheckCron;
  if (typeof cron === 'string' && cron.trim().split(/\s+/).length === 5) {
    const timezone = await getUserTimezone();
    const next = parseCronToNextRun(cron, new Date(fromMs), timezone);
    if (next) return next.toISOString();
  }
  const ms = Number(interval?.recheckIntervalMs) > 0
    ? Number(interval.recheckIntervalMs)
    : DEFAULT_PERPETUAL_RECHECK_MS;
  return new Date(fromMs + ms).toISOString();
}

/**
 * Shorten a computed park so it cannot sleep past a moment the caller already
 * KNOWS the situation changes on its own.
 *
 * The recheck cadence is a poll interval — the right default when nothing is
 * known about *when* new work appears. But some parks wait on a deadline the
 * detector can name: branch-reconcile holds a merged branch whose claim worktree
 * is still inside its grace window, and that hold lifts at a computable instant.
 * Parking past it compounds two waits (the grace window, then the next cron
 * fire) into a stall several times longer than either — on a weekly recheck a
 * 7-day hold becomes up to 14 days of a task that looks idle.
 *
 * Only ever SHORTENS: a bound that is unparseable, already elapsed, or later
 * than the recheck is ignored, so a bad bound can never extend a park (nor spin
 * one into a hot retry loop).
 *
 * @param {string} recheckAt - ISO timestamp from computePerpetualRecheckAt
 * @param {string|null|undefined} notLaterThan - ISO instant the hold self-lifts
 * @param {number} [nowMs]
 * @returns {string} ISO timestamp
 */
export function boundParkedUntil(recheckAt, notLaterThan, nowMs = Date.now()) {
  const bound = Date.parse(notLaterThan);
  const recheck = Date.parse(recheckAt);
  if (!Number.isFinite(bound) || !Number.isFinite(recheck)) return recheckAt;
  if (bound <= nowMs || bound >= recheck) return recheckAt;
  return new Date(bound).toISOString();
}

/**
 * Numeric ms of a record's perpetual park, or 0 when it carries none (or an
 * unparseable timestamp). The single reader of `parkedUntil` — every park
 * comparison in this file goes through it so "parked" can't mean two things.
 */
function parkedUntilMs(record) {
  if (!record?.parkedUntil) return 0;
  const ms = new Date(record.parkedUntil).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Roll a perpetual task's park records up into ONE aggregate that every
 * per-app-park consumer projects from (getUpcomingTasks eligibility and the
 * getScheduleStatus UI block).
 *
 * GLOBAL-RECORD INCLUSION RULE (documented once, here, so the callers can't
 * diverge): every `perApp` record is a tracked scope; the top-level execution
 * record is a tracked scope ONLY when it carries its OWN `parkedUntil`.
 * Rationale — perpetual parks are recorded PER-APP (parkPerpetual is always
 * called with an appId for the shipped app-scoped drains: claim-issue,
 * claim-work, branch-/issue-reconcile), so for those the top-level record is
 * just a container and must not be mistaken for a scope that is "due now".
 * A future global-park perpetual (none ship today) stamps its own `parkedUntil`
 * and is then folded in like any other scope.
 *
 * Returns:
 *   trackedAppCount  per-app records (the UI's "N app(s)" denominator)
 *   trackedCount     tracked scopes total (per-app + an own-parked global)
 *   parkedAppCount   per-app records still parked in the future
 *   globalParked     the top-level record carries a park that hasn't elapsed
 *   soonestParkAt    ms of the earliest un-elapsed park, or null when none
 *   anyDueNow        some tracked scope is unparked or its park has elapsed
 *   parkReason       first parked app's reason, else the parked global's
 */
function aggregatePerpetualParks(execution, now) {
  const appRecords = Object.values(execution?.perApp || {});
  const globalUntil = parkedUntilMs(execution);
  const globalTracked = globalUntil > 0;
  const globalParked = globalUntil > now;

  let parkedAppCount = 0;
  let anyDueNow = false;
  let soonestParkAt = null;
  // The FIRST parked app in iteration order, not the first one that happens to
  // carry a reason — the UI names the app it counted first, so a reasonless park
  // must read as "no reason" rather than borrowing the next app's.
  let firstParkedApp = null;

  for (const rec of appRecords) {
    const until = parkedUntilMs(rec);
    // Unparked (mid-drain) or park already elapsed → this scope is due now.
    if (until <= now) {
      anyDueNow = true;
      continue;
    }
    parkedAppCount++;
    if (firstParkedApp === null) firstParkedApp = rec;
    if (soonestParkAt === null || until < soonestParkAt) soonestParkAt = until;
  }

  if (globalTracked) {
    if (globalParked) {
      if (soonestParkAt === null || globalUntil < soonestParkAt) soonestParkAt = globalUntil;
    } else {
      anyDueNow = true;
    }
  }

  return {
    trackedAppCount: appRecords.length,
    trackedCount: appRecords.length + (globalTracked ? 1 : 0),
    parkedAppCount,
    globalParked,
    soonestParkAt,
    anyDueNow,
    parkReason: firstParkedApp?.parkReason || (globalParked ? execution.parkReason : null) || null
  };
}

/**
 * The park record lives ALONGSIDE the execution record (global or per-app), so a
 * perpetual task's "parked until" survives restarts the same way `lastRun` does.
 * Returns the execution sub-record that holds the park fields, creating the
 * skeleton if absent.
 */
function ensureExecutionRecord(schedule, taskType, appId) {
  const key = executionKey(taskType);
  if (!schedule.executions[key]) {
    schedule.executions[key] = { lastRun: null, count: 0, perApp: {} };
  }
  const top = schedule.executions[key];
  if (appId) {
    if (!top.perApp) top.perApp = {};
    if (!top.perApp[appId]) top.perApp[appId] = { lastRun: null, count: 0 };
    return top.perApp[appId];
  }
  return top;
}

/** Normalize a task type to its `task:`-prefixed executions map key. */
function executionKey(taskType) {
  return taskType.startsWith('task:') ? taskType : `task:${taskType}`;
}

/**
 * Resolve the EXISTING execution sub-record (global or per-app) without creating
 * it — the read-only counterpart to ensureExecutionRecord. Returns null when the
 * task (or that app) has no record yet.
 */
function resolveExecutionRecord(schedule, taskType, appId = null) {
  const top = schedule.executions[executionKey(taskType)];
  if (!top) return null;
  return (appId ? top.perApp?.[appId] : top) || null;
}

// Every field parkPerpetual stamps for a park. Kept as one list so the clear /
// reset paths can't drift from what park writes (adding a park field here is the
// single edit that keeps all three in sync).
const PARK_FIELDS = ['parkedUntil', 'parkReason', 'parkActionableCount', 'parkCounts', 'parkNotLaterThan', 'parkedAt'];

/**
 * Park a perpetual task: its work-detector reported nothing actionable, so stop
 * draining and wait until `parkedUntil` before re-probing. Stamps the park
 * fields on the (per-app or global) execution record.
 *
 * `signature` and `dispatchCount` are the drain's two convergence brakes, both
 * settable HERE rather than by a follow-up call, because every terminal park has
 * to land them in the same write it lands the park. A second await after this one
 * is a step a future park path can forget — and a stale non-zero dispatch count
 * makes the NEXT fresh drain cap out early, which looks exactly like the task
 * silently doing nothing.
 *
 * `notLaterThan` is an optional ISO instant at which the caller knows the hold
 * lifts on its own; the park is shortened to it when that is sooner than the
 * recheck cadence, and ignored otherwise.
 *
 * `dispatchCount` therefore DEFAULTS to 0: a park ends the drain window by
 * definition, so zeroing the budget is the invariant, not an opt-in every caller
 * has to remember. The churn detector's park in agentChurn.js relies on this
 * default so a local signal ends the current drain window cleanly. Note
 * `dispatchCount` is still deliberately NOT in `PARK_FIELDS`:
 * `recordPerpetualDispatch` clears those fields mid-drain on every dispatch, and
 * zeroing the counter there would reset the budget before every dispatch, so the
 * cap could never fire.
 */
export async function parkPerpetual(taskType, appId = null, { reason = null, actionableCount = 0, counts = null, signature, dispatchCount = 0, notLaterThan = null } = {}) {
  const { record, parkedUntil } = await updateSchedule(async (schedule) => {
    const interval = schedule.tasks[taskType] || {};
    // Bound HERE, not at the assignment: `parkedUntil` is also what the log line and
    // the schedule:perpetual-parked event publish, and a change whose whole point is
    // an honest "when will this actually run" must not report the un-shortened time.
    const parkedUntil = boundParkedUntil(await computePerpetualRecheckAt(interval), notLaterThan);
    const record = ensureExecutionRecord(schedule, taskType, appId);
    record.parkedUntil = parkedUntil;
    record.parkReason = reason;
    record.parkActionableCount = actionableCount;
    // The detector's candidate breakdown ({ open, inFlight, filtered }). Lets the
    // UI explain WHY a non-empty queue yields zero claimable work — "0 of N, M
    // in-flight" — instead of a bare "no work". `null` = the detector reported no
    // breakdown (e.g. the reconcile scans), so the field is left off the record.
    if (counts != null) record.parkCounts = counts;
    else delete record.parkCounts;
    // The self-expiry has to OUTLIVE this call: updateTaskInterval restamps every
    // un-elapsed park from the new cadence, and without a remembered bound it would
    // stretch a correctly-shortened park back out — reintroducing the stacking this
    // option exists to remove, via an unrelated settings edit.
    if (notLaterThan) record.parkNotLaterThan = notLaterThan;
    else delete record.parkNotLaterThan;
    record.parkedAt = new Date().toISOString();
    // A drain that parks because a full cycle made NO progress (branch-reconcile's
    // 'no-progress' park) records the actionable signature it was stuck on, so the
    // next recheck can tell "same stuck set" (park again) from "the set changed"
    // (resume). `null` clears it (an idle park with nothing actionable); `undefined`
    // (the default) leaves any prior signature untouched.
    //
    // `signatureRepeatCount` is the harvested "same finding again" metric the
    // CoS churn detector reports: increment when this park restates the same
    // signature, reset when the set changes, clear when idle.
    if (signature !== undefined) {
      if (signature === null) {
        delete record.lastActionableSignature;
        delete record.signatureRepeatCount;
      } else if (signature === record.lastActionableSignature) {
        record.signatureRepeatCount = (Number(record.signatureRepeatCount) || 1) + 1;
      } else {
        record.lastActionableSignature = signature;
        record.signatureRepeatCount = 1;
      }
    }
    // Same option shape for the consecutive-dispatch budget: `0` (or null) clears it
    // because this park ended the drain window; `undefined` leaves it alone.
    if (dispatchCount !== undefined) {
      if (!dispatchCount) delete record.perpetualDispatchCount;
      else record.perpetualDispatchCount = dispatchCount;
    }

    return { result: { record, parkedUntil }, changed: true };
  });
  emitLog('info', `Perpetual ${taskType} parked until ${parkedUntil} (${reason || 'idle'})`, { taskType, appId, parkedUntil }, '📅 TaskSchedule');
  cosEvents.emit('schedule:perpetual-parked', { taskType, appId, parkedUntil, reason, actionableCount, counts });
  return record;
}

/**
 * Read the current park record for a perpetual task (or null when not parked).
 * Used by the on-demand handler to explain to the user WHY an explicit "Run"
 * produced no task — the park fields are freshly stamped by the same dispatch,
 * so this reflects the just-completed detection, not stale cadence state.
 */
export async function getPerpetualParkInfo(taskType, appId = null) {
  const schedule = await loadSchedule();
  const record = resolveExecutionRecord(schedule, taskType, appId);
  if (!record || record.parkedUntil == null) return null;
  return {
    parkedUntil: record.parkedUntil,
    parkReason: record.parkReason ?? null,
    parkActionableCount: record.parkActionableCount ?? null,
    parkCounts: record.parkCounts ?? null,
    parkedAt: record.parkedAt ?? null,
    signatureRepeatCount: Number.isFinite(record.signatureRepeatCount) ? record.signatureRepeatCount : null
  };
}

/**
 * Is this type+app parked with an UNEXPIRED `parkedUntil`?
 *
 * `getPerpetualParkInfo` reports the park record whether or not it has elapsed —
 * an elapsed park is deliberately left on disk (it reads as "due right now"), so
 * its mere presence is not a stop signal. This is the elapse-aware question, and
 * it is what the completion refill asks before re-issuing a drain: a park means
 * "stop draining until the recheck cadence", and until #3848 the refill lane
 * never asked, so a park could not stop a refill hop.
 */
export async function isPerpetualParkActive(taskType, appId = null) {
  const schedule = await loadSchedule();
  const record = resolveExecutionRecord(schedule, taskType, appId);
  return parkedUntilMs(record) > Date.now();
}

/**
 * A perpetual drain's convergence state, read in ONE pass: the actionable
 * signature its last dispatch was handed, and how many times it has dispatched
 * since it last went idle. Read together because they are decided together — two
 * separate getters also left a read-skew window between the two fields.
 * @returns {Promise<{ signature:string|null, dispatchCount:number }>}
 */
export async function getPerpetualDrainState(taskType, appId = null) {
  const schedule = await loadSchedule();
  const record = resolveExecutionRecord(schedule, taskType, appId);
  return {
    signature: record?.lastActionableSignature ?? null,
    dispatchCount: record?.perpetualDispatchCount || 0
  };
}

/**
 * Record that a perpetual drain is dispatching against `signature`: resume the
 * drain (drop any park), remember the signature so a later cycle can recognize
 * "same set ⇒ no progress", and spend one dispatch from the cap's budget — all in
 * a single read-modify-write, so the three facts can never land apart.
 * @returns {Promise<number>} the new consecutive-dispatch count
 */
export async function recordPerpetualDispatch(taskType, appId = null, signature) {
  return updateSchedule(async (schedule) => {
    const record = ensureExecutionRecord(schedule, taskType, appId);
    for (const field of PARK_FIELDS) delete record[field];
    // Mirrors parkPerpetual's signature handling, including the churn detector's
    // `signatureRepeatCount`. A dispatch only happens when the set CHANGED (an
    // unchanged one parks instead), so this is always the "new signature ⇒ first
    // sighting" case — leaving the previous count in place would let the NEXT park
    // increment a stale value, over-reporting "same finding again" to a detector
    // that parks the coordinator and files a tracker issue off that number.
    if (signature == null) {
      delete record.lastActionableSignature;
      delete record.signatureRepeatCount;
    } else {
      record.lastActionableSignature = signature;
      record.signatureRepeatCount = 1;
    }
    const count = (record.perpetualDispatchCount || 0) + 1;
    record.perpetualDispatchCount = count;
    return { result: count, changed: true };
  });
}

/**
 * Reset a perpetual task's cached drain state for an explicit user-initiated
 * re-run. Drops any park AND the convergence `lastActionableSignature` in a
 * single write, so the next detection dispatches on LIVE state alone — never a
 * stale "no-progress" verdict or a cadence park. This is what makes a manual
 * "Run" honor the user's intent to re-check now: without clearing the signature,
 * branch-reconcile/issue-reconcile would re-park `no-progress` against an
 * unchanged-since-last-run set even though the user explicitly asked to re-drive.
 *
 * ONLY a human asking for a re-run may call this. An automated re-issue that
 * borrows the on-demand lane (the perpetual drain's own completion refill) must
 * NOT: clearing the convergence signature and the dispatch counter is precisely
 * what removes every brake the drain has, and the drain then re-dispatches for as
 * long as one actionable item exists. That is the loop that ran ~40 branch-reconcile
 * coordinators overnight on 2026-08-12. See `origin` on the on-demand request.
 *
 * Returns true when it cleared anything.
 */
export async function resetPerpetualForManualRun(taskType, appId = null) {
  return updateSchedule(async (schedule) => {
    const record = resolveExecutionRecord(schedule, taskType, appId);
    if (!record) return { result: false, changed: false };
    let changed = false;
    for (const field of [...PARK_FIELDS, 'lastActionableSignature', 'signatureRepeatCount', 'perpetualDispatchCount']) {
      if (record[field] !== undefined) { delete record[field]; changed = true; }
    }
    return { result: changed, changed };
  });
}

/**
 * Apply the "a human pressed Run" state resets for one on-demand request — and
 * apply NOTHING when the request is an automated drain refill.
 *
 * This is the single home of that policy. It used to be open-coded in each spawn
 * engine that drains the on-demand queue, which is how the loop this guards against
 * got in: the engines could not tell a human "Run Now" from the perpetual drain
 * re-issuing itself through the same queue, so they cleared the drain's park,
 * convergence signature, and dispatch budget on every automated hop. There are
 * THREE consumers of that queue (cos.dequeueNextTask, cosTaskGenerator's
 * spawnPriority0OnDemand, and the idle-review path), so "remember to check origin
 * at each call site" is not a durable invariant — calling this instead is.
 *
 * @param {{taskType:string, origin?:string}} request - the queued on-demand record
 * @param {string|null} [appId] - the app scope, or null for a global task
 * @returns {Promise<boolean>} true when the request was user-initiated (resets
 *   applied) — callers use it to decide whether user-facing feedback is warranted
 */
export async function applyOnDemandRunResets(request, appId = null) {
  if (isRefillRequest(request)) return false;
  // A user-initiated "Run" must re-check live state, never honor a stale park or
  // convergence verdict.
  await resetPerpetualForManualRun(request.taskType, appId);
  // It also unparks a failure-parked type (#2616): a human explicitly re-running is
  // an "I've addressed it" signal. A refill carries no such signal from anybody —
  // gating this too keeps a drain that fails every run from clearing its own
  // failure park forever.
  await clearTaskTypeFailurePark(request.taskType, appId);
  return true;
}

/**
 * Check if all runAfter dependencies have completed since this task's last run.
 * Returns { satisfied, pending } where pending lists unfinished dependency task types.
 *
 * Dependencies that are disabled — either globally (missing from the schedule or
 * `enabled: false`) or disabled for the requesting app — are skipped, since they
 * will never run and would otherwise block the dependent task indefinitely.
 */
async function checkRunAfterDeps(schedule, taskType, appId = null) {
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
    if (appId && !(await isTaskTypeEnabledForApp(appId, dep))) continue;

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

/**
 * Shared due/cooldown evaluation for the fixed-cadence interval types
 * (DAILY, WEEKLY, CUSTOM), which differ only in their base interval and the
 * reason-string prefix (`label`). Reason strings are persisted and compared
 * elsewhere, so they must come out byte-identical to what each case produced
 * before this was extracted (e.g. `'daily-due'`, `'weekly-cooldown-adjusted'`).
 */
async function evaluateFixedInterval(taskType, baseIntervalMs, label, timeSinceLastRun, lastRun, buildResult) {
  const learningAdjustment = await getPerformanceAdjustedInterval(taskType, baseIntervalMs);
  const adjustedInterval = learningAdjustment.adjustedIntervalMs;
  if (timeSinceLastRun >= adjustedInterval) {
    return buildResult(true, learningAdjustment.adjusted ? `${label}-due-adjusted` : `${label}-due`, baseIntervalMs, { learningAdjustment });
  }
  return buildResult(false, learningAdjustment.adjusted ? `${label}-cooldown-adjusted` : `${label}-cooldown`, baseIntervalMs, {
    learningAdjustment, nextRunIn: adjustedInterval - timeSinceLastRun,
    nextRunAt: new Date(lastRun + adjustedInterval).toISOString(),
    baseIntervalMs, adjustedIntervalMs: adjustedInterval
  });
}

/**
 * Check if a task type should run for a specific app (or globally)
 */
export async function shouldRunTask(taskType, appId = null) {
  const schedule = await loadSchedule();
  const interval = schedule.tasks[taskType];

  if (!interval || !interval.enabled) {
    return { shouldRun: false, reason: 'disabled' };
  }

  // Fetch timezone once for reuse across weekday and cron checks
  const timezone = await getUserTimezone();

  // Weekday-only tasks skip weekends (timezone-aware)
  if (interval.weekdaysOnly) {
    const { dayOfWeek } = getLocalParts(new Date(), timezone);
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return { shouldRun: false, reason: 'weekday-only' };
    }
  }

  if (appId) {
    const enabledForApp = await isTaskTypeEnabledForApp(appId, taskType);
    if (!enabledForApp) {
      return { shouldRun: false, reason: 'disabled-for-app' };
    }
  }

  // Determine effective interval type: per-app override takes precedence
  const perAppInterval = appId ? await getAppTaskTypeInterval(appId, taskType) : null;
  // A per-app numeric intervalMs override (used by handler-backed tasks like
  // layered-intelligence, whose Intelligence-tab UI offers sub-daily cadences the
  // string enum can't express). When set alongside interval:'custom', the CUSTOM
  // branch below uses THIS value as the base interval instead of the global one.
  const perAppIntervalMs = appId ? await getAppTaskTypeIntervalMs(appId, taskType) : null;
  const hasCustomIntervalMs = Number.isFinite(perAppIntervalMs) && perAppIntervalMs > 0;
  // Cron expressions (contain spaces) are stored directly as the interval value
  const isCronOverride = perAppInterval && perAppInterval.includes(' ');
  const effectiveType = isCronOverride ? INTERVAL_TYPES.CRON : (perAppInterval || interval.type);

  const key = `task:${taskType}`;
  const execution = schedule.executions[key] || { lastRun: null, count: 0, perApp: {} };

  // For per-app tracking, use app-specific execution data
  const appExecution = appId
    ? (execution.perApp[appId] || { lastRun: null, count: 0 })
    : execution;

  // Type-level failure auto-park (#2616): a type whose instances failed
  // FAILURE_PARK_THRESHOLD times in a row is parked for ALL cadence types
  // (including ROTATION) until a manual retry or config change clears the
  // ledger. Checked before the cadence switch so it short-circuits every type.
  if (appExecution.failureParkedAt) {
    return {
      shouldRun: false,
      reason: 'failure-parked',
      failureParkedAt: appExecution.failureParkedAt,
      failureParkReason: appExecution.failureParkReason || null,
      consecutiveFailures: Number(appExecution.consecutiveFailures) || 0
    };
  }

  const now = Date.now();
  const lastRun = appExecution.lastRun ? new Date(appExecution.lastRun).getTime() : 0;
  const timeSinceLastRun = now - lastRun;

  const buildResult = (shouldRun, reason, baseIntervalMs, extra = {}) => {
    const result = { shouldRun, reason, ...extra };
    if (extra.learningAdjustment?.adjusted) {
      result.learningApplied = true;
      result.successRate = extra.learningAdjustment.successRate;
      result.adjustmentMultiplier = extra.learningAdjustment.multiplier;
      result.dataPoints = extra.learningAdjustment.dataPoints;
    }
    return result;
  };

  let result;

  switch (effectiveType) {
    case INTERVAL_TYPES.ROTATION:
      result = { shouldRun: true, reason: 'rotation' };
      break;

    case INTERVAL_TYPES.DAILY:
      result = await evaluateFixedInterval(taskType, DAY, 'daily', timeSinceLastRun, lastRun, buildResult);
      break;

    case INTERVAL_TYPES.WEEKLY:
      result = await evaluateFixedInterval(taskType, WEEK, 'weekly', timeSinceLastRun, lastRun, buildResult);
      break;

    case INTERVAL_TYPES.ONCE:
      result = appExecution.count === 0
        ? { shouldRun: true, reason: 'once-first-run' }
        : { shouldRun: false, reason: 'once-completed', completedAt: appExecution.lastRun };
      break;

    case INTERVAL_TYPES.ON_DEMAND:
      result = { shouldRun: false, reason: 'on-demand-only' };
      break;

    case INTERVAL_TYPES.CUSTOM: {
      // A per-app numeric intervalMs override wins over the global custom interval
      // (handler-backed tasks store their per-app cadence there).
      const baseInterval = (hasCustomIntervalMs ? perAppIntervalMs : interval.intervalMs) || DAY;
      result = await evaluateFixedInterval(taskType, baseInterval, 'custom', timeSinceLastRun, lastRun, buildResult);
      break;
    }

    case INTERVAL_TYPES.CRON: {
      // Cron expression: per-app override (stored as the interval string) or global config
      const cronExpr = isCronOverride ? perAppInterval : interval.cronExpression;
      if (!cronExpr || typeof cronExpr !== 'string' || cronExpr.trim().split(/\s+/).length !== 5) {
        result = { shouldRun: false, reason: 'invalid-cron' };
        break;
      }

      // Catch-up: if a cron slot has already elapsed since the last successful run
      // (or, for never-run tasks, within the last cron period), fire it now instead
      // of waiting another full period. This recovers from daemon downtime, restarts,
      // and the hourly-check window missing the 60-second cron match.
      const prevRun = parseCronToPrevRun(cronExpr, new Date(now), timezone);
      if (prevRun) {
        const prevRunMs = prevRun.getTime();
        let lookbackBound;
        if (lastRun) {
          lookbackBound = lastRun;
        } else {
          // Never-run: only catch up to a slot that elapsed AFTER the task was
          // configured. Without this bound a never-run task always fires its most
          // recent past slot, so a weekly "Sunday 09:00" task enabled on a Friday
          // immediately reads as "due now (catch-up)" for last Sunday — a slot that
          // predates the task and was never actually missed. `createdAt` is stamped
          // when the task is first seen (loadSchedule backfills it for existing
          // installs), so catch-up only recovers slots the task was around for. An
          // un-backfilled task (createdAt absent) yields bound 0 → the legacy
          // always-catch-up behavior.
          lookbackBound = safeDate(interval.createdAt);
        }
        if (prevRunMs > lookbackBound && prevRunMs <= now) {
          // Compute nextRun for telemetry/reporting
          const nextRunAfterCatch = parseCronToNextRun(cronExpr, new Date(now), timezone);
          result = {
            shouldRun: true,
            reason: 'cron-catch-up',
            cronExpression: cronExpr,
            missedSlot: prevRun.toISOString(),
            nextRunAt: nextRunAfterCatch ? nextRunAfterCatch.toISOString() : null
          };
          break;
        }
      }

      // For never-run tasks, use 1 minute ago so the first scheduled occurrence can match
      const fromDate = lastRun ? new Date(lastRun) : new Date(now - 60_000);
      const nextRun = parseCronToNextRun(cronExpr, fromDate, timezone);
      if (!nextRun) {
        result = { shouldRun: false, reason: 'invalid-cron', cronExpression: cronExpr };
        break;
      }
      if (now >= nextRun.getTime()) {
        result = { shouldRun: true, reason: 'cron-due', cronExpression: cronExpr, nextRunAt: nextRun.toISOString() };
      } else {
        result = { shouldRun: false, reason: 'cron-cooldown', cronExpression: cronExpr,
          nextRunAt: nextRun.toISOString() };
      }
      break;
    }

    case INTERVAL_TYPES.PERPETUAL: {
      // Drain-until-done: a perpetual task is "due" whenever it isn't parked.
      // The actual programmatic work-detector runs at DISPATCH time (the gate in
      // generateManagedAppImprovementTaskForType) and PARKS the task — writing
      // `parkedUntil` onto the execution record — when nothing is actionable.
      // shouldRunTask only reads that persisted park, so it never does network
      // I/O even though it's called several times per evaluation cycle. While
      // parked, the recheck cadence (parkedUntil) gates re-probing; once it
      // elapses the task becomes due again and the gate re-runs the detector.
      const parkUntil = parkedUntilMs(appExecution);
      if (parkUntil && now < parkUntil) {
        result = {
          shouldRun: false,
          reason: 'perpetual-parked',
          nextRunAt: new Date(parkUntil).toISOString(),
          parkReason: appExecution.parkReason || null,
          parkActionableCount: appExecution.parkActionableCount ?? null
        };
      } else {
        result = { shouldRun: true, reason: parkUntil ? 'perpetual-recheck' : 'perpetual-drain' };
      }
      break;
    }

    default:
      result = { shouldRun: true, reason: 'unknown-default-rotation' };
  }

  // Escalating failure backoff (#2616): a type with recent consecutive failures
  // (still below the park threshold) slows down — 2^n × base, capped — instead
  // of re-queuing every tick. Applies to ALL cadence types, including ROTATION
  // (which is otherwise `shouldRun: true` unconditionally). Gated on
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
          reason: 'failure-cooldown',
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
    const depCheck = await checkRunAfterDeps(schedule, taskType, appId);
    if (!depCheck.satisfied) {
      return { shouldRun: false, reason: 'waiting-on-dependencies', pendingDeps: depCheck.pending };
    }
  }

  return result;
}

/**
 * Get all enabled task types that are due to run (optionally for a specific app)
 */
export async function getDueTasks(appId = null) {
  const schedule = await loadSchedule();
  const due = [];

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!interval.enabled) continue;

    const check = await shouldRunTask(taskType, appId);
    if (check.shouldRun) {
      due.push({ taskType, reason: check.reason, interval });
    }
  }

  return due;
}

/**
 * Get the next task type to run (optionally for a specific app)
 */
export async function getNextTaskType(appId = null, lastType = '', { perpetualOnly = false } = {}) {
  const schedule = await loadSchedule();
  const taskTypes = Object.keys(schedule.tasks);

  const dueTasks = await getDueTasks(appId);

  // `perpetualOnly` constrains the pick to a due perpetual (drain-until-done)
  // task, skipping every other schedule type. Callers set this when the app is
  // on its review cooldown: only perpetual drains bypass that cooldown (their
  // work-detector park is the throttle), so a higher-priority cron/custom/daily
  // type that's also due must NOT be returned — it would mask the perpetual
  // drain and the caller, seeing a non-exempt pick, would skip the whole app for
  // the cooldown window (the mixed-schedule stall). Returns null when nothing
  // perpetual is due, so the caller leaves the cooled-down app alone.
  if (perpetualOnly) {
    const perpetualDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.PERPETUAL);
    return perpetualDue.length > 0
      ? { taskType: perpetualDue[0].taskType, reason: 'perpetual-drain' }
      : null;
  }

  // Explicit time-based schedules (cron, custom interval) outrank loose interval-based
  // ones (daily/weekly/once). A user-pinned 9 AM cron should fire at 9 AM even if a
  // weekly task is perpetually "ready" — the loose tasks will pick up the next slot.
  const cronDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.CRON || t.interval.type === INTERVAL_TYPES.CUSTOM);
  if (cronDue.length > 0) {
    return { taskType: cronDue[0].taskType, reason: `${cronDue[0].interval.type}-due` };
  }

  // Perpetual tasks actively draining a backlog outrank the loose interval
  // tasks (daily/weekly/once/rotation) so the drain keeps the app's single
  // improvement slot until its work-detector idles and it parks — at which
  // point the loose tasks below get their turn. (Explicit time-pinned cron/
  // custom schedules above still win, so a perpetual drain can't starve a
  // user-pinned 9 AM job.)
  const perpetualDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.PERPETUAL);
  if (perpetualDue.length > 0) {
    return { taskType: perpetualDue[0].taskType, reason: 'perpetual-drain' };
  }

  const dailyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.DAILY);
  if (dailyDue.length > 0) {
    return { taskType: dailyDue[0].taskType, reason: 'daily-priority' };
  }

  const weeklyDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.WEEKLY);
  if (weeklyDue.length > 0) {
    return { taskType: weeklyDue[0].taskType, reason: 'weekly-priority' };
  }

  const onceDue = dueTasks.filter(t => t.interval.type === INTERVAL_TYPES.ONCE);
  if (onceDue.length > 0) {
    return { taskType: onceDue[0].taskType, reason: 'once-first-run' };
  }

  // Fall back to rotation among enabled rotation tasks
  const rotationTasks = taskTypes.filter(t =>
    schedule.tasks[t].enabled &&
    schedule.tasks[t].type === INTERVAL_TYPES.ROTATION
  );

  if (rotationTasks.length === 0) {
    return null;
  }

  const currentIndex = rotationTasks.indexOf(lastType);
  const nextIndex = (currentIndex + 1) % rotationTasks.length;

  return { taskType: rotationTasks[nextIndex], reason: 'rotation' };
}

// ============================================================
// On-Demand Requests
// ============================================================

/**
 * Who asked for an on-demand run. `'user'` (the default, and what any request
 * already on disk from before this field existed reads as) means a human pressed
 * Run: the drain engines reset the park, the convergence signature, and the
 * dispatch counter so the check runs against live state. `'refill'` means the
 * perpetual drain re-issued ITSELF through the same lane after a completed run —
 * automated, and therefore NOT allowed to clear its own brakes.
 */
export async function triggerOnDemandTask(taskType, appId = null, { emit = true, origin = ON_DEMAND_ORIGINS.USER } = {}) {
  const request = await updateSchedule(async (schedule) => {
    // Cheap per-task-type check first; the master-flag check pays a state.json read.
    const tasks = schedule.tasks || {};
    if (!Object.prototype.hasOwnProperty.call(tasks, taskType)) {
      return { result: { error: `Unknown task type '${taskType}'` }, changed: false };
    }
    if (!tasks[taskType].enabled) {
      return { result: { error: `Task type '${taskType}' is disabled` }, changed: false };
    }

    // Reject if the master Improve toggle is off — request would be silently dropped downstream
    const state = await loadState();
    if (!isImprovementEnabled(state)) {
      return { result: { error: 'Improvement is disabled — enable it in CoS → Config to run on-demand tasks' }, changed: false };
    }

    if (!schedule.onDemandRequests) {
      schedule.onDemandRequests = [];
    }

    const request = {
      id: `demand-${Date.now().toString(36)}`,
      taskType,
      appId,
      origin,
      requestedAt: new Date().toISOString()
    };

    schedule.onDemandRequests.push(request);
    return { result: request, changed: true };
  });

  if (request.error) return request;

  emitLog('info', `On-demand task requested: ${taskType}`, { appId }, '📅 TaskSchedule');
  // The event's only consumer is a `dequeueNextTask()` trigger (cos.js). Callers
  // that already own their own dequeue (the perpetual drain-on-completion refill,
  // which enqueues a re-issue and then drains it via its OWN
  // dequeueNextTask({ ignoreTaskId })) pass `emit: false` to avoid a redundant
  // SECOND dequeue of the same request — which would re-run recordExecution + the
  // work-detector probe. The manual "Run Now" route keeps the default so its
  // request is picked up promptly.
  if (emit) cosEvents.emit('task:on-demand-requested', request);

  return request;
}

export async function getOnDemandRequests() {
  const schedule = await loadSchedule();
  return schedule.onDemandRequests || [];
}

export async function clearOnDemandRequest(requestId) {
  return updateSchedule(async (schedule) => {
    if (!schedule.onDemandRequests) return { result: null, changed: false };

    const index = schedule.onDemandRequests.findIndex(r => r.id === requestId);
    if (index === -1) return { result: null, changed: false };

    const cleared = schedule.onDemandRequests.splice(index, 1)[0];
    return { result: cleared, changed: true };
  });
}

// ============================================================
// Schedule Status
// ============================================================

export async function getScheduleStatus() {
  // Surface the master Improve toggle so the UI can disable Run Now affordances
  const [schedule, state] = await Promise.all([loadSchedule(), loadState()]);

  const status = {
    lastUpdated: schedule.lastUpdated,
    improvementEnabled: isImprovementEnabled(state),
    tasks: {},
    templates: schedule.templates,
    onDemandRequests: schedule.onDemandRequests || [],
    learningAdjustmentsActive: 0,
    dataInputCatalog: getTaskDataInputCatalog()
  };

  // Fetch active apps once for per-app override aggregation
  const activeApps = await getActiveApps().catch(() => []);
  const totalAppCount = activeApps.length;

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    const execution = schedule.executions[`task:${taskType}`] || { lastRun: null, count: 0, perApp: {} };

    // Get learning adjustment info
    const baseInterval = interval.type === 'daily' ? DAY : interval.type === 'weekly' ? WEEK : (interval.intervalMs || DAY);
    const learningInfo = await getPerformanceAdjustedInterval(taskType, baseInterval);

    // Check global shouldRun status
    const check = await shouldRunTask(taskType);

    const isEnabledForApp = (override) => override?.enabled === true;
    const appOverrides = {};
    let enabledAppCount = 0;
    const allOverrides = await mapWithConcurrency(activeApps, 8, (app) => getAppTaskTypeOverrides(app.id));
    for (let i = 0; i < activeApps.length; i++) {
      const override = allOverrides[i][taskType];
      if (override) {
        appOverrides[activeApps[i].id] = {
          enabled: isEnabledForApp(override),
          interval: override.interval || null,
          // Surface the per-app provider/model pin: it OUTRANKS the global pin at
          // spawn for every task type (#4783), so omitting it here made the Schedule
          // page's provider read as authoritative when it wasn't (an app pinned to
          // another provider ran on that one with no hint why).
          ...(override.providerId && { providerId: override.providerId }),
          ...(override.model && { model: override.model }),
          ...(override.taskMetadata && { taskMetadata: override.taskMetadata })
        };
      }
      if (isEnabledForApp(override)) {
        enabledAppCount++;
      }
    }

    const taskStatus = {
      ...interval,
      lastRun: execution.lastRun,
      runCount: execution.count,
      globalLastRun: execution.lastRun,
      globalRunCount: execution.count,
      perAppCount: Object.keys(execution.perApp).length,
      appOverrides,
      enabledAppCount,
      totalAppCount,
      status: check,
      learningAdjusted: learningInfo.adjusted,
      learningMultiplier: learningInfo.multiplier,
      successRate: learningInfo.successRate,
      dataPoints: learningInfo.dataPoints,
      adjustedIntervalMs: learningInfo.adjustedIntervalMs,
      recommendation: learningInfo.recommendation,
      // Whether a "Run Now" with NO app is this type's real run (it sweeps every
      // managed app in one dispatch). Served from the server registry rather than
      // mirrored in client constants, so the UI cannot drift from the set the
      // dispatch engines actually treat as install-wide.
      installWide: INSTALL_WIDE_TASK_TYPES.has(taskType)
    };

    // Include default stage prompts for pipeline tasks so UI can display them
    if (interval.taskMetadata?.pipeline?.stages?.length > 0) {
      taskStatus.stagePrompts = interval.taskMetadata.pipeline.stages.map(stage =>
        DEFAULT_TASK_PROMPTS[stage.promptKey] || null
      );
    }

    // Surface agent-managed flags so the UI can lock the corresponding toggles
    if (MANAGED_AGENT_OPTIONS[taskType]) {
      taskStatus.managedAgentOptions = MANAGED_AGENT_OPTIONS[taskType];
    }

    if (isAuditTaskType(taskType)) {
      taskStatus.fileIssuesCapable = true;
      taskStatus.defaultFileIssues = defaultFileIssuesFor(taskType);
    }

    // Perpetual tasks park PER-APP (parkPerpetual is called with the appId), so
    // the global `status` above (shouldRunTask with no appId) always reads
    // 'perpetual-drain' for app-scoped tasks like claim-issue/claim-work even
    // when every app is parked. Aggregate the per-app (and global) park records
    // so the UI can show the true parked/draining state and the soonest recheck.
    // Projects the shared aggregatePerpetualParks rollup (same park semantics as
    // the getUpcomingTasks eligibility derivation below).
    if (interval.type === INTERVAL_TYPES.PERPETUAL) {
      const parks = aggregatePerpetualParks(execution, Date.now());
      taskStatus.perpetual = {
        globalParked: parks.globalParked,
        parkedAppCount: parks.parkedAppCount,
        trackedAppCount: parks.trackedAppCount,
        nextRecheckAt: parks.soonestParkAt === null ? null : new Date(parks.soonestParkAt).toISOString(),
        parkReason: parks.parkReason
      };
    }

    status.tasks[taskType] = taskStatus;

    if (learningInfo.adjusted) {
      status.learningAdjustmentsActive++;
    }
  }

  return status;
}

/**
 * Reset execution history for a task type
 */
export async function resetExecutionHistory(taskType, appId = null) {
  const result = await updateSchedule(async (schedule) => {
    const key = `task:${taskType}`;

    if (!schedule.executions[key]) {
      return { result: { error: 'No execution history found' }, changed: false };
    }

    if (appId) {
      if (schedule.executions[key].perApp?.[appId]) {
        delete schedule.executions[key].perApp[appId];
      }
    } else {
      delete schedule.executions[key];
    }

    return { result: { success: true, taskType, appId }, changed: true };
  });

  if (result.error) return result;
  emitLog('info', `Reset execution history for ${taskType}`, { appId }, '📅 TaskSchedule');

  return result;
}

// ============================================================
// Upcoming Tasks Preview
// ============================================================

/**
 * Aggregate a perpetual task's park records into a single upcoming-eligibility
 * verdict for getUpcomingTasks.
 *
 * Perpetual parks are recorded PER-APP (parkPerpetual is always called with an
 * appId — see applyPerpetualWorkGate / the reconcile blocks in cosTaskGenerator),
 * so the top-level execution record is only a container and never carries its own
 * `parkedUntil` for the app-scoped drains (claim-issue, claim-work, branch-/
 * issue-reconcile). The GLOBAL `shouldRunTask` therefore always reads
 * 'perpetual-drain' (shouldRun:true) even when every app is parked on its recheck
 * cadence — which made getUpcomingTasks report the task 'ready' forever and hid
 * its real next-recheck boundary (e.g. a `recheckCron: '0 9 * * *'`) from
 * scheduleNextImprovementCheck. The daemon then never woke AT 9am; the parked
 * drain only resumed on the ≤1h fallback poll, so a task configured for 9am ran
 * up to an hour late (or read as "didn't run").
 *
 * Derive eligibility from the shared aggregatePerpetualParks rollup instead (see
 * its GLOBAL-RECORD INCLUSION RULE for which scopes count). Returns:
 *   - null                                    → no tracked scope yet (caller keeps its global 'ready' default)
 *   - { status:'ready', eligibleAt:now }      → some tracked scope is due now (unparked or park elapsed)
 *   - { status:'scheduled', eligibleAt:<ms> } → every tracked scope parked; soonest recheck
 */
function perpetualUpcomingEligibility(execution, now) {
  const parks = aggregatePerpetualParks(execution, now);
  if (parks.trackedCount === 0) return null;
  return parks.anyDueNow
    ? { status: 'ready', eligibleAt: now }
    : { status: 'scheduled', eligibleAt: parks.soonestParkAt };
}

export async function getUpcomingTasks(limit = 10) {
  const schedule = await loadSchedule();
  const now = Date.now();
  const upcoming = [];

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!interval.enabled) continue;
    if (interval.type === INTERVAL_TYPES.ON_DEMAND) continue;

    const check = await shouldRunTask(taskType);
    const execution = schedule.executions[`task:${taskType}`] || { lastRun: null, count: 0 };

    let eligibleAt = now;
    let taskStatus = 'ready';

    if (check.shouldRun) {
      eligibleAt = now;
      taskStatus = 'ready';
    } else if (check.nextRunAt) {
      eligibleAt = new Date(check.nextRunAt).getTime();
      taskStatus = 'scheduled';
    } else if (interval.type === INTERVAL_TYPES.ONCE && execution.count > 0) {
      taskStatus = 'completed';
      eligibleAt = Infinity;
    }

    // Perpetual tasks park per-app, so the global `check` above can't see the
    // recheck boundary — re-derive status/eligibility from the park records so
    // scheduleNextImprovementCheck wakes the daemon AT the next recheck (e.g. 9am)
    // instead of only on the ≤1h fallback poll. See perpetualUpcomingEligibility.
    if (interval.type === INTERVAL_TYPES.PERPETUAL) {
      const perpetual = perpetualUpcomingEligibility(execution, now);
      if (perpetual) {
        taskStatus = perpetual.status;
        eligibleAt = perpetual.eligibleAt;
      }
    }

    if (taskStatus === 'completed') continue;

    upcoming.push({
      taskType,
      intervalType: interval.type,
      status: taskStatus,
      eligibleAt,
      eligibleIn: eligibleAt - now,
      eligibleInFormatted: formatTimeRemaining(eligibleAt - now),
      lastRun: execution.lastRun,
      lastRunFormatted: execution.lastRun ? formatRelativeTime(new Date(execution.lastRun).getTime()) : 'never',
      runCount: execution.count,
      successRate: check.successRate ?? null,
      learningAdjusted: check.learningApplied || false,
      adjustmentMultiplier: check.adjustmentMultiplier || 1.0,
      description: getTaskTypeDescription(taskType)
    });
  }

  upcoming.sort((a, b) => {
    if (a.status === 'ready' && b.status !== 'ready') return -1;
    if (b.status === 'ready' && a.status !== 'ready') return 1;
    return a.eligibleAt - b.eligibleAt;
  });

  return upcoming.slice(0, limit);
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return '< 1m';
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}
