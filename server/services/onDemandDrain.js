import { isLegacyDeepAudit } from '../lib/auditWorkflow.js';
/**
 * On-demand request drain — the ONE loop body both Priority 0 engines run.
 *
 * PortOS has two on-demand engines draining the SAME queue: the periodic
 * `evaluateTasks` engine (`cosTaskGenerator.js#spawnPriority0OnDemand`) and the
 * event-driven `dequeueNextTask` engine (`cos.js#spawnDequeuePriority0OnDemand`).
 * Which one drains a given request is a race — `quotaBurnAcceptance.js` states
 * that contract plainly — so any behavior either engine has, the other must have
 * too. They used to be hand-mirrored line-for-line, and the registry-failure fix
 * in #3294 landed on ONLY the generator: a request drained by the cos.js copy
 * while `getActiveApps()` was failing had its user-initiated "Run Now" silently
 * destroyed (issue #6618).
 *
 * The loop lives here now, so there is nothing left to mirror. Each engine
 * supplies an `adapter` for engine-specific capacity and dispatch behavior:
 *
 *   - `capacityExhausted()` / `projectCapacityExhausted(appId)` /
 *     `canSpawn(task)` — the generator fills a `tasksToSpawn` array against
 *     `availableSlots`; the dequeue engine runs the `cosDequeue.js` capacity
 *     tracker and admits via `canSpawnCommitted`. The per-project precheck keeps
 *     requests queued before preparation when their app is already full.
 *   - `emitSpawn(task)` — push-to-array + `trackSpawn` vs
 *     `cosEvents.emit('task:ready', …)` + `capacity.trackSpawn`.
 *   - `addTaskOptions` — the `{ ignoreTaskId }` only the dequeue engine forwards.
 *
 * The generator's registry read is canonical and both engines now get it: ONE
 * `getActiveApps()` per cycle, outside the loop, with `null` meaning the read
 * FAILED (distinct from "no active apps") so a failure DEFERS the requests
 * instead of clearing them.
 */

import { emitLog } from './cos/cosEvents.js';
import { claimOnDemandRequest, settleOnDemandRequest, reconcileOnDemandHandoffs } from './onDemandHandoff.js';
import { getActiveApps } from './apps.js';
import { loadState, saveState, withStateLock, isImprovementEnabled } from './cos/cosState.js';
import { markAppReviewCooldown, bindAppReviewAgent } from './appActivity.js';
import { isManualOnDemandRequest, onDemandRequestMetadata, quotaBurnProvenance } from '../lib/quotaBurnOrigin.js';
import { addTask, reviveBlockedTask } from './cos/cosTaskStore.js';
import { cardIdForRequest, finishPreflightCard, finishPreflightDispatch, reportPreflightStep, startPreflightCard } from './preflightTaskCard.js';
import { beginPreflightActivity } from './preflightActivity.js';

/**
 * Build the task for a claimed request that targets a managed app.
 * `reviewStartedApps` dedupes the cooldown advance per app per cycle.
 */
async function prepareAppRequestTask({ request, targetApp, state, cardId, lane, reviewStartedApps, taskScheduleMod, prepareManagedAppImprovementTask }) {
  emitLog('info', `Processing on-demand improvement: ${request.taskType} for ${targetApp.name}${lane}`, { requestId: request.id, appId: targetApp.id });
  // Advance the cooldown eagerly (deduped per app per cycle), but defer
  // binding the active agent until a task is produced — a null result
  // here must not strand `activeAgentId` (issue #978).
  if (!reviewStartedApps.has(targetApp.id)) {
    await markAppReviewCooldown(targetApp.id);
    reviewStartedApps.add(targetApp.id);
  }
  const prepared = await prepareManagedAppImprovementTask(request.taskType, targetApp, state, {
    skipPreconditions: true,
    onDemand: true,
    onDemandOrigin: request.origin ?? null,
    targetPullRequest: request.targetPullRequest ?? null,
    // The deterministic pre-agent work reports into the user's card as it
    // runs — this is the whole reason the card exists early.
    preflightCardId: cardId,
    providerOverride: request.providerOverride ?? null,
    // A quota-burn step's per-invocation run parameters. They must reach
    // the PROMPT, so unlike the provider/model/effort pins they cannot
    // ride the post-generation `onDemandRequestMetadata` stamp in the drain loop —
    // the generator overlays them before it picks the mode banner.
    // `normalizeQuotaBurnProvenance` (lib/quotaBurnOrigin.js) has to keep
    // `overrides.params` for a step to reach this; it drops them today,
    // so a burn currently runs the task's SAVED mode, which is correct
    // for every step until the migration starts pinning one.
    runOverrides: request.burn?.overrides?.params ?? null
  });
  if (prepared.task) {
    await taskScheduleMod.recordExecution(`task:${request.taskType}`, targetApp.id);
    await bindAppReviewAgent(targetApp.id, `on-demand-${Date.now()}`);
  }
  return prepared;
}

