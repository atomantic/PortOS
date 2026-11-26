
/**
 * CoS Task Generator Module (Dispatch Evaluation & Slot Admission)
 *
 * The periodic/startup evaluation loop extracted from cos.js. Owns:
 *  - `evaluateTasks` — decides what to spawn (priority 0 on-demand → 1 user
 *    → 2 auto-system → 3.6 feature agent → 4 idle review) and emits
 *    `task:ready` for each pick.
 *  - Slot admission (`admitAutoApprovedSystemTasks`, `admitPendingUserTasks`,
 *    `selectDryRunAutoApproved`), autonomy budget (`resolveAutonomyBudget`),
 *    per-project capacity (`countRunningAgentsByProject`, `isWithinProjectLimit`),
 *    and cooldown-expiry unblocking (`unblockExpiredCooldowns`).
 *
 * Scheduled/on-demand improvement-task preparation and queueing live in
 * `cosImprovementTasks.js`.
 *
 * Self-contained — it imports only sibling services (no import back to cos.js).
 * `evaluateTasks` emits `task:ready` rather than spawning directly, so the
 * spawn-side scheduler (`dequeueNextTask`/`tryImmediateSpawn`) stays in cos.js.
 * The startup-skip flag is passed in as the `initialStartup` option rather than
 * read from cos.js module state, and the paused check reads state directly.
 */

import { MAX_TOTAL_SPAWNS } from '../../lib/cos/cosTaskMetadata.js';
import { currentTaskTypeName } from '../../lib/scheduledTaskTypes.js';
import { hasQuotaBurnProvenance, } from '../../lib/quotaBurnOrigin.js';
import { isAutoApprovableInvestigation } from '../../lib/investigationTasks.js';
import { loadState, saveState, withStateLock, isDaemonRunning } from './cosState.js';
import { getDomainMode } from '../../lib/domainAutonomy.js';
import { remainingActionBudget } from '../../lib/domainBudgets.js';
import { getDomainBudgetStatus } from '../domainUsage.js';
import { pendingCosActionReservations } from './cosAdmissionReservations.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { updateTask, getAllTasks, reconcileLegacyForgeMaintenanceTasks } from './cosTaskStore.js';
import { recordDecision, DECISION_TYPES } from '../decisionLog.js';
import { isAppOnCooldown, } from '../appActivity.js';
// The single Priority-0 on-demand loop body, shared with the dequeueNextTask
// engine in cos.js so the two can no longer drift (#6618).
import { drainOnDemandRequests } from '../onDemandDrain.js';
import { admitFeatureAgentTasks, admitIdleReviewTask, countUnregisteredInFlight, isUserTaskRunnableUnattended } from './cosDequeueAdmission.js';
import { spawningTasks } from '../agent/agentState.js';
import { getSkipReason } from './cosTaskClaim.js';
import { ensureInstanceId } from '../instanceIdentity.js';
import { MAX_SPAWNS_BLOCKED_CATEGORY, TIMED_COOLDOWN_BLOCKED_CATEGORIES } from '../../lib/taskBlockCategories.js';

import { isTruthyMeta, } from '../../lib/metadataFlags.js';
import { finishPreflightCard, finishPreflightDispatch, } from '../preflightTaskCard.js';
/**
 * Persist a `blocked` status on a task that has hit the max-total-spawns
 * ceiling. Unconditional: the caller has already established `exceedsMaxSpawns`.
 * The name carries the side effect — dry-run planning must only ever call the
 * pure `exceedsMaxSpawns` predicate.
 */
async function blockMaxSpawnsExceeded(task, taskType) {
  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  emitLog('info', `🚫 Blocking task ${task.id} — exceeded max spawns (${totalSpawns}/${MAX_TOTAL_SPAWNS})`, { taskId: task.id });
  await updateTask(task.id, {
    status: 'blocked',
    metadata: { ...task.metadata, blockedReason: `Max total spawns exceeded (${totalSpawns}/${MAX_TOTAL_SPAWNS})`, blockedCategory: MAX_SPAWNS_BLOCKED_CATEGORY, blockedAt: new Date().toISOString() }
  }, taskType).catch(err => {
    emitLog('warn', `Failed to block task ${task.id}: ${err.message}`, { taskId: task.id });
  });
}

/**
 * Pure predicate — true when a task has hit the max-total-spawns ceiling.
 * Never blocks or persists; the execute passes pair it with
 * `blockMaxSpawnsExceeded`, and the dry-run pass uses it alone.
 */
export function exceedsMaxSpawns(task) {
  return (Number(task.metadata?.totalSpawnCount) || 0) >= MAX_TOTAL_SPAWNS;
}

/**
 * A task that must BYPASS the per-app review cooldown at spawn time. Three
 * classes qualify, for the same reason — the cooldown is not their throttle:
 *   - **Pipeline continuations** (`metadata.pipeline.currentStage > 0`) — a
 *     multi-stage pipeline's own stage gating sequences the work.
 *   - **Perpetual drains** (`metadata.perpetual`) — the work-detector park is the
 *     throttle (see `queueEligibleImprovementTasks` / agentCompletion.js). Without
 *     this, a perpetual task the refill just *queued* (after correctly bypassing
 *     the queue-path cooldown) would still be skipped here at the spawn gate,
 *     because the on-demand "Run" path stamped `lastReviewedAt` and these gates
 *     read it — so a manually-triggered perpetual drain stalls one item in.
 *   - **Quota burns** (`metadata.quotaBurnFamily`) — the throttle is the burn
 *     plan's own gate ladder: the reset-window horizon, the family's reserve, and
 *     `maxDispatchesPerWindow`, all checked before the task is ever queued. The
 *     app cooldown is re-stamped by EVERY completed task on that app, so on an app
 *     carrying any other recurring CoS work (a perpetual drain, which is itself
 *     exempt and therefore keeps completing) it never lapses — and the burn task
 *     sits in Pending until its window resets unspent, which is the exact outcome
 *     quota burn exists to prevent. (Tasks queued before this stamp existed are
 *     back-filled by migration 225, so the predicate reads metadata only.) Read
 *     through `hasQuotaBurnProvenance` rather than the raw key so this gate stays
 *     tied to the one block definition in `lib/quotaBurnOrigin.js` — a task
 *     written by any release, in either the flat or the block shape, is exempt.
 *
 * `metadata.perpetual` is a bare boolean set upstream, but rows stored before #16407 and peers on older versions
 * hold it as the STRING `"true"`. So accept BOTH — a `=== true` check alone would
 * silently miss those tasks.
 *
 * Shared by both spawn engines (`dequeueNextTask` in cos.js and `evaluateTasks`
 * here) and their dry-run planners so the cooldown-exempt set can't drift.
 */
