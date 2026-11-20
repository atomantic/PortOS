/**
 * Task Schedule Service (v2 - Unified)
 *
 * Manages configurable intervals for improvement tasks across all apps (including PortOS).
 * All task types live in a single `tasks` object — no more selfImprovement/appImprovement split.
 *
 * Cadence model (two variants + one orthogonal flag):
 * - type 'on-demand': never auto-queued; only a manual trigger runs it.
 * - type 'cron': clock-scheduled from `cronExpression` (5-field), without replaying missed slots.
 * - `perpetual: true` (independent of type): drain actionable work back-to-back
 *   (re-queue on completion) until a programmatic work-detector reports nothing
 *   actionable, then PARK on a recheck cadence. An on-demand+perpetual task
 *   rechecks on `recheckCron` / `recheckIntervalMs` (default daily); a
 *   cron+perpetual task's cron slot INITIATES the drain and the same expression
 *   gates the next attempt once it parks. With `autoStart: false`, on-demand
 *   drains start only on explicit dispatch and never wake on a recheck timer.
 *   Omitted autoStart preserves legacy automatic on-demand drains.
 *   See server/services/perpetualWork.js for the detector registry and the
 *   perpetual gate in cosTaskGenerator.prepareManagedAppImprovementTask.
 */

import { scheduleExecutionFieldsSchema } from '../lib/scheduleExecutionFieldsValidation.js';
import { randomUUID } from 'node:crypto';
import { ServerError } from '../lib/errorHandler.js';
import { TASK_READINESS_REASON } from '../lib/taskReadinessReasons.js';
import { cosEvents, emitLog } from './cos/cosEvents.js';
import { getActiveApps, clearAllPrWatcherState, clearAllIssueWatcherState } from './apps.js';
import { loadState, isImprovementEnabled } from './cos/cosState.js';
import { stampPromptWrite } from './taskPromptDefaults.js';
import { INTERVAL_TYPES, ON_DEMAND_ORIGINS, isUserOriginRequest } from './taskScheduleConstants.js';
import {
  TASK_INPUT_PATHS,
  getTaskTypeDescription,
  getTaskTypeInvocation,
  enforceBranchReconcileBatch,
  enforceManagedAgentOptions
} from './taskScheduleRegistry.js';
import { ensureExecutionRecord, loadSchedule, updateSchedule } from './taskScheduleStore.js';
import { recordUserAction } from './userActions.js';
import { isManualOnDemandRequest, normalizeQuotaBurnProvenance } from '../lib/quotaBurnOrigin.js';
import { enabledAppIdsByTaskType, evaluateOnDemandEligibility } from '../lib/quotaBurnTaskRef.js';
import { clearFailureLedgerFields, clearTaskTypeFailureParkNotification } from './taskScheduleBackoff.js';
import { boundParkedUntil, computePerpetualRecheckAt, parkedUntilMs } from './taskSchedulePerpetual.js';
import { createFeatureGate, getAvailableOnDemandRequests, inputsUnchangedForTask } from './taskScheduleEvaluator.js';

export { PROMPT_VERSIONS, REFERENCE_WATCH_AUDITED_VERSION } from './taskPromptDefaults.js';
export { INTERVAL_TYPES, ON_DEMAND_ORIGINS } from './taskScheduleConstants.js';
export { DEFAULT_TASK_INTERVALS, INSTALL_WIDE_TASK_TYPES, SELF_IMPROVEMENT_TASK_TYPES, getTaskTypeInvocation, requiresManagedAppTarget, requiresInstallWideTarget, isProgrammaticScheduledTaskType, stripManagedAgentOptionsFromOverride } from './taskScheduleRegistry.js';
export { loadSchedule } from './taskScheduleStore.js';
export { recordTaskTypeFailure, recordTaskTypeSuccess } from './taskScheduleBackoff.js';

