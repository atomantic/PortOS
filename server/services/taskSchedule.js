/**
 * Task Schedule Service (v2 - Unified)
 *
 * Manages configurable intervals for improvement tasks across all apps (including PortOS).
 * All task types live in a single `tasks` object — no more selfImprovement/appImprovement split.
 *
 * Cadence model (two variants + one orthogonal flag):
 * - type 'on-demand': never auto-queued; only a manual trigger runs it.
 * - type 'cron': clock-scheduled from `cronExpression` (5-field), with catch-up.
 * - `perpetual: true` (independent of type): drain actionable work back-to-back
 *   (re-queue on completion) until a programmatic work-detector reports nothing
 *   actionable, then PARK on a recheck cadence. An on-demand+perpetual task
 *   rechecks on `recheckCron` / `recheckIntervalMs` (default daily); a
 *   cron+perpetual task's cron slot INITIATES the drain and the same expression
 *   gates the next attempt once it parks.
 *   See server/services/perpetualWork.js for the detector registry and the
 *   perpetual gate in cosTaskGenerator.generateManagedAppImprovementTaskForType.
 */

import { cosEvents, emitLog } from './cosEvents.js';
import { DAY, safeDate } from '../lib/fileUtils.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { getAdaptiveCooldownMultiplier } from './taskLearning.js';
import { isTaskTypeEnabledForApp, getAppTaskTypeInterval, getAppTaskTypeIntervalMs, getActiveApps, getAppTaskTypeOverrides, clearAllPrWatcherState, clearAllIssueWatcherState } from './apps.js';
import { loadState, isImprovementEnabled } from './cosState.js';
import { getLocalParts } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';
import { parseCronToNextRun, parseCronToPrevRun } from './eventScheduler.js';
import { isAuditTaskType, defaultFileIssuesFor, auditDoWorkRequiresWorktree } from '../lib/auditCatalog.js';
import { DEFAULT_TASK_PROMPTS } from './taskPromptDefaults.js';
import {
  DEFAULT_PERPETUAL_RECHECK_MS,
  INTERVAL_TYPES,
  ON_DEMAND_ORIGINS,
  decodeIntervalType,
  isCronExpression,
  isRefillRequest
} from './taskScheduleConstants.js';
import {
  DEFAULT_TASK_INTERVALS,
  INSTALL_WIDE_TASK_TYPES,
  MANAGED_APP_TARGET_TASK_TYPES,
  MANAGED_AGENT_OPTIONS,
  getTaskTypeDescription,
  getTaskTypeInvocation,
  getTaskTypePromptInfo,
  requiresManagedAppTarget,
  enforceBranchReconcileBatch,
  enforceManagedAgentOptions
} from './taskScheduleRegistry.js';
import { loadSchedule, updateSchedule } from './taskScheduleStore.js';
import { isInstanceFeatureEnabled } from './instanceFeatures.js';
import { recordUserAction } from './userActions.js';
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
  MANAGED_APP_TARGET_TASK_TYPES,
  MANAGED_AGENT_OPTIONS, PERPETUAL_DRAIN_DISPATCH_CAP, SELF_IMPROVEMENT_TASK_TYPES,
  TASK_TYPE_DESCRIPTIONS, TASK_TYPE_INVOCATION, TASK_TYPE_PROMPT_INFO,
  getTaskTypeInvocation, getTaskTypePromptInfo, requiresManagedAppTarget,
  stripManagedAgentOptionsFromOverride
} from './taskScheduleRegistry.js';
export { loadSchedule } from './taskScheduleStore.js';
export {
  FAILURE_BACKOFF_BASE_MS, FAILURE_BACKOFF_CAP_MS, FAILURE_PARK_THRESHOLD,
  clearTaskTypeFailurePark, computeFailureBackoffMs, recordTaskTypeFailure,
  recordTaskTypeSuccess
} from './taskScheduleBackoff.js';
export { addTemplateTask, deleteTemplateTask, getTemplateTasks } from './taskScheduleTemplates.js';

