/**
 * CoS Task Generator Module
 *
 * The task-generation + evaluation engine extracted from cos.js. Owns:
 *  - `evaluateTasks` — the periodic/startup evaluation loop that decides what
 *    to spawn (priority 0 on-demand → 1 user → 2 auto-system → 3 mission/feature
 *    → 4 idle review) and emits `task:ready` for each pick.
 *  - the self-improvement / managed-app / idle-review generators that build the
 *    actual task objects (prompt template + metadata + confidence approval).
 *  - the PLAN.md in-flight pick helpers (`applyPlanIdMetadata`,
 *    `buildPlanConstraintBlock`) and the pipeline-precondition helpers
 *    (`checkStagePrecondition`, `shouldSkipForPrecondition`,
 *    `initializePipelineMetadata`, `applyAppWorktreeDefault`).
 *
 * Self-contained — it imports only sibling services (no import back to cos.js).
 * `evaluateTasks` emits `task:ready` rather than spawning directly, so the
 * spawn-side scheduler (`dequeueNextTask`/`tryImmediateSpawn`) stays in cos.js.
 * The startup-skip flag is passed in as the `initialStartup` option rather than
 * read from cos.js module state, and the paused check reads state directly.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { sanitizeTaskMetadata, PIPELINE_BEHAVIOR_FLAGS, MAX_TOTAL_SPAWNS, normalizeReviewers } from '../lib/validation.js';
import { parsePlanItems, extractAllIds, findInProgressIds, pickFirstAvailable, diagnoseUnpickablePlan } from '../lib/planIds.js';
import { loadState, saveState, withStateLock, isImprovementEnabled, isDaemonRunning } from './cosState.js';
import { getDomainMode } from '../lib/domainAutonomy.js';
import { remainingActionBudget } from '../lib/domainBudgets.js';
import { getDomainBudgetStatus } from './domainUsage.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { addTask, updateTask, getAllTasks, getCosTasks, firstLine, PRIORITY_VALUES } from './cosTaskStore.js';
import { recordDecision, DECISION_TYPES } from './decisionLog.js';
import { isAppOnCooldown, markAppReviewCooldown, bindAppReviewAgent, markIdleReviewStarted, getNextAppForReview, loadAppActivity, isAppActivityOnCooldown } from './appActivity.js';
import { getActiveApps, getAppTaskTypeOverrides } from './apps.js';
import { getTaskTypeConfidence } from './taskLearning.js';
import { generateProactiveTasks as generateMissionTasks } from './missions.js';
import { isRecoveryTask } from './recoveryTasks.js';

/**
 * Block a task that has exceeded the max spawn limit. Returns true if blocked.
 */
export async function blockIfExceedsMaxSpawns(task, taskType) {
  if (!exceedsMaxSpawns(task)) return false;
  const totalSpawns = Number(task.metadata?.totalSpawnCount) || 0;
  emitLog('info', `🚫 Blocking task ${task.id} — exceeded max spawns (${totalSpawns}/${MAX_TOTAL_SPAWNS})`, { taskId: task.id });
  await updateTask(task.id, {
    status: 'blocked',
    metadata: { ...task.metadata, blockedReason: `Max total spawns exceeded (${totalSpawns}/${MAX_TOTAL_SPAWNS})`, blockedCategory: 'max-spawns', blockedAt: new Date().toISOString() }
  }, taskType).catch(err => {
    emitLog('warn', `Failed to block task ${task.id}: ${err.message}`, { taskId: task.id });
  });
  return true;
}

/**
 * Non-mutating sibling of `blockIfExceedsMaxSpawns` — true when a task has hit
 * the max-total-spawns ceiling, WITHOUT blocking/persisting it. Used by the
 * dry-run eligibility pass, which must predict execute's skip without mutating.
 */
export function exceedsMaxSpawns(task) {
  return (Number(task.metadata?.totalSpawnCount) || 0) >= MAX_TOTAL_SPAWNS;
}

/**
 * Dry-run eligibility pass over auto-approved system tasks. Walks the tasks in
 * file order applying the SAME gates execute mode uses — global slot cap,
 * max-total-spawns, app cooldown, per-project cap — while tracking virtual
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
    extraSkip = () => false
  } = ctx;

  const counts = { ...spawnProjectCounts };
  let spawned = alreadySpawned;
  const spawnable = [];

  for (const task of autoApproved) {
    if (spawned >= availableSlots) break;
    if (exceedsMaxSpawns(task)) continue;
    if (extraSkip(task)) continue;
    const appId = task.metadata?.app;
    if (appId && !cooldownExempt(task) && (await isOnCooldown(appId))) continue;
    const project = appId || '_self';
    if ((counts[project] || 0) >= perProjectLimit) continue;
    counts[project] = (counts[project] || 0) + 1;
    spawned++;
    spawnable.push(task);
  }

  return spawnable;
}

// Task types where the scheduler reads PLAN.md to find an in-flight-aware pick.
// `do-replan` is excluded — it assigns IDs rather than picking one off the list.
const PLAN_PICK_TASK_TYPES = new Set(['feature-ideas', 'plan-task']);

// Subset of PLAN_PICK_TASK_TYPES where the AGENT picks (and claims) its own slug
// at execution time — mirroring the `/claim` slash command. For these, the
// scheduler must NOT stamp `metadata.planId`: a dispatch-time pre-pick happens
// before the agent creates its `claim/<slug>` branch (the real lock), so two
// near-simultaneous dispatches would both target the same first-available item.
// We still run the in-flight scan below purely as a DISPATCH GATE (skip the run
// when nothing is pickable), but leave the actual pick to the agent's Phase 1
// scan, which immediately precedes branch creation. The 2026-05-21 duplicate-PR
// incident (see cos.test.js) is guarded by the full Phase 1–7 self-pick prompt,
// not by the pre-pick. `feature-ideas` is intentionally NOT in this set — it
// uses a scheduler-managed worktree whose branch name encodes `planId`.
const PLAN_SELF_CLAIM_TASK_TYPES = new Set(['plan-task']);

// Subset of PLAN_PICK_TASK_TYPES where the dispatch should be skipped entirely
// when no PLAN.md item is dispatchable. `feature-ideas` is intentionally
// excluded: it brainstorms new items when PLAN.md is empty/blocked, so it
// must run regardless. `plan-task` is a strict executor and would just exit
// cleanly — burning an LLM round for nothing.
const PLAN_GATE_TASK_TYPES = new Set(['plan-task']);

/**
 * For feature-ideas / plan-task, read the target repo's PLAN.md, find which
 * item IDs are already in flight via branch/PR scan, and pick the first
 * available item. Mutates `metadata` in place by setting `planId` when a
 * pick succeeds — EXCEPT for self-claiming task types (PLAN_SELF_CLAIM_TASK_TYPES),
 * where the agent picks its own slug at execution time and the scan is used
 * only as the dispatch gate (no `planId` stamp).
 *
 * Returns `{ skipReason }` so the caller can short-circuit the LLM dispatch
 * for `plan-task` when there's literally nothing to do (empty plan, all
 * items blocked on human input via NEEDS_INPUT/DRIFT, or all claimed
 * elsewhere). `feature-ideas` is never gated — its job is to brainstorm
 * from scratch when the plan is empty, so it always runs.
 *
 * @returns {Promise<{ skipReason: string | null }>}
 */