export function isCooldownExemptTask(task) {
  const meta = task?.metadata;
  if (!meta) return false;
  return meta.pipeline?.currentStage > 0
    || isTruthyMeta(meta.perpetual)
    || hasQuotaBurnProvenance(meta);
}



/**
 * The ordered per-task admission gates for auto-approved system tasks — the ONE
 * place their order lives. `selectDryRunAutoApproved` walks it for the plan
 * (never calling `onReject`); `admitAutoApprovedSystemTasks` walks it for the
 * real pass and runs the first rejecting gate's `onReject` effect. Adding or
 * reordering a gate here changes both passes at once, so the dry-run plan cannot
 * drift from what execute does.
 *
 * `rejects(task, hooks)` is pure (it may await a read-only probe); every side
 * effect (logging, persisting a block, deferral records) belongs to `onReject`.
 * `hooks` carries the engine-specific predicates: `notRunnableHere` (pinned to
 * another instance #4520, or a peer's live lease #1650 — returns a truthy
 * reason), `extraSkip` (disabled analysis type), `cooldownExempt`, `isOnCooldown`.
 */
const AUTO_APPROVED_GATES = Object.freeze([
  {
    name: 'not-runnable-here',
    rejects: (task, hooks) => hooks.notRunnableHere(task),
    onReject: async (task, { detail }) => {
      emitLog('debug', `Skipping system task ${task.id} — ${detail}`, { taskId: task.id });
    },
  },
  {
    name: 'max-spawns',
    rejects: (task) => exceedsMaxSpawns(task),
    onReject: (task) => blockMaxSpawnsExceeded(task, 'internal'),
  },
  {
    name: 'disabled-analysis-type',
    rejects: (task, hooks) => hooks.extraSkip(task),
    onReject: async (task, { detail }) => {
      emitLog('info', typeof detail === 'string' ? `System task deferred — ${detail}`
        : `System task skipped — task type '${analysisTypeForTask(task)}' is disabled`, { taskId: task.id });
    },
  },
  {
    name: 'cooldown',
    rejects: async (task, hooks) => {
      const appId = task.metadata?.app;
      return Boolean(appId) && !hooks.cooldownExempt(task) && (await hooks.isOnCooldown(appId));
    },
    onReject: (task, { onDefer }) => onDefer({ type: 'cooldown', task, appId: task.metadata?.app }),
  },
]);

/**
 * First gate in `AUTO_APPROVED_GATES` that rejects `task`, as `{ gate, detail }`
 * (`detail` is the gate's truthy verdict, e.g. the not-runnable-here reason), or
 * null when the task clears them all. Pure — runs no `onReject` effect.
 */
async function firstRejectingGate(task, hooks) {
  for (const gate of AUTO_APPROVED_GATES) {
    const detail = await gate.rejects(task, hooks);
    if (detail) return { gate, detail };
  }
  return null;
}

/**
 * Dry-run eligibility pass over auto-approved system tasks. Walks the tasks in
 * file order applying the SAME gates execute mode uses — global slot cap, then
 * the shared `AUTO_APPROVED_GATES` table (one declarative list that
 * `admitAutoApprovedSystemTasks` also iterates), then per-project cap — while tracking virtual
 * capacity, and returns the ordered subset execute mode WOULD spawn. It never
 * blocks, persists, or emits anything, so a dry-run can log exactly the set
 * execute would spawn instead of over-reporting (logging tasks execute would
 * skip) or under-reporting (stopping early before applying the gates).
 *
 * The two spawn engines (`dequeueNextTask` in cos.js and `evaluateTasks` here)
 * have small execute-path differences, expressed via the optional per-task
 * hooks so each engine's dry-run plan matches its own execute path:
 * `extraSkip` adds an engine-specific gate (dequeue's disabled-analysis-type
 * check); `cooldownExempt` exempts a task from the cooldown gate (this engine's
 * pipeline-continuation bypass).
 *
 * @param {object[]} autoApproved - auto-approved system tasks, file order
 * @param {object} ctx
 * @param {number} ctx.availableSlots - global free slots at the start of this cycle
 * @param {number} ctx.alreadySpawned - slots already consumed by higher-priority picks (on-demand/user)
 * @param {number} ctx.perProjectLimit - per-project concurrent cap
 * @param {Record<string, number>} ctx.spawnProjectCounts - running+spawned counts per project (cloned, not mutated)
 * @param {(appId: string) => Promise<boolean>} ctx.isOnCooldown - async cooldown probe
 * @param {(task: object) => boolean} [ctx.cooldownExempt] - true ⇒ skip the cooldown gate for this task
 * @param {(task: object) => boolean} [ctx.extraSkip] - true ⇒ task ineligible (engine-specific gate)
 * @param {(task: object) => boolean} [ctx.notRunnableHere] - true ⇒ this instance would pass over the task anyway: it is pinned to another instance (#4520) or a federated peer holds a live lease on it (#1650). The execute path skips it before spawning, so the dry-run plan must too
 * @returns {Promise<object[]>} the tasks execute mode would spawn, in order
 */