/** Build the task for a claimed install-wide (app-less) request. */
async function prepareInstallRequestTask({ request, state, lane, taskScheduleMod, generateSelfImprovementTaskForType }) {
  emitLog('info', `Processing on-demand improvement: ${request.taskType}${lane}`, { requestId: request.id });
  await taskScheduleMod.recordExecution(`task:${request.taskType}`);
  await withStateLock(async () => {
    const s = await loadState();
    s.stats.lastSelfImprovement = new Date().toISOString();
    s.stats.lastSelfImprovementType = request.taskType;
    await saveState(s);
  });
  const drainOptions = (request.providerOverride || request.targetModels)
    ? {
        providerOverride: request.providerOverride ?? null,
        targetModels: request.targetModels ?? null,
      }
    : undefined;
  const task = drainOptions
    ? await generateSelfImprovementTaskForType(request.taskType, state, drainOptions)
    : await generateSelfImprovementTaskForType(request.taskType, state);
  return { task, pendingPerpetualDispatch: null, skip: null };
}

async function acquireQueuedRequest(queuedRequest, taskScheduleMod) {
  if (queuedRequest.burn || queuedRequest.cleanupSourceAgentId) {
    const claim = await claimOnDemandRequest(queuedRequest.id);
    return { claim, request: claim?.request };
  }
  return { claim: null, request: await taskScheduleMod.clearOnDemandRequest(queuedRequest.id) };
}

// Waiting requests can stay visible without a claim. Repeated opens deduplicate by card id.
async function openCard(request, apps) {
  if (!cardIdForRequest(request)) return;
  await startPreflightCard({
    requestId: request.id,
    taskType: request.taskType,
    appId: request.appId ?? null,
    appName: apps.find(app => app.id === request.appId)?.name || null,
    targetPullRequest: request.targetPullRequest ?? null,
  });
}

// Acquire before touching the card: a stale snapshot can belong to another drain.
async function dropRequest(queuedRequest, apps, taskScheduleMod, level, reason, note) {
  const { claim, request } = await acquireQueuedRequest(queuedRequest, taskScheduleMod);
  if (!request) return;
  if (claim) await settleOnDemandRequest(claim, { reason: `${note} Resume explicitly.` });
  await openCard(request, apps);
  emitLog(level, `On-demand request dropped — ${note}`, { requestId: queuedRequest.id, taskType: queuedRequest.taskType });
  await finishPreflightCard(cardIdForRequest(request), { outcome: 'failed', reason, note });
}

async function persistOrReviveTask(task, request, claim, addTaskOptions, activity) {
  // Stamp provenance before addTask so a blocked twin inherits it on revival
  // and any continuing perpetual drain can decide which lane to use.
  task.metadata = { ...(task.metadata || {}), ...onDemandRequestMetadata(request) };
  if (request.cleanupSourceAgentId) {
    task.metadata.cleanupRefillSource = request.cleanupSourceAgentId;
    task.id = `sys-swarm-refill-${request.cleanupSourceAgentId}`;
  }
  // The dequeue engine can exclude a completing task from duplicate detection
  // because agent:completed fires before its status is committed.
  const persisted = await addTask(task, 'internal', { raw: true, ...addTaskOptions, suppressDequeue: true,
    ...(request.cleanupSourceAgentId && { idempotencyKey: `swarm-cleanup-refill:${request.cleanupSourceAgentId}` }) });
  if (persisted?.error) throw new Error(persisted.error);
  if (!persisted?.duplicate) {
    activity.acceptedTaskId = persisted?.id || task.id;
    return { outcome: 'dispatch', spawnTask: task };
  }
  if (persisted.status === 'blocked' && !request.cleanupSourceAgentId) {
    // Explicit Run resumes a failure-blocked twin (#2614).
    const stored = await reviveBlockedTask(persisted.id, { priority: task.priority, metadata: task.metadata }, 'internal', { suppressDequeue: true });
    if (stored?.error || stored?.statusChanged) return { outcome: 'held' };
    activity.acceptedTaskId = stored?.id || persisted.id;
    // Deep resumes must retain the stored branch pointer and original audit text.
    const spawnTask = isLegacyDeepAudit(task.metadata) ? stored : { ...task, id: persisted.id };
    return { outcome: 'revived', spawnTask, revivedTaskId: persisted.id };
  }
  if (!claim || quotaBurnProvenance(persisted.metadata).requestId === request.id
    || (request.cleanupSourceAgentId && persisted.id === task.id)) {
    activity.acceptedTaskId = persisted.id;
  }
  return { outcome: 'duplicate' };
}