async function applyPlanIdMetadata(taskType, repoPath, metadata) {
  if (!PLAN_PICK_TASK_TYPES.has(taskType)) return { skipReason: null };
  if (!repoPath) return { skipReason: null };
  const planMd = await readFile(join(repoPath, 'PLAN.md'), 'utf-8').catch(() => '');
  const gateDispatch = PLAN_GATE_TASK_TYPES.has(taskType);
  if (!planMd) {
    return { skipReason: gateDispatch ? 'PLAN.md missing or empty' : null };
  }
  const items = parsePlanItems(planMd);

  // Short-circuit on local evidence before the network round-trip to
  // `git fetch --prune` + `gh pr list`. When every unchecked item is
  // already blocked on human input, no in-flight scan can change that.
  if (gateDispatch) {
    const localOnly = diagnoseUnpickablePlan(null, new Set(), items);
    if (localOnly) return { skipReason: localOnly };
  }

  const knownIds = new Set(extractAllIds(planMd));
  const inFlight = await findInProgressIds(repoPath, knownIds).catch(() => new Set());
  const pick = pickFirstAvailable(items, inFlight);
  if (pick?.id) {
    // Self-claiming task types pick their own slug at execution time (like
    // `/claim`); stamping it here would pin concurrent dispatches to the same
    // item. For them this scan only serves as the gate above.
    if (!PLAN_SELF_CLAIM_TASK_TYPES.has(taskType)) {
      metadata.planId = pick.id;
    }
    return { skipReason: null };
  }
  if (!gateDispatch) return { skipReason: null };
  return { skipReason: diagnoseUnpickablePlan(null, inFlight, items) };
}

/**
 * Build the `{planConstraint}` substitution block. Empty when no planId —
 * the prompt's existing Phase 1 fallback (brainstorm or exit-clean) takes over.
 */
function buildPlanConstraintBlock(planId) {
  if (!planId) return '';
  return `
## Item Constraint

The scheduler has reserved PLAN.md item \`[${planId}]\` for you. You MUST work on that exact item — do not pick a different one, do not brainstorm. If the line is missing from PLAN.md, has already been checked, or carries \`<!-- NEEDS_INPUT -->\`, exit cleanly without commits or PR.
`;
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
 * Unblock tasks whose orphan-retry cooldown has expired. Walks the blocked
 * groups of both task stores and flips any `orphan-cooldown` task back to
 * pending once its `cooldownUntil` has passed. Extracted from `evaluateTasks`
 * so the cooldown-unblock pass is independently testable.
 */
async function unblockExpiredOrphanCooldowns(userTaskData, cosTaskData) {
  const allBlocked = [
    ...(userTaskData.grouped?.blocked || []),
    ...(cosTaskData.grouped?.blocked || [])
  ];
  for (const task of allBlocked) {
    if (task.metadata?.blockedCategory === 'orphan-cooldown' && task.metadata?.cooldownUntil) {
      if (new Date(task.metadata.cooldownUntil).getTime() <= Date.now()) {
        const taskType = task.taskType || (userTaskData.grouped?.blocked?.includes(task) ? 'user' : 'internal');
        emitLog('info', `⏰ Orphan cooldown expired for task ${task.id}, unblocking`, { taskId: task.id });
        await updateTask(task.id, {
          status: 'pending',
          metadata: {
            ...task.metadata,
            blockedReason: undefined,
            blockedCategory: undefined,
            blockedAt: undefined,
            cooldownUntil: undefined
          }
        }, taskType);
      }
    }
  }
}

/**
 * Resolve the per-domain CoS auto-run mode and the remaining autonomous-action
 * budget for this cycle (#711). The mode starts from `getDomainMode` and is
 * forced to `off` when the daily minutes cap is hit; the action budget caps how
 * many autonomous admissions the autonomous tiers may add this cycle.
 *
 * Off/dry-run withhold all AUTOMATIC internal spawns (auto-approved system
 * tasks, mission, feature-agent, idle-review); user and on-demand tasks are
 * unaffected. Usage is tallied in completeAgent for autonomous runs only, so a
 * pure dry-run never accrues; user/on-demand spawns are already past this gate.
 *
 * @returns {Promise<{ cosAutonomyMode: string, autonomousActionsRemaining: number }>}
 */
async function resolveAutonomyBudget(state, runningAgentEntries) {
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
      autonomousActionsRemaining = remainingActionBudget(cosBudget.budget, cosBudget.usage, runningAutonomous);
      if (autonomousActionsRemaining === 0) {
        emitLog('info', `CoS auto-run paused — daily actions budget reached`, { domainBudget: 'cos', exceeded: 'actions' });
        cosAutonomyMode = 'off';
      }
    }
  }

  return { cosAutonomyMode, autonomousActionsRemaining };
}

/**
 * Priority 0: On-demand task requests (highest priority — user explicitly
 * requested these). Reads the live schedule's `onDemandRequests`, clears each
 * as it is processed, and pushes any produced task (deduped) into the spawn set.
 * Runs against the global slot cap — on-demand work never counts against the
 * autonomous action budget.
 */
async function spawnPriority0OnDemand(ctx) {
  const { state, availableSlots, tasksToSpawn, canSpawnTask, trackSpawn } = ctx;

  const taskSchedule = await import('./taskSchedule.js');
  const liveSchedule = await taskSchedule.loadSchedule();
  const onDemandRequests = Array.isArray(liveSchedule?.onDemandRequests) ? liveSchedule.onDemandRequests : [];

  // Track apps already marked review-started this cycle so multiple on-demand
  // requests for the same app don't each rewrite its activity record.
  const reviewStartedApps = new Set();
  if (onDemandRequests.length > 0 && tasksToSpawn.length < availableSlots) {
    for (const request of onDemandRequests) {
      if (tasksToSpawn.length >= availableSlots) break;

      if (!isImprovementEnabled(state)) {
        emitLog('warn', `On-demand request dropped — improvement is disabled (Config → Improve)`, { requestId: request.id, taskType: request.taskType });
        await taskSchedule.clearOnDemandRequest(request.id);
        continue;
      }

      // Skip if the task type was disabled or removed after queuing — parity with dequeueNextTask.
      if (!liveSchedule.tasks[request.taskType]?.enabled) {
        emitLog('info', `On-demand request skipped — task type '${request.taskType}' is disabled`, { requestId: request.id });
        await taskSchedule.clearOnDemandRequest(request.id);
        continue;
      }

      let task = null;
      // Determine target app (if any)
      const apps = await getActiveApps().catch(() => []);
      let targetApp = null;

      if (request.appId) {
        targetApp = apps.find(a => a.id === request.appId);
        if (!targetApp) {
          emitLog('warn', `On-demand request for unknown app: ${request.appId}`, { requestId: request.id });
          await taskSchedule.clearOnDemandRequest(request.id);
          continue;
        }
      }

      await taskSchedule.clearOnDemandRequest(request.id);

      if (targetApp) {
        emitLog('info', `Processing on-demand improvement: ${request.taskType} for ${targetApp.name}`, { requestId: request.id, appId: targetApp.id });
        // Advance the cooldown eagerly (deduped per app per cycle), but defer
        // binding the active agent until a task is produced — a null result
        // here must not strand `activeAgentId` (issue #978).
        if (!reviewStartedApps.has(targetApp.id)) {
          await markAppReviewCooldown(targetApp.id);
          reviewStartedApps.add(targetApp.id);
        }
        await taskSchedule.recordExecution(`task:${request.taskType}`, targetApp.id);
        task = await generateManagedAppImprovementTaskForType(request.taskType, targetApp, state, { skipPreconditions: true });
        if (task) {
          await bindAppReviewAgent(targetApp.id, `on-demand-${Date.now()}`);
        }
      } else {
        emitLog('info', `Processing on-demand improvement: ${request.taskType}`, { requestId: request.id });
        await taskSchedule.recordExecution(`task:${request.taskType}`);
        await withStateLock(async () => {
          const s = await loadState();
          s.stats.lastSelfImprovement = new Date().toISOString();
          s.stats.lastSelfImprovementType = request.taskType;
          await saveState(s);
        });
        task = await generateSelfImprovementTaskForType(request.taskType, state);
      }

      if (task && canSpawnTask(task)) {
        const persisted = await addTask(task, 'internal', { raw: true });
        if (!persisted?.duplicate) {
          tasksToSpawn.push(task);
          trackSpawn(task);
        }
      }
    }
  }
}