export async function selectDryRunAutoApproved(autoApproved, ctx) {
  const {
    availableSlots,
    alreadySpawned = 0,
    perProjectLimit,
    spawnProjectCounts = {},
    isOnCooldown,
    cooldownExempt = () => false,
    extraSkip = () => false,
    notRunnableHere = () => false
  } = ctx;
  const hooks = { isOnCooldown, cooldownExempt, extraSkip, notRunnableHere };

  const counts = { ...spawnProjectCounts };
  let spawned = alreadySpawned;
  const spawnable = [];

  for (const task of autoApproved) {
    if (spawned >= availableSlots) break;
    if (await firstRejectingGate(task, hooks)) continue;
    const project = task.metadata?.app || '_self';
    if ((counts[project] || 0) >= perProjectLimit) continue;
    counts[project] = (counts[project] || 0) + 1;
    spawned++;
    spawnable.push(task);
  }

  return spawnable;
}


/**
 * Count running agents grouped by project (app ID).
 * Agents without an app (self-improvement, PortOS tasks) are grouped under '_self'.
 */
export function countRunningAgentsByProject(agents) {
  const counts = {};
  for (const agent of Object.values(agents)) {
    if (agent.status !== 'running') continue;
    const project = agent.metadata?.taskApp || agent.metadata?.app || '_self';
    counts[project] = (counts[project] || 0) + 1;
  }
  return counts;
}

/**
 * Check if a task would exceed the per-project concurrency limit.
 * Returns true if the task can be spawned (within limit), false otherwise.
 */
export function isWithinProjectLimit(task, agentsByProject, perProjectLimit) {
  const project = task.metadata?.app || '_self';
  const current = agentsByProject[project] || 0;
  return current < perProjectLimit;
}

/**
 * Unblock every expired timed-cooldown task in ONE queue's blocked group.
 * `defaultTaskType` names the store the array came from, so a task that carries
 * no explicit `taskType` is routed back to the queue it was read from — no
 * membership scan needed.
 *
 * Gated on the shared `TIMED_COOLDOWN_BLOCKED_CATEGORIES` vocabulary rather than
 * a literal `orphan-cooldown`: any block whose only precondition is "wait a
 * while" (the newer `worktree-busy` is the second) revives through this same
 * pass, and a category added to that set without a sweeper of its own would
 * otherwise sit blocked forever.
 */
async function unblockExpiredCooldownsInQueue(blocked, defaultTaskType) {
  let revived = 0;
  for (const task of blocked || []) {
    if (!TIMED_COOLDOWN_BLOCKED_CATEGORIES.has(task.metadata?.blockedCategory) || !task.metadata?.cooldownUntil) continue;
    // An unparseable `cooldownUntil` yields NaN, and NaN loses BOTH comparisons —
    // so the expiry test has to be written as "is expired", not as the negation of
    // "is still cooling". Guard it explicitly: a garbage timestamp leaves the task
    // blocked (the pre-#3500 behavior) rather than reviving it on the next tick.
    const cooldownUntil = new Date(task.metadata.cooldownUntil).getTime();
    if (!(cooldownUntil <= Date.now())) continue;
    emitLog('info', `⏰ Cooldown expired for task ${task.id} (${task.metadata.blockedCategory}), unblocking`, { taskId: task.id });
    await updateTask(task.id, {
      status: 'pending',
      metadata: {
        ...task.metadata,
        blockedReason: undefined,
        blockedCategory: undefined,
        blockedAt: undefined,
        cooldownUntil: undefined
      }
    }, task.taskType || defaultTaskType);
    revived++;
  }
  return revived;
}

/**
 * Unblock tasks whose timed cooldown has expired. Walks the blocked groups of
 * both task stores and flips any task in `TIMED_COOLDOWN_BLOCKED_CATEGORIES`
 * back to pending once its `cooldownUntil` has passed. Extracted from
 * `evaluateTasks` so the cooldown-unblock pass is independently testable.
 *
 * Each store is walked separately rather than concatenated: the old single-pass
 * version re-derived the queue of origin with `userBlocked.includes(task)` per
 * task, an O(N) scan inside an O(N) loop (#3500). Passing the origin down makes
 * classification O(1) and the whole pass linear.
 *
 * @returns {Promise<number>} how many tasks were revived
 */
export async function unblockExpiredCooldowns(userTaskData, cosTaskData) {
  const user = await unblockExpiredCooldownsInQueue(userTaskData.grouped?.blocked, 'user');
  const internal = await unblockExpiredCooldownsInQueue(cosTaskData.grouped?.blocked, 'internal');
  return user + internal;
}

/**
 * Resolve the per-domain CoS auto-run mode and the remaining autonomous-action
 * budget for this cycle (#711). The mode starts from `getDomainMode` and is
 * forced to `off` when the daily minutes cap is hit; the action budget caps how
 * many autonomous admissions the autonomous tiers may add this cycle.
 *
 * Off/dry-run withhold all AUTOMATIC internal spawns (auto-approved system
 * tasks, feature-agent, idle-review). User and on-demand tasks bypass this mode
 * gate; on-demand tasks also bypass the global pause. All non-user runs,
 * including on-demand work, count toward the daily actions/minutes ledger in
 * completeAgent and the in-flight action allowance here. A pure dry-run never
 * accrues usage.
 *
 * @returns {Promise<{ cosAutonomyMode: string, autonomousActionsRemaining: number }>}
 */