async function handOffTask(spawnTask, cardId, activity, dispatch) {
  const { emitSpawn, deferPreflightDispatch } = dispatch;
  activity.handoffAttempted = true;
  emitSpawn(spawnTask);
  if (cardId && deferPreflightDispatch) {
    deferPreflightDispatch(spawnTask.id, {
      cardId, resultTaskId: activity.acceptedTaskId, endPreflight: activity.endPreflight, persisted: true,
    });
    activity.preflightTransferred = true;
  } else {
    await finishPreflightDispatch(cardId, activity.acceptedTaskId);
  }
}

async function processClaimedRequest(request, claim, activity, {
  apps, state, schedule, reviewStartedApps, taskScheduleMod, improvementTasks, dispatch,
}) {
  const {
    prepareManagedAppImprovementTask, generateSelfImprovementTaskForType,
    recordDeferredPerpetualDispatch, applyOnDemandConsent, emitOnDemandEmpty,
  } = improvementTasks;

  // Resolve dispatch from the claimed record instead of the queue snapshot.
  const targetApp = request.appId ? apps.find(app => app.id === request.appId) : null;
  const cardId = cardIdForRequest(request);
  // Old queued certification work must not silently become an extended audit.
  if (isLegacyDeepAudit(request.burn?.overrides?.params)) {
    activity.refusalReason = 'Historical Deep requests are read-only; start a new Deep audit.';
    await openCard(request, apps);
    await finishPreflightCard(cardId, { outcome: 'failed', reason: 'deep-audit-historical', note: activity.refusalReason });
    return;
  }
  await openCard(request, apps);
  // Task types with their own preflight steps ignore the generic prepare step.
  await reportPreflightStep(cardId, 'prepare');

  const preparationStartedAt = performance.now();
  const requestedAt = Date.parse(request.requestedAt);
  const queueWaitMs = Number.isFinite(requestedAt) ? Math.max(0, Date.now() - requestedAt) : null;
  // A human Run clears the drain brakes before fresh detection. Automated refills inherit them.
  const userInitiated = await taskScheduleMod.applyOnDemandRunResets(request, targetApp?.id ?? null);
  const lane = userInitiated ? '' : ' (drain refill)';
  // Keep the dispatch record from preparation even if addTask returns a different object (#6871).
  const { task, pendingPerpetualDispatch, skip } = targetApp
    ? await prepareAppRequestTask({ request, targetApp, state, cardId, lane, reviewStartedApps, taskScheduleMod, prepareManagedAppImprovementTask })
    : await prepareInstallRequestTask({ request, state, lane, taskScheduleMod, generateSelfImprovementTaskForType });

  applyOnDemandConsent(task);
  const { canSpawn, addTaskOptions } = dispatch;
  // Priority 0 capacity checks are committed: the request has already left the queue (#4834).
  if (task && canSpawn(task)) {
    const persisted = await persistOrReviveTask(task, request, claim, addTaskOptions, activity);
    if (persisted.outcome === 'held') {
      await finishPreflightCard(cardId, { outcome: 'failed', reason: 'existing-task-held',
        note: 'The existing task could not be resumed. Inspect its hold before trying again.' });
      return;
    }
    if (persisted.outcome === 'duplicate') {
      await finishPreflightCard(cardId, {
        outcome: 'nothing-to-do', reason: 'existing-task', note: 'An existing task already owns this request.',
      });
    } else {
      await recordDeferredPerpetualDispatch(pendingPerpetualDispatch, taskScheduleMod);
      await handOffTask(persisted.spawnTask, cardId, activity, dispatch);
      if (persisted.outcome === 'revived') {
        const { revivedTaskId } = persisted;
        emitLog('info', `🔁 On-demand ${request.taskType} revived blocked task ${revivedTaskId}`, { taskId: revivedTaskId });
      }
    }
  } else if (!task && userInitiated) {
    // Report why an explicit Run produced nothing. Automated refills converge quietly.
    await emitOnDemandEmpty({ taskScheduleMod, request, targetApp, taskConfig: schedule.tasks[request.taskType], preflightCardId: cardId, skip });
  }
  // Specific outcomes above survive this idempotent close. Deferred dispatch now owns its card.
  if (!activity.preflightTransferred) await finishPreflightDispatch(cardId);
  if (userInitiated) {
    const preparationMs = Math.round(performance.now() - preparationStartedAt);
    emitLog('info', `On-demand preparation finished: ${request.taskType} (${request.id}) — queue wait ${queueWaitMs ?? 'unknown'}ms, preparation ${preparationMs}ms, ${task ? 'task generated' : 'no task generated'}`, {
      requestId: request.id,
      appId: targetApp?.id ?? null,
      queueWaitMs,
      preparationMs,
      taskGenerated: !!task,
    });
  }
}

