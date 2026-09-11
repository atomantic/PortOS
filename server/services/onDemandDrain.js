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
    // Already handled above (and its request cleared) — `onDemandRequests` is
    // a snapshot taken before that drain.
    if (handledProgrammatically.has(request.id)) continue;
    if (capacityExhausted()) break;

    if (!isImprovementEnabled(state)) {
      emitLog('warn', `On-demand request dropped — improvement is disabled (Config → Improve)`, { requestId: request.id, taskType: request.taskType });
      await taskScheduleMod.clearOnDemandRequest(request.id);
      continue;
    }

    // Removed tasks never run; only automated requests honor schedule disablement.
    if (!schedule.tasks[request.taskType] || (!isManualOnDemandRequest(request) && !schedule.tasks[request.taskType].enabled)) {
      emitLog('info', `On-demand request skipped — task type '${request.taskType}' is disabled`, { requestId: request.id });
      await taskScheduleMod.clearOnDemandRequest(request.id);
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
        emitLog('warn', `On-demand request for unknown app: ${request.appId}`, { requestId: request.id });
        await taskScheduleMod.clearOnDemandRequest(request.id);
        continue;
      }
    }

    await taskScheduleMod.clearOnDemandRequest(request.id);

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
      await emitOnDemandEmpty({ taskScheduleMod, request, targetApp, taskConfig: schedule.tasks[request.taskType] });
    }
  }

  return { schedule };
}