export async function resolveAutonomyBudget(state, runningAgentEntries) {
  let cosAutonomyMode = getDomainMode(state.config, 'cos');

  // Daily CoS budget (#711). Two dimensions, handled differently so a single
  // evaluation can't overshoot a small cap by spawning a whole concurrent batch:
  //  - minutes: binary — a run's wall-clock isn't known at spawn time, so once
  //    today's autonomous minutes reach the cap we withhold all automatic spawns
  //    (treat as `off`); a single in-flight run's overshoot is unavoidable.
  //  - actions: precise — cap THIS cycle's autonomous admissions to the remaining
  //    daily allowance, counting both completed (ledger) and in-flight autonomous
  //    runs. `autonomousActionsRemaining` flows into `autonomousSlotCeiling`.
  const cosBudget = await getDomainBudgetStatus('cos');
  let autonomousActionsRemaining = Infinity;
  if (cosAutonomyMode !== 'off') {
    if (cosBudget.exceeded === 'minutes') {
      emitLog('info', `CoS auto-run paused — daily minutes budget reached`, { domainBudget: 'cos', exceeded: 'minutes' });
      cosAutonomyMode = 'off';
    } else if (cosBudget.budget?.maxActionsPerDay != null) {
      const runningAutonomous = runningAgentEntries.filter(
        (a) => a.metadata?.taskType && a.metadata.taskType !== 'user'
      ).length;
      autonomousActionsRemaining = remainingActionBudget(
        cosBudget.budget,
        cosBudget.usage,
        runningAutonomous + pendingCosActionReservations()
      );
      if (autonomousActionsRemaining === 0) {
        emitLog('info', `CoS auto-run paused — daily actions budget reached`, { domainBudget: 'cos', exceeded: 'actions' });
        cosAutonomyMode = 'off';
      }
    }
  }

  return { cosAutonomyMode, autonomousActionsRemaining };
}

// Tasks queued before a task-type rename (TASK_TYPE_RENAMES) resolve to the
// current schedule key, or they would read as disabled and never drain.
const analysisTypeForTask = (task) => currentTaskTypeName(task.metadata?.analysisType || task.metadata?.selfImprovementType);

async function isDisabledAnalysisType(task, taskSchedule) {
  const analysisType = analysisTypeForTask(task);
  if (['release-sync', 'do-release'].includes(analysisType)) {
    const { releaseTaskDispatchDisposition } = await import('../releaseSynchronization.js');
    const disposition = await releaseTaskDispatchDisposition(task);
    if (['registered-continuation', 'registered-release-owner'].includes(disposition)) return false;
    if (disposition === 'review-policy-unverified') return 'release synchronization review policy was not captured; recover from historical delivery evidence';
    if (disposition === 'retired-continuation') return 'the previous release synchronization was retired by an operator';
    if (disposition === 'delivered-continuation') return 'the release was independently delivered; this continuation remains historical';
    if (disposition === 'wait-for-synchronization') return 'previous release is published; development synchronization and cleanup are unfinished';
  }
  // The shared drain contract always supplies a schedule. If that contract is
  // ever violated, fail closed for scheduled analysis work without aborting the
  // rest of the evaluation cycle.
  return Boolean(analysisType) && taskSchedule?.tasks?.[analysisType]?.enabled !== true;
}

/**
 * Run the one Priority-2 admission pass shared by the periodic evaluator and
 * event-driven dequeue engine. The pass owns candidate expansion and every
 * dry-run/execute gate; adapters only decide how an admitted task is emitted
 * and how their per-cycle capacity bookkeeping is updated.
 */
export async function admitAutoApprovedSystemTasks(ctx, adapter) {
  const {
    state,
    cosTaskData,
    taskSchedule,
    cosAutonomyMode,
    autonomousSlotCeiling,
    alreadySpawned,
    perProjectLimit,
    spawnProjectCounts,
    instanceId,
  } = ctx;
  const { canSpawn, trackSpawn, emitSpawn, isOwned = () => false, onDefer = async () => {} } = adapter;

  // A task already spawning or admitted this cycle is not a candidate: letting
  // it reach the gates would record a capacity/cooldown deferral for work that
  // is already running.
  const autoApproved = [
    ...(cosTaskData.autoApproved || []),
    ...(state.config.autoApproveInvestigations
      ? (cosTaskData.grouped?.pending || []).filter((task) => isAutoApprovableInvestigation(task, state.config))
      : [])
  ].filter((task) => !isOwned(task));
  // One hook set feeds both walks, so the dry-run plan and the execute pass
  // cannot disagree about what each gate means.
  const gateHooks = {
    isOnCooldown: (appId) => isAppOnCooldown(appId, state.config.appReviewCooldownMs),
    cooldownExempt: isCooldownExemptTask,
    extraSkip: (task) => isDisabledAnalysisType(task, taskSchedule),
    notRunnableHere: (task) => getSkipReason(task.metadata, instanceId)
  };

  if (cosAutonomyMode !== 'execute') {
    if (cosAutonomyMode !== 'dry-run') return [];
    const wouldSpawn = await selectDryRunAutoApproved(autoApproved, {
      availableSlots: autonomousSlotCeiling,
      alreadySpawned,
      perProjectLimit,
      spawnProjectCounts,
      ...gateHooks
    });
    for (const task of wouldSpawn) {
      emitLog('info', `[dry-run] CoS auto-run would spawn system task: ${task.id}`, { taskId: task.id, domainAutonomy: 'cos' });
    }
    return wouldSpawn;
  }

  const admitted = [];
  let spawned = alreadySpawned;
  for (const task of autoApproved) {
    if (spawned >= autonomousSlotCeiling) break;
    const rejection = await firstRejectingGate(task, gateHooks);
    if (rejection) {
      await rejection.gate.onReject(task, { detail: rejection.detail, onDefer });
      continue;
    }
    const appId = task.metadata?.app;
    const sysTask = { ...task, taskType: 'internal' };
    if (!canSpawn(sysTask, autonomousSlotCeiling)) {
      await onDefer({ type: 'capacity', task, project: appId || '_self' });
      continue;
    }
    emitSpawn(sysTask);
    trackSpawn(sysTask);
    admitted.push(sysTask);
    spawned++;
  }
  return admitted;
}