async function settleClaim(claim, request, { acceptedTaskId, refusalReason }, preparationFailed, taskScheduleMod) {
  const retry = !!request.cleanupSourceAgentId && !acceptedTaskId
    && !await taskScheduleMod.isPerpetualParkActive(request.taskType, request.appId).catch(() => false);
  await settleOnDemandRequest(claim, {
    taskId: acceptedTaskId,
    ...(request.cleanupSourceAgentId && { retry }),
    reason: acceptedTaskId ? null : refusalReason ?? (preparationFailed ? 'Request preparation failed; resume explicitly.' : 'Request produced no task; resume explicitly.'),
  });
}

/**
 * Drain the on-demand request queue, generating + persisting a task per request
 * and handing each admitted task to the caller's `adapter.emitSpawn`.
 *
 * @param {{ state: object }} ctx        Shared CoS state for this cycle.
 * @param {{
 *   capacityExhausted: () => boolean,
 *   projectCapacityExhausted?: (appId: string|null) => boolean,
 *   canSpawn: (task: object) => boolean,
 *   emitSpawn: (task: object) => void,
 *   addTaskOptions?: object,
 * }} adapter                            Engine-specific capacity and dispatch behavior.
 * @returns {Promise<{ schedule: object }>} The loaded schedule, so a caller that
 *   needs it downstream (dequeueNextTask's Priority 2 disabled-analysis-type
 *   gate) reuses this load instead of issuing a second one.
 */
