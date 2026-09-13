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
 * supplies an `adapter` for the only three things that genuinely differ:
 *
 *   - `capacityExhausted()` / `canSpawn(task)` — the generator fills a
 *     `tasksToSpawn` array against `availableSlots`; the dequeue engine runs the
 *     `cosDequeue.js` capacity tracker and admits via `canSpawnCommitted`
 *     (Priority 0 is a COMMITTED tier — see #4834).
 *   - `emitSpawn(task)` — push-to-array + `trackSpawn` vs
 *     `cosEvents.emit('task:ready', …)` + `capacity.trackSpawn`.
 *   - `addTaskOptions` — the `{ ignoreTaskId }` only the dequeue engine forwards.
 *
 * The generator's registry read is canonical and both engines now get it: ONE
 * `getActiveApps()` per cycle, outside the loop, with `null` meaning the read
 * FAILED (distinct from "no active apps") so a failure DEFERS the requests
 * instead of clearing them.
 */

import { emitLog } from './cosEvents.js';
import { getActiveApps } from './apps.js';
import { loadState, saveState, withStateLock, isImprovementEnabled } from './cosState.js';
import { markAppReviewCooldown, bindAppReviewAgent } from './appActivity.js';
import { isManualOnDemandRequest, onDemandRequestMetadata } from '../lib/quotaBurnOrigin.js';
import { addTask, reviveBlockedTask } from './cosTaskStore.js';
import { cardIdForRequest, finishPreflightCard, finishPreflightDispatch, reportPreflightStep, startPreflightCard } from './preflightTaskCard.js';

/**
 * Drain the on-demand request queue, generating + persisting a task per request
 * and handing each admitted task to the caller's `adapter.emitSpawn`.
 *
 * @param {{ state: object }} ctx        Shared CoS state for this cycle.
 * @param {{
 *   capacityExhausted: () => boolean,
 *   canSpawn: (task: object) => boolean,
 *   emitSpawn: (task: object) => void,
 *   addTaskOptions?: object,
 * }} adapter                            The three per-engine differences.
 * @returns {Promise<{ schedule: object }>} The loaded schedule, so a caller that
 *   needs it downstream (dequeueNextTask's Priority 2 disabled-analysis-type
 *   gate) reuses this load instead of issuing a second one.
 */
export async function drainOnDemandRequests(ctx, adapter) {
  const { state } = ctx;
  const { capacityExhausted, canSpawn, emitSpawn, addTaskOptions = {} } = adapter;

  // Deferred so the static import graph stays acyclic: cosTaskGenerator.js
  // imports THIS module, and these six helpers are declared there. Deferring to
  // call time is the same idiom the engines already use for taskSchedule.js.
  const {
    prepareManagedAppImprovementTask,
    generateSelfImprovementTaskForType,
    recordDeferredPerpetualDispatch,
    applyOnDemandConsent,
    drainProgrammaticOnDemandRequests,
    emitOnDemandEmpty,
  } = await import('./cosTaskGenerator.js');

  const taskScheduleMod = await import('./taskSchedule.js');
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

  for (const request of onDemandRequests) {
    // This request's programmatic-phase card, or null for the automated origins
    // that are never carded — `cardIdForRequest` owns that policy, so this
    // engine and the idle-review steal cannot disagree about who gets a card.
    // Derived rather than stamped on the request, so every report and close site
    // below needs no branch of its own: a null id short-circuits each of them
    // BEFORE it reads the task file, which matters because an automated refill
    // drain would otherwise pay a cold whole-file parse per request just to
    // discover it has no card.
    const cardId = cardIdForRequest(request);

    // Already handled above (and its request cleared) — `onDemandRequests` is
    // a snapshot taken before that drain.
    if (handledProgrammatically.has(request.id)) {
      await finishPreflightCard(cardId, { outcome: 'programmatic' });
      continue;
    }

    // Open the card BEFORE the capacity check, so a Run that has to wait for a
    // free slot still shows up on the Tasks page as waiting. Until this existed
    // nothing appeared there until an agent task did — which for pr-reviewer is
    // after the whole security preflight — and the click read as a no-op. Only
    // a human's Run is carded: a drain refill or a quota-burn step has nobody
    // waiting on it, and carding those would fill the page with noise. Repeat
    // cycles re-enter here and `addTask` rejects the duplicate id, so a request
    // that waits several cycles keeps ONE card rather than gaining one per tick.
    if (cardId) {
      await startPreflightCard({
        requestId: request.id,
        taskType: request.taskType,
        appId: request.appId ?? null,
        appName: apps.find(app => app.id === request.appId)?.name || null,
        targetPullRequest: request.targetPullRequest ?? null,
      });
    }

    // Abandon this request: clear it from the queue and tell the user's card why.
    // One helper so the log line and the card can never name different reasons —
    // the same hand-mirroring this module's header exists to eliminate.
    const dropRequest = async (level, reason, note) => {
      emitLog(level, `On-demand request dropped — ${note}`, { requestId: request.id, taskType: request.taskType });
      await taskScheduleMod.clearOnDemandRequest(request.id);
      await finishPreflightCard(cardId, { outcome: 'failed', reason, note });
    };

    if (capacityExhausted()) break;

    if (!isImprovementEnabled(state)) {
      await dropRequest('warn', 'improvement-disabled',
        'Improvement is turned off for this install. Turn it on in Config → Improve, then run this again.');
      continue;
    }

    // Removed tasks never run; only automated requests honor schedule disablement.
    if (!schedule.tasks[request.taskType] || (!isManualOnDemandRequest(request) && !schedule.tasks[request.taskType].enabled)) {
      await dropRequest('info', 'task-type-disabled',
        `The scheduled task type '${request.taskType}' is disabled or no longer registered.`);
      continue;
    }

    let task = null;
    // The perpetual drain signature `prepareManagedAppImprovementTask` decided
    // to record for this task, if any — returned as a plain record rather than
    // discovered by re-finding the task object, so it survives regardless of
    // which task-object variant `addTask` below hands back (#6871).
    let pendingPerpetualDispatch = null;
    // Determine target app (if any)
    let targetApp = null;

    if (request.appId) {
      targetApp = apps.find(a => a.id === request.appId);
      if (!targetApp) {
        await dropRequest('warn', 'app-unknown',
          `App '${request.appId}' is no longer active, so this run has nothing to target.`);
        continue;
      }
    }

    await taskScheduleMod.clearOnDemandRequest(request.id);
    // Off the queue and into preparation. A task type with its own preflight
    // (pr-reviewer) has no `prepare` step and reports its real first step
    // moments later, so this is a no-op there rather than a competing claim.
    await reportPreflightStep(cardId, 'prepare');

    const preparationStartedAt = performance.now();
    const requestedAt = Date.parse(request.requestedAt);
    const queueWaitMs = Number.isFinite(requestedAt) ? Math.max(0, Date.now() - requestedAt) : null;

    // A HUMAN "Run" re-checks live state (park + convergence signature + dispatch
    // budget all cleared); an automated refill (origin: 'refill') inherits them,
    // or the drain has no brakes left. The origin check lives inside
    // applyOnDemandRunResets so this drain and the refill lane can't drift on it.
    const userInitiated = await taskScheduleMod.applyOnDemandRunResets(request, targetApp?.id ?? null);
    const lane = userInitiated ? '' : ' (drain refill)';

    if (targetApp) {
      emitLog('info', `Processing on-demand improvement: ${request.taskType} for ${targetApp.name}${lane}`, { requestId: request.id, appId: targetApp.id });
      // Advance the cooldown eagerly (deduped per app per cycle), but defer
      // binding the active agent until a task is produced — a null result
      // here must not strand `activeAgentId` (issue #978).
      if (!reviewStartedApps.has(targetApp.id)) {
        await markAppReviewCooldown(targetApp.id);
        reviewStartedApps.add(targetApp.id);
      }
      await taskScheduleMod.recordExecution(`task:${request.taskType}`, targetApp.id);
      const prepared = await prepareManagedAppImprovementTask(request.taskType, targetApp, state, {
        skipPreconditions: true,
        targetPullRequest: request.targetPullRequest ?? null,
        // The deterministic pre-agent work reports into the user's card as it
        // runs — this is the whole reason the card exists early.
        preflightCardId: cardId,
        providerOverride: request.providerOverride ?? null,
        // A quota-burn step's per-invocation run parameters. They must reach
        // the PROMPT, so unlike the provider/model/effort pins they cannot
        // ride the post-generation `onDemandRequestMetadata` stamp below —
        // the generator overlays them before it picks the mode banner.
        // `normalizeQuotaBurnProvenance` (lib/quotaBurnOrigin.js) has to keep
        // `overrides.params` for a step to reach this; it drops them today,
        // so a burn currently runs the task's SAVED mode, which is correct
        // for every step until the migration starts pinning one.
        runOverrides: request.burn?.overrides?.params ?? null
      });
      task = prepared?.task ?? null;
      pendingPerpetualDispatch = prepared?.pendingPerpetualDispatch ?? null;
      if (task) {
        await bindAppReviewAgent(targetApp.id, `on-demand-${Date.now()}`);
      }
    } else {
      emitLog('info', `Processing on-demand improvement: ${request.taskType}${lane}`, { requestId: request.id });
      await taskScheduleMod.recordExecution(`task:${request.taskType}`);
      await withStateLock(async () => {
        const s = await loadState();
        s.stats.lastSelfImprovement = new Date().toISOString();
        s.stats.lastSelfImprovementType = request.taskType;
        await saveState(s);
      });
      task = await generateSelfImprovementTaskForType(request.taskType, state);
    }

    applyOnDemandConsent(task);
    // Priority 0 is a COMMITTED tier: the request is already cleared and the
    // marker bound, and this branch is the only thing that persists the task, so
    // a denial would discard the user's "Run". See canSpawnCommitted (#4834).
    if (task && canSpawn(task)) {
      // Mark this a MANUAL (on-demand) run so its perpetual drain continues in
      // the on-demand lane (see perpetualRefillPlan in cos.js). Stamped before
      // addTask so the blocked-revive branch inherits it via `task.metadata`.
      // `onDemandRequestMetadata` also carries the request's ORIGIN, which
      // `perpetualRefillPlan` reads to decide whether the completed run may
      // continue its drain — and a quota burn's provenance when it is one.
      task.metadata = { ...(task.metadata || {}), ...onDemandRequestMetadata(request) };
      // `addTaskOptions` carries the dequeue engine's `ignoreTaskId` so a
      // completion-triggered re-issue is dedup-safe: the perpetual drain
      // regenerates an identical first-line for the same app, and
      // `agent:completed` fires before the completing task's updateTask settles
      // it to `completed` — so without excluding it the re-issued claim is
      // rejected as a duplicate of the run that just finished and the drain stalls.
      const persisted = await addTask(task, 'internal', { raw: true, ...addTaskOptions, suppressDequeue: true });
      await finishPreflightDispatch(cardId, persisted?.id || task.id);
      if (!persisted?.duplicate) {
        await recordDeferredPerpetualDispatch(pendingPerpetualDispatch, taskScheduleMod);
        emitSpawn(task);
      } else if (persisted.status === 'blocked') {
        // Explicit user Run colliding with a failure-blocked twin (#2614):
        // revive the existing task instead of silently dropping the Run and
        // stranding the bound on-demand review marker.
        await reviveBlockedTask(persisted.id, { priority: task.priority, metadata: task.metadata }, 'internal', { suppressDequeue: true });
        await recordDeferredPerpetualDispatch(pendingPerpetualDispatch, taskScheduleMod);
        const revived = { ...task, id: persisted.id };
        emitSpawn(revived);
        emitLog('info', `🔁 On-demand ${request.taskType} revived blocked task ${persisted.id}`, { taskId: persisted.id });
      }
    } else if (!task && userInitiated) {
      // Explicit user "Run" produced no task — surface WHY (parked / transient /
      // idle) so the trigger isn't a silent no-op. Because we reset the park
      // BEFORE the fresh detection above, the outcome classification reflects
      // THIS check.
      //
      // `userInitiated` only: a drain refill ends by converging (that's the point),
      // and nobody is waiting on it, so toasting "nothing to do" for every automated
      // hop would turn a healthy overnight drain into a pile of notifications.
      await emitOnDemandEmpty({ taskScheduleMod, request, targetApp, taskConfig: schedule.tasks[request.taskType], preflightCardId: cardId });
    }
    // Every other exit from this iteration (a task that capacity refused, or a
    // refill with no task) still owes the card a close — a card left open would
    // keep animating until the orphan sweep reaped it. Already-closed cards are
    // a no-op, so the specific reason each path recorded above survives.
    await finishPreflightDispatch(cardId);
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

  return { schedule };
}