async function recordAutoApprovedDeferral({ type, task, appId, project }, state, perProjectLimit) {
  if (type === 'cooldown') {
    emitLog('debug', `Skipping system task ${task.id} - app ${appId} on cooldown`);
    await recordDecision(
      DECISION_TYPES.COOLDOWN_ACTIVE,
      `System task ${task.id} skipped — app ${appId} on cooldown (${Math.round(state.config.appReviewCooldownMs / 60000)}min window)`,
      { taskId: task.id, appId, cooldownMs: state.config.appReviewCooldownMs }
    );
    return;
  }
  emitLog('debug', `⏳ Queued system task ${task.id} - per-project limit reached for ${project}`);
  await recordDecision(
    DECISION_TYPES.CAPACITY_FULL,
    `System task ${task.id} deferred — per-project limit (${perProjectLimit}) reached for ${project}`,
    { taskId: task.id, project, limit: perProjectLimit }
  );
}

/**
 * Run the one Priority-1 admission pass shared by the periodic evaluator and
 * event-driven dequeue engine (#7523 — the two used to hand-mirror this
 * ordered ladder, and #4520/#7300 each landed as two synchronized edits).
 * Owns the ordered not-runnable-here, approval, and max-spawn gates for
 * pending user tasks; adapters only decide how an admitted task is emitted,
 * how per-cycle capacity is tracked, and (optionally) what happens when
 * capacity denies a candidate.
 */
export async function admitPendingUserTasks({ pendingUserTasks, instanceId }, adapter) {
  const { capacityExhausted, canSpawn, emitSpawn, trackSpawn, isOwned = () => false, onDefer = async () => {} } = adapter;

  const admitted = [];
  for (const task of pendingUserTasks) {
    if (capacityExhausted()) break;
    // Already spawning or admitted this cycle — not deferred, just not a candidate.
    if (isOwned(task)) continue;
    // Not runnable here: the task is pinned to another instance (#4520), or a
    // federated peer holds a live lease on it (#1650) and is working it on the
    // other machine. Skip it during candidate selection so it doesn't consume
    // this cycle's spawn slot (the spawn guard would return null anyway) and
    // starve later runnable tasks.
    const skipReason = getSkipReason(task.metadata, instanceId);
    if (skipReason) {
      emitLog('debug', `Skipping user task ${task.id} — ${skipReason}`, { taskId: task.id });
      continue;
    }
    // A user row that says it is NOT auto-approved is withheld from the unattended
    // spawn (#7300) — see isUserTaskRunnableUnattended for why, and for why the
    // rule lives in cosDequeueAdmission.js rather than once per engine.
    if (!isUserTaskRunnableUnattended(task)) {
      emitLog('debug', `Skipping user task ${task.id} — recovered row is not auto-approved`, { taskId: task.id });
      continue;
    }
    if (exceedsMaxSpawns(task)) {
      await blockMaxSpawnsExceeded(task, 'user');
      continue;
    }
    const userTask = { ...task, taskType: 'user' };
    if (!canSpawn(userTask)) {
      await onDefer(userTask);
      continue;
    }
    emitSpawn(userTask);
    trackSpawn(userTask);
    admitted.push(userTask);
  }
  return admitted;
}

/**
 * Priority 0: On-demand task requests, including user, refill and quota-burn
 * origins. Reads the live schedule's `onDemandRequests`, clears each
 * as it is processed, and admits any produced task (deduped) through the
 * cycle's shared `spawnAdapter`. On-demand work bypasses the auto-run mode gate
 * and global pause, but uses global slots and counts toward the daily budget
 * like other non-user runs.
 *
 * Returns the schedule the drain loaded so `evaluateTasks` can hand it to
 * Priority 2 explicitly (its disabled-analysis-type gate) instead of a second
 * load.
 */
async function spawnPriority0OnDemand(ctx) {
  const { state, availableSlots, perProjectLimit, spawnProjectCounts, tasksToSpawn, spawnAdapter } = ctx;

  const { schedule } = await drainOnDemandRequests({ state }, {
    capacityExhausted: () => tasksToSpawn.length >= availableSlots,
    projectCapacityExhausted: (appId) =>
      (spawnProjectCounts[appId || '_self'] || 0) >= perProjectLimit,
    canSpawn: spawnAdapter.canSpawn,
    emitSpawn: spawnAdapter.emitSpawn,
    deferPreflightDispatch: spawnAdapter.deferPreflightDispatch,
  });
  return { schedule };
}

/**
 * Priority 1: User tasks (always run — cooldown only applies to system tasks).
 * Runs against the global slot cap; user work never counts against the
 * autonomous action budget.
 */
async function spawnPriority1UserTasks(ctx) {
  const { pendingUserTasks, availableSlots, perProjectLimit, tasksToSpawn, spawnAdapter, instanceId } = ctx;
  await admitPendingUserTasks({ pendingUserTasks, instanceId }, {
    ...spawnAdapter,
    capacityExhausted: () => tasksToSpawn.length >= availableSlots,
    onDefer: (task) => recordPendingUserDeferral(task, perProjectLimit),
  });
}