/**
 * Priority 1: User tasks (always run — cooldown only applies to system tasks).
 * Runs against the global slot cap; user work never counts against the
 * autonomous action budget.
 */
async function spawnPriority1UserTasks(ctx) {
  const { pendingUserTasks, availableSlots, perProjectLimit, tasksToSpawn, canSpawnTask, trackSpawn } = ctx;
  for (const task of pendingUserTasks) {
    if (tasksToSpawn.length >= availableSlots) break;
    if (await blockIfExceedsMaxSpawns(task, 'user')) continue;
    const userTask = { ...task, taskType: 'user' };
    if (!canSpawnTask(userTask)) {
      const project = task.metadata?.app || '_self';
      emitLog('debug', `⏳ Queued user task ${task.id} - per-project limit reached for ${project}`);
      await recordDecision(
        DECISION_TYPES.CAPACITY_FULL,
        `User task ${task.id} deferred — per-project limit (${perProjectLimit}) reached for ${project}`,
        { taskId: task.id, project, limit: perProjectLimit }
      );
      continue;
    }
    tasksToSpawn.push(userTask);
    trackSpawn(userTask);
  }
}

/**
 * Priority 2: Auto-approved system tasks (if slots available) — gated by the
 * CoS auto-run domain. off/dry-run withhold the unattended spawn; dry-run logs
 * what would have run so the user can see the plan without it executing. Capped
 * by `autonomousSlotCeiling` (the CoS action budget, #711).
 */
async function spawnPriority2AutoApproved(ctx) {
  const { state, cosTaskData, cosAutonomyMode, autonomousSlotCeiling, perProjectLimit, spawnProjectCounts, tasksToSpawn, canSpawnTask, trackSpawn } = ctx;

  if (tasksToSpawn.length < autonomousSlotCeiling && cosTaskData.exists && cosAutonomyMode !== 'execute') {
    if (cosAutonomyMode === 'dry-run') {
      // Log only the tasks execute mode would ACTUALLY spawn — applying the same
      // max-spawns / cooldown / per-project gates against virtual capacity —
      // rather than every auto-approved task regardless of eligibility.
      const wouldSpawn = await selectDryRunAutoApproved(cosTaskData.autoApproved || [], {
        availableSlots: autonomousSlotCeiling,
        alreadySpawned: tasksToSpawn.length,
        perProjectLimit,
        spawnProjectCounts,
        isOnCooldown: (appId) => isAppOnCooldown(appId, state.config.appReviewCooldownMs),
        cooldownExempt: (task) => task.metadata?.pipeline?.currentStage > 0
      });
      for (const task of wouldSpawn) {
        emitLog('info', `[dry-run] CoS auto-run would spawn system task: ${task.id}`, { taskId: task.id, domainAutonomy: 'cos' });
      }
    }
  } else if (tasksToSpawn.length < autonomousSlotCeiling && cosTaskData.exists) {
    const autoApproved = cosTaskData.autoApproved || [];
    for (const task of autoApproved) {
      if (tasksToSpawn.length >= autonomousSlotCeiling) break;

      if (await blockIfExceedsMaxSpawns(task, 'internal')) continue;

      // Check if task's app is on cooldown (pipeline continuations bypass cooldown)
      const appId = task.metadata?.app;
      const isPipelineContinuation = task.metadata?.pipeline?.currentStage > 0;
      if (appId && !isPipelineContinuation) {
        const onCooldown = await isAppOnCooldown(appId, state.config.appReviewCooldownMs);
        if (onCooldown) {
          emitLog('debug', `Skipping system task ${task.id} - app ${appId} on cooldown`);
          await recordDecision(
            DECISION_TYPES.COOLDOWN_ACTIVE,
            `System task ${task.id} skipped — app ${appId} on cooldown (${Math.round(state.config.appReviewCooldownMs / 60000)}min window)`,
            { taskId: task.id, appId, cooldownMs: state.config.appReviewCooldownMs }
          );
          continue;
        }
      }

      const sysTask = { ...task, taskType: 'internal' };
      if (!canSpawnTask(sysTask, autonomousSlotCeiling)) {
        const sysProject = appId || '_self';
        emitLog('debug', `⏳ Queued system task ${task.id} - per-project limit reached for ${sysProject}`);
        await recordDecision(
          DECISION_TYPES.CAPACITY_FULL,
          `System task ${task.id} deferred — per-project limit (${perProjectLimit}) reached for ${sysProject}`,
          { taskId: task.id, project: sysProject, limit: perProjectLimit }
        );
        continue;
      }
      tasksToSpawn.push(sysTask);
      trackSpawn(sysTask);
    }
  }
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
    await queueEligibleImprovementTasks(state, cosTaskData);
  }
}

/**
 * Priority 3: Mission-driven proactive tasks (if no user tasks). Autonomous —
 * gated by the CoS auto-run domain (off/dry-run skip generation entirely) and
 * capped by `autonomousSlotCeiling`.
 */
async function spawnPriority3Missions(ctx) {
  const { state, hasPendingUserTasks, cosAutonomyMode, autonomousSlotCeiling, tasksToSpawn, canSpawnTask, trackSpawn } = ctx;

  if (tasksToSpawn.length < autonomousSlotCeiling && !hasPendingUserTasks && state.config.proactiveMode && cosAutonomyMode === 'execute') {
    const missionTasks = await generateMissionTasks({ maxTasks: autonomousSlotCeiling - tasksToSpawn.length }).catch(err => {
      emitLog('debug', `Mission task generation failed: ${err.message}`);
      return [];
    });

    for (const missionTask of missionTasks) {
      if (tasksToSpawn.length >= autonomousSlotCeiling) break;
      // Convert mission task to COS task format
      const cosTask = {
        id: missionTask.id,
        description: missionTask.description,
        priority: missionTask.priority?.toUpperCase() || 'MEDIUM',
        status: 'pending',
        metadata: missionTask.metadata,
        taskType: 'internal',
        approvalRequired: !missionTask.autoApprove
      };
      if (!canSpawnTask(cosTask, autonomousSlotCeiling)) continue;
      tasksToSpawn.push(cosTask);
      trackSpawn(cosTask);
      emitLog('info', `Generated mission task: ${missionTask.id} (${missionTask.metadata?.missionName})`, {
        missionId: missionTask.metadata?.missionId,
        appId: missionTask.metadata?.appId
      });
    }
  }
}

/**
 * Priority 3.6: Feature Agents (after autonomous jobs, yield to user tasks).
 * Autonomous — gated by the CoS auto-run domain and capped by
 * `autonomousSlotCeiling`.
 *
 * Priority 3.5 (autonomous jobs) has no inline tier: those are handled by
 * registerJobSchedules(), which sets up individual one-shot timers per job via
 * executeScheduledJob(). It used to also check getDueJobs() and spawn here,
 * which caused duplicate agent spawns on startup when both paths fired for the
 * same past-due job within seconds of each other.
 */