const createFeatureGate = () => {
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
  return schedule.tasks[taskType] || {
    type: INTERVAL_TYPES.ON_DEMAND,
    perpetual: false,
    enabled: false,
    providerId: null,
    model: null,
    description: getTaskTypeDescription(taskType),
  };
}

export async function updateTaskInterval(taskType, settings) {
  const { task, unparkedScopes } = await updateSchedule(async (schedule) => {
    if (!schedule.tasks[taskType]) {
      schedule.tasks[taskType] = { type: INTERVAL_TYPES.ON_DEMAND, perpetual: false, enabled: false, providerId: null, model: null, createdAt: new Date().toISOString() };
    }

    // Normalize empty/whitespace prompts to null (treated as "use default")
    if ('prompt' in settings && typeof settings.prompt === 'string' && !settings.prompt.trim()) {
      settings.prompt = null;
    }
    // The description is display-only schedule metadata. Keep it separate from
    // the prompt so custom card copy never becomes agent instructions.
    if ('description' in settings) {
      settings.description = typeof settings.description === 'string'
        ? settings.description.trim().slice(0, 240) || null
        : null;
    }
    // If user is setting a custom prompt, mark it so auto-upgrade won't overwrite it.
    // If user clears the prompt (null), remove the customized flag to resume defaults.
    //
    // `promptSource: 'user'` records that this write was an EXPLICIT user action,
    // which is what the store's self-heal reads to leave the pin alone (#5432).
    // Without it, pasting an older SHIPPED body into Settings → Scheduled Tasks was
    // un-pinnable: the self-heal saw a body matching a retired default, cleared the
    // flag on the next load, and the next PROMPT_VERSIONS bump overwrote the text.
    //
    // A body identical to the CURRENT default is not a pin. The editor prefills its
    // textarea from the stored prompt, so re-saving an untouched default would
    // otherwise stamp a permanent pin and freeze that type off every future prompt
    // upgrade — which is exactly the mis-flag the self-heal existed to undo, now
    // beyond its reach. Retired shipped bodies still pin: that is the #5432 case.
    if ('prompt' in settings) {
      settings.promptCustomized = settings.prompt != null
        && settings.prompt !== DEFAULT_TASK_PROMPTS[taskType];
      settings.promptSource = settings.promptCustomized ? 'user' : null;
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
    if (['pr-watcher', 'issue-watcher'].includes(taskType) && settings.enabled === false) {
      delete schedule.executions[`task:${taskType}`];
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
    if (merged.perpetual && ('recheckCron' in settings || 'recheckIntervalMs' in settings || 'cronExpression' in settings)) {
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
  if (taskType === 'issue-watcher' && settings.enabled === false) {
    await clearAllIssueWatcherState().catch((err) => {
      emitLog('warn', `issue-watcher global-disable state clear failed: ${err.message}`, {}, '📅 TaskSchedule');
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
 * A cron-scheduled perpetual task rechecks on its own `cronExpression`;
 * otherwise this prefers `recheckCron` (a 5-field cron string, evaluated in the
 * user's timezone) over `recheckIntervalMs`, falling back to
 * DEFAULT_PERPETUAL_RECHECK_MS.
 * Returns an ISO timestamp string.
 */
export async function computePerpetualRecheckAt(interval, fromMs = Date.now()) {
  // A cron+perpetual task needs no separate recheck cadence: its own schedule
  // both initiates the drain and gates the next attempt after it parks.
  const cron = (interval?.type === INTERVAL_TYPES.CRON && isCronExpression(interval?.cronExpression))
    ? interval.cronExpression
    : interval?.recheckCron;
  if (isCronExpression(cron)) {
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
    const depPerAppInterval = appId ? await getAppTaskTypeInterval(appId, dep) : null;
    if ((depPerAppInterval || depConfig.type) === INTERVAL_TYPES.ON_DEMAND) continue;

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
 * Check if a task type should run for a specific app (or globally)
 */
export async function shouldRunTask(taskType, appId = null, { featureEnabled = createFeatureGate() } = {}) {
  const schedule = await loadSchedule();
  const interval = schedule.tasks[taskType];

  if (!interval || !interval.enabled) {
    return { shouldRun: false, reason: 'disabled' };
  }
  if (!(await featureEnabled(interval))) {
    return { shouldRun: false, reason: 'feature-disabled', feature: interval.feature };
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
  // layered-intelligence, whose Intelligence-tab UI offers sub-daily cadences a
  // named cadence never expressed). A legacy `interval: 'custom'` override
  // decodes THIS value into the per-app cron expression below.
  const perAppIntervalMs = appId ? await getAppTaskTypeIntervalMs(appId, taskType) : null;
  // A per-app override may be a raw cron expression or a retired named cadence
  // written by an older install; decode both onto the two-variant model.
  const perAppDecoded = perAppInterval
    ? decodeIntervalType(perAppInterval, { intervalMs: perAppIntervalMs })
    : null;
  const effectiveType = perAppDecoded ? perAppDecoded.type : interval.type;
  const effectiveCron = perAppDecoded
    ? perAppDecoded.cronExpression
    : (interval.cronExpression || null);
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

  let result;

  // A perpetual task's park record is the drain's brake: the work-detector at
  // DISPATCH time writes `parkedUntil` when nothing is actionable, and this only
  // READS it (so shouldRunTask never does network I/O). Shared by both cadence
  // variants — an on-demand+perpetual task is due whenever it isn't parked, a
  // cron+perpetual task additionally needs a cron slot to initiate a drain.
  const perpetualParkResult = () => {
    const parkUntil = parkedUntilMs(appExecution);
    if (parkUntil && now < parkUntil) {
      return {
        shouldRun: false,
        reason: 'perpetual-parked',
        nextRunAt: new Date(parkUntil).toISOString(),
        parkReason: appExecution.parkReason || null,
        parkActionableCount: appExecution.parkActionableCount ?? null
      };
    }
    return parkUntil ? { shouldRun: true, reason: 'perpetual-recheck' } : null;
  };

  switch (effectiveType) {
    case INTERVAL_TYPES.ON_DEMAND:
      // Drain-until-done when perpetual; otherwise a manual trigger is the only
      // way this ever runs.
      result = isPerpetual
        ? (perpetualParkResult() || { shouldRun: true, reason: 'perpetual-drain' })
        : { shouldRun: false, reason: 'on-demand-only' };
      break;

    case INTERVAL_TYPES.CRON: {
      // A parked perpetual drain is gated by its park, not by the cron slot —
      // and once the park elapses it is due immediately (computePerpetualRecheckAt
      // already derived that instant from this very expression).
      if (isPerpetual) {
        const parked = perpetualParkResult();
        if (parked) { result = parked; break; }
        // Unparked: the cron evaluation below decides whether to INITIATE a
        // drain. Once one is running, the completion-refill lane keeps it going
        // back-to-back regardless of subsequent ticks.
      }
      // Cron expression: per-app override (stored as the interval string) or global config
      const cronExpr = effectiveCron;
      if (!isCronExpression(cronExpr)) {
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

    default:
      // Unreachable once normalized — an unreadable cadence must never auto-run.
      result = { shouldRun: false, reason: 'on-demand-only' };
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
    const depCheck = await checkRunAfterDeps(schedule, taskType, appId, featureEnabled);
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
  const featureEnabled = createFeatureGate();

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!interval.enabled) continue;

    const check = await shouldRunTask(taskType, appId, { featureEnabled });
    if (check.shouldRun) {
      due.push({ taskType, reason: check.reason, interval });
    }
  }

  return due;
}

/**
 * Get the next task type to run (optionally for a specific app)
 */
export async function getNextTaskType(appId = null, { perpetualOnly = false } = {}) {
  const dueTasks = await getDueTasks(appId);

  // `perpetualOnly` constrains the pick to a due perpetual (drain-until-done)
  // task, skipping every other schedule type. Callers set this when the app is
  // on its review cooldown: only perpetual drains bypass that cooldown (their
  // work-detector park is the throttle), so a higher-priority cron type that's
  // also due must NOT be returned — it would mask the perpetual drain and the
  // caller, seeing a non-exempt pick, would skip the whole app for the cooldown
  // window (the mixed-schedule stall). Returns null when nothing perpetual is
  // due, so the caller leaves the cooled-down app alone.
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
export async function triggerOnDemandTask(taskType, appId = null, { emit = true, origin = ON_DEMAND_ORIGINS.USER, targetPullRequest = null } = {}) {
  // A targeted run names ONE open PR/MR instead of letting the task pick from
  // the app's whole open set (the PR/MR row's "Review this PR" button). Coerced
  // and validated here so a bad value can't reach the generator's forge filter.
  const requested = Number(targetPullRequest);
  const scopedPullRequest = Number.isInteger(requested) && requested > 0 ? requested : null;
  const request = await updateSchedule(async (schedule) => {
    // Cheap per-task-type check first; the master-flag check pays a state.json read.
    const tasks = schedule.tasks || {};
    if (!Object.prototype.hasOwnProperty.call(tasks, taskType)) {
      return { result: { error: `Unknown task type '${taskType}'` }, changed: false };
    }
    if (!tasks[taskType].enabled) {
      return { result: { error: `Task type '${taskType}' is disabled` }, changed: false };
    }
    if (!(await createFeatureGate()(tasks[taskType]))) {
      return { result: { error: `Task type '${taskType}' requires the '${tasks[taskType].feature}' feature` }, changed: false };
    }
    const invocation = getTaskTypeInvocation(taskType);
    if (origin === ON_DEMAND_ORIGINS.USER && !invocation.userInvokable) {
      return { result: { error: `Task type '${taskType}' is managed by another automation and cannot be run manually` }, changed: false };
    }
    if (requiresManagedAppTarget(taskType) && !appId) {
      return { result: { error: `Task type '${taskType}' requires a managed app target` }, changed: false };
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
      requestedAt: new Date().toISOString(),
      ...(scopedPullRequest ? { targetPullRequest: scopedPullRequest } : {})
    };

    schedule.onDemandRequests.push(request);
    return { result: request, changed: true };
  });

  if (request.error) return request;

  // Operator-action ledger (#5594): ONLY a human pressing Run Now. The perpetual
  // drain re-issues itself through this same lane with `origin: REFILL` — logging
  // that would fill the ledger with events the user never performed and make
  // "what did I trigger?" unanswerable.
  if (origin === ON_DEMAND_ORIGINS.USER) {
    await recordUserAction({
      type: 'cos.schedule.trigger',
      target: taskType,
      targetName: appId,
      summary: `Ran scheduled task '${taskType}' on demand${appId ? ` for ${appId}` : ''}${scopedPullRequest ? ` (#${scopedPullRequest})` : ''}`,
      payload: { taskType, appId: appId ?? null, requestId: request.id, ...(scopedPullRequest ? { targetPullRequest: scopedPullRequest } : {}) },
      source: { service: 'taskSchedule', fn: 'triggerOnDemandTask' },
      happenedAt: request.requestedAt,
      dedupeKey: `cos.schedule.trigger:${request.id}`,
    });
  }

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
  const featureEnabled = createFeatureGate();
  return getAvailableOnDemandRequests(schedule, featureEnabled);
}

async function getAvailableOnDemandRequests(schedule, featureEnabled) {
  const requests = schedule.onDemandRequests || [];
  const availability = await Promise.all(requests.map((request) => (
    featureEnabled(schedule.tasks?.[request.taskType])
  )));
  return requests.filter((_request, index) => availability[index]);
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
  const featureEnabled = createFeatureGate();
  const onDemandRequests = (await getAvailableOnDemandRequests(schedule, featureEnabled))
    .filter(request => getTaskTypeInvocation(request.taskType).visibility !== 'hidden');

  const status = {
    lastUpdated: schedule.lastUpdated,
    improvementEnabled: isImprovementEnabled(state),
    tasks: {},
    templates: schedule.templates,
    onDemandRequests,
    learningAdjustmentsActive: 0,
    dataInputCatalog: getTaskDataInputCatalog()
  };

  // Fetch active apps once for per-app override aggregation
  const activeApps = await getActiveApps().catch(() => []);
  const totalAppCount = activeApps.length;

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!(await featureEnabled(interval))) continue;
    const invocation = getTaskTypeInvocation(taskType);
    if (invocation.visibility === 'hidden') continue;
    const execution = schedule.executions[`task:${taskType}`] || { lastRun: null, count: 0, perApp: {} };
    const promptInfo = getTaskTypePromptInfo(taskType);

    // Get learning adjustment info
    const baseInterval = interval.intervalMs || DAY;
    const learningInfo = await getPerformanceAdjustedInterval(taskType, baseInterval);

    // Check global shouldRun status
    const check = await shouldRunTask(taskType, null, { featureEnabled });

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
      description: interval.description || getTaskTypeDescription(taskType),
      promptMode: promptInfo.mode,
      ...(promptInfo.description ? { promptDescription: promptInfo.description } : {}),
      invocation,
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
      if (auditDoWorkRequiresWorktree(taskType)) {
        taskStatus.doWorkRequiresWorktree = true;
      }
    } else if (taskType === 'user-action-review') {
      // Not an audit-catalog type (no mode-contract injection — its
      // alternative to filing issues is queueing CoS tasks, not editing code),
      // but its deliverable posture is the same fileIssues toggle, so the
      // schedule UI surfaces the switch the same way.
      taskStatus.fileIssuesCapable = true;
      taskStatus.defaultFileIssues = true;
    }

    // Perpetual tasks park PER-APP (parkPerpetual is called with the appId), so
    // the global `status` above (shouldRunTask with no appId) always reads
    // 'perpetual-drain' for app-scoped tasks like claim-issue/claim-work even
    // when every app is parked. Aggregate the per-app (and global) park records
    // so the UI can show the true parked/draining state and the soonest recheck.
    // Projects the shared aggregatePerpetualParks rollup (same park semantics as
    // the getUpcomingTasks eligibility derivation below).
    if (interval.perpetual) {
      const parks = aggregatePerpetualParks(execution, Date.now());
      // Named apart from the `perpetual` BOOLEAN this config carries: the flag
      // says the task drains, this says what its drain is doing right now.
      taskStatus.perpetualStatus = {
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
  const featureEnabled = createFeatureGate();

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!interval.enabled) continue;
    if (!(await featureEnabled(interval))) continue;
    if (getTaskTypeInvocation(taskType).visibility === 'hidden') continue;
    // On-demand tasks have no wall-clock position — unless they are perpetual,
    // whose park/recheck boundary IS the schedule the daemon must wake on.
    if (interval.type === INTERVAL_TYPES.ON_DEMAND && !interval.perpetual) continue;

    const check = await shouldRunTask(taskType, null, { featureEnabled });
    const execution = schedule.executions[`task:${taskType}`] || { lastRun: null, count: 0 };

    let eligibleAt = now;
    let taskStatus = 'ready';

    if (check.shouldRun) {
      eligibleAt = now;
      taskStatus = 'ready';
    } else if (check.nextRunAt) {
      eligibleAt = new Date(check.nextRunAt).getTime();
      taskStatus = 'scheduled';
    }

    // Perpetual tasks park per-app, so the global `check` above can't see the
    // recheck boundary — re-derive status/eligibility from the park records so
    // scheduleNextImprovementCheck wakes the daemon AT the next recheck (e.g. 9am)
    // instead of only on the ≤1h fallback poll. See perpetualUpcomingEligibility.
    if (interval.perpetual) {
      const perpetual = perpetualUpcomingEligibility(execution, now);
      if (perpetual) {
        taskStatus = perpetual.status;
        eligibleAt = perpetual.eligibleAt;
      }
    }

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
      description: interval.description || getTaskTypeDescription(taskType)
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