async function recordPendingUserDeferral(task, perProjectLimit) {
  const project = task.metadata?.app || '_self';
  emitLog('debug', `⏳ Queued user task ${task.id} - per-project limit reached for ${project}`);
  await recordDecision(
    DECISION_TYPES.CAPACITY_FULL,
    `User task ${task.id} deferred — per-project limit (${perProjectLimit}) reached for ${project}`,
    { taskId: task.id, project, limit: perProjectLimit }
  );
}

/**
 * Priority 2: Auto-approved system tasks (if slots available) — gated by the
 * CoS auto-run domain. off/dry-run withhold the unattended spawn; dry-run logs
 * what would have run so the user can see the plan without it executing. Capped
 * by `autonomousSlotCeiling` (the CoS action budget, #711).
 */
async function spawnPriority2AutoApproved(ctx, { taskSchedule, autonomousSlotCeiling }) {
  const { state, cosTaskData, cosAutonomyMode, perProjectLimit, spawnProjectCounts, tasksToSpawn, spawnAdapter, instanceId } = ctx;
  return admitAutoApprovedSystemTasks({
    state,
    cosTaskData,
    taskSchedule,
    cosAutonomyMode,
    autonomousSlotCeiling,
    alreadySpawned: tasksToSpawn.length,
    perProjectLimit,
    spawnProjectCounts,
    instanceId,
  }, {
    ...spawnAdapter,
    onDefer: (decision) => recordAutoApprovedDeferral(decision, state, perProjectLimit),
  });
}

/**
 * Background: Queue eligible self-improvement tasks as system tasks. Only queue
 * if there are NO pending user tasks (user tasks always take priority). Skip on
 * initial startup to avoid auto-spawning agents on fresh installs. Also skip
 * when CoS auto-run isn't `execute` — queueing creates autonomous work.
 */
async function maybeQueueImprovementTasks(ctx) {
  const { state, cosTaskData, hasPendingUserTasks, initialStartup, cosAutonomyMode } = ctx;
  if (state.config.idleReviewEnabled && !hasPendingUserTasks && !initialStartup && cosAutonomyMode === 'execute') {
    const { queueEligibleImprovementTasks } = await import('./cosImprovementTasks.js');
    await queueEligibleImprovementTasks(state, cosTaskData);
  }
}

/**
 * Priority 3.6: Feature Agents (after autonomous jobs, yield to user tasks).
 * Autonomous — gated by the CoS auto-run domain and capped by
 * `autonomousSlotCeiling`. The admission pass is shared with dequeueNextTask.
 */
async function spawnPriority36FeatureAgents(ctx, { autonomousSlotCeiling }) {
  return admitFeatureAgentTasks({
    spawnedCount: () => ctx.tasksToSpawn.length,
    hasPendingUserTasks: ctx.hasPendingUserTasks,
    cosAutonomyMode: ctx.cosAutonomyMode,
    autonomousSlotCeiling,
  }, ctx.spawnAdapter);
}

/**
 * Priority 4: Generate a direct idle-review task ONLY when:
 * 1. Nothing else is queued to spawn
 * 2. No pending user tasks (even on cooldown)
 * 3. No system tasks queued
 * Autonomous — gated by the CoS auto-run domain.
 */
async function spawnPriority4IdleReview(ctx, { autonomousSlotCeiling }) {
  return admitIdleReviewTask({
    state: ctx.state,
    alreadySpawned: ctx.tasksToSpawn.length,
    hasPendingUserTasks: ctx.hasPendingUserTasks,
    cosAutonomyMode: ctx.cosAutonomyMode,
    autonomousSlotCeiling,
  }, ctx.spawnAdapter);
}

/**
 * Evaluate tasks and decide what to spawn.
 *
 * Orchestrates the spawn-priority tiers in sequence, each extracted into a named
 * private function that reads a frozen spawn context (`ctx`), admits through its
 * shared `spawnAdapter`, and receives anything an earlier tier produced (the
 * Priority-0 schedule, the autonomous ceiling) as an explicit argument:
 *   - Priority 0 — on-demand requests       (`spawnPriority0OnDemand`)
 *   - Priority 1 — pending user tasks        (`spawnPriority1UserTasks`)
 *   - Priority 2 — auto-approved system tasks (`spawnPriority2AutoApproved`)
 *   - Priority 3.6 — due feature agents      (`spawnPriority36FeatureAgents`)
 *   - Priority 4 — idle review               (`spawnPriority4IdleReview`)
 *
 * Cross-cutting gates live here so they cover every tier uniformly: the
 * paused/daemon guard, the global slot cap, orphan-cooldown unblocking, and the
 * CoS auto-run + daily-budget gate (`resolveAutonomyBudget`). Priorities 0–1
 * spend against the global `availableSlots`; the autonomous tiers (2, 3.6, 4)
 * spend against the lower `autonomousSlotCeiling` so the CoS action budget caps
 * them. `evaluateTasks` emits `task:ready` per pick; the spawn-side scheduler
 * (`dequeueNextTask`/`tryImmediateSpawn`) stays in cos.js.
 */