async function spawnPriority36FeatureAgents(ctx) {
  const { hasPendingUserTasks, cosAutonomyMode, autonomousSlotCeiling, tasksToSpawn, canSpawnTask, trackSpawn } = ctx;

  if (tasksToSpawn.length < autonomousSlotCeiling && !hasPendingUserTasks && cosAutonomyMode === 'execute') {
    const { getDueFeatureAgents, generateTaskFromFeatureAgent, setCurrentAgent } = await import('./featureAgents.js');
    const dueAgents = await getDueFeatureAgents().catch(err => {
      emitLog('debug', `Feature agents check failed: ${err.message}`);
      return [];
    });
    for (const fa of dueAgents) {
      if (tasksToSpawn.length >= autonomousSlotCeiling) break;
      const task = generateTaskFromFeatureAgent(fa);
      if (!canSpawnTask(task, autonomousSlotCeiling)) continue;
      tasksToSpawn.push(task);
      trackSpawn(task);
      // Mark agent as having a pending task to prevent duplicate spawns
      await setCurrentAgent(fa.id, task.id).catch(() => {});
      emitLog('info', `Feature agent due: ${fa.name}`, { featureAgentId: fa.id });
    }
  }
}

/**
 * Priority 4: Generate a direct idle-review task ONLY when:
 * 1. Nothing else is queued to spawn
 * 2. No pending user tasks (even on cooldown)
 * 3. No system tasks queued
 * Autonomous — gated by the CoS auto-run domain.
 */
async function spawnPriority4IdleReview(ctx) {
  const { state, hasPendingUserTasks, cosAutonomyMode, autonomousSlotCeiling, tasksToSpawn, canSpawnTask, trackSpawn } = ctx;

  if (tasksToSpawn.length === 0 && state.config.idleReviewEnabled && !hasPendingUserTasks && cosAutonomyMode === 'execute') {
    const freshCosTasks = await getCosTasks();
    const pendingSystemTasks = freshCosTasks.autoApproved?.length || 0;
    if (pendingSystemTasks === 0) {
      const idleTask = await generateIdleReviewTask(state);
      if (idleTask && canSpawnTask(idleTask, autonomousSlotCeiling)) {
        tasksToSpawn.push(idleTask);
        trackSpawn(idleTask);
      }
    }
  }
}

/**
 * Evaluate tasks and decide what to spawn.
 *
 * Orchestrates the spawn-priority tiers in sequence, each extracted into a named
 * private function that mutates a shared spawn context (`ctx`):
 *   - Priority 0 — on-demand requests       (`spawnPriority0OnDemand`)
 *   - Priority 1 — pending user tasks        (`spawnPriority1UserTasks`)
 *   - Priority 2 — auto-approved system tasks (`spawnPriority2AutoApproved`)
 *   - Priority 3 — mission-driven tasks      (`spawnPriority3Missions`)
 *   - Priority 3.6 — due feature agents      (`spawnPriority36FeatureAgents`)
 *   - Priority 4 — idle review               (`spawnPriority4IdleReview`)
 *
 * Cross-cutting gates live here so they cover every tier uniformly: the
 * paused/daemon guard, the global slot cap, orphan-cooldown unblocking, and the
 * CoS auto-run + daily-budget gate (`resolveAutonomyBudget`). Priorities 0–1
 * spend against the global `availableSlots`; the autonomous tiers (2, 3, 3.6, 4)
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

  // Check if paused - skip evaluation if so
  const paused = (await loadState()).paused || false;
  if (paused) {
    emitLog('debug', 'CoS is paused - skipping evaluation');
    return;
  }

  // Update evaluation timestamp with lock to prevent race conditions
  const state = await withStateLock(async () => {
    const s = await loadState();
    s.stats.lastEvaluation = new Date().toISOString();
    await saveState(s);
    return s;
  });

  // Get both user and CoS tasks
  const { user: userTaskData, cos: cosTaskData } = await getAllTasks();

  // Unblock tasks whose orphan-retry cooldown has expired
  await unblockExpiredOrphanCooldowns(userTaskData, cosTaskData);

  // Count running agents and available slots (global + per-project)
  const runningAgentEntries = Object.values(state.agents).filter(a => a.status === 'running');
  const runningAgents = runningAgentEntries.length;
  const availableSlots = state.config.maxConcurrentAgents - runningAgents;

  const perProjectLimit = state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents;
  const agentsByProject = countRunningAgentsByProject(state.agents);

  if (availableSlots <= 0) {
    emitLog('warn', `Max concurrent agents reached (${runningAgents}/${state.config.maxConcurrentAgents})`);
    await recordDecision(
      DECISION_TYPES.CAPACITY_FULL,
      `All ${state.config.maxConcurrentAgents} agent slots occupied`,
      { running: runningAgents, max: state.config.maxConcurrentAgents }
    );
    cosEvents.emit('evaluation', { message: 'Max concurrent agents reached', running: runningAgents });
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
  const canSpawnTask = (task, ceiling = availableSlots) => {
    if (tasksToSpawn.length >= ceiling) return false;
    const project = task.metadata?.app || '_self';
    return (spawnProjectCounts[project] || 0) < perProjectLimit;
  };
  // Helper: track a spawned task's project
  const trackSpawn = (task) => {
    const project = task.metadata?.app || '_self';
    spawnProjectCounts[project] = (spawnProjectCounts[project] || 0) + 1;
  };

  // Check if there are pending user tasks (even if on cooldown). If user tasks
  // exist, don't run self-improvement — wait for user tasks to be ready.
  const pendingUserTasks = userTaskData.grouped?.pending || [];
  const hasPendingUserTasks = pendingUserTasks.length > 0;

  // Shared spawn context threaded through each priority tier. The tiers mutate
  // `tasksToSpawn` / `spawnProjectCounts` through the helpers; `canSpawnTask`
  // and `trackSpawn` close over those same references so the running totals stay
  // consistent across tiers. `autonomousSlotCeiling` is filled in after the
  // global-slot tiers (0–1) settle, below.
  const ctx = {
    state,
    cosTaskData,
    availableSlots,
    perProjectLimit,
    tasksToSpawn,
    spawnProjectCounts,
    cosAutonomyMode,
    initialStartup,
    pendingUserTasks,
    hasPendingUserTasks,
    canSpawnTask,
    trackSpawn,
    autonomousSlotCeiling: availableSlots
  };

  // Priorities 0–1 spend against the global slot cap.
  await spawnPriority0OnDemand(ctx);
  await spawnPriority1UserTasks(ctx);

  // Ceiling for AUTONOMOUS admissions this cycle (#711). On-demand + user tasks
  // are already in `tasksToSpawn` and never count against the CoS action budget,
  // so the autonomous sections below may add at most `autonomousActionsRemaining`
  // more. With no action cap this equals `availableSlots`, so the default path is
  // unchanged. The autonomous tiers use this in place of `availableSlots`.
  ctx.autonomousSlotCeiling = Math.min(availableSlots, tasksToSpawn.length + autonomousActionsRemaining);

  // Priorities 2, 3, 3.6, 4 spend against the lower autonomous ceiling.
  await spawnPriority2AutoApproved(ctx);
  await maybeQueueImprovementTasks(ctx);
  await spawnPriority3Missions(ctx);
  await spawnPriority36FeatureAgents(ctx);
  await spawnPriority4IdleReview(ctx);

  // Emit evaluation status
  const pendingUserCount = userTaskData.grouped?.pending?.length || 0;
  const inProgressCount = userTaskData.grouped?.in_progress?.length || 0;
  const pendingSystemCount = cosTaskData.grouped?.pending?.length || 0;

  const evalLevel = tasksToSpawn.length > 0 ? 'info' : 'debug';
  emitLog(evalLevel, `Evaluation: ${pendingUserCount} user pending, ${inProgressCount} in_progress, ${pendingSystemCount} system, spawning ${tasksToSpawn.length}`, {
    pendingUser: pendingUserCount,
    inProgress: inProgressCount,
    pendingSystem: pendingSystemCount,
    toSpawn: tasksToSpawn.length,
    availableSlots
  });

  // Note: Performance summaries, learning insights, and rehabilitation checks
  // are now handled by dedicated maintenance intervals (cos-performance-summary,
  // cos-learning-insights, cos-rehabilitation-check) instead of evalCount gating.

  // Spawn all ready tasks (up to available slots)
  for (const task of tasksToSpawn) {
    emitLog('success', `Spawning task: ${task.id} (${task.priority || 'MEDIUM'})`, {
      taskId: task.id,
      taskType: task.taskType,
      app: task.metadata?.app
    });
    cosEvents.emit('task:ready', task);
  }

  // Emit awaiting approval count if any
  if (cosTaskData.exists && cosTaskData.awaitingApproval?.length > 0) {
    emitLog('info', `${cosTaskData.awaitingApproval.length} tasks awaiting approval`);
    cosEvents.emit('evaluation', {
      message: 'Tasks awaiting approval',
      awaitingApproval: cosTaskData.awaitingApproval.length
    });
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
    cosEvents.emit('evaluation', { message: 'No pending tasks to process' });
  }
}

/**
 * Generate an idle task when no user/system tasks are pending
 * Alternates between:
 * 1. Self-improvement tasks (UI analysis, security, code quality)
 * 2. App reviews for managed apps
 *
 * @param {Object} state - Current CoS state
 * @returns {Object|null} Generated task or null if nothing to do
 */