export {
  computePerpetualRecheckAt,
  boundParkedUntil,
  parkPerpetual,
  getPerpetualParkInfo,
  recordPerpetualStall,
  isPerpetualParkActive,
  getPerpetualDrainState,
  recordPerpetualDispatch,
  resetPerpetualForManualRun,
  applyOnDemandRunResets
} from './taskSchedulePerpetual.js';
export {
  createFeatureGate,
  shouldRunTask,
  shouldContinuePerpetualDrain,
  getDueTasks,
  getNextTaskType
} from './taskScheduleEvaluator.js';
export { getScheduleStatus, getUpcomingTasks } from './taskScheduleStatus.js';

// Settings whose edit is not an "I've addressed the cause" signal, so saving
// one leaves a failure-parked task parked (see the unpark block below).
const PRESENTATION_ONLY_SETTINGS = new Set(['labels', 'suggestedAfter']);

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
  const executionFields = scheduleExecutionFieldsSchema.safeParse(settings);
  if (!executionFields.success) {
    throw new ServerError('Invalid schedule execution fields', { status: 400, code: 'VALIDATION_ERROR' });
  }
  settings = { ...settings, ...executionFields.data };
  const { task, unparkedScopes } = await updateSchedule(async (schedule) => {
    if (!schedule.tasks[taskType]) {
      schedule.tasks[taskType] = { type: INTERVAL_TYPES.ON_DEMAND, perpetual: false, enabled: false, providerId: null, model: null, createdAt: new Date().toISOString() };
    }

    // The description is display-only schedule metadata. Keep it separate from
    // the prompt so custom card copy never becomes agent instructions.
    if ('description' in settings) {
      settings.description = typeof settings.description === 'string'
        ? settings.description.trim().slice(0, 240) || null
        : null;
    }
    if ('prompt' in settings) {
      Object.assign(settings, stampPromptWrite(settings.prompt, taskType));
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
    // Page-organizing edits do not signal that a failed task is repaired:
    // labels group the cards and `suggestedAfter` orders them, neither touching
    // what the task does when it runs.
    const presentationOnly = Object.keys(settings).every(key => PRESENTATION_ONLY_SETTINGS.has(key));
    if (topExec && !presentationOnly) {
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

/**
 * Keep the latest triage output of an audit beside its execution record so the
 * Schedule card can show it (#12085). Machine-local: the execution store never
 * federates. An empty list clears nothing — a run that produced no
 * recommendation leaves the previous one visible rather than erasing it.
 */
export async function recordRecommendedAudits(taskType, appId, items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return updateSchedule(async (schedule) => {
    const key = taskType.startsWith('task:') ? taskType : `task:${taskType}`;
    schedule.executions[key] ||= { lastRun: null, count: 0, perApp: {} };
    schedule.executions[key].recommendedAudits = {
      at: new Date().toISOString(),
      appId: appId || null,
      items: items.slice(0, 3).map(item => String(item).slice(0, 300)),
    };
    return { result: schedule.executions[key].recommendedAudits, changed: true };
  });
}

/**
 * Baseline for the `inputs-unchanged` gate: the repo HEAD of the last clean run
 * of an input-gated task. A failed or finding-producing run passes `null`, which
 * drops the baseline so the next automatic launch runs.
 */
export async function recordCleanInputBaseline(taskType, appId, head) {
  if (!TASK_INPUT_PATHS[taskType] || !appId) return false;
  return updateSchedule(async (schedule) => {
    const record = ensureExecutionRecord(schedule, taskType, appId);
    if ((record.lastCleanHead ?? null) === (head ?? null)) return { result: false, changed: false };
    if (head) record.lastCleanHead = head;
    else delete record.lastCleanHead;
    return { result: true, changed: true };
  });
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
export async function triggerOnDemandTask(taskType, appId = null, {
  emit = true, origin = ON_DEMAND_ORIGINS.USER, targetPullRequest = null, burn = null,
  provider = null, model = null, effort = null, executionOptions, targetModels = null, cleanupSourceAgentId = null,
} = {}) {
  if (cleanupSourceAgentId != null && (typeof cleanupSourceAgentId !== 'string' || !/^agent-[a-z0-9-]{1,100}$/i.test(cleanupSourceAgentId))) {
    return { error: 'Invalid swarm cleanup continuation source' };
  }
  // A targeted run names ONE open PR/MR instead of letting the task pick from
  // the app's whole open set (the PR/MR row's "Review this PR" button). Coerced
  // and validated here so a bad value can't reach the generator's forge filter.
  const requested = Number(targetPullRequest);
  const scopedPullRequest = Number.isInteger(requested) && requested > 0 ? requested : null;
  // Burn provenance rides ON the request because acceptance is asynchronous —
  // an on-demand engine generates the task minutes later and stamps these keys
  // onto it (lib/quotaBurnOrigin.js). Refused BEFORE the schedule write rather
  // than dropped: an unattributable burn would leave a task that reads as
  // cooldown-exempt with no family to credit its refusal to.
  const burnProvenance = origin === ON_DEMAND_ORIGINS.QUOTA_BURN ? normalizeQuotaBurnProvenance(burn) : null;
  if (origin === ON_DEMAND_ORIGINS.QUOTA_BURN && !burnProvenance) {
    return { error: 'A quota-burn request must name the burning family and its burn step' };
  }
  // Optional per-request provider/model/effort pin (the PR/MR row's "Run with"
  // picker) — layered onto the task's metadata by
  // prepareManagedAppImprovementTask as the MOST specific pin, above
  // the schedule interval and the app's own per-app override.
  const providerOverride = (provider || model || effort || executionOptions) ? { provider, model, effort, ...(executionOptions !== undefined ? { executionOptions } : {}) } : null;
  const manual = isManualOnDemandRequest({ origin, burn: burnProvenance });
  // Unattended launches (burn, refill) of an input-gated audit are declined while
  // nothing it reads changed since its last clean run; a human Run always goes.
  if (!manual && await inputsUnchangedForTask(taskType, appId, await loadSchedule())) {
    return { error: `Task type '${taskType}' inputs are unchanged since its last clean run`, reason: TASK_READINESS_REASON.INPUTS_UNCHANGED };
  }
  const request = await updateSchedule(async (schedule) => {
    const tasks = schedule.tasks || {};
    const config = Object.prototype.hasOwnProperty.call(tasks, taskType) ? tasks[taskType] : null;
    const entry = config ? {
      enabled: manual || config.enabled === true,
      featureEnabled: await createFeatureGate()(config),
      feature: config.feature || null,
      // A quota burn faces this gate alongside a human Run: a type owned by
      // another automation is not something an unattended burn may commandeer
      // either. Only the drain's own REFILL is exempt — it is that automation
      // re-issuing itself.
      eligible: origin === ON_DEMAND_ORIGINS.REFILL || getTaskTypeInvocation(taskType).userInvokable !== false,
      // Per-app enablement is a rung for an UNATTENDED origin only. A human
      // pressing Run is deliberately overriding the app's cadence switch — the
      // drain's applyOnDemandRunResets exists for exactly that — while a burn
      // or a notification hand-off picks its own target and must respect the
      // switch the user set. Omitted,
      // the ladder skips the rung.
      appIds: (origin === ON_DEMAND_ORIGINS.QUOTA_BURN || origin === ON_DEMAND_ORIGINS.GITHUB_NOTIFICATION) && !manual
        ? enabledAppIdsByTaskType(await getActiveApps().catch(() => [])).get(taskType) || []
        : undefined,
    } : null;

    // The ladder itself lives in lib/quotaBurnTaskRef.js so the Quota Burn page
    // renders exactly the verdict this dispatch would produce (#6405).
    const gate = evaluateOnDemandEligibility({ taskType, appId, entry });
    if (gate) return { result: { error: gate.reason }, changed: false };

    // The master Improve switch is the one ladder input that pays a state.json
    // read, so it is resolved only once the cheap rungs pass and then fed back
    // through the SAME ladder — the rung is never restated here. Rejecting on it
    // matters: the request would be silently dropped downstream.
    const improvement = evaluateOnDemandEligibility({
      taskType, appId, entry, improvementEnabled: isImprovementEnabled(await loadState()),
    });
    if (improvement) return { result: { error: improvement.reason }, changed: false };

    // The source receipt and request share this write: if the server stops
    // before the agent record is marked, replay must not enqueue a second run.
    const pending = schedule.swarmCleanupRefillPending?.[cleanupSourceAgentId];
    if (cleanupSourceAgentId && pending) {
      if (schedule.onDemandHandoffs?.[pending.id]) {
        return { result: { ...pending, alreadyQueued: true }, changed: false };
      }
      if (!schedule.onDemandRequests?.some(row => row.id === pending.id)) {
        schedule.onDemandRequests ||= [];
        schedule.onDemandRequests.push(pending);
        return { result: { ...pending, alreadyQueued: true }, changed: true };
      }
      return { result: { ...pending, alreadyQueued: true }, changed: false };
    }

    if (!schedule.onDemandRequests) {
      schedule.onDemandRequests = [];
    }

    const request = {
      id: `demand-${randomUUID()}`,
      taskType,
      appId,
      origin,
      requestedAt: new Date().toISOString(),
      ...(cleanupSourceAgentId ? { cleanupSourceAgentId } : {}),
      ...(scopedPullRequest ? { targetPullRequest: scopedPullRequest } : {}),
      ...(burnProvenance ? { burn: burnProvenance } : {}),
      ...(providerOverride ? { providerOverride } : {}),
      ...(Array.isArray(targetModels) && targetModels.length > 0 ? { targetModels } : {})
    };

    schedule.onDemandRequests.push(request);
    if (cleanupSourceAgentId) {
      schedule.swarmCleanupRefillPending ||= {};
      schedule.swarmCleanupRefillPending[cleanupSourceAgentId] = request;
    }
    return { result: request, changed: true };
  });

  if (request.error) return request;

  // Operator-action ledger (#5594): ONLY a human pressing Run Now. The perpetual
  // drain re-issues itself through this same lane with `origin: REFILL` — logging
  // that would fill the ledger with events the user never performed and make
  // "what did I trigger?" unanswerable.
  if (isUserOriginRequest(request)) {
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

/**
 * Queue the next item in a perpetual drain without treating it as a human
 * pressing Run. The two options are an inseparable policy pair: the refill's
 * completion handler owns dequeue, and the automated origin must preserve the
 * drain's park, convergence signature, and dispatch counter.
 */
export async function queuePerpetualRefill(taskType, appId, { cleanupSourceAgentId = null } = {}) {
  return triggerOnDemandTask(taskType, appId, {
    emit: false,
    origin: ON_DEMAND_ORIGINS.REFILL,
    cleanupSourceAgentId,
  });
}

/** Retain the replay fence until both source recording and admission settle. */
export async function acknowledgeSwarmCleanupRefill(agentId) {
  return updateSchedule(async schedule => {
    const pending = schedule.swarmCleanupRefillPending?.[agentId];
    if (!pending) return { result: false, changed: false };
    const handoff = schedule.onDemandHandoffs?.[pending.id];
    if (handoff && handoff.status !== 'preparing') {
      delete schedule.swarmCleanupRefillPending[agentId];
      return { result: true, changed: true };
    }
    if (pending.sourceMarked) return { result: true, changed: false };
    schedule.swarmCleanupRefillPending[agentId] = { ...pending, sourceMarked: true };
    return { result: true, changed: true };
  });
}

export async function getOnDemandRequests() {
  const schedule = await loadSchedule();
  const featureEnabled = createFeatureGate();
  return getAvailableOnDemandRequests(schedule, featureEnabled);
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