export async function evaluateTasks(options) {
  // `initialStartup` is passed by cos.js's start() (true on the boot-time eval)
  // so the self-improvement queue is skipped on fresh installs; all other
  // callers omit it. Destructured from a plain options arg (not a destructuring
  // param) so the signature carries no leading brace.
  const { initialStartup = false } = options || {};
  if (!isDaemonRunning()) return;

  // A global pause stops scheduled/autonomous/user spawning, but NOT explicit
  // user triggers: on-demand requests (Priority 0) are still drained while
  // paused so a manual "Run" (or a force-evaluate) fires. The user/autonomous
  // tiers below are gated on `!paused` — parity with dequeueNextTask in cos.js.
  const paused = (await loadState()).paused || false;

  // Update evaluation timestamp with lock to prevent race conditions
  const state = await withStateLock(async () => {
    const s = await loadState();
    s.stats.lastEvaluation = new Date().toISOString();
    await saveState(s);
    return s;
  });

  // Drain merge-only PRs here rather than on the `pr-watcher` task's schedule,
  // which most installs leave disabled — that coupling stranded every green
  // PortOS-opened PR at `ticks: 0` forever. This is the OPPORTUNISTIC drain:
  // evaluation is event-driven, so the cadence-bearing one is the
  // `cos-pending-merge-sweep` timer in cos.js (#3630). Keeping it here costs
  // nothing and makes `POST /api/cos/evaluate` do the obvious thing.
  // Runs BEFORE the agent-slot
  // gate below because a deterministic merge claims no lane, so a full agent
  // roster must not also wedge the merge queue.
  //
  // Gated on `!paused` AND on CoS auto-run being in `execute`, like every other
  // autonomous tier: merging writes to a default branch, so it is the LAST thing
  // that may run while the user has auto-run set to `off` or `dry-run`. The mode
  // is read directly rather than via `resolveAutonomyBudget` (which runs further
  // down, after the agent-slot gate) because the daily minutes/actions budget
  // meters agent RUNS — a deterministic merge spawns nothing and consumes none
  // of it — while the mode is the user's "may PortOS act on its own" switch.
  if (!paused && getDomainMode(state.config, 'cos') === 'execute') {
    const prWatcher = await import('../prWatcher.js');
    const sweep = await prWatcher.sweepPendingMergePrs();
    if (sweep.merged || sweep.escalated || sweep.timedOut) {
      emitLog('info', `🤖 Pending merges: ${sweep.merged} merged, ${sweep.escalated} escalated, ${sweep.timedOut} timed out`);
    }
  }

  if (state.config.persistentMindMaintainer?.enabled) {
    const { runDevelopmentWatchdog } = await import('../developmentWatchdog.js');
    await runDevelopmentWatchdog().catch(err => console.error(`❌ Development watchdog failed: ${err.message}`));
  }

  // Resolve this instance's federation id once per cycle so the priority tiers
  // can skip tasks a peer holds a live lease on (#1650). Warm path is the cheap
  // cached read; only the cold boot creates the identity.
  const instanceId = await ensureInstanceId();

  if (!paused && getDomainMode(state.config, 'cos') === 'execute') {
    await reconcileLegacyForgeMaintenanceTasks({ instanceId });
  }

  // Get both user and CoS tasks
  const { user: userTaskData, cos: cosTaskData } = await getAllTasks();

  // Unblock tasks whose orphan-retry cooldown has expired
  await unblockExpiredCooldowns(userTaskData, cosTaskData);

  // Count running agents and available slots (global + per-project)
  const runningAgentEntries = Object.values(state.agents).filter(a => a.status === 'running');
  const runningAgents = runningAgentEntries.length;
  // In-flight spawns hold a slot before their agent registers as running.
  const availableSlots = state.config.maxConcurrentAgents - runningAgents - countUnregisteredInFlight(spawningTasks, state.agents);

  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  const agentsByProject = countRunningAgentsByProject(state.agents);

  if (availableSlots <= 0) {
    emitLog('warn', `Max concurrent agents reached (${runningAgents}/${state.config.maxConcurrentAgents})`);
    await recordDecision(
      DECISION_TYPES.CAPACITY_FULL,
      `All ${state.config.maxConcurrentAgents} agent slots occupied`,
      { running: runningAgents, max: state.config.maxConcurrentAgents }
    );
    return;
  }

  const tasksToSpawn = [];
  // Track per-project counts including tasks we're about to spawn in this batch
  const spawnProjectCounts = { ...agentsByProject };

  // Resolve the CoS auto-run mode + daily-budget ceiling for this cycle (#711).
  const { cosAutonomyMode, autonomousActionsRemaining } = await resolveAutonomyBudget(state, runningAgentEntries);

  // Helper: check if a task can spawn (within both global and per-project limits).
  // `ceiling` defaults to the global slot count; autonomous sections pass the
  // lower `autonomousSlotCeiling` so the CoS action budget (#711) caps them.
  const admittedTaskIds = new Set();
  const isTaskOwned = (task) => Boolean(task?.id) && (admittedTaskIds.has(task.id) || spawningTasks.has(task.id));
  const canSpawnTask = (task, ceiling = availableSlots) => {
    if (isTaskOwned(task)) return false;
    if (tasksToSpawn.length >= ceiling) return false;
    const project = task.metadata?.app || '_self';
    return (spawnProjectCounts[project] || 0) < perProjectLimit;
  };
  // The ONE admission sink every tier uses: queue the pick for the spawn loop
  // below AND count it against its project's cap, together, so no tier can do
  // one without the other (#9609).
  const admitSpawn = (task) => {
    tasksToSpawn.push(task);
    if (task.id) admittedTaskIds.add(task.id);
    const project = task.metadata?.app || '_self';
    spawnProjectCounts[project] = (spawnProjectCounts[project] || 0) + 1;
  };
  // An admission here is only an in-memory pick. Keep its card and activity
  // alive until the loop below actually emits task:ready; a later tier may fail.
  const deferredPreflights = new Map();
  const deferPreflightDispatch = (taskId, entry) => {
    if (!taskId || deferredPreflights.has(taskId)) throw new Error('Cannot defer preflight for a missing or duplicate task');
    deferredPreflights.set(taskId, { ...entry, attempted: false });
  };
  const settleDeferredPreflight = async (taskId, emitted) => {
    const entry = deferredPreflights.get(taskId);
    if (!entry) return;
    deferredPreflights.delete(taskId);
    try {
      if (emitted) await finishPreflightDispatch(entry.cardId, entry.resultTaskId);
      else await finishPreflightCard(entry.cardId, {
        outcome: 'failed', reason: 'dispatch-interrupted',
        note: entry.persisted || entry.attempted
          ? 'The handoff did not finish. Inspect the task and activity log before trying again.'
          : 'The handoff did not finish. Check the activity log and run again.',
      });
    } catch (error) {
      console.error(`❌ Could not settle preflight card ${entry.cardId}: ${error.message}`);
    } finally {
      entry.endPreflight();
    }
  };
  // The adapter every tier hands to its shared admission pass, unchanged. Those
  // passes also serve dequeueNextTask (cos.js), which dispatches and counts
  // through different objects, so they take emit and track as separate hooks;
  // here `admitSpawn` already does both, so the track hook is inert.
  const spawnAdapter = Object.freeze({ canSpawn: canSpawnTask, emitSpawn: admitSpawn, trackSpawn: () => {},
    isOwned: isTaskOwned, deferPreflightDispatch });

  // Check if there are pending user tasks (even if on cooldown). If user tasks
  // exist, don't run self-improvement — wait for user tasks to be ready.
  const pendingUserTasks = userTaskData.grouped?.pending || [];
  const hasPendingUserTasks = pendingUserTasks.length > 0;

  // Read-only spawn context shared by every priority tier (#9609). Frozen so a
  // tier cannot pass a value to a later tier by writing into it — a tier that
  // produces something a later tier needs RETURNS it, and the sequence below
  // threads it as a named argument. Spawning goes through `spawnAdapter`, whose
  // closures own the running `tasksToSpawn` / `spawnProjectCounts` totals.
  const ctx = Object.freeze({
    state,
    cosTaskData,
    instanceId,
    availableSlots,
    perProjectLimit,
    tasksToSpawn,
    spawnProjectCounts,
    cosAutonomyMode,
    initialStartup,
    pendingUserTasks,
    hasPendingUserTasks,
    spawnAdapter,
  });

  const pendingUserCount = userTaskData.grouped?.pending?.length || 0;
  const inProgressCount = userTaskData.grouped?.in_progress?.length || 0;
  const pendingSystemCount = cosTaskData.grouped?.pending?.length || 0;

  try {
    // Priority 0 (on-demand) spends against the global slot cap and runs even when
    // paused — an explicit user "Run" bypasses the global pause.
    const { schedule: taskSchedule } = await spawnPriority0OnDemand(ctx);

    // Every tier below is scheduled/autonomous/user work that the global pause
    // stops. When paused we skip them and let the shared spawn loop below emit just
    // the on-demand tasks Priority 0 collected.
    if (!paused) {
      // Priority 1 spends against the global slot cap.
      await spawnPriority1UserTasks(ctx);

      // Ceiling for AUTOMATIC admissions this cycle (#711). User and on-demand
      // tasks already bypassed the mode gate; on-demand also bypasses pause. The
      // automatic tiers may add at most `autonomousActionsRemaining` more tasks.
      // On-demand runs still count as non-user work in the completion ledger and
      // subsequent in-flight allowance; only user tasks are exempt. With no action
      // cap this equals `availableSlots`.
      const autonomousSlotCeiling = Math.min(availableSlots, tasksToSpawn.length + autonomousActionsRemaining);

      // Priorities 2, 3.6, 4 spend against the lower autonomous ceiling.
      await spawnPriority2AutoApproved(ctx, { taskSchedule, autonomousSlotCeiling });
      await maybeQueueImprovementTasks(ctx);
      await spawnPriority36FeatureAgents(ctx, { autonomousSlotCeiling });
      await spawnPriority4IdleReview(ctx, { autonomousSlotCeiling });
    }

    // Emit evaluation status
    const evalLevel = tasksToSpawn.length > 0 ? 'info' : 'debug';
    emitLog(evalLevel, `Evaluation: ${pendingUserCount} user pending, ${inProgressCount} in_progress, ${pendingSystemCount} system, spawning ${tasksToSpawn.length}`, {
      pendingUser: pendingUserCount,
      inProgress: inProgressCount,
      pendingSystem: pendingSystemCount,
      toSpawn: tasksToSpawn.length,
      availableSlots
    });

    // Spawn all ready tasks (up to available slots)
    for (const task of tasksToSpawn) {
      emitLog('success', `Spawning task: ${task.id} (${task.priority || 'MEDIUM'})`, {
        taskId: task.id,
        taskType: task.taskType,
        app: task.metadata?.app
      });
      const entry = deferredPreflights.get(task.id);
      if (entry) entry.attempted = true;
      const emitted = cosEvents.emit('task:ready', task);
      if (entry) await settleDeferredPreflight(task.id, emitted);
    }
  } finally {
    // A failed tier (or an interrupted dispatch) must not claim a handoff.
    for (const taskId of deferredPreflights.keys()) await settleDeferredPreflight(taskId, false);
  }

  // Emit awaiting approval count if any
  if (cosTaskData.awaitingApproval?.length > 0) {
    emitLog('info', `${cosTaskData.awaitingApproval.length} tasks awaiting approval`);
  }

  if (tasksToSpawn.length === 0) {
    const awaitingCount = cosTaskData.awaitingApproval?.length || 0;
    const idleReason = awaitingCount > 0
      ? `${awaitingCount} task(s) awaiting approval, none auto-approved`
      : hasPendingUserTasks
        ? 'User tasks exist but all on cooldown or at capacity'
        : 'No user tasks, system tasks, or idle work available';
    emitLog('debug', `No tasks to process - idle: ${idleReason}`);
    await recordDecision(
      DECISION_TYPES.IDLE,
      idleReason,
      { pendingUser: pendingUserCount, pendingSystem: pendingSystemCount, awaitingApproval: awaitingCount, runningAgents }
    );
  }
}