export async function generateIdleReviewTask(state) {
  if (!isImprovementEnabled(state)) {
    emitLog('debug', 'Improvement tasks are disabled');
    return null;
  }

  // Get all active (non-archived) managed apps (including PortOS)
  const apps = await getActiveApps().catch(() => []);

  if (apps.length > 0) {
    // Find next app eligible for review (not on cooldown, oldest review first)
    const nextApp = await getNextAppForReview(apps, state.config.appReviewCooldownMs);

    if (nextApp) {
      // Mark that we're starting an idle review. Advance the per-app cooldown
      // eagerly (so this app isn't re-picked on the next idle tick) but do NOT
      // bind an active agent yet — the task generator below may return null
      // (no claimable PLAN item, watcher no-op, precondition skip), in which
      // case binding here would strand `activeAgentId` and leave the app stuck
      // reading "in review" until stale-agent cleanup (issue #978).
      await markIdleReviewStarted();
      await markAppReviewCooldown(nextApp.id);

      // Update lastIdleReview timestamp
      await withStateLock(async () => {
        const s = await loadState();
        s.stats.lastIdleReview = new Date().toISOString();
        await saveState(s);
      });

      emitLog('info', `Generating improvement task for ${nextApp.name}`, { appId: nextApp.id });
      const idleTask = await generateManagedAppImprovementTask(nextApp, state);
      // Only bind the active marker once a real task exists.
      if (idleTask) {
        await bindAppReviewAgent(nextApp.id, `idle-review-${Date.now()}`);
      }
      return idleTask;
    }
  }

  emitLog('debug', 'No idle tasks available');
  return null;
}

/**
 * Queue eligible self-improvement and app improvement tasks as system tasks
 * Called during every evaluation to ensure system tasks are queued even when user tasks exist
 * Tasks are queued to COS-TASKS.md and will be picked up in Priority 2
 */
export async function queueEligibleImprovementTasks(state, cosTaskData) {
  const { getNextTaskType, recordExecution } = await import('./taskSchedule.js');

  if (!isImprovementEnabled(state)) return;

  // Get existing pending/in_progress system tasks to avoid duplicates
  // Also skip task types where a user-terminated blocked task exists (user intentionally killed it)
  const existingTasks = cosTaskData.tasks || [];
  const existingTaskTypes = new Set();
  // Apps that already have *any* pending/in_progress improvement task. We cap each
  // app at one queued improvement at a time to avoid a fan-out where multiple
  // improvement types pile up faster than the per-app cooldown can drain them.
  const appsWithPendingImprovement = new Set();

  for (const task of existingTasks) {
    const isActive = task.status === 'pending' || task.status === 'in_progress';
    const isUserTerminated = task.status === 'blocked' && task.metadata?.blockedCategory === 'user-terminated';
    if (isActive || isUserTerminated) {
      const analysisType = task.metadata?.analysisType ||
        task.metadata?.selfImprovementType ||
        task.description?.match(/\[(?:self-improvement|improvement)\]\s*(\w[\w-]*)/i)?.[1];
      const appId = task.metadata?.app;
      if (analysisType) {
        existingTaskTypes.add(appId ? `app:${appId}:${analysisType}` : analysisType);
      }
    }
    if (isActive && task.metadata?.app && !isRecoveryTask(task)) {
      appsWithPendingImprovement.add(task.metadata.app);
    }
  }

  let queued = 0;

  // Load the activity snapshot ONCE before the per-app loop. Both the
  // cooldown gate and the rotation `lastType` lookup are derived from
  // `data/app-activity.json`; before this hoist, each app paid two
  // separate disk reads (one via `isAppOnCooldown` + one via
  // `getAppActivityById`), so a 10-app deployment did 20 reads of the
  // same file per scheduler tick. With the snapshot pinned, the cost
  // is O(1) read per `queueEligibleImprovementTasks` invocation. Falls
  // back to an empty `apps` map on disk error so the loop's per-app
  // lookups uniformly return `undefined` (both gates treat that as
  // "no activity yet — not on cooldown, no last type").
  const activitySnapshot = await loadAppActivity().catch(() => ({ apps: {} }));

  // Queue eligible improvement tasks for all managed apps (including PortOS)
  const apps = await getActiveApps().catch(() => []);
  for (const app of apps) {
    // One pending improvement per app at a time — sibling types must wait
    // until the current task drains, otherwise they queue faster than they
    // can run (per-project concurrency limit + cooldown after each completion).
    if (appsWithPendingImprovement.has(app.id)) {
      emitLog('debug', `App ${app.name} already has a pending improvement task — skipping queue`);
      continue;
    }

    // Derive both gates from the single shared snapshot. The async
    // `isAppOnCooldown` would also work, but it loads the activity file
    // again per app — see comment on `activitySnapshot` above.
    // Optional chain on `.apps` — `loadAppActivity()` spreads
    // `DEFAULT_ACTIVITY` over the file contents, but a hand-edited
    // activity.json that explicitly sets `apps: null` (or any non-object)
    // would still surface here; both gates treat `undefined` as
    // "no activity yet."
    const appActivity = activitySnapshot.apps?.[app.id];
    if (isAppActivityOnCooldown(appActivity, state.config.appReviewCooldownMs)) continue;

    // Get next eligible improvement type for this app. `getNextTaskType`
    // falls back to ROTATION when nothing is time-due, and the rotation
    // pointer is derived from the `lastType` argument — without it, the
    // rotation always restarts from index 0 and starves every other
    // rotation type for the app. Mirror `generateManagedAppTask` (the
    // legacy direct-spawn caller above) which threads the per-app
    // `lastImprovementType` in.
    const lastType = appActivity?.lastImprovementType || '';
    const nextTypeResult = await getNextTaskType(app.id, lastType).catch(() => null);
    if (!nextTypeResult) continue;
    const nextType = nextTypeResult.taskType;

    const taskKey = `app:${app.id}:${nextType}`;
    if (existingTaskTypes.has(taskKey)) {
      emitLog('debug', `Improvement task ${nextType} for ${app.name} already queued`);
      continue;
    }

    // Route through the rich generator so `applyPlanIdMetadata` runs — it
    // scans open `claim/<slug>` branches + PRs and excludes in-flight slugs
    // from the pick. The old stub path skipped this and let two plan-task
    // agents claim the same slug (2026-05-21 incident). The generator
    // returns null on plan-gate / precondition skip; we silently continue.
    // Regression-pinned in cos.test.js.
    const task = await generateManagedAppImprovementTaskForType(nextType, app, state);
    if (!task) continue;

    // Queue-path invariants override the generator's direct-spawn defaults
    // (which use MEDIUM priority + `app-improve-*` id).
    task.priority = 'LOW';
    task.priorityValue = PRIORITY_VALUES.LOW;
    task.id = `sys-${app.id.slice(0, 8)}-${nextType}-${Date.now().toString(36)}`;

    // Move the generator's multi-line prompt into `metadata.context` so it
    // survives the COS-TASKS.md round-trip. The on-demand path dispatches the
    // in-memory task immediately (cosEvents.emit('task:ready', task) with the
    // unparsed object), so it never round-trips through the markdown — but
    // the queue path persists first and re-reads from disk on the next
    // `dequeueNextTask` tick. `generateTasksMarkdown` interpolates the full
    // `task.description` onto a single line (taskParser.js:268) and
    // `parseTasksMarkdown` only matches the first line of a `- [ ]` block —
    // so any newline in `description` corrupts the file (stray `## Phase`
    // lines become section headers, `- ` lines become new tasks) AND silently
    // strips the Phase 1–7 instructions on the re-read. `metadata.context` is
    // newline-escaped via `escapeNewlines`/`unescapeNewlines` (JSON-sentinel
    // encoding) so it round-trips losslessly. The agent prompt builder
    // (`cos-agent-briefing.md` + the built-in fallback in
    // `agentPromptBuilder.js`) renders both `task.description` AND
    // `task.metadata.context` into the agent's prompt, so the agent still
    // sees the full Phase 1–7 body.
    if (typeof task.description === 'string' && task.description.includes('\n')) {
      task.metadata = task.metadata || {};
      task.metadata.context = task.description;
      task.description = firstLine(task.description);
    }

    const newTask = await addTask(task, 'internal', { raw: true });
    if (newTask?.duplicate) continue;

    await recordExecution(`task:${nextType}`, app.id);

    emitLog('info', `Queued improvement task: ${nextType} for ${app.name}`, { taskId: newTask.id, appId: app.id });
    existingTaskTypes.add(taskKey);
    appsWithPendingImprovement.add(app.id);
    queued++;

    // Only queue one task per app per evaluation to avoid flooding
  }

  if (queued > 0) {
    emitLog('info', `Queued ${queued} improvement task(s) to system tasks`);
  }
}