export async function drainOnDemandRequests(ctx, adapter) {
  const { state } = ctx;
  const {
    capacityExhausted,
    projectCapacityExhausted = () => false,
    canSpawn,
    emitSpawn,
    deferPreflightDispatch = null,
    addTaskOptions = {},
  } = adapter;

  // cosImprovementTasks.js imports this module. Defer the import to avoid a static cycle.
  const improvementTasks = await import('./cos/cosImprovementTasks.js');
  const { drainProgrammaticOnDemandRequests } = improvementTasks;

  const taskScheduleMod = await import('./taskSchedule.js');
  await reconcileOnDemandHandoffs();
  const schedule = await taskScheduleMod.loadSchedule();
  const onDemandRequests = await taskScheduleMod.getOnDemandRequests();

  // Track apps already marked review-started this cycle so multiple on-demand
  // requests for the same app don't each rewrite its activity record.
  const reviewStartedApps = new Set();
  // The app registry can't change mid-loop, so read it once per cycle rather
  // than once per request (getActiveApps' 2s cache can miss at a boundary).
  // `null` means the read FAILED, which is not the same as "no active apps":
  // an empty list would make every app-targeted request below look like it
  // names an unknown app and get cleared, silently dropping user-initiated
  // work. On a failure we leave the requests queued for the next cycle.
  const apps = onDemandRequests.length > 0 ? await getActiveApps().catch(() => null) : [];

  // Programmatic handlers first, and outside the slot-bounded loop below: they
  // spawn nothing, so a busy autonomy budget must not hold a user's Run Now.
  const handledProgrammatically = await drainProgrammaticOnDemandRequests({
    taskScheduleMod, requests: onDemandRequests, schedule, state
  });

  if (!apps) {
    emitLog('warn', `On-demand requests deferred — the app registry could not be read this cycle`);
    return { schedule };
  }

  const requestContext = {
    apps, state, schedule, reviewStartedApps, taskScheduleMod, improvementTasks,
    dispatch: { canSpawn, emitSpawn, deferPreflightDispatch, addTaskOptions },
  };
  for (const queuedRequest of onDemandRequests) {
    // Share card eligibility with the idle-review drain. A null id lets card
    // operations skip task-file reads for automated refills.
    const queuedCardId = cardIdForRequest(queuedRequest);

    // Already handled above (and its request cleared) — `onDemandRequests` is
    // a snapshot taken before that drain.
    if (handledProgrammatically.has(queuedRequest.id)) {
      await finishPreflightCard(queuedCardId, { outcome: 'programmatic' });
      continue;
    }

    if (capacityExhausted()) {
      await openCard(queuedRequest, apps);
      break;
    }

    if (!isImprovementEnabled(state)) {
      await dropRequest(queuedRequest, apps, taskScheduleMod, 'warn', 'improvement-disabled',
        'Improvement is turned off for this install. Turn it on in Config → Improve, then run this again.');
      continue;
    }

    // Removed tasks never run; only automated requests honor schedule disablement.
    if (!schedule.tasks[queuedRequest.taskType] || (!isManualOnDemandRequest(queuedRequest) && !schedule.tasks[queuedRequest.taskType].enabled)) {
      await dropRequest(queuedRequest, apps, taskScheduleMod, 'info', 'task-type-disabled',
        `The scheduled task type '${queuedRequest.taskType}' is disabled or no longer registered.`);
      continue;
    }

    const targetApp = queuedRequest.appId ? apps.find(app => app.id === queuedRequest.appId) : null;
    if (queuedRequest.appId && !targetApp) {
      await dropRequest(queuedRequest, apps, taskScheduleMod, 'warn', 'app-unknown',
        `App '${queuedRequest.appId}' is no longer active, so this run has nothing to target.`);
      continue;
    }

    if (queuedRequest.cleanupSourceAgentId) {
      const { validCleanupRefillSource } = await import('./swarmCleanupDelivery.js');
      if (queuedRequest.origin !== 'refill' || !await validCleanupRefillSource(
        queuedRequest.cleanupSourceAgentId, queuedRequest.taskType, queuedRequest.appId,
      ).catch(() => false)) {
        emitLog('warn', 'Swarm cleanup refill deferred: its delivery source changed or is unreadable', { requestId: queuedRequest.id });
        continue;
      }
    }

    // A request that cannot fit under its app's concurrency cap must stay in
    // the durable on-demand queue. Clearing it before preparation used to be
    // safe only when the final `canSpawn` could not deny; per-project capacity
    // can deny while global slots remain, which discarded the prepared task and
    // closed the visible card without ever creating an agent task.
    if (projectCapacityExhausted(targetApp?.id ?? queuedRequest.appId ?? null)) {
      await openCard(queuedRequest, apps);
      emitLog('debug', `On-demand request deferred — per-project agent limit reached`, {
        requestId: queuedRequest.id,
        taskType: queuedRequest.taskType,
      });
      continue;
    }

    // Only the atomic removal winner owns preparation and the card's outcome.
    // Start activity before acquisition so the stale-card sweep sees the handoff gap.
    const activity = {
      endPreflight: beginPreflightActivity(queuedCardId),
      acceptedTaskId: null,
      handoffAttempted: false,
      preflightTransferred: false,
      refusalReason: null,
    };
    let claim = null;
    let request = null;
    let preparationFailed = false;
    try {
      ({ claim, request } = await acquireQueuedRequest(queuedRequest, taskScheduleMod));
      if (request) await processClaimedRequest(request, claim, activity, requestContext);
    } catch (error) {
      preparationFailed = true;
      if (request) await finishPreflightCard(cardIdForRequest(request), {
        outcome: 'failed', reason: 'preparation-failed',
        note: activity.handoffAttempted || activity.acceptedTaskId ? 'The handoff did not finish. Inspect the task and activity log before trying again.'
          : 'Preparation failed before the handoff completed. Check the activity log and run again.',
      });
      throw error;
    } finally {
      if (!activity.preflightTransferred) activity.endPreflight();
      if (claim) await settleClaim(claim, request, activity, preparationFailed, taskScheduleMod);
    }
  }

  return { schedule };
}