/**
 * Resolve auto-approval for a task based on confidence scoring.
 * Returns { autoApproved, approvalRequired } ready to spread into task objects.
 */
async function resolveConfidenceApproval(state, taskTypeKey, logLabel) {
  const config = state?.config?.confidenceAutoApproval ?? {};
  if (config.enabled === false) return { autoApproved: true, approvalRequired: false };

  const confidence = await getTaskTypeConfidence(taskTypeKey, config);
  if (!confidence.autoApprove) {
    emitLog('info', `🔒 ${logLabel} requires approval (${confidence.reason})`, {}, '[Confidence]');
  }
  return { autoApproved: confidence.autoApprove, approvalRequired: !confidence.autoApprove };
}

/**
 * Helper function to generate a self-improvement task for a specific type
 * Used by both normal rotation and on-demand task requests
 */
export async function generateSelfImprovementTaskForType(taskType, state) {
  const taskSchedule = await import('./taskSchedule.js');
  const interval = await taskSchedule.getTaskInterval(taskType);

  // Get the effective prompt (custom or default)
  const description = await taskSchedule.getTaskPrompt(taskType);

  const metadata = {
    analysisType: taskType,
    autoGenerated: true,
    selfImprovement: true
  };

  // Apply sanitized task-type-specific metadata from schedule config (e.g., useWorktree, simplify)
  const sanitizedMeta = sanitizeTaskMetadata(interval.taskMetadata);
  if (sanitizedMeta) {
    Object.assign(metadata, sanitizedMeta);
  }

  // Use configured model/provider if specified, otherwise use default
  if (interval.providerId) {
    metadata.provider = interval.providerId;
    metadata.providerId = interval.providerId;
  }
  if (interval.model) {
    metadata.model = interval.model;
  } else {
    metadata.model = 'claude-opus-4-5-20251101';
  }

  const approval = await resolveConfidenceApproval(state, `self-improve:${taskType}`, `Task self-improve:${taskType}`);

  const task = {
    id: `self-improve-${taskType}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: 'MEDIUM',
    priorityValue: PRIORITY_VALUES['MEDIUM'],
    description,
    metadata,
    taskType: 'internal',
    ...approval
  };

  return task;
}

/**
 * Check if a pipeline stage's precondition is met.
 * Supports { fileExists: 'path' } and { fileNotExists: 'path' }.
 * Paths are relative to repoPath.
 */
export function checkStagePrecondition(stage, repoPath) {
  const pre = stage?.precondition;
  if (!pre || !repoPath) return { passed: true };
  if (pre.fileExists) {
    const fullPath = join(repoPath, pre.fileExists);
    if (!existsSync(fullPath)) return { passed: false, reason: `${pre.fileExists} does not exist` };
  }
  if (pre.fileNotExists) {
    const fullPath = join(repoPath, pre.fileNotExists);
    if (existsSync(fullPath)) return { passed: false, reason: `${pre.fileNotExists} already exists` };
  }
  return { passed: true };
}

/**
 * Check stage 0 precondition after pipeline initialization.
 * Returns true if the task should be skipped (precondition failed).
 */
function shouldSkipForPrecondition(metadata, app, analysisType) {
  const stage0 = metadata.pipeline?.stages?.[0];
  if (!stage0?.precondition) return false;
  const check = checkStagePrecondition(stage0, app.repoPath);
  if (!check.passed) {
    emitLog('info', `⏭️ Skipping ${analysisType} for ${app.name}: ${check.reason}`, { appId: app.id, analysisType });
    return true;
  }
  return false;
}

/**
 * Initialize pipeline runtime state on metadata if pipeline stages are configured.
 * Mutates the metadata object in place.
 */
function initializePipelineMetadata(metadata) {
  if (!metadata.pipeline?.stages?.length) return;
  metadata.pipeline = {
    ...metadata.pipeline,
    id: `pipeline-${Date.now().toString(36)}`,
    currentStage: 0,
    stageResults: [],
    previousStageAgentId: null,
    status: 'running'
  };
  const stage0 = metadata.pipeline.stages[0];
  if (stage0.readOnly !== undefined) {
    metadata.readOnly = stage0.readOnly;
  }
  // Propagate stage 0's provider/model so the first agent uses per-stage config
  if (stage0.model) metadata.model = stage0.model;
  if (stage0.providerId) {
    metadata.provider = stage0.providerId;
    metadata.providerId = stage0.providerId;
  }
  // Save task-level defaults and apply stage 0 overrides in one pass
  // Read-only stages default flags to false to prevent worktree/PR/simplify on review-only stages
  metadata.pipeline.taskDefaults = {};
  const stageReadOnly = stage0.readOnly ?? false;
  for (const flag of PIPELINE_BEHAVIOR_FLAGS) {
    if (metadata[flag] !== undefined) metadata.pipeline.taskDefaults[flag] = metadata[flag];
    if (flag in stage0) {
      metadata[flag] = stage0[flag];
    } else if (stageReadOnly) {
      metadata[flag] = false;
    }
  }
}

// Apply app-level worktree/PR defaults only when not already set by task-type metadata.
// openPR is applied first since it implies useWorktree — this prevents defaultUseWorktree: false
// from blocking defaultOpenPR: true when both are app-level defaults.
export function applyAppWorktreeDefault(metadata, app) {
  const taskTypeDisabledWorktree = metadata.useWorktree === false || metadata.useWorktree === 'false';

  // Apply defaultOpenPR first (since openPR implies useWorktree)
  if (metadata.openPR === undefined) {
    if (app.defaultOpenPR === true && !taskTypeDisabledWorktree) {
      metadata.openPR = true;
      metadata.useWorktree = true; // openPR implies useWorktree
    } else if (app.defaultOpenPR === false || taskTypeDisabledWorktree) {
      metadata.openPR = false;
    }
  }

  // Apply defaultUseWorktree (only if not already set by task-type or openPR above)
  if (metadata.useWorktree === undefined) {
    // openPR implies useWorktree — don't let app default override explicit openPR: true
    const explicitOpenPR = metadata.openPR === true || metadata.openPR === 'true';
    if (explicitOpenPR) {
      metadata.useWorktree = true;
    } else if (app.defaultUseWorktree === true) {
      metadata.useWorktree = true;
    } else if (app.defaultUseWorktree === false) {
      metadata.useWorktree = false;
    }
  }

  // Final invariant: openPR implies useWorktree (normalize in both directions)
  const finalOpenPR = metadata.openPR === true || metadata.openPR === 'true';
  const finalWorktreeOff = metadata.useWorktree === false || metadata.useWorktree === 'false';
  if (finalOpenPR && finalWorktreeOff) {
    // openPR wins — force useWorktree on
    metadata.useWorktree = true;
  } else if (finalWorktreeOff) {
    metadata.openPR = false;
  }
}

async function generateManagedAppImprovementTask(app, state) {
  const { getAppActivityById, updateAppActivity } = await import('./appActivity.js');
  const taskSchedule = await import('./taskSchedule.js');

  // First, check for any on-demand task requests for this app
  const onDemandRequests = await taskSchedule.getOnDemandRequests();
  const appRequests = onDemandRequests.filter(r => r.appId === app.id);

  let nextType;
  let selectionReason;

  if (appRequests.length > 0) {
    const request = appRequests[0];
    await taskSchedule.clearOnDemandRequest(request.id);
    nextType = request.taskType;
    selectionReason = 'on-demand';
    emitLog('info', `Processing on-demand app task request: ${nextType} for ${app.name}`, { requestId: request.id });
  } else {
    // Get last improvement type for this app
    const appActivity = await getAppActivityById(app.id);
    const lastType = appActivity?.lastImprovementType || '';

    // Use the schedule service to determine the next task type
    const nextTypeResult = await taskSchedule.getNextTaskType(app.id, lastType);

    if (!nextTypeResult) {
      emitLog('info', `No app improvement tasks are eligible for ${app.name} based on schedule`);
      return null;
    }

    nextType = nextTypeResult.taskType;
    selectionReason = nextTypeResult.reason;
  }

  // Record execution in the schedule service
  await taskSchedule.recordExecution(`task:${nextType}`, app.id);

  // Update app activity with new type
  await updateAppActivity(app.id, {
    lastImprovementType: nextType
  });

  emitLog('info', `Generating improvement task for ${app.name}: ${nextType} (${selectionReason})`, { appId: app.id, analysisType: nextType });

  // Delegate the actual task build to the per-type generator so the dynamic
  // blocks run on the idle-review path too: pr-watcher's PR poll +
  // {prData}/{repoFullName}/{defaultBranch} injection, and reference-watch's
  // {referenceData} injection. Without delegation this path replaced only the
  // generic placeholders, so a watcher type selected here would spawn a prompt
  // with the literal {prData}/{referenceData} markers and never poll. The
  // recordExecution + activity bump above already accounted for the idle
  // spawn; the per-type generator does not record execution itself.
  return generateManagedAppImprovementTaskForType(nextType, app, state);
}

/**
 * Generate a managed app improvement task for a specific type
 * Used by on-demand task processing and can be called directly
 *
 * @param {string} taskType - The type of improvement task (e.g., 'security-audit', 'code-quality')
 * @param {Object} app - The managed app object
 * @param {Object} state - Current CoS state
 * @returns {Object} Generated task
 */
export async function generateManagedAppImprovementTaskForType(taskType, app, state, { skipPreconditions = false } = {}) {
  const { updateAppActivity } = await import('./appActivity.js');
  const taskSchedule = await import('./taskSchedule.js');

  // NOTE: `updateAppActivity` + the "Generating improvement task" log are
  // intentionally deferred until AFTER every gate returns non-null (see end
  // of function). The original code stamped both eagerly, which was tolerable
  // when only the on-demand path called this — the user explicitly asked for
  // a task, so logging + rotation-pointer advance was correct even when the
  // generator decided not to produce one. Now `queueEligibleImprovementTasks`
  // routes through this every scheduler tick, so an eager update would (a)
  // advance the per-app rotation pointer on every skip (biasing
  // `getNextTaskType` away from a type with nothing actionable to do, but
  // also away from types that *could* run on a future tick) and (b) emit a
  // misleading "Generating improvement task" line for skipped types. The
  // single-call ordering at the bottom keeps both paths in sync — a returned
  // task means rotation advanced; a `return null` short-circuit means it
  // didn't.

  // Get interval settings to determine provider/model and pipeline config
  const interval = await taskSchedule.getTaskInterval(taskType);

  const metadata = {
    app: app.id,
    appName: app.name,
    repoPath: app.repoPath,
    analysisType: taskType,
    autoGenerated: true,
    comprehensiveImprovement: true
  };

  // Apply sanitized task-type-specific metadata from schedule config (e.g., useWorktree, simplify, pipeline)
  const sanitizedGlobalMeta = sanitizeTaskMetadata(interval.taskMetadata);
  if (sanitizedGlobalMeta) {
    Object.assign(metadata, sanitizedGlobalMeta);
  }

  // Apply sanitized per-app taskMetadata overrides (merge on top of global).
  // Strip managed-agent fields first — see comment in the sibling
  // generateManagedAppTask path for the full rationale.
  const appOverrides = await getAppTaskTypeOverrides(app.id);
  const strippedAppOverride = taskSchedule.stripManagedAgentOptionsFromOverride(
    taskType, appOverrides[taskType]?.taskMetadata
  );
  const sanitizedAppMeta = sanitizeTaskMetadata(strippedAppOverride);
  if (sanitizedAppMeta) {
    Object.assign(metadata, sanitizedAppMeta);
  }

  initializePipelineMetadata(metadata);
  if (!skipPreconditions && shouldSkipForPrecondition(metadata, app, taskType)) return null;

  const promptTemplate = metadata.pipeline?.stages
    ? await taskSchedule.getStagePrompt(taskType, 0)
    : await taskSchedule.getTaskPrompt(taskType);

  // reference-watch: dynamically inject {referenceData} — a Markdown chunk
  // describing each ref configured on the app + commits since lastReviewedSha.
  // The check itself fetches each upstream and persists status/lastError, so
  // a bad URL surfaces in the UI even if the agent dispatch is skipped below.
  let referenceDataBlock = '';
  if (taskType === 'reference-watch') {
    const refs = Array.isArray(app.referenceRepos) ? app.referenceRepos : [];
    if (refs.length === 0) {
      emitLog('info', `Skipping reference-watch for ${app.name}: no reference repos configured`, { appId: app.id });
      return null;
    }
    const referenceRepos = await import('./referenceRepos.js');
    const blocks = [];
    let anySuccessWithCommits = false;
    for (const ref of refs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const snapshot = await referenceRepos.checkReferenceRepo(app.id, ref.id);
        if (snapshot.commitCount > 0) {
          blocks.push(referenceRepos.formatReferenceForPrompt(ref, snapshot));
          anySuccessWithCommits = true;
        }
      } catch (err) {
        emitLog('warn', `Reference check failed for ${ref.name}: ${err.message}`, { appId: app.id, refId: ref.id });
        blocks.push(`## Reference: ${ref.name}\n\n_Check failed: ${err.message}_`);
      }
    }
    // Don't burn an agent dispatch when there's nothing actionable —
    // either every ref is up-to-date OR every ref errored. Errored refs
    // already surfaced their lastError in the UI via checkReferenceRepo,
    // so the user can fix configs without an agent involved.
    if (!anySuccessWithCommits) {
      emitLog('info', `Skipping reference-watch for ${app.name}: no refs produced reviewable commits`, { appId: app.id });
      return null;
    }
    referenceDataBlock = blocks.join('\n\n---\n\n');
  }

  // pr-watcher: poll the app's GitHub repo for PRs newly opened against the
  // default branch, gated on authorship (self / others / any). Dispatches one
  // agent run covering all new PRs; injects {prData}/{repoFullName}/
  // {defaultBranch}. State (the lastSeenPrNumber high-water mark) is persisted
  // inline on the app, mirroring reference-watch's lastReviewedSha.
  let prDataBlock = '';
  let prRepoFullName = '';
  let prDefaultBranch = '';
  if (taskType === 'pr-watcher') {
    const prWatcher = await import('./prWatcher.js');
    // prAuthorFilter was already merged (global → per-app override) and
    // value-constrained into `metadata` by sanitizeTaskMetadata above, so read
    // it from there rather than re-merging the raw configs.
    const authorFilter = metadata.prAuthorFilter || 'any';

    const check = await prWatcher.checkPullRequests(app, { authorFilter });
    const checkedAt = new Date().toISOString();

    // The gh poll IS the cadence-bearing work for pr-watcher, so a poll that
    // dispatches nothing still has to advance the interval. The queue path
    // (queueEligibleImprovementTasks) only records execution AFTER a task is
    // queued, so a bare `return null` would leave lastRun unset — and a CUSTOM
    // task with no lastRun reads as perpetually "due", re-polling GitHub every
    // scheduler tick and (being CUSTOM-priority) starving the app's other task
    // types until a PR appears. Record the poll here on every no-dispatch path.
    const recordPoll = () => taskSchedule.recordExecution(taskType, app.id);

    if (!check.ok) {
      await prWatcher.persistPrWatcherState(app.id, { lastCheckedAt: checkedAt, lastError: check.reason });
      await recordPoll();
      emitLog('info', `Skipping pr-watcher for ${app.name}: ${check.reason}`, { appId: app.id });
      return null;
    }

    // Always advance the high-water mark + clear any prior error. First run
    // baselines silently; later runs mark every evaluated PR (dispatched AND
    // gated-out) as seen so a fixed author filter doesn't re-fire them.
    await prWatcher.persistPrWatcherState(app.id, {
      lastSeenPrNumber: check.newLastSeen,
      lastCheckedAt: checkedAt,
      lastError: null
    });

    if (check.firstRun) {
      await recordPoll();
      emitLog('info', `pr-watcher baselined ${app.name} at PR #${check.newLastSeen} — no dispatch on first run`, { appId: app.id });
      return null;
    }
    if (check.newPrs.length === 0) {
      await recordPoll();
      emitLog('info', `Skipping pr-watcher for ${app.name}: no new PRs (author filter: ${authorFilter})`, { appId: app.id });
      return null;
    }

    prDataBlock = prWatcher.formatPullRequestsForPrompt(check.newPrs, {
      repoFullName: check.repoFullName, defaultBranch: check.defaultBranch
    });
    prRepoFullName = check.repoFullName;
    prDefaultBranch = check.defaultBranch;
    emitLog('info', `pr-watcher dispatching for ${app.name}: ${check.newPrs.length} new PR(s)`, { appId: app.id, analysisType: taskType });
  }

  const planMeta = await applyPlanIdMetadata(taskType, app.repoPath, metadata);
  if (planMeta.skipReason) {
    emitLog('info', `Skipping ${taskType} for ${app.name}: ${planMeta.skipReason}`, { appId: app.id });
    return null;
  }
  const planConstraintBlock = buildPlanConstraintBlock(metadata.planId);
  const reviewersCsv = normalizeReviewers(metadata).join(',');
  // claim-issue: expand {issueAuthorFilter} into a concrete directive telling
  // the agent which open issues are claimable. The filter was already merged
  // (global → per-app override) and value-constrained by sanitizeTaskMetadata,
  // so read it from `metadata`. 'owner' (the default, matching /claim --issues)
  // restricts to repo-owner-filed issues; 'any' claims any open issue.
  const issueAuthorFilterBlock = (metadata.issueAuthorFilter || 'owner') === 'any'
    ? '**Author filter: any author.** Claim the next eligible open issue regardless of who filed it — omit `--author` from `gh issue list` entirely.'
    : '**Author filter: repository owner only.** Only claim issues filed by the repository owner/creator. Resolve the owner with `OWNER="$(gh repo view --json owner -q .owner.login)"` and pass `--author "$OWNER"` (a quoted single token) to `gh issue list`; skip issues opened by anyone else.';

  const description = promptTemplate
    .replace(/\{appName\}/g, app.name)
    .replace(/\{repoPath\}/g, app.repoPath)
    .replace(/\{appId\}/g, app.id)
    .replace(/\{reviewers\}/g, reviewersCsv)
    .replace(/\{issueAuthorFilter\}/g, () => issueAuthorFilterBlock)
    // Use a replacer function — String.replace with a replacement STRING
    // interprets `$&`, `$1`, etc. as backreferences. Commit subjects/authors
    // legitimately contain `$` (env-var docs, prices, awk snippets) and
    // would get mangled. The function form passes the value verbatim.
    .replace(/\{referenceData\}/g, () => referenceDataBlock)
    .replace(/\{prData\}/g, () => prDataBlock)
    .replace(/\{repoFullName\}/g, () => prRepoFullName)
    .replace(/\{defaultBranch\}/g, () => prDefaultBranch)
    .replace(/\{planConstraint\}/g, () => planConstraintBlock);

  applyAppWorktreeDefault(metadata, app);

  // Use configured model/provider if specified, otherwise use default
  if (interval.providerId) {
    metadata.provider = interval.providerId;
    metadata.providerId = interval.providerId;
  }
  if (interval.model) {
    metadata.model = interval.model;
  } else if (!metadata.provider) {
    // Only default to Claude when no per-stage provider overrides the selection
    metadata.model = 'claude-opus-4-5-20251101';
  }

  const approval = await resolveConfidenceApproval(state, `app-improve:${taskType}`, `Task app-improve:${taskType} for ${app.name}`);

  // All gates passed — record the rotation-pointer advance + emit the
  // generation log. Deferred from the top of the function (see note there);
  // every `return null` above this point intentionally leaves both untouched.
  await updateAppActivity(app.id, { lastImprovementType: taskType });
  emitLog('info', `Generating improvement task for ${app.name}: ${taskType}`, { appId: app.id, analysisType: taskType });

  const task = {
    id: `app-improve-${app.id}-${taskType}-${Date.now().toString(36)}`,
    status: 'pending',
    priority: state.config.idleReviewPriority || 'MEDIUM',
    priorityValue: PRIORITY_VALUES[state.config.idleReviewPriority] || 2,
    description,
    metadata,
    taskType: 'internal',
    ...approval
  };

  return task;
}
