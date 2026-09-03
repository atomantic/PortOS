/**
 * CoS Task Generator Module
 *
 * The task-generation + evaluation engine extracted from cos.js. Owns:
 *  - `evaluateTasks` — the periodic/startup evaluation loop that decides what
 *    to spawn (priority 0 on-demand → 1 user → 2 auto-system → 3 mission/feature
 *    → 4 idle review) and emits `task:ready` for each pick.
 *  - the self-improvement / managed-app / idle-review generators that build the
 *    actual task objects (prompt template + metadata + confidence approval).
 *  - the PLAN.md in-flight pick helper (`applyPlanIdMetadata`) and the
 *    pipeline-precondition helpers (`checkStagePrecondition`,
 *    `shouldSkipForPrecondition`, `initializePipelineMetadata`,
 *    `applyAppWorktreeDefault`).
 *
 * The per-task-type prompt PRE-STEP layer (the deterministic scans, their
 * `{ skip, block }` resolvers, the drain brakes, and the token renderer) lives
 * in `cosTaskPreStepBlocks.js`; this module composes it.
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
import { sanitizeTaskMetadata, PIPELINE_STAGE_BEHAVIOR_FLAGS, MAX_TOTAL_SPAWNS, resolveClaimReviewerConfig, reviewerConfigMetadata } from '../lib/validation.js';
import { PATHS } from '../lib/fileUtils.js';
import { MODEL_ABUSE_GUARD_ID, normalizeEligibilityFacts } from '../lib/modelAbuseGuard.js';
import { isPlainObject } from '../lib/objects.js';
import { parsePlanItems, extractAllIds, findInProgressIds, pickFirstAvailable, diagnoseUnpickablePlan } from '../lib/planIds.js';
import { loadState, saveState, withStateLock, isImprovementEnabled, isDaemonRunning } from './cosState.js';
import { getDomainMode } from '../lib/domainAutonomy.js';
import { remainingActionBudget } from '../lib/domainBudgets.js';
import { getDomainBudgetStatus } from './domainUsage.js';
import { pendingCosActionReservations } from './cosAdmissionReservations.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { addTask, updateTask, reviveBlockedTask, getAllTasks, getCosTasks, firstLine, PRIORITY_VALUES } from './cosTaskStore.js';
import { recordDecision, DECISION_TYPES } from './decisionLog.js';
import { isAppOnCooldown, markAppReviewCooldown, bindAppReviewAgent, markIdleReviewStarted, getNextAppForReview, loadAppActivity, isAppActivityOnCooldown } from './appActivity.js';
import { getActiveApps, getAppTaskTypeOverrides } from './apps.js';
import { resolveAgentProviderPin } from './appTaskProviderPin.js';
import { getTaskTypeConfidence } from './taskLearning.js';
import { classifySafetyKind, requiresSafetyApproval } from './taskLearning/safetyKind.js';
import { generateProactiveTasks as generateMissionTasks } from './missions.js';
import { isRecoveryTask } from './recoveryTasks.js';
import { getCodeReviewDefaults } from './codeReview.js';
import { getSkipReason } from './cosTaskClaim.js';
import { ensureInstanceId } from './instances.js';
import { PR_COMPLETION_VALUES } from '../lib/prDisposition.js';
import { resolveTrackerFilingBlock } from '../lib/workTracker.js';
import {
  isAuditTaskType,
  isFileIssuesMode,
  auditDoWorkRequiresWorktree,
  modeContractFor,
  applyAuditModeWrapper,
} from '../lib/auditCatalog.js';
import { TIMED_COOLDOWN_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';
import { ServerError } from '../lib/errorHandler.js';
import { isReconcileDrainTaskType } from './taskScheduleConstants.js';
import {
  appendClaimOverrideContext,
  appendPrefetchedIssueContext,
  appendReviewerEffortBlock,
  appendTargetWorkItemBlock,
  buildClaimOverrideContextBlock,
  buildLocalReviewerInstructions,
  buildIssueReplanPrompt,
  buildPrefetchedIssueContextBlock,
  normalizeWorkItemRef,
} from './cosTaskPrompts.js';
import { appendTaskDataInputs, resolveTaskDataInputs } from './taskDataInputs.js';
import { ensurePrReviewerPipeline } from './prReviewerPipeline.js';
import {
  applyPerpetualDrainCap,
  buildImprovementTaskDescription,
  buildPlanConstraintBlock,
  resolveBranchReconcileBlock,
  resolveIssueAuthorFilterBlock,
  resolveIssueExcludeLabelsBlock,
  resolveIssueReconcileBlock,
  resolvePrWatcherBlock,
  resolveReferenceWatchBlock,
  resolveRepoSyncBlock,
  resolveSwarmBlock,
} from './cosTaskPreStepBlocks.js';
import { detectIdleLeftoverBranches, formatUserActionDetectorBlock } from './userActionDetectors.js';

// Back-compat shim — these five were public here before the pre-step layer moved
// to its own module, so a deep import of this file keeps resolving them.
export {
  applyPerpetualDrainCap,
  resolveIssueAuthorFilterBlock,
  resolveIssueExcludeLabelsBlock,
  resolveReconcileDrainGate,
  resolveSwarmBlock,
} from './cosTaskPreStepBlocks.js';

export {
  buildClaimOverrideContextBlock,
  buildLocalReviewerInstructions,
  buildPrefetchedIssueContextBlock,
  buildTargetWorkItemBlock,
  normalizeWorkItemRef,
} from './cosTaskPrompts.js';

// Claim prompts create and manage their own claim/<item> worktree and
// push/PR/MR/review lifecycle. This marker is separate from `openPR: false`,
// which is the CoS provisioning posture that prevents a nested worktree. Keep
// the type list here as a backstop for old schedules that predate claimFlow.
const CLAIM_FLOW_TASK_TYPES = new Set([
  'plan-task', 'claim-issue', 'claim-issue-gitlab', 'claim-issue-jira', 'claim-work'
]);

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
 *     back-filled by migration 225, so the predicate reads metadata only.)
 *
 * `metadata.perpetual` is a bare boolean set upstream, but it round-trips through
 * COS-TASKS.md as the STRING `"true"` (taskParser serializes non-string/-object
 * metadata via `String(value)`; only arrays/objects like `pipeline` get the JSON
 * sentinel that preserves their type). So accept BOTH the in-memory boolean and
 * the re-parsed string — a `=== true` check alone would silently miss the
 * persisted-then-reloaded task, which is exactly the one the spawn gate sees.
 *
 * Shared by both spawn engines (`dequeueNextTask` in cos.js and `evaluateTasks`
 * here) and their dry-run planners so the cooldown-exempt set can't drift.
 */
export function isCooldownExemptTask(task) {
  const meta = task?.metadata;
  if (!meta) return false;
  return meta.pipeline?.currentStage > 0
    || meta.perpetual === true || meta.perpetual === 'true'
    || Boolean(meta.quotaBurnFamily);
}

/**
 * A claim/plan perpetual drain must stop when a completed agent leaves the
 * complete actionable set unchanged. A null signature means the detector has
 * no progress identity and keeps the legacy behavior; an empty signature is a
 * valid idle result but never reaches this predicate because `actionable` is
 * false.
 */
export function shouldParkUnchangedPerpetualWork(detection, lastSignature, dispatchCount = 0) {
  return detection?.actionable === true
    && detection.signature != null
    && lastSignature != null
    && detection.signature === lastSignature
    // A same-issue continuation is allowed one unchanged recheck: the prior
    // claim may have shipped a partial slice while leaving the issue actionable.
    // A second unchanged observation is a genuine no-progress loop.
    && dispatchCount > 1;
}

// The generator can be called before either spawn engine admits its result.
// Keep the drain signature off persisted task metadata until that admission is
// known to have succeeded; a WeakMap carries it only across the in-memory handoff.
const deferredPerpetualSignatures = new WeakMap();

export async function recordDeferredPerpetualDispatch(task, taskSchedule) {
  const deferred = deferredPerpetualSignatures.get(task);
  if (!deferred) return false;
  deferredPerpetualSignatures.delete(task);
  await taskSchedule.recordPerpetualDispatch(deferred.taskType, deferred.appId, deferred.signature);
  return true;
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

  const counts = { ...spawnProjectCounts };
  let spawned = alreadySpawned;
  const spawnable = [];

  for (const task of autoApproved) {
    if (spawned >= availableSlots) break;
    if (notRunnableHere(task)) continue;
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
 * Resolve an app's configured `claim-work` metadata the same way the scheduled
 * router does: global schedule metadata, then per-app overrides on top (managed
 * agent fields stripped, both passes sanitized/value-constrained). This is what
 * carries the user's `issueAuthorFilter`, reviewer, and swarm choices into the
 * prompt. Shared by `buildClaimWorkTask` and the work-item picker route, so the
 * items offered are scanned with the SAME author filter the claim agent will use.
 *
 * @returns {Promise<{ metadata: object, interval: object }>}
 */
export async function resolveClaimWorkMetadata(app) {
  const taskSchedule = await import('./taskSchedule.js');
  // Independent reads (schedule config + per-app overrides) — the merge below
  // needs both, but neither depends on the other.
  const [interval, appOverrides] = await Promise.all([
    taskSchedule.getTaskInterval('claim-work'),
    getAppTaskTypeOverrides(app.id)
  ]);
  const metadata = {};
  const sanitizedGlobalMeta = sanitizeTaskMetadata(interval.taskMetadata);
  if (sanitizedGlobalMeta) Object.assign(metadata, sanitizedGlobalMeta);
  const strippedAppOverride = taskSchedule.stripManagedAgentOptionsFromOverride(
    'claim-work', appOverrides['claim-work']?.taskMetadata
  );
  const sanitizedAppMeta = sanitizeTaskMetadata(strippedAppOverride);
  if (sanitizedAppMeta) Object.assign(metadata, sanitizedAppMeta);
  return { metadata, interval };
}

/**
 * The author filter a claim run will actually apply: explicit option >
 * configured `claim-work` metadata > `'self'` (the slashdo `/do:next --self`
 * security boundary — only claim issues you filed).
 */
export function resolveClaimAuthorFilter(explicit, metadata) {
  return explicit ?? metadata?.issueAuthorFilter ?? 'self';
}

/**
 * Build a one-off "claim the next work item" task for `app`, routed by the app's
 * configured workTracker — the manual (Slashdo `/do:next` button) counterpart to
 * the scheduled `claim-work` router below. Resolves the tracker, delegates to the
 * matching claim prompt body (plan-task / claim-issue / claim-issue-gitlab /
 * claim-issue-jira), substitutes the standard placeholders, and surfaces the
 * delegated flow's worktree/PR posture. `claimFlow` separately marks that the
 * prompt owns its worktree + MR/PR lifecycle; false/false remains the correct
 * CoS provisioning posture because a nested CoS worktree would conflict with
 * the claim branch.
 *
 * `issueAuthorFilter` and the reviewer options default to the app's *configured*
 * `claim-work` behavior (global schedule metadata → per-app override → Code
 * Review Defaults), exactly as the scheduled `claim-work` router resolves them —
 * so clicking the button honors `issueAuthorFilter: 'any'` and non-Copilot
 * reviewers instead of silently forcing owner-only + Copilot. A direct
 * `claim-work` prompt customization likewise overrides the tracker-specific body
 * (matching the scheduled router's `promptKeyForBody` selection). Explicit
 * options still win when a caller passes them.
 *
 * `target` pins the run to ONE work item (the drawer's "pick a specific item"
 * mode) by appending the tracker-appropriate constraint block, overriding the
 * prompt's own Phase 1 pick while keeping every claim safety check. A matching
 * `issueContext` from the managed-app Issues tab is appended for forge targets
 * so the agent can use the already-fetched title/body without retrieving it a
 * second time.
 *
 * @returns {Promise<{ tracker, source, promptTaskType, prompt, taskMetadata, target }>}
 */
export async function buildClaimWorkTask(app, {
  issueAuthorFilter,
  reviewers,
  usernames,
  optionalReviewers,
  reviewerMaxRounds,
  reviewerModels,
  reviewerEfforts,
  target,
  issueContext,
  overrideContext
} = {}) {
  const { resolveAppWorkTracker, trackerToClaimTaskType } = await import('../lib/workTracker.js');
  const { getTaskPrompt } = await import('./taskPromptService.js');
  const taskSchedule = await import('./taskSchedule.js');

  // The tracker probe (a `git` shell-out), the configured claim-work metadata,
  // and the Code Review Defaults are mutually independent — only the prompt-body
  // read below depends on them, so overlap the three.
  const [wt, { metadata, interval }, codeReviewDefaults] = await Promise.all([
    resolveAppWorkTracker(app),
    resolveClaimWorkMetadata(app),
    getCodeReviewDefaults().catch(() => null)
  ]);
  const promptTaskType = trackerToClaimTaskType(wt.resolved) || 'plan-task';

  // Honor a direct claim-work prompt customization if the user set one;
  // otherwise delegate to the resolved tracker's prompt body. Mirrors the
  // scheduled router's `promptKeyForBody` selection — a custom claim-work prompt
  // overrides the tracker-specific body for both paths.
  const template = await getTaskPrompt(
    interval.prompt ? 'claim-work' : promptTaskType,
    { claimFlow: true }
  );

  const resolvedAuthorFilter = resolveClaimAuthorFilter(issueAuthorFilter, metadata);

  // Reviewers: an explicit option wins per field, then the app's configured
  // claim-work metadata, then the Code Review Defaults. One resolver for the
  // whole bundle (list + usernames + `~opt` set + the three keyed pins), so the
  // CSV the prompt names and the `reviewers` this task PERSISTS below cannot
  // disagree. Local-LLM reviewers stay in the operative list; an appended
  // procedure below tells the claim agent how to invoke PortOS's review service
  // instead of silently replacing the user's configured reviewer.
  const claimReviewers = resolveClaimReviewerConfig({
    ...metadata,
    reviewers: reviewers !== undefined ? (Array.isArray(reviewers) ? reviewers : [reviewers]) : metadata.reviewers,
    usernames: usernames ?? metadata.usernames,
    optionalReviewers: optionalReviewers ?? metadata.optionalReviewers,
    reviewerMaxRounds: reviewerMaxRounds ?? metadata.reviewerMaxRounds,
    reviewerModels: reviewerModels ?? metadata.reviewerModels,
    reviewerEfforts: reviewerEfforts ?? metadata.reviewerEfforts
  }, codeReviewDefaults, codeReviewDefaults?.reviewers);
  const {
    reviewers: reviewersList,
    reviewerModels: promptReviewerModels,
    reviewerEfforts: promptReviewerEfforts,
    csv: reviewersCsv
  } = claimReviewers;
  const issueAuthorFilterBlock = resolveIssueAuthorFilterBlock(promptTaskType, resolvedAuthorFilter);
  const issueExcludeLabelsBlock = resolveIssueExcludeLabelsBlock(metadata.issueExcludeLabels);
  // Swarm mode (`/do:next --swarm`) is prepended (not an in-template
  // placeholder) so it stays an opt-in orchestration wrapper that needs no
  // prompt-default version bump; empty when swarmCount is off or the tracker
  // isn't a forge issue tracker. {reviewers} inside the block is substituted by
  // the same replacer below. A pinned target claims exactly one item, so the
  // swarm wrapper (claim N in parallel) is suppressed — the two are exclusive.
  const targetRef = normalizeWorkItemRef(target);
  const swarmBlock = targetRef ? '' : resolveSwarmBlock(promptTaskType, metadata.swarmCount);

  const prompt = `${swarmBlock}${template}`
    .replace(/\{appName\}/g, app.name)
    .replace(/\{repoPath\}/g, app.repoPath)
    .replace(/\{appId\}/g, app.id)
    // Function-form replacers so literal `$`/`$1` in the substituted text isn't
    // interpreted as a backreference (see the scheduler's same-pattern note).
    .replace(/\{reviewers\}/g, () => reviewersCsv)
    .replace(/\{issueAuthorFilter\}/g, () => issueAuthorFilterBlock)
    .replace(/\{issueExcludeLabels\}/g, () => issueExcludeLabelsBlock)
    + appendTargetWorkItemBlock(promptTaskType, targetRef, issueExcludeLabelsBlock)
    + appendPrefetchedIssueContext(promptTaskType, targetRef, issueContext)
    + appendClaimOverrideContext(overrideContext)
    + appendReviewerEffortBlock(reviewersList, promptReviewerEfforts, promptReviewerModels)
    + buildLocalReviewerInstructions(reviewersList, promptReviewerModels, promptReviewerEfforts, {
      claimCommentGate: promptTaskType === 'claim-issue',
    });

  // Mirror the scheduler: inherit the delegated flow's isolation posture so the
  // JIRA route runs in a CoS-managed worktree rather than the live checkout.
  // The resolved reviewer bundle rides along so the prompt builder's
  // `resolveReviewerConfig(task.metadata, …)` reads back the list this prompt
  // names — the reviewer pin is emitted once from there (#4770).
  const delegatedMeta = taskSchedule.DEFAULT_TASK_INTERVALS[promptTaskType]?.taskMetadata || {};
  const taskMetadata = { ...reviewerConfigMetadata(claimReviewers), claimFlow: true };
  // The manual `/do:next` path persists this non-raw task through addTask's
  // metadata allowlist before agentLifecycle sees it. Carry the same count that
  // rendered the swarm block so Codex can size its session to root + workers.
  // A pinned target suppresses swarmBlock above and therefore must not retain a
  // stale configured count.
  if (swarmBlock) taskMetadata.swarmCount = metadata.swarmCount;
  if ('useWorktree' in delegatedMeta) taskMetadata.useWorktree = delegatedMeta.useWorktree;
  if ('openPR' in delegatedMeta) taskMetadata.openPR = delegatedMeta.openPR;

  return { tracker: wt.resolved, source: wt.source, promptTaskType, prompt, taskMetadata, target: targetRef };
}

/**
 * Resolve the reviewer prompt pieces for the claim flow exactly as
 * buildClaimWorkTask does (including local-LLM reviewers). Mirrors the
 * scheduled claim-work resolution so the JIRA play button honors the user's
 * reviewer choice.
 *
 * Returns each piece separately because they travel differently: `csv` fills the
 * template's `{reviewers}` placeholder, `effortBlock` is appended prose (the
 * claim agent spawns each reviewer CLI itself, so no `--review-with` parser ever
 * reads the CSV's `~effort=` suffix), and `taskMetadata` is PERSISTED so the
 * prompt builder resolves the same list back off the task record (#4770).
 */
async function resolveClaimReviewerPrompt() {
  const codeReviewDefaults = await getCodeReviewDefaults().catch(() => null);
  // No task record exists yet for the play button, so the whole bundle resolves
  // from the Code Review Defaults: the reviewer list, the `@user` tokens that
  // gate the merge, the `~opt` set, the `~max=<n>` caps, and the model/effort
  // pins (which resolve together — an agy model id can carry its effort as a
  // suffix, so the bracket and the appended instruction can't disagree).
  const config = resolveClaimReviewerConfig({}, codeReviewDefaults, codeReviewDefaults?.reviewers);
  const { reviewers: list, reviewerModels, reviewerEfforts, csv } = config;
  return {
    csv,
    taskMetadata: reviewerConfigMetadata(config),
    effortBlock: appendReviewerEffortBlock(list, reviewerEfforts, reviewerModels),
    localReviewerBlock: buildLocalReviewerInstructions(list, reviewerModels, reviewerEfforts),
  };
}

/**
 * Build a one-off "implement THIS JIRA ticket" task for `app` — the per-card
 * "play" button on the app overview's sprint board (the JIRA analogue of the
 * `/do:next` claim button). Resolves the `claim-issue-jira` prompt body directly
 * (NOT via buildClaimWorkTask — an app can show a JIRA board while its general
 * Work Tracker resolves to GitHub/PLAN, so route the click to the JIRA flow
 * regardless of that setting), substitutes the standard placeholders, and appends
 * a target-ticket constraint that pins the agent to `ticketKey` while keeping
 * every claim safety check. `ticketKey` is normalized to upper-case (`PROJ-1234`).
 *
 * claim-issue-jira self-manages its worktree + MR/PR. `claimFlow` records that
 * lifecycle ownership while `useWorktree/openPR` stay `false/false` so CoS does
 * not provision a nested worktree.
 *
 * @returns {Promise<{ ticketKey: string, prompt: string, taskMetadata: { useWorktree: boolean, openPR: boolean, claimFlow: boolean } }>} —
 *   `taskMetadata` also carries the resolved reviewer bundle so the prompt
 *   builder's reviewer pin names this prompt's list (#4770).
 */
export async function buildJiraTicketTask(app, ticketKey) {
  const { getTaskPrompt } = await import('./taskPromptService.js');
  // Same normalizer the `/do:next` target uses — one definition of "a valid work
  // item ref". The route's Zod key regex has already rejected junk by here, so a
  // null (unnormalizable) key can only come from a direct service caller.
  const key = normalizeWorkItemRef(ticketKey);

  // Independent reads (prompt body + Code Review Defaults) — fetch concurrently.
  const [template, { csv: reviewersCsv, taskMetadata: reviewerMetadata, effortBlock, localReviewerBlock }] = await Promise.all([
    getTaskPrompt('claim-issue-jira'),
    resolveClaimReviewerPrompt(),
  ]);
  const prompt = template
    .replace(/\{appName\}/g, app.name)
    .replace(/\{repoPath\}/g, app.repoPath)
    .replace(/\{appId\}/g, app.id)
    // Function-form replacer so a literal `$` in the reviewers CSV isn't read as
    // a backreference.
    .replace(/\{reviewers\}/g, () => reviewersCsv)
    + appendTargetWorkItemBlock('claim-issue-jira', key)
    + effortBlock
    + localReviewerBlock;

  return { ticketKey: key, prompt, taskMetadata: { ...reviewerMetadata, useWorktree: false, openPR: false, claimFlow: true } };
}

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
  }
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
 */
export async function unblockExpiredCooldowns(userTaskData, cosTaskData) {
  await unblockExpiredCooldownsInQueue(userTaskData.grouped?.blocked, 'user');
  await unblockExpiredCooldownsInQueue(cosTaskData.grouped?.blocked, 'internal');
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
  const onDemandRequests = await taskSchedule.getOnDemandRequests();

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
  if (!apps) {
    emitLog('warn', `On-demand requests deferred — the app registry could not be read this cycle`);
  } else if (onDemandRequests.length > 0 && tasksToSpawn.length < availableSlots) {
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

      // Only a human "Run" may clear the drain's brakes; an automated refill
      // (origin: 'refill') inherits them. The policy — and the origin check — lives
      // in applyOnDemandRunResets so this engine and its siblings can't drift.
      const userInitiated = await taskSchedule.applyOnDemandRunResets(request, targetApp?.id ?? null);
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
        await taskSchedule.recordExecution(`task:${request.taskType}`, targetApp.id);
        task = await generateManagedAppImprovementTaskForType(request.taskType, targetApp, state, {
          skipPreconditions: true,
          deferPerpetualDispatch: true,
          targetPullRequest: request.targetPullRequest ?? null
        });
        if (task) {
          await bindAppReviewAgent(targetApp.id, `on-demand-${Date.now()}`);
        }
      } else {
        emitLog('info', `Processing on-demand improvement: ${request.taskType}${lane}`, { requestId: request.id });
        await taskSchedule.recordExecution(`task:${request.taskType}`);
        await withStateLock(async () => {
          const s = await loadState();
          s.stats.lastSelfImprovement = new Date().toISOString();
          s.stats.lastSelfImprovementType = request.taskType;
          await saveState(s);
        });
        task = await generateSelfImprovementTaskForType(request.taskType, state);
      }

      applyOnDemandConsent(task);
      if (task && canSpawnTask(task)) {
        // Mark this a MANUAL (on-demand) run so its perpetual drain continues in
        // the on-demand lane (see perpetualRefillPlan in cos.js). BOTH on-demand
        // engines must stamp it — either may drain a given request. Stamped before
        // addTask so the blocked-revive branch inherits it via `task.metadata`.
        task.metadata = { ...(task.metadata || {}), onDemand: true };
        const persisted = await addTask(task, 'internal', { raw: true, suppressDequeue: true });
        if (!persisted?.duplicate) {
          await recordDeferredPerpetualDispatch(task, taskSchedule);
          tasksToSpawn.push(task);
          trackSpawn(task);
        } else if (persisted.status === 'blocked') {
          // Explicit user Run colliding with a failure-blocked twin (#2614):
          // revive the existing task instead of silently dropping the Run and
          // stranding the bound on-demand review marker. Mirrors the sibling
          // dequeueNextTask on-demand engine in cos.js.
          await reviveBlockedTask(persisted.id, { priority: task.priority, metadata: task.metadata }, 'internal', { suppressDequeue: true });
          await recordDeferredPerpetualDispatch(task, taskSchedule);
          const revived = { ...task, id: persisted.id };
          tasksToSpawn.push(revived);
          trackSpawn(revived);
          emitLog('info', `🔁 On-demand ${request.taskType} revived blocked task ${persisted.id}`, { taskId: persisted.id });
        }
      } else if (!task && userInitiated) {
        // Explicit user Run produced no task on THIS engine too — same feedback
        // as cos.dequeueNextTask so a request drained here isn't a silent no-op.
        // An automated refill is skipped for the same reason it is there: it ends
        // by converging, and nobody is waiting on the toast.
        await emitOnDemandEmpty({ taskScheduleMod: taskSchedule, request, targetApp, taskConfig: liveSchedule.tasks[request.taskType] });
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
  const { pendingUserTasks, availableSlots, perProjectLimit, tasksToSpawn, canSpawnTask, trackSpawn, instanceId } = ctx;
  for (const task of pendingUserTasks) {
    if (tasksToSpawn.length >= availableSlots) break;
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
  const { state, cosTaskData, cosAutonomyMode, autonomousSlotCeiling, perProjectLimit, spawnProjectCounts, tasksToSpawn, canSpawnTask, trackSpawn, instanceId } = ctx;

  if (tasksToSpawn.length < autonomousSlotCeiling && cosTaskData.exists && cosAutonomyMode !== 'execute') {
    if (cosAutonomyMode === 'dry-run') {
      // Log only the tasks execute mode would ACTUALLY spawn — applying the same
      // instance-pin / peer-lease / max-spawns / cooldown / per-project gates
      // against virtual capacity — rather than every auto-approved task
      // regardless of eligibility.
      const wouldSpawn = await selectDryRunAutoApproved(cosTaskData.autoApproved || [], {
        availableSlots: autonomousSlotCeiling,
        alreadySpawned: tasksToSpawn.length,
        perProjectLimit,
        spawnProjectCounts,
        isOnCooldown: (appId) => isAppOnCooldown(appId, state.config.appReviewCooldownMs),
        cooldownExempt: isCooldownExemptTask,
        notRunnableHere: (task) => getSkipReason(task.metadata, instanceId) !== null
      });
      for (const task of wouldSpawn) {
        emitLog('info', `[dry-run] CoS auto-run would spawn system task: ${task.id}`, { taskId: task.id, domainAutonomy: 'cos' });
      }
    }
  } else if (tasksToSpawn.length < autonomousSlotCeiling && cosTaskData.exists) {
    const autoApproved = cosTaskData.autoApproved || [];
    for (const task of autoApproved) {
      if (tasksToSpawn.length >= autonomousSlotCeiling) break;

      // Pinned to another instance (#4520), or a federated peer holds a live
      // lease on it (#1650) — skip it during candidate selection so it doesn't
      // consume an autonomous slot the spawn guard would just reject.
      const skipReason = getSkipReason(task.metadata, instanceId);
      if (skipReason) {
        emitLog('debug', `Skipping system task ${task.id} — ${skipReason}`, { taskId: task.id });
        continue;
      }

      if (await blockIfExceedsMaxSpawns(task, 'internal')) continue;

      // Check if task's app is on cooldown (pipeline continuations AND perpetual
      // drains bypass cooldown — see isCooldownExemptTask).
      const appId = task.metadata?.app;
      if (appId && !isCooldownExemptTask(task)) {
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
        await recordDeferredPerpetualDispatch(idleTask, await import('./taskSchedule.js'));
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
    const prWatcher = await import('./prWatcher.js');
    const sweep = await prWatcher.sweepPendingMergePrs();
    if (sweep.merged || sweep.escalated || sweep.timedOut) {
      emitLog('info', `🤖 Pending merges: ${sweep.merged} merged, ${sweep.escalated} escalated, ${sweep.timedOut} timed out`);
    }
  }

  // Resolve this instance's federation id once per cycle so the priority tiers
  // can skip tasks a peer holds a live lease on (#1650). Warm path is the cheap
  // cached read; only the cold boot creates the identity.
  const instanceId = await ensureInstanceId();

  // Get both user and CoS tasks
  const { user: userTaskData, cos: cosTaskData } = await getAllTasks();

  // Unblock tasks whose orphan-retry cooldown has expired
  await unblockExpiredCooldowns(userTaskData, cosTaskData);

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
    instanceId,
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

  // Priority 0 (on-demand) spends against the global slot cap and runs even when
  // paused — an explicit user "Run" bypasses the global pause.
  await spawnPriority0OnDemand(ctx);

  // Every tier below is scheduled/autonomous/user work that the global pause
  // stops. When paused we skip them and let the shared spawn loop below emit just
  // the on-demand tasks Priority 0 collected.
  if (!paused) {
    // Priority 1 spends against the global slot cap.
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
  }

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
export async function generateIdleReviewTask(state, { ignoreTaskId = null } = {}) {
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
      const idleTask = await generateManagedAppImprovementTask(nextApp, state, { ignoreTaskId });
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
 * Build the dedup sets `queueEligibleImprovementTasks` uses to decide whether
 * an improvement slot is already occupied.
 *
 * Active (pending/in_progress) tasks occupy both their per-type slot and the
 * per-app "one improvement at a time" cap. Blocked tasks ALSO occupy their
 * per-type slot regardless of blockedCategory (#2614): before this, only
 * `user-terminated` blocked tasks counted, so a task blocked by repeated
 * failures (max-retries, max-spawns, provider-config, unknown, …) was
 * invisible to dedup and the generator minted an identical duplicate every
 * cadence tick — nothing reaps blocked tasks, so the pile grew unbounded.
 * Failure-blocked *improvement* tasks (blocked with any category except
 * `user-terminated`, AND an analysis type is derivable) also count toward the
 * per-app cap — the retry path is unblocking the existing task, not creating
 * a new one. A blocked NON-improvement task (an investigation, a review
 * follow-up) never holds the app cap: blocked tasks are not reaped, so it
 * would freeze the app's improvement rotation forever. `user-terminated`
 * keeps its original scope (per-type slot only) so an intentional kill of
 * one type doesn't freeze the whole app's rotation either.
 *
 * `blockedTaskTypes` / `appsWithBlockedImprovement` are Maps (key → blocking
 * task id) mirroring which entries came from blocked tasks so the caller can
 * log a visible, actionable skip reason instead of silently suppressing
 * generation.
 *
 * `ignoreTaskId` excludes one task from every set — used by the perpetual
 * drain-on-completion refill, where the just-completed task is still
 * `in_progress` on disk (agent:completed fires before updateTask finalizes
 * it). Without it the completing task would make its own app look busy and
 * block the next perpetual run.
 */
export function buildImprovementDedupSets(existingTasks, { ignoreTaskId = null } = {}) {
  const existingTaskTypes = new Set();
  // Apps that already have *any* pending/in_progress/failure-blocked improvement
  // task. We cap each app at one queued improvement at a time to avoid a fan-out
  // where multiple improvement types pile up faster than the per-app cooldown
  // can drain them.
  const appsWithPendingImprovement = new Set();
  const blockedTaskTypes = new Map();
  const appsWithBlockedImprovement = new Map();

  for (const task of existingTasks) {
    if (task.id === ignoreTaskId) continue;
    const isActive = task.status === 'pending' || task.status === 'in_progress';
    const isBlocked = task.status === 'blocked';
    const isFailureBlocked = isBlocked && task.metadata?.blockedCategory !== 'user-terminated';
    const analysisType = task.metadata?.analysisType ||
      task.metadata?.selfImprovementType ||
      task.description?.match(/\[(?:self-improvement|improvement)\]\s*(\w[\w-]*)/i)?.[1];
    const appId = task.metadata?.app;
    if ((isActive || isBlocked) && analysisType) {
      const taskKey = appId ? `app:${appId}:${analysisType}` : analysisType;
      existingTaskTypes.add(taskKey);
      if (isBlocked && !blockedTaskTypes.has(taskKey)) blockedTaskTypes.set(taskKey, task.id);
    }
    // Active tasks of ANY kind with an app hold the per-app cap (pre-existing
    // behavior — active tasks drain, so the hold is temporary). Blocked tasks
    // hold it only when failure-blocked AND actually an improvement task —
    // see the docstring above.
    if ((isActive || (isFailureBlocked && analysisType)) && appId && !isRecoveryTask(task)) {
      appsWithPendingImprovement.add(appId);
      if (isFailureBlocked && !appsWithBlockedImprovement.has(appId)) appsWithBlockedImprovement.set(appId, task.id);
    }
  }

  return { existingTaskTypes, appsWithPendingImprovement, blockedTaskTypes, appsWithBlockedImprovement };
}

function prepareQueuedImprovementTask(task) {
  // Queued tasks round-trip through COS-TASKS.md, whose task description field
  // is single-line. Preserve the full prompt in metadata so the agent receives
  // it after the task is re-read from disk.
  if (typeof task.description === 'string' && task.description.includes('\n')) {
    task.metadata = task.metadata || {};
    task.metadata.prompt = task.description;
    task.description = firstLine(task.description);
  }
  return task;
}

export async function queueDueInstallWideImprovementTasks({
  dueTasks,
  state,
  taskSchedule,
  existingTaskTypes,
  blockedTaskTypes,
  ignoreTaskId = null,
  wakeAfterRecord = true,
  generateTask = generateSelfImprovementTaskForType,
  persistTask = addTask,
  wake = () => cosEvents.emit('cos:dequeue-requested')
}) {
  let queued = 0;
  const dueInstallWideTasks = dueTasks
    .filter(({ taskType }) => taskSchedule.INSTALL_WIDE_TASK_TYPES.has(taskType));

  for (const { taskType } of dueInstallWideTasks) {
    const taskKey = taskType;
    if (existingTaskTypes.has(taskKey)) {
      if (blockedTaskTypes.has(taskKey)) {
        emitLog('info', `⛔ Skipping install-wide ${taskType}: blocked task ${blockedTaskTypes.get(taskKey)} already exists — resolve or delete it to resume`, { analysisType: taskType });
      } else {
        emitLog('debug', `Install-wide improvement task ${taskType} already queued`);
      }
      continue;
    }

    const task = await generateTask(taskType, state);
    // Hooks such as user-action-review's empty-ledger check deliberately
    // advance their cadence while returning no task, so do not record a second
    // execution here when the generator declines to dispatch.
    if (!task) continue;

    task.priority = 'LOW';
    task.priorityValue = PRIORITY_VALUES.LOW;
    task.id = `sys-install-${taskType}-${Date.now().toString(36)}`;
    prepareQueuedImprovementTask(task);

    const newTask = await persistTask(task, 'internal', { raw: true, ignoreTaskId, suppressDequeue: true });
    if (newTask?.duplicate) continue;
    if (wakeAfterRecord) wake();

    await taskSchedule.recordExecution(`task:${taskType}`);
    emitLog('info', `Queued install-wide improvement task: ${taskType}`, { taskId: newTask.id, analysisType: taskType });
    existingTaskTypes.add(taskKey);
    queued++;
  }

  return queued;
}

/**
 * Queue eligible self-improvement and app improvement tasks as system tasks
 * Called during every evaluation to ensure system tasks are queued even when user tasks exist
 * Tasks are queued to COS-TASKS.md and will be picked up in Priority 2
 */
export async function queueEligibleImprovementTasks(state, cosTaskData, { ignoreTaskId = null, wakeAfterRecord = true } = {}) {
  const taskSchedule = await import('./taskSchedule.js');
  const { getDueTasks, getNextTaskType, recordExecution } = taskSchedule;

  if (!isImprovementEnabled(state)) return;

  // Existing active AND blocked system tasks feed the dedup sets — see
  // buildImprovementDedupSets for the occupancy semantics (#2614). The same
  // `ignoreTaskId` is forwarded to addTask below so its disk-level duplicate
  // scan ignores it too.
  const existingTasks = cosTaskData.tasks || [];
  const { existingTaskTypes, appsWithPendingImprovement, blockedTaskTypes, appsWithBlockedImprovement } =
    buildImprovementDedupSets(existingTasks, { ignoreTaskId });

  let queued = 0;

  // Install-wide task types have no managed-app target: their cadence is
  // tracked by the global execution record, and one task is the complete run
  // for this PortOS install. Run this before the per-app pass: an install-wide
  // hook may deliberately reject app targets while recording that app-scoped
  // check, which must not consume the global due window first.
  //
  // Do not select a single generic next task here — every install-wide type
  // that is independently due must get its own lane. The dedup key is the bare
  // analysis type, matching buildImprovementDedupSets for globally-scoped tasks
  // and ensuring one pending/blocked task suppresses only its own duplicate.
  queued += await queueDueInstallWideImprovementTasks({
    dueTasks: await getDueTasks(), state, taskSchedule, existingTaskTypes,
    blockedTaskTypes, ignoreTaskId, wakeAfterRecord
  });

  // Load the activity snapshot ONCE before the per-app loop. The cooldown gate
  // is derived from `data/app-activity.json`; before this hoist, each app paid a
  // separate disk read (via `isAppOnCooldown`), so a 10-app deployment re-read
  // the same file once per app per scheduler tick. With the snapshot pinned, the
  // cost is O(1) read per `queueEligibleImprovementTasks` invocation. Falls back
  // to an empty `apps` map on disk error so the loop's per-app lookups uniformly
  // return `undefined` (read as "no activity yet — not on cooldown").
  const activitySnapshot = await loadAppActivity().catch(() => ({ apps: {} }));

  // Queue eligible improvement tasks for all managed apps (including PortOS)
  const apps = await getActiveApps().catch(() => []);
  for (const app of apps) {
    // One pending improvement per app at a time — sibling types must wait
    // until the current task drains, otherwise they queue faster than they
    // can run (per-project concurrency limit + cooldown after each completion).
    if (appsWithPendingImprovement.has(app.id)) {
      if (appsWithBlockedImprovement.has(app.id)) {
        emitLog('info', `⛔ Skipping improvement queue for ${app.name}: failure-blocked improvement task ${appsWithBlockedImprovement.get(app.id)} occupies the app slot — resolve or delete it to resume`, { appId: app.id });
      } else {
        emitLog('debug', `App ${app.name} already has a pending improvement task — skipping queue`);
      }
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

    // Perpetual (drain-until-done) tasks BYPASS the per-app review cooldown:
    // their work-detector park IS the throttle (taskSchedule.parkPerpetual), and
    // agentCompletion.js already skips the post-completion cooldown bump for
    // them. But the spawn-time `markAppReviewCooldown` stamp (written by BOTH the
    // on-demand manual-trigger path and the idle-review loop) sets
    // `lastReviewedAt`, which `isAppActivityOnCooldown` reads — so without a
    // bypass the back-to-back refill fired right after a perpetual run reads its
    // OWN app as "on cooldown" and skips the re-queue, and the drain stalls.
    //
    // When the app IS on cooldown, constrain the pick to a due perpetual task
    // (`perpetualOnly`). This is what makes a MIXED schedule converge: if the app
    // also has a due cron/custom type (e.g. pr-watcher), the unconstrained
    // `getNextTaskType` would return that higher-priority NON-exempt type first,
    // we'd see a non-perpetual pick, and we'd skip the whole app for the cooldown
    // window — stranding the perpetual drain behind it. Asking perpetual-only
    // returns the due perpetual drain (or null → leave the cooled-down app
    // alone). When NOT on cooldown, the normal full-priority pick runs.
    const onCooldown = isAppActivityOnCooldown(appActivity, state.config.appReviewCooldownMs);

    const nextTypeResult = await getNextTaskType(app.id, { perpetualOnly: onCooldown }).catch(() => null);
    if (!nextTypeResult) continue;
    const nextType = nextTypeResult.taskType;

    const taskKey = `app:${app.id}:${nextType}`;
    if (existingTaskTypes.has(taskKey)) {
      if (blockedTaskTypes.has(taskKey)) {
        emitLog('info', `⛔ Skipping ${nextType} for ${app.name}: blocked task ${blockedTaskTypes.get(taskKey)} of this type already exists — resolve or delete it to resume`, { appId: app.id });
      } else {
        emitLog('debug', `Improvement task ${nextType} for ${app.name} already queued`);
      }
      continue;
    }

    // Route through the rich generator so `applyPlanIdMetadata` runs — it
    // scans open `claim/<slug>` branches + PRs and excludes in-flight slugs
    // from the pick. The old stub path skipped this and let two plan-task
    // agents claim the same slug (2026-05-21 incident). The generator
    // returns null on plan-gate / precondition skip; we silently continue.
    // Regression-pinned in cos.test.js.
    const task = await generateManagedAppImprovementTaskForType(nextType, app, state, {
      ignoreTaskId,
      deferPerpetualDispatch: true
    });
    if (!task) continue;

    // Queue-path invariants override the generator's direct-spawn defaults
    // (which use MEDIUM priority + `app-improve-*` id).
    task.priority = 'LOW';
    task.priorityValue = PRIORITY_VALUES.LOW;
    task.id = `sys-${app.id.slice(0, 8)}-${nextType}-${Date.now().toString(36)}`;

    // Move the generator's multi-line prompt into `metadata.prompt` so it
    // survives the COS-TASKS.md round-trip. The on-demand path dispatches the
    // in-memory task immediately (cosEvents.emit('task:ready', task) with the
    // unparsed object), so it never round-trips through the markdown — but
    // the queue path persists first and re-reads from disk on the next
    // `dequeueNextTask` tick. `generateTasksMarkdown` interpolates the full
    // `task.description` onto a single line (taskParser.js:268) and
    // `parseTasksMarkdown` only matches the first line of a `- [ ]` block —
    // so any newline in `description` corrupts the file (stray `## Phase`
    // lines become section headers, `- ` lines become new tasks) AND silently
    // strips the Phase 1–7 instructions on the re-read. Task metadata is
    // newline-escaped via `escapeNewlines`/`unescapeNewlines` (JSON-sentinel
    // encoding) so it round-trips losslessly. The agent prompt builder
    // (`cos-agent-briefing.md` + the built-in fallback in
    // `agentPromptBuilder.js`) renders both `task.description` AND the task's
    // context block into the agent's prompt, so the agent still sees the full
    // Phase 1–7 body.
    //
    // The payload lands in `metadata.prompt`, NOT `metadata.context` (#4153):
    // `context` is the one-line human note, and overloading it made a
    // multi-thousand-character agent prompt indistinguishable from one. Readers
    // go through `getTaskPrompt` (server/lib/cosTaskPrompt.js), which falls back
    // to `metadata.context` for tasks written before the split.
    // Keep the queue-path normalization visible here as well as in the
    // install-wide helper: COS-TASKS.md is a single-line format, and the
    // queue contract is source-checked by the scheduler tests.
    if (typeof task.description === 'string' && task.description.includes('\n')) {
      task.metadata = task.metadata || {};
      task.metadata.prompt = task.description;
      task.description = firstLine(task.description);
    }

    const newTask = await addTask(task, 'internal', { raw: true, ignoreTaskId, suppressDequeue: true });
    if (newTask?.duplicate) continue;
    await recordDeferredPerpetualDispatch(task, taskSchedule);
    if (wakeAfterRecord) cosEvents.emit('cos:dequeue-requested');

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
 * Resolve auto-approval for a task based on confidence scoring, with a
 * safety-kind override (#2440) that is orthogonal to confidence.
 *
 * Outward-facing / irreversible work (publishing content, federating records to
 * sync peers, external/upstream PRs, releases) always requires the user's
 * sign-off no matter how high the task type's success rate is — a high score
 * can't undo work that has already left the install. Reversible internal work
 * (analysis, refactor, same-repo improvement PRs) keeps the pure success-rate
 * gate, so existing behavior is unchanged unless the task carries an outward
 * signal.
 *
 * Returns { autoApproved, approvalRequired, safetyKind, approvalReason? } ready
 * to spread into task objects — `safetyKind` + `approvalReason` surface WHY a
 * high-confidence task still needs approval on the task record and in the UI.
 */
export function isConfiguredApprovalRequired(metadata) {
  return metadata?.requireApproval === true;
}

async function resolveConfidenceApproval(state, taskTypeKey, logLabel, metadata = {}) {
  const safety = classifySafetyKind({ taskTypeKey, metadata });
  const safetyConfig = state?.config?.safetyKindApproval ?? {};

  // Explicit per-type/per-app toggle wins over every automatic gate. The user
  // turned "Require approval" on for this scheduled type; do not second-guess
  // that with confidence or a Run Now consent flip.
  if (isConfiguredApprovalRequired(metadata)) {
    emitLog('info', `🔒 ${logLabel} requires approval (task metadata requireApproval)`, {}, '[Approval]');
    return {
      autoApproved: false,
      approvalRequired: true,
      safetyKind: safety.kind,
      approvalReason: 'config:requireApproval'
    };
  }

  // Safety-kind override runs BEFORE (and independent of) the confidence gate.
  if (safety.outwardFacing && requiresSafetyApproval(safety.kind, safetyConfig)) {
    emitLog('info', `🔒 ${logLabel} requires approval (safety-kind: ${safety.kind} — ${safety.reason})`, {}, '[Safety]');
    return {
      autoApproved: false,
      approvalRequired: true,
      safetyKind: safety.kind,
      approvalReason: `safety-kind:${safety.kind}`
    };
  }

  const config = state?.config?.confidenceAutoApproval ?? {};
  if (config.enabled === false) {
    return { autoApproved: true, approvalRequired: false, safetyKind: safety.kind };
  }

  const confidence = await getTaskTypeConfidence(taskTypeKey, config);
  if (!confidence.autoApprove) {
    emitLog('info', `🔒 ${logLabel} requires approval (${confidence.reason})`, {}, '[Confidence]');
  }
  return {
    autoApproved: confidence.autoApprove,
    approvalRequired: !confidence.autoApprove,
    safetyKind: safety.kind,
    ...(confidence.autoApprove ? {} : { approvalReason: `confidence:${confidence.tier}` })
  };
}

/**
 * Clicking Run (or a refill of that run) is the user's consent. Safety-kind
 * and confidence gates exist so UNATTENDED queue-path work can't ship
 * irreversible actions on its own — they must not re-hold a task the user
 * just asked to run, or "Run Now" lands in awaiting-approve and never
 * auto-spawns (Priority 2 only picks AUTO tasks; force-spawn refuses
 * APPROVAL tasks).
 *
 * `metadata.requireApproval` is the escape hatch: a type the user marked
 * "always ask" (e.g. release-check when they want to review the merge)
 * keeps the hold even on Run Now.
 */
export function applyOnDemandConsent(task) {
  if (!task) return task;
  if (isConfiguredApprovalRequired(task.metadata)) return task;
  task.approvalRequired = false;
  task.autoApproved = true;
  if ('approvalReason' in task) delete task.approvalReason;
  // The hint TaskItem reads lives on metadata — COS-TASKS.md only persists
  // that bag. Clear both so a consented Run Now does not keep a stale reason.
  if (task.metadata && 'approvalReason' in task.metadata) delete task.metadata.approvalReason;
  return task;
}

function stampApprovalReason(metadata, approval) {
  if (approval?.approvalReason) metadata.approvalReason = approval.approvalReason;
  else delete metadata.approvalReason;
}

/**
 * Helper function to generate a self-improvement task for a specific type
 * Used by both normal rotation and on-demand task requests
 */
export async function generateSelfImprovementTaskForType(taskType, state) {
  const taskSchedule = await import('./taskSchedule.js');
  const { getTaskPrompt } = await import('./taskPromptService.js');
  const interval = await taskSchedule.getTaskInterval(taskType);
  // App-scoped task types must never fall through this global lane. The
  // on-demand request gate normally rejects a missing appId, but scheduled
  // rotation and older callers can still reach the generator directly.
  if (taskSchedule.requiresManagedAppTarget(taskType)) {
    emitLog('warn', `Skipping ${taskType} without a managed app target`);
    return null;
  }
  let description = await getTaskPrompt(taskType);

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
  // Only pin a model when the schedule config explicitly sets one. With no
  // pin, leave metadata.model unset so selectModelForTask resolves the ACTIVE
  // provider's tier/default model at spawn time — never a hardcoded literal.
  // (A stale literal here once pinned an opus release that had since dropped
  // out of the provider config, spawning claude with a --model the provider
  // no longer lists.)
  if (interval.model) {
    metadata.model = interval.model;
  }
  if (interval.effort) {
    metadata.effort = interval.effort;
  }

  // repo-sync's install-wide sweep. This lane is what a global "Run Now" (no
  // app) hits, and sweeping EVERY managed app in one run is the shape the task
  // exists for — so the pre-step runs here, not only in the per-app lane. It
  // returns `skip` when the sweep left nothing for an agent to do, which is the
  // common case on an already-clean machine and costs no provider call.
  // Programmatic pre-agent input hook (taskTypeHooks.js) — the install-wide
  // lane mirrors the per-app one so a hook-gated type (user-action-review's
  // empty-ledger check) can skip here too, without burning an agent. Gated to
  // INSTALL-WIDE types: the per-app hooks (issue-watcher, layered-intelligence)
  // guard on `!app`, and the synthetic `{ id: null }` row below is truthy — an
  // ungated call would march issue-watcher into resolving the PortOS repo as
  // its app via getOriginInfo's cwd default. The synthetic row only labels the
  // skip log / execution record; provider pins from a hook are a per-app
  // concept and are not applied in this lane.
  if (taskSchedule.INSTALL_WIDE_TASK_TYPES.has(taskType)) {
    const inputHook = await resolveTaskInputHook({ id: null, name: 'PortOS' }, taskType, taskSchedule);
    if (inputHook.skip) return null;
    if (inputHook.hookPrompt) description = inputHook.hookPrompt;
  }

  // user-action-review delivers filed issues / queued tasks, never a commit.
  // Stamp the action-output posture the way the audit file-issues path does —
  // `noCodeOutput` is dispatch-stamped, not user-settable, so it cannot arrive
  // from DEFAULT_TASK_INTERVALS through sanitizeTaskMetadata. Without it the
  // completion contract tells a live-checkout agent to commit and `/do:push`.
  if (taskType === 'user-action-review') {
    metadata.noCodeOutput = true;
    metadata.worktreeChangesExpected = false;
  }

  // user-action-review: render the delivery posture the operator chose
  // (fileIssues on = tracker issues, off = queued CoS tasks).
  description = applyUserActionDeliveryMode(description, taskType, metadata);
  description = await applyUserActionDetectorSection(description, taskType);

  const repoSync = await resolveRepoSyncBlock(null, taskType, metadata);
  if (repoSync.skip) return null;
  if (repoSync.block) {
    // Function form — the report embeds branch names, git error text, and stash
    // subjects, any of which may contain a dollar-sign backreference token that a
    // replacement STRING would expand instead of inserting literally (same reason
    // as {referenceData}/{prData}).
    description = description.replace(/\{repoSyncReport\}/g, () => repoSync.block);
  }

  const approval = await resolveConfidenceApproval(state, `self-improve:${taskType}`, `Task self-improve:${taskType}`, metadata);
  stampApprovalReason(metadata, approval);

  // Self-improvement tasks do not pass through the managed-app prompt renderer,
  // but release-check still names the install's configured reviewers explicitly.
  // Resolve that token here so the global/on-demand path gets the same reviewer
  // contract and local-review procedure as an app-scoped release task.
  if (description.includes('{reviewers}')) {
    const codeReviewDefaults = await getCodeReviewDefaults().catch(() => null);
    const reviewers = resolveClaimReviewerConfig(metadata, codeReviewDefaults, codeReviewDefaults?.reviewers);
    Object.assign(metadata, reviewerConfigMetadata(reviewers));
    description = description
      .replace(/\{reviewers\}/g, () => reviewers.csv)
      + appendReviewerEffortBlock(reviewers.reviewers, reviewers.reviewerEfforts, reviewers.reviewerModels)
      + buildLocalReviewerInstructions(reviewers.reviewers, reviewers.reviewerModels, reviewers.reviewerEfforts);
  }

  const taskDataInputs = await resolveTaskDataInputs(interval.dataInputs, {
    app: { id: null, name: 'PortOS', repoPath: PATHS.root }
  });
  description = appendTaskDataInputs(description, taskDataInputs);

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
  // Propagate stage 0's provider/model/effort so the first agent uses per-stage config
  if (stage0.model) metadata.model = stage0.model;
  if (stage0.providerId) {
    metadata.provider = stage0.providerId;
    metadata.providerId = stage0.providerId;
  }
  if (stage0.effort) metadata.effort = stage0.effort;
  // Save task-level defaults and apply stage 0 overrides in one pass
  // Read-only stages default flags to false to prevent worktree/PR/simplify on review-only stages
  metadata.pipeline.taskDefaults = {};
  const stageReadOnly = stage0.readOnly ?? false;
  for (const flag of PIPELINE_STAGE_BEHAVIOR_FLAGS) {
    if (metadata[flag] !== undefined) metadata.pipeline.taskDefaults[flag] = metadata[flag];
    if (flag in stage0) {
      metadata[flag] = stage0[flag];
    } else if (stageReadOnly) {
      metadata[flag] = false;
    }
  }
}

const SECURITY_SCAN_ACTIVE_TASK_STATUSES = new Set(['pending', 'in_progress', 'blocked'])
const SECURITY_SCAN_PIPELINE_OUTPUT_MAX_CHARS = 11_000

function securityScanReports(scan) {
  if (Array.isArray(scan?.reports)) return scan.reports
  if (Array.isArray(scan?.reviewedPrs)) return scan.reviewedPrs
  return []
}

const reportIsSafe = (report) => report?.safe === true

const reportFindingCount = (report) => (
  Array.isArray(report?.securityFindings) && report.securityFindings.length > 0
    ? report.securityFindings.length
    : reportIsSafe(report) ? 0 : 1
)

/**
 * Serialize only the trust decision needed by the app-code reviewer. The
 * human-facing report and the raw model response deliberately never cross
 * this boundary: even a report that calls itself an explanation is still
 * untrusted model output and could contain a second prompt injection.
 */
export function buildSecurityScanPipelineOutput(scan, reports, status) {
  const base = {
    securityScan: status,
    scanCode: scan.code || null,
    reviewedCount: reports.length,
    reviewedPrs: [],
  }
  const included = []
  for (const report of reports) {
    const candidate = {
      number: report.number,
      safe: reportIsSafe(report),
      headRefOid: reportIsSafe(report) && typeof report.headRefOid === 'string' ? report.headRefOid : null,
      findingCount: reportFindingCount(report),
    }
    const next = JSON.stringify({ ...base, reviewedPrs: [...included, candidate] })
    if (next.length <= SECURITY_SCAN_PIPELINE_OUTPUT_MAX_CHARS) {
      included.push(candidate)
      continue
    }
    return JSON.stringify({ ...base, complete: false, reviewedPrs: included })
  }
  return JSON.stringify({ ...base, complete: true, reviewedPrs: included })
}

/**
 * Name the single PR a targeted pr-reviewer run covers. The number goes in the
 * FIRST line specifically: `addTask`'s duplicate guard keys on (first line +
 * app), so without it, targeting a second PR while the first run is still in
 * flight would be rejected as a duplicate of it. The trailing sentence repeats
 * the scope for the agent; the header keeps its `[Improvement: <app>] …` shape
 * so the CoS queue still reads the same way.
 */
function scopeDescriptionToPullRequest(description, metadata) {
  const number = metadata?.targetPullRequest;
  if (!number) return description;
  const [firstLine, ...rest] = description.split('\n');
  return [
    `${firstLine} — pull request #${number} only`,
    ...rest,
    '',
    `This run is scoped to pull request #${number}: it is the only request the server cleared, and the only one this run may act on.`,
  ].join('\n');
}

function formatSecurityScanContext(scan, reports, status) {
  const findingCount = reports.filter((report) => !reportIsSafe(report)).length
  return [
    `Security scan status: ${status}.`,
    `Reviewed ${reports.length} external pull request${reports.length === 1 ? '' : 's'}${findingCount ? `; ${findingCount} contained model-abuse flags or an unvalidated response` : ''}.`,
    'No GitHub pull request or issue actions have been taken.',
    status === 'findings'
      ? 'This scan is only a model-abuse boundary. Flagged PR content and its source text are withheld from the Eligibility Gate; the gate may process only PRs explicitly marked safe and must not fetch or inspect flagged PRs.'
      : status === 'unavailable'
        ? `The scan stopped with ${scan.code || 'an unknown error'} after retaining the reports collected so far. No PR has a safe status; leave every PR untouched until the scan can be completed.`
        : 'All reviewed PRs have an explicit model-abuse safety status. The Eligibility Gate may process only the PRs marked safe, after approval.',
  ].join('\n')
}

async function findActiveSecurityScanTask(appId, scanKey) {
  if (!scanKey) return { unavailable: false, task: null }
  const cosTasks = await getCosTasks().catch(() => null)
  if (!cosTasks) return { unavailable: true, task: null }
  const task = cosTasks.tasks?.find((candidate) => (
    SECURITY_SCAN_ACTIVE_TASK_STATUSES.has(candidate.status)
    && candidate.metadata?.analysisType === 'pr-reviewer'
    && candidate.metadata?.app === appId
    && candidate.metadata?.pipeline?.securityScan?.scanKey === scanKey
  )) || null
  return { unavailable: false, task }
}

/**
 * Run pr-reviewer's Security Scan through the direct local, no-tools path and
 * hand only safe PR metadata to the Eligibility Gate. A normal stage-0 agent
 * is intentionally never spawned: `readOnly` is prompt guidance, not an OS
 * sandbox, and the generic agent resolver rejects API providers anyway.
 *
 * External contributor PRs are held for human approval before the stage that
 * can review, comment, or merge. The preflight itself remains read-only and
 * does not checkout or execute any contributor branch.
 *
 * `targetPullRequest` narrows the run to ONE open PR — the per-row "Review this
 * PR" trigger on an app's PRs / MRs tab. The narrowing happens BEFORE the
 * fingerprint and the security scan, so every downstream contract (scan key,
 * public-review snapshot, `issueWatcher.pullRequests` coverage, and the output
 * hook's strict envelope check) is scoped to that one PR by construction rather
 * than by a prompt asking the agent to ignore the rest.
 */
async function runPrReviewerSecurityPreflight(taskType, app, metadata, targetPullRequest = null) {
  if (taskType !== 'pr-reviewer') return { skipped: false };

  const stages = metadata.pipeline?.stages;
  const securityStage = stages?.[0];
  const nextStage = stages?.[1];
  if (!securityStage || !nextStage) {
    emitLog('warn', `Skipping pr-reviewer for ${app.name}: security pipeline requires an eligibility gate`, { appId: app.id, analysisType: taskType });
    return { skipped: true };
  }

  const { listExternalOpenPullRequests, runPrReviewerSecurityScan, securityScanFingerprint } = await import('./prReviewerSecurity.js');
  const { writePublicReviewInputSnapshot } = await import('./modelAbuseGuard.js');
  let target = await listExternalOpenPullRequests(app);
  if (!target.ok) {
    emitLog('warn', `Skipping pr-reviewer for ${app.name}: ${target.code || 'security-scan-target-unavailable'}`, { appId: app.id, analysisType: taskType });
    return { skipped: true };
  }
  if (target.prs.length === 0) {
    emitLog('info', `Skipping pr-reviewer for ${app.name}: no-external-open-prs`, { appId: app.id, analysisType: taskType });
    return { skipped: true, reason: 'no-external-open-prs' };
  }
  if (targetPullRequest) {
    const scoped = target.prs.filter((pr) => pr.number === targetPullRequest);
    if (scoped.length === 0) {
      emitLog('warn', `Skipping pr-reviewer for ${app.name}: target-pull-request-not-reviewable (#${targetPullRequest})`, { appId: app.id, analysisType: taskType });
      return { skipped: true, reason: 'target-pull-request-not-reviewable' };
    }
    // A maintainer pressed "Review this PR" on this row. The linked-open-issue
    // prerequisite exists to bound UNATTENDED spend on unsolicited PRs; an
    // explicit per-PR request is the maintainer choosing to spend that review,
    // so the fact set records the waiver. The Eligibility Gate still judges the
    // change itself, and Stage 1 still screens it. Stamped BEFORE the
    // fingerprint so a targeted run never shares a scan key with a sweep.
    target = {
      ...target,
      prs: scoped.map((pr) => ({ ...pr, eligibilityFacts: { ...normalizeEligibilityFacts(pr.eligibilityFacts), maintainerTargeted: true } })),
    };
    metadata.targetPullRequest = targetPullRequest;
  }
  const scanKey = securityScanFingerprint(target);
  const active = await findActiveSecurityScanTask(app.id, scanKey);
  if (active.unavailable) {
    emitLog('warn', `Skipping pr-reviewer for ${app.name}: security-scan-task-state-unavailable`, { appId: app.id, analysisType: taskType });
    return { skipped: true };
  }
  if (active.task) {
    emitLog('info', `Skipping pr-reviewer for ${app.name}: security-scan-report-pending`, { appId: app.id, analysisType: taskType, taskId: active.task.id });
    return { skipped: true, reason: 'security-scan-report-pending', task: active.task };
  }

  const scan = await runPrReviewerSecurityScan({
    app,
    target,
  });
  const reports = securityScanReports(scan);
  if (!scan.ok && !reports.length) {
    emitLog('warn', `Skipping pr-reviewer for ${app.name}: ${scan.code || 'security-scan-not-passed'}`, { appId: app.id, analysisType: taskType });
    return { skipped: true };
  }

  const status = !scan.ok ? 'unavailable' : (scan.passed ? 'passed' : 'findings');
  const snapshotWritten = await writePublicReviewInputSnapshot({
    scanKey: scan.scanKey || scanKey,
    pullRequests: scan.ok ? (scan.reviewInputs || []) : [],
  });
  if (!snapshotWritten) {
    emitLog('warn', `Skipping pr-reviewer for ${app.name}: public-review-input-snapshot-failed`, { appId: app.id, analysisType: taskType });
    return { skipped: true };
  }
  const reviewOutput = buildSecurityScanPipelineOutput(scan, reports, status);
  // A partial/unavailable scan is never a usable allowlist. Keeping already
  // safe-looking reports here would let a later stage review a subset while
  // the remaining PRs had no completed safety verdict.
  const safeReports = scan.ok ? reports.filter(reportIsSafe) : [];
  metadata.pipeline = {
    ...metadata.pipeline,
    currentStage: 1,
    stageResults: [{
      stage: 0,
      name: securityStage.name,
      agentId: null,
      success: scan.ok,
      completedAt: new Date().toISOString(),
      summary: {
        guardId: scan.guardId || MODEL_ABUSE_GUARD_ID,
        guardModel: scan.guardModel || null,
        guardRevision: scan.guardRevision || null,
        code: scan.code || null,
        reviewedPrCount: reports.length,
        findingCount: reports.filter((report) => !reportIsSafe(report)).length,
        reportStatus: status,
      },
    }],
    previousStageAgentId: null,
    previousStageOutput: reviewOutput,
    securityScan: {
      completed: scan.ok,
      status,
      code: scan.code || null,
      guardId: scan.guardId || MODEL_ABUSE_GUARD_ID,
      guardModel: scan.guardModel || null,
      guardRevision: scan.guardRevision || null,
      layers: scan.layers || null,
      repoFullName: scan.repoFullName || target.repoFullName,
      defaultBranch: scan.defaultBranch || target.defaultBranch,
      scanKey: scan.scanKey || scanKey,
      reviewedPrCount: reports.length,
      findingCount: reports.filter((report) => !reportIsSafe(report)).length,
      reports,
      noActionsTaken: true,
      safePrCount: safeReports.length,
    },
  };
  const safeInputByNumber = new Map((scan.reviewInputs || []).map((input) => [input.number, input]));
  metadata.issueWatcher = {
    repoFullName: scan.repoFullName || target.repoFullName,
    defaultBranch: scan.defaultBranch || target.defaultBranch,
    issueComments: [],
    pullRequests: safeReports.map((report) => ({
      number: report.number,
      headSha: report.headRefOid,
      authorLogin: safeInputByNumber.get(report.number)?.authorLogin || null,
      eligibilityFacts: safeInputByNumber.get(report.number)?.eligibilityFacts || null,
      diffTruncated: false,
      contentFingerprint: report.contentFingerprint,
    })),
    strictPullRequestCoverage: true,
  };
  metadata.executionProfile = nextStage.executionProfile || null;
  metadata.pipeline.reviewInputKey = scan.scanKey || scanKey;
  metadata.context = formatSecurityScanContext(scan, reports, status);

  // Apply the next stage's provider/model/effort and behavior flags exactly as
  // the ordinary agent-completion hand-off does. Keeping this in the generator
  // makes the synthetic stage-0 result indistinguishable from a real one to
  // the rest of task creation.
  metadata.readOnly = nextStage.readOnly ?? false;
  if (nextStage.model) metadata.model = nextStage.model;
  if (nextStage.providerId) {
    metadata.provider = nextStage.providerId;
    metadata.providerId = nextStage.providerId;
  }
  if (nextStage.effort) metadata.effort = nextStage.effort;
  const nextStageReadOnly = nextStage.readOnly ?? false;
  const taskDefaults = metadata.pipeline.taskDefaults || {};
  for (const flag of PIPELINE_STAGE_BEHAVIOR_FLAGS) {
    if (flag in nextStage) {
      metadata[flag] = nextStage[flag];
    } else if (nextStageReadOnly) {
      metadata[flag] = false;
    } else if (flag in taskDefaults) {
      metadata[flag] = taskDefaults[flag];
    }
  }

  // No forced human approval here. The pipeline's own gates bound what an
  // external PR can do: Stage 1 already screened it, the Eligibility Gate is
  // tool-free, and Stage 3 runs sandboxed with the deterministic coordinator
  // owning every forge mutation. Forcing approval on every scanned PR held
  // the cheap tool-free gate behind a click on each run, including a targeted
  // "Review this PR" the maintainer had just pressed. The schedule's own
  // "Require approval" toggle (metadata.requireApproval from the interval
  // config) still holds the run when the user asks for that.
  emitLog(
    status === 'passed' ? 'info' : 'warn',
    `pr-reviewer security scan ${status} for ${app.name}: ${reports.length} external PR(s)`,
    { appId: app.id, analysisType: taskType },
  );
  return { skipped: false, scan };
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
    } else if ((app.defaultUseWorktree === true || metadata.useWorktree === true || metadata.useWorktree === 'true') && app.defaultOpenPR !== false) {
      metadata.openPR = true;
      metadata.useWorktree = true;
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

  // Legacy apps without this field keep resolving their persisted reviewLoop
  // metadata. Once an app explicitly configures a default, stamp it onto new
  // PR tasks so the policy survives later app-default changes.
  if (finalOpenPR && metadata.prCompletion === undefined && PR_COMPLETION_VALUES.includes(app.defaultPrCompletion)) {
    metadata.prCompletion = app.defaultPrCompletion;
  }
}

async function generateManagedAppImprovementTask(app, state, { ignoreTaskId = null } = {}) {
  const { updateAppActivity } = await import('./appActivity.js');
  const taskSchedule = await import('./taskSchedule.js');

  // First, check for any on-demand task requests for this app
  const onDemandRequests = await taskSchedule.getOnDemandRequests();
  const appRequests = onDemandRequests.filter(r => r.appId === app.id);

  let nextType;
  let selectionReason;
  // A stolen on-demand request may be SCOPED to one PR (the PRs/MRs tab's
  // per-row pr-reviewer trigger). Carrying it is not optional: the generator
  // reads no target as "sweep every external PR", so dropping it here would
  // silently promote the user's one-row click into a full-repo review — the
  // same widening the perpetual-refill skip guards against on the other side.
  let targetPullRequest = null;

  if (appRequests.length > 0) {
    const request = appRequests[0];
    targetPullRequest = request.targetPullRequest ?? null;
    await taskSchedule.clearOnDemandRequest(request.id);
    // Only a human "Run" may clear the drain's brakes (park state, dispatch
    // count); the policy lives in applyOnDemandRunResets so this idle-review
    // path can't drift from its spawnPriority0OnDemand siblings — without it,
    // a currently drain-capped or parked perpetual type dequeued here stays
    // capped/parked and the explicit "Run" silently produces no task.
    await taskSchedule.applyOnDemandRunResets(request, app.id);
    nextType = request.taskType;
    selectionReason = 'on-demand';
    emitLog('info', `Processing on-demand app task request: ${nextType} for ${app.name}`, { requestId: request.id });
  } else {
    // Use the schedule service to determine the next task type
    const nextTypeResult = await taskSchedule.getNextTaskType(app.id);

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
  const task = await generateManagedAppImprovementTaskForType(nextType, app, state, {
    ignoreTaskId,
    deferPerpetualDispatch: true,
    targetPullRequest
  });
  // Idle-review can steal a queued on-demand request for this app. That
  // request is still a user Run — apply the same consent as Priority 0.
  if (selectionReason === 'on-demand') applyOnDemandConsent(task);
  return task;
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
// Last transient (non-parking) detector verdict, keyed the same way a park is
// (`taskType` + appId), so emitOnDemandEmpty can read it right beside
// getPerpetualParkInfo. A transient skip deliberately does NOT park — there is no
// park record to hang the reason on — so this is that path's reason channel.
//
// Deliberately in-memory and short-lived: the only consumer is the emit that
// follows the gate a few frames later in the SAME drain, so a persisted schedule
// field would have nothing left to read it after a restart. The TTL keeps a
// verdict from a *previous* drain out of an unrelated later toast, and the read
// consumes it so it can never be reported twice.
const TRANSIENT_VERDICT_TTL_MS = 60_000;
const transientVerdicts = new Map();
const transientVerdictKey = (taskType, appId) => `${taskType}:${appId || 'global'}`;

/**
 * Record why a perpetual work gate skipped WITHOUT parking. `cli` is the forge
 * CLI whose probe failed (`gh` / `glab`), or null when no forge was involved.
 * Passing a null verdict clears any stale entry (the actionable / park paths).
 */
export function recordPerpetualTransient(taskType, appId, verdict) {
  const key = transientVerdictKey(taskType, appId);
  if (!verdict) {
    transientVerdicts.delete(key);
    return;
  }
  transientVerdicts.set(key, { ...verdict, at: Date.now() });
}

/** Read-and-consume the recorded verdict; null when absent or past its TTL. */
function takePerpetualTransient(taskType, appId) {
  const key = transientVerdictKey(taskType, appId);
  const verdict = transientVerdicts.get(key);
  transientVerdicts.delete(key);
  if (!verdict || (Date.now() - verdict.at) > TRANSIENT_VERDICT_TTL_MS) return null;
  return verdict;
}

/**
 * Surface WHY a user-initiated on-demand "Run" produced no task, so the trigger
 * isn't a silent no-op the user only discovers in the pm2 logs. Emits
 * `schedule:on-demand-empty` (which the client toasts) with an `outcome`:
 *   - 'parked'    → a detector-driven task re-checked and found no actionable work;
 *                   carries the reason + open/in-flight/filtered breakdown.
 *   - 'transient' → a detector-driven task that did NOT park — a gh/glab probe
 *                   failure — so the check didn't actually complete. Carries a
 *                   `forge` block naming the real fault when the CLI is broken
 *                   in a way that will NOT clear on its own.
 *   - 'idle'      → a non-perpetual task produced no task: a genuine "nothing to
 *                   do", NOT a failure (e.g. pr-watcher with no new PRs).
 *
 * Called from BOTH on-demand drain engines (cos.dequeueNextTask and
 * spawnPriority0OnDemand below) so a user Run gets feedback no matter which one
 * drains the request. `taskConfig` is the already-loaded interval for the task,
 * passed in to avoid re-reading the schedule. The event fires ONLY on the
 * user-initiated on-demand path, so the client can toast it without
 * background-park noise.
 */
export async function emitOnDemandEmpty({ taskScheduleMod, request, targetApp, taskConfig }) {
  const appId = targetApp?.id || null;
  const parkInfo = await taskScheduleMod.getPerpetualParkInfo(request.taskType, appId).catch(() => null);
  const isDetectorDriven = taskConfig?.perpetual === true;
  const outcome = parkInfo ? 'parked' : (isDetectorDriven ? 'transient' : 'idle');

  // Layered Intelligence skips (e.g. a provider that can't drive an agent) record
  // an actionable last-run reason. Surface it so a manual "Run" toasts WHY it
  // produced nothing (e.g. "pick a CLI/TUI provider") instead of a misleading
  // generic "nothing to do". Read the freshest record — the skip's recordRun
  // landed after `targetApp` was loaded. Best-effort; a read failure just omits it.
  let reason = null;
  if (outcome === 'idle' && appId && request.taskType === 'layered-intelligence') {
    const { getAppById } = await import('./apps.js');
    const app = await getAppById(appId).catch(() => null);
    reason = app?.layeredIntelligence?.lastRunReason || null;
  }

  // 'transient' says "the forge probe failed, try again shortly" — only true when
  // the forge is momentarily flaky. A gh that is missing, unauthenticated, or
  // blocked by an outbound firewall fails EVERY tick forever, so that advice sends
  // the user in circles. Ask the CLI the detector actually ran (recorded by the
  // work gate moments ago — the task-type NAME can't answer this: `claim-work`
  // resolves its forge internally, and branch-reconcile goes transient over
  // git/provider faults with no forge involved) whether it is broken in a
  // way that won't self-clear, and pass the remedy through. No verdict, an
  // unprobeable CLI, or a healthy one all leave `forge` null and keep the
  // generic copy — the failure really was a blip, or at least not one we can name.
  let forge = null;
  const verdict = outcome === 'transient' ? takePerpetualTransient(request.taskType, appId) : null;
  if (verdict?.remedy) {
    // The detector already knew the fault AND the way out — a per-repo permission
    // the token lacks (e.g. the collaborators/members list behind the "Me +
    // collaborators" author gate). checkGhHealth can't see that: it probes global
    // auth, which such a token passes, so asking it here would drop the remedy and
    // fall back to "try again shortly" — the exact dead end this channel exists to
    // avoid.
    forge = { cli: verdict.cli, remedy: verdict.remedy };
  } else if (verdict?.cli === 'gh') {
    const { checkGhHealth } = await import('./github.js');
    const health = await checkGhHealth().catch(() => null);
    if (health && !health.ok && health.remedy) forge = { cli: 'gh', remedy: health.remedy };
  }

  cosEvents.emit('schedule:on-demand-empty', {
    requestId: request.id,
    taskType: request.taskType,
    appId,
    appName: targetApp?.name || null,
    outcome,
    reason,
    forge,
    parkReason: parkInfo?.parkReason || null,
    parkedUntil: parkInfo?.parkedUntil || null,
    actionableCount: parkInfo?.parkActionableCount ?? null,
    counts: parkInfo?.parkCounts || null
  });
}

/**
 * Assemble the base improvement-task metadata and layer the sanitized global
 * (schedule interval) + per-app taskMetadata overrides on top. `appOverride` is
 * this app's stored entry for `taskType` (loaded once by the caller, which also
 * reads its provider/model pin). Per-app strips
 * managed-agent fields first (see the sibling generateManagedAppTask path for
 * the rationale). Pure assembly — no gating, no early return.
 */
function buildImprovementTaskMetadata(taskType, app, interval, taskSchedule, appOverride) {
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
  const strippedAppOverride = taskSchedule.stripManagedAgentOptionsFromOverride(
    taskType, appOverride?.taskMetadata
  );
  const sanitizedAppMeta = sanitizeTaskMetadata(strippedAppOverride);
  if (sanitizedAppMeta) {
    Object.assign(metadata, sanitizedAppMeta);
  }

  // Derive the marker from the task type as well as the shipped schedule
  // metadata. This keeps pre-migration/custom schedule records from losing the
  // claim-owned lifecycle when they still carry the legacy false/false flags.
  // Do this after schedule and app overrides so the claim contract cannot be
  // disabled by stale or malformed metadata.
  if (CLAIM_FLOW_TASK_TYPES.has(taskType)) metadata.claimFlow = true;

  return metadata;
}

/**
 * Run a task type's registered buildTaskInput hook (taskTypeHooks.js) for
 * deterministic pre-agent data collection. Returns `{ skip: true }` when the
 * hook opts out (execution recorded so cadence advances), otherwise
 * `{ skip: false, hookPrompt, hookOverride, hookMetadata }` — the hook may fully
 * own the rendered prompt, pin the app's per-app provider/model, and hand back a
 * metadata bag to stamp onto the created task.
 *
 * `hookMetadata` is normalized to null unless the hook returned a real object,
 * so the caller's "stamp it" check can't be tripped by a stray primitive.
 */
export async function resolveTaskInputHook(app, taskType, taskSchedule, { ignoreTaskId = null } = {}) {
  const { getTaskInputHook } = await import('./taskTypeHooks.js');
  const inputHook = await getTaskInputHook(taskType);
  if (!inputHook) return { skip: false, hookPrompt: null, hookOverride: {}, hookMetadata: null };
  const input = await inputHook({ app, taskType, ignoreTaskId }).catch((err) => {
    emitLog('warn', `buildTaskInput hook failed for ${taskType}/${app.name}: ${err.message}`, { appId: app.id, analysisType: taskType });
    return { skip: { reason: 'input-hook-error' } };
  });
  if (input?.skip) {
    emitLog('info', `Skipping ${taskType} for ${app.name}: ${input.skip.reason}`, { appId: app.id, analysisType: taskType });
    await taskSchedule.recordExecution(taskType, app.id);
    return { skip: true };
  }
  return {
    skip: false,
    hookPrompt: input?.prompt || null,
    hookOverride: { providerId: input?.providerId || null, model: input?.model || null },
    hookMetadata: isPlainObject(input?.hookMetadata) ? input.hookMetadata : null
  };
}

/**
 * claim-work single-source router: resolve the app's workTracker (default
 * 'auto' → git origin host) and delegate to the concrete claim flow. Mutates
 * `metadata` with the delegated flow's isolation posture (useWorktree/openPR)
 * and returns the resolved promptTaskType (=== taskType for every
 * non-claim-work type). The hook stays even though all four concrete claim
 * prompts self-manage worktree+PR, so a future delegated type carrying a
 * CoS-managed DEFAULT_TASK_INTERVALS entry would have its posture applied.
 */
async function resolveClaimWorkRouting(app, taskType, metadata, taskSchedule) {
  if (taskType !== 'claim-work') return taskType;
  metadata.claimFlow = true;
  const { resolveAppWorkTracker, trackerToClaimTaskType } = await import('../lib/workTracker.js');
  const wt = await resolveAppWorkTracker(app);
  const promptTaskType = trackerToClaimTaskType(wt.resolved) || 'plan-task';
  emitLog('info', `claim-work for ${app.name}: tracker=${wt.resolved} (${wt.source}) → ${promptTaskType}`, { appId: app.id, analysisType: taskType });
  const delegatedMeta = taskSchedule.DEFAULT_TASK_INTERVALS[promptTaskType]?.taskMetadata;
  if (delegatedMeta) {
    if ('useWorktree' in delegatedMeta) metadata.useWorktree = delegatedMeta.useWorktree;
    if ('openPR' in delegatedMeta) metadata.openPR = delegatedMeta.openPR;
  }
  return promptTaskType;
}

/**
 * Perpetual (drain-until-done) work-detector gate. For a task type running on
 * the 'perpetual' interval — excluding branch-/issue-reconcile, whose own scan
 * IS the detector — a programmatic detector decides whether there's anything to
 * claim BEFORE building the (expensive) prompt or burning an agent:
 *   - actionable → stamp metadata.perpetual (skip cooldown), proceed;
 *   - unchanged actionable set → PARK after a successful no-progress run;
 *   - idle (definitive) → PARK on the recheck cadence, skip;
 *   - transient probe failure → skip WITHOUT parking so the next tick retries.
 * The detector keys on the RESOLVED promptTaskType. Returns `{ skip, spendDispatch,
 * signature }` and mutates `metadata.perpetual` on the actionable path.
 *
 * `spendDispatch` is the caller's cue to call `recordPerpetualDispatch` (which
 * clears the park and spends one unit of the type's `drainDispatchCap` budget in a
 * single write) — deliberately NOT done here. Gates that run AFTER this one can
 * still return null with no agent ever spawned (`applyPlanIdMetadata` skips
 * plan-task when every unchecked item is in-flight or blocked), and charging the
 * budget for a task that was never created would exhaust a capped drain on
 * evaluations alone, parking it for `drain-cap` without a single dispatch.
 */
async function applyPerpetualWorkGate(app, taskType, promptTaskType, metadata, interval, taskSchedule, { ignoreTaskId = null } = {}) {
  // The reconcile drains run their own scan-driven gate (the blocks in
  // cosTaskPreStepBlocks), so they opt out of the generic work detector.
  if (interval.perpetual !== true || isReconcileDrainTaskType(taskType)) {
    return { skip: false };
  }
  const { detectActionableWork } = await import('./perpetualWork.js');
  const detection = await detectActionableWork(promptTaskType, app, {
    issueAuthorFilter: metadata.issueAuthorFilter || 'self',
    issueExcludeLabels: metadata.issueExcludeLabels || [],
    // A detector that counts in-flight work must skip the task whose completion
    // triggered this refill — it is already recorded, just not yet marked done.
    ignoreTaskId
  });
  if (detection.actionable) {
    // A successful claim/plan agent can still return without changing forge or
    // PLAN state (for example, it decides not to pick the advertised item). The
    // completion refill would otherwise dispatch the same candidate forever.
    // The detector's signature covers the complete set; `items` is capped for
    // the picker and is not sufficient for convergence.
    const drainSignature = detection.signature == null
      ? null
      : JSON.stringify({ taskType: promptTaskType, candidates: detection.signature });
    if (drainSignature != null) {
      const { signature: lastSignature, dispatchCount } = await taskSchedule.getPerpetualDrainState(taskType, app.id);
      if (shouldParkUnchangedPerpetualWork({ ...detection, signature: drainSignature }, lastSignature, dispatchCount)) {
        const counts = detection.total != null
          ? { open: detection.total, inFlight: detection.inFlightCount ?? 0, filtered: detection.filteredCount ?? 0 }
          : null;
        await taskSchedule.parkPerpetual(taskType, app.id, {
          reason: 'no-progress',
          actionableCount: detection.count,
          counts,
          signature: null
        });
        emitLog('info', `Perpetual ${taskType} parked for ${app.name}: actionable work unchanged after the last run`, { appId: app.id });
        return { skip: true };
      }
    }
    recordPerpetualTransient(taskType, app.id, null);
    metadata.perpetual = true;
    // The dispatch is SPENT BY THE CALLER, once a task is certain — see the note
    // on `spendDispatch` in the JSDoc above.
    return { skip: false, spendDispatch: true, signature: drainSignature };
  }
  if (detection.transient) {
    emitLog('debug', `Perpetual ${taskType} skip for ${app.name} (transient: ${detection.reason})`, { appId: app.id });
    // The skip is silent by design (the next tick retries), but an explicit user
    // "Run" ends here too — record which CLI failed so emitOnDemandEmpty can tell
    // the difference between a blip and a forge that is broken for good, plus any
    // remedy the detector already named (a permission the token lacks, which no
    // amount of retrying fixes).
    recordPerpetualTransient(taskType, app.id, {
      cli: detection.cli || null, reason: detection.reason, remedy: detection.remedy || null
    });
    return { skip: true };
  }
  recordPerpetualTransient(taskType, app.id, null);
  // Carry the detector's open/in-flight/filtered breakdown into the park so an
  // explicit "Run" can explain WHY a non-empty queue yielded no work.
  const counts = detection.total != null
    ? { open: detection.total, inFlight: detection.inFlightCount ?? 0, filtered: detection.filteredCount ?? 0 }
    : null;
  // Terminal park — parkPerpetual zeroes the dispatch budget in the same write, so
  // the next drain window starts fresh instead of capping early on this one's spend.
  await taskSchedule.parkPerpetual(taskType, app.id, { reason: detection.reason, actionableCount: detection.count, counts, signature: null });
  emitLog('info', `Perpetual ${taskType} parked for ${app.name}: ${detection.reason}`, { appId: app.id });
  return { skip: true };
}

/**
 * user-action-review's `{userActionDelivery}` block: the operator's
 * `fileIssues` choice decides HOW proposals leave the run — filed tracker
 * issues (default) or queued CoS tasks. Resolved at dispatch, like the audit
 * mode contract, so a customized stored prompt still honors the toggle. The
 * type is not in the audit catalog (its "do work" alternative is queueing
 * tasks, not editing code), so the audit mode wrapper does not apply to it.
 */
export function resolveUserActionDeliveryBlock(taskType, metadata) {
  if (taskType !== 'user-action-review') return '';
  return metadata?.fileIssues === false || metadata?.fileIssues === 'false'
    ? 'Deliver each accepted proposal as a QUEUED CoS TASK (`POST /api/cos/tasks`, one bounded task per proposal, priority LOW unless the evidence is severe) — the operator turned off file-issues mode for this schedule. Do not file tracker issues.'
    : 'Deliver each accepted proposal as a FILED TRACKER ISSUE in the PortOS repository (`gh issue create` with the `plan` label; create the label first if missing). This is file-issues mode, the default. Do not queue CoS tasks.';
}

/**
 * Render the delivery posture into a user-action-review prompt. Mirrors
 * `applyAuditModeWrapper`: a customized stored prompt that dropped the
 * `{userActionDelivery}` token still gets the operator's choice PREPENDED —
 * otherwise flipping fileIssues would be a silent no-op on that install.
 */
export function applyUserActionDeliveryMode(promptTemplate, taskType, metadata) {
  const prompt = typeof promptTemplate === 'string' ? promptTemplate : '';
  const block = resolveUserActionDeliveryBlock(taskType, metadata);
  if (!block) return prompt;
  if (prompt.includes('{userActionDelivery}')) return prompt.replace(/\{userActionDelivery\}/g, () => block);
  return `## Delivery mode\n\n${block}\n\n---\n\n${prompt}`;
}

/**
 * Render leftover-branch detector findings into a user-action-review prompt.
 * A customized stored prompt that dropped `{userActionDetectors}` still gets
 * the section PREPENDED — otherwise the detector would be a silent no-op.
 */
export async function applyUserActionDetectorSection(promptTemplate, taskType) {
  if (taskType !== 'user-action-review') return typeof promptTemplate === 'string' ? promptTemplate : '';
  const prompt = typeof promptTemplate === 'string' ? promptTemplate : '';
  const findings = await detectIdleLeftoverBranches().catch((error) => {
    console.error(`❌ user-action-review detector interpolation failed: ${error.message}`);
    return [];
  });
  const block = formatUserActionDetectorBlock(findings) || 'No leftover-branch findings.';
  if (prompt.includes('{userActionDetectors}')) return prompt.replace(/\{userActionDetectors\}/g, () => block);
  return `## Detectors\n\n${block}\n\n---\n\n${prompt}`;
}


const EMPTY_PROVIDER_PIN = Object.freeze({ providerId: null, model: null });

/**
 * The app's per-app provider/model pin for this task type, as an overlay to apply
 * over the global Schedule pin. Runs the shared harness guard
 * (`resolveAgentProviderPin`) so an api-typed per-app pin — which has no
 * file-writing harness and could only ever fail at spawn — falls back to the
 * Schedule pin rather than reaching the agent.
 *
 * Returns an EMPTY overlay when nothing resolvable is harness-capable: the
 * Schedule pin then stands untouched and agentProviderResolution reports its
 * actionable permanent error, which beats silently rerouting the run onto a
 * provider the user never chose.
 */
async function resolveAppProviderPin({ app, taskType, appOverride, interval }) {
  if (!appOverride?.providerId && !appOverride?.model) return EMPTY_PROVIDER_PIN;
  const { providerId, model, skipReason } = await resolveAgentProviderPin({
    appPin: { providerId: appOverride.providerId || null, model: appOverride.model ?? null },
    readSchedulePin: () => interval,
    taskType,
    appName: app.name
  });
  return skipReason ? EMPTY_PROVIDER_PIN : { providerId, model };
}

/**
 * Layer the provider/model/effort pins onto `metadata`, least specific first:
 * the global schedule interval, then the app's own per-app pin, then a
 * buildTaskInput hook's fully-resolved choice. A model is only ever pinned when
 * explicitly configured — otherwise it stays unset so selectModelForTask resolves
 * the active provider's tier/default model at spawn time (see the note in
 * generateSelfImprovementTaskForType).
 */
function applyOneProviderPin(metadata, pin) {
  // A model pinned with no provider REFINES the layer below (the user picked a
  // model for the provider that layer resolved), so it applies on its own.
  if (!pin?.providerId) {
    if (pin?.model) metadata.model = pin.model;
    return;
  }
  metadata.provider = pin.providerId;
  metadata.providerId = pin.providerId;
  // A model is PROVIDER-SCOPED: one chosen for the layer below is not something
  // the provider that just replaced it can necessarily run, and
  // agentProviderResolution honors an explicit `metadata.model` as a CLI
  // pass-through rather than dropping it — so a leaked model ships to the wrong
  // CLI (`claude --model gemini-…`) and fails on every retry until the task
  // blocks. Take this layer's model, or none and let selectModelForTask resolve
  // the new provider's own default.
  if (pin.model) metadata.model = pin.model;
  else delete metadata.model;
}

function applyProviderModelPins(metadata, interval, appPin, hookOverride) {
  // Least specific first: the task's global Schedule pin. Then the app's own
  // per-app pin, which is the more specific choice — honored for EVERY task type
  // (#4783), not just the one whose buildTaskInput hook read it. Then a
  // buildTaskInput hook's fully-resolved choice, which wins outright.
  applyOneProviderPin(metadata, { providerId: interval.providerId || null, model: interval.model || null });
  if (interval.effort) {
    metadata.effort = interval.effort;
  }
  applyOneProviderPin(metadata, appPin);
  applyOneProviderPin(metadata, hookOverride);
}

export async function generateManagedAppImprovementTaskForType(taskType, app, state, {
  skipPreconditions = false,
  ignoreTaskId = null,
  deferPerpetualDispatch = false,
  targetPullRequest = null
} = {}) {
  const { updateAppActivity } = await import('./appActivity.js');
  const taskSchedule = await import('./taskSchedule.js');
  const { getTaskPrompt, getStagePrompt } = await import('./taskPromptService.js');

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

  // Get interval settings to determine provider/model and pipeline config.
  // The per-app override entry is loaded ONCE here: it carries both the
  // taskMetadata merged below and the provider/model pin applied further down.
  const [interval, appOverrides] = await Promise.all([
    taskSchedule.getTaskInterval(taskType),
    getAppTaskTypeOverrides(app.id)
  ]);
  const appOverride = appOverrides[taskType] || null;
  const metadata = buildImprovementTaskMetadata(taskType, app, interval, taskSchedule, appOverride);

  if (taskType === 'pr-reviewer') ensurePrReviewerPipeline(metadata);
  initializePipelineMetadata(metadata);
  const securityPreflight = await runPrReviewerSecurityPreflight(taskType, app, metadata, targetPullRequest);
  if (securityPreflight.skipped) return null;
  if (!skipPreconditions && shouldSkipForPrecondition(metadata, app, taskType)) return null;

  // Programmatic-I/O input hook. A task type may register a buildTaskInput hook
  // (taskTypeHooks.js) that does deterministic pre-agent data collection and
  // fully OWNS its prompt. `hookOverride` may pin the app's per-app
  // provider/model — captured here but APPLIED AFTER the global-interval
  // provider/model block below, so the per-app choice wins.
  // `ignoreTaskId` reaches the hook because a drain-on-completion refill runs
  // while the completing task is still `in_progress` on disk — a hook that
  // counts in-flight tasks against a budget must not count the run that just
  // finished and already recorded itself (#3179).
      const inputHook = await resolveTaskInputHook(app, taskType, taskSchedule, { ignoreTaskId });
  if (inputHook.skip) return null;
  const { hookPrompt, hookOverride, hookMetadata } = inputHook;

  // claim-work single-source router: `taskType` stays 'claim-work' for
  // interval/cadence/recording; `promptTaskType` drives prompt selection, PLAN
  // gating, and the forge-specific author-filter directive below.
  const promptTaskType = await resolveClaimWorkRouting(app, taskType, metadata, taskSchedule);

  // Consecutive-dispatch cap for EVERY perpetual drain (#3848). First, because a
  // capped drain must not pay for a work-detector probe or a reconcile git/gh scan
  // it is only going to discard.
  const drainCap = await applyPerpetualDrainCap(app, taskType, interval, taskSchedule);
  if (drainCap.skip) return null;

  // Perpetual (drain-until-done) gate — probes for actionable work before
  // building the prompt or burning an agent (branch-/issue-reconcile self-gate
  // in their own blocks, so this excludes them).
  const perpetualGate = await applyPerpetualWorkGate(app, taskType, promptTaskType, metadata, interval, taskSchedule, { ignoreTaskId });
  if (perpetualGate.skip) return null;

  // branch-reconcile: deterministic git/gh pre-step that carries the actionable
  // in-flight set into the prompt via {inFlightBranches}.
  const branchReconcile = await resolveBranchReconcileBlock(app, taskType, metadata, taskSchedule);
  if (branchReconcile.skip) return null;
  const inFlightBranchesBlock = branchReconcile.block;

  // repo-sync: deterministic git pre-step that syncs this app's checkout with
  // origin and carries whatever it refused to do into the prompt via
  // {repoSyncReport}. (The install-wide sweep runs from the global lane —
  // generateSelfImprovementTaskForType — which is what "Run Now" with no app
  // triggers; this branch covers a run scoped to one app.)
  const repoSync = await resolveRepoSyncBlock(app, taskType, metadata);
  if (repoSync.skip) return null;
  const repoSyncReportBlock = repoSync.block;

  // issue-reconcile: deterministic forge pre-step that carries the zombie-issue
  // set into the prompt via {zombieIssues}.
  const issueReconcile = await resolveIssueReconcileBlock(app, taskType, metadata, taskSchedule);
  if (issueReconcile.skip) return null;
  const zombieIssuesBlock = issueReconcile.block;

  // Honor a direct claim-work prompt customization if the user set one;
  // otherwise delegate to the resolved tracker's prompt body via
  // getTaskPrompt(promptTaskType), which reads THAT type's interval.prompt
  // override — so a user's claim-issue / plan-task customization flows
  // through. (The prompt-only bodies claim-issue-gitlab and claim-issue-jira
  // have no schedule/UI customization slot, so they always render the shipped
  // default.)
  const promptKeyForBody = (taskType === 'claim-work' && !interval.prompt) ? promptTaskType : taskType;

  // A buildTaskInput hook that returned a fully-rendered prompt wins over the
  // template path — the hook owns its prompt (LI has no DEFAULT_TASK_PROMPTS
  // entry). The token-replacement chain below is a no-op on it (no {tokens}).
  const currentStageIndex = metadata.pipeline?.currentStage ?? 0;
  const promptTemplate = hookPrompt
    ? hookPrompt
    : (metadata.pipeline?.stages
      ? await getStagePrompt(taskType, currentStageIndex)
      : await getTaskPrompt(promptKeyForBody));

  // reference-watch: dynamically inject {referenceData} — a Markdown chunk
  // describing each ref configured on the app + commits since lastReviewedSha.
  const referenceWatch = await resolveReferenceWatchBlock(app, taskType);
  if (referenceWatch.skip) return null;
  const referenceDataBlock = referenceWatch.block;

  // Tracker-filing types (reference-watch, or an audit type with fileIssues):
  // the {trackerInstructions} block for the app's resolved work tracker.
  const fileIssues = isFileIssuesMode(taskType, metadata);
  const trackerFiling = await resolveTrackerFilingBlock(app, taskType, { fileIssues });
  if (trackerFiling.workTracker) {
    // Traceability + deliverable posture, derived from the SAME resolved tracker
    // that selected the {trackerInstructions} block above so the flag can't drift
    // from the instructions the agent actually got: the PLAN.md path commits
    // checklist items (dirty tree), while github/gitlab/jira file issues/tickets
    // and leave the tree CLEAN. Without this downstream bookkeeping mistakes a
    // scheduled forge-tracker run for missing code work (#3102).
    metadata.workTracker = trackerFiling.workTracker;
    // Stamped unconditionally — a schedule/per-app `worktreeChangesExpected`
    // override would let the flag disagree with the instructions the agent
    // actually got, which is the exact drift this derivation exists to prevent.
    metadata.worktreeChangesExpected = trackerFiling.worktreeChangesExpected;
  }

  // pr-watcher: poll the app's GitHub repo for PRs newly opened against the
  // default branch; injects {prData}/{repoFullName}/{defaultBranch}.
  const prWatch = await resolvePrWatcherBlock(app, taskType, metadata, taskSchedule);
  if (prWatch.skip) return null;
  const prDataBlock = prWatch.block;
  const prRepoFullName = prWatch.repoFullName;
  const prDefaultBranch = prWatch.defaultBranch;

  // Gate on PLAN.md using the RESOLVED type so a claim-work run routed to the
  // PLAN.md flow still skips cleanly on an empty/all-in-flight queue. For
  // standalone tasks promptTaskType === taskType, so behavior is unchanged.
  const planMeta = await applyPlanIdMetadata(promptTaskType, app.repoPath, metadata);
  if (planMeta.skipReason) {
    emitLog('info', `Skipping ${taskType} for ${app.name}: ${planMeta.skipReason}`, { appId: app.id });
    return null;
  }
  const planConstraintBlock = buildPlanConstraintBlock(metadata.planId);

  const modeInstructions = isAuditTaskType(taskType) ? modeContractFor(fileIssues) : '';
  const baseDescription = await buildImprovementTaskDescription({
    promptTemplate: applyAuditModeWrapper(promptTemplate, modeInstructions),
    app, promptTaskType, metadata,
    blocks: {
      referenceData: referenceDataBlock,
      trackerInstructions: trackerFiling.trackerInstructions,
      modeInstructions,
      prData: prDataBlock,
      inFlightBranches: inFlightBranchesBlock,
      zombieIssues: zombieIssuesBlock,
      repoSyncReport: repoSyncReportBlock,
      repoFullName: prRepoFullName,
      defaultBranch: prDefaultBranch,
      planConstraint: planConstraintBlock
    }
  });
  const taskDataInputs = await resolveTaskDataInputs(interval.dataInputs, { app });
  const description = scopeDescriptionToPullRequest(
    appendTaskDataInputs(baseDescription, taskDataInputs),
    metadata
  );

  applyAppWorktreeDefault(metadata, app);
  // File-issues posture wins over app worktree/PR defaults — the deliverable
  // is tracker items, so a managed worktree or an implied PR is the wrong shape.
  if (fileIssues) {
    metadata.fileIssues = true;
    metadata.noCodeOutput = true;
    metadata.useWorktree = false;
    metadata.openPR = false;
    metadata.simplify = false;
  } else if (auditDoWorkRequiresWorktree(taskType)) {
    // Some structural audits are safe to remediate only in isolation. Enforce
    // this after schedule/app defaults so a stale file-issues toggle transition
    // cannot dispatch edits into the app's live checkout. PR creation remains
    // independently configurable through metadata.openPR.
    metadata.useWorktree = true;
  }
  // The app's per-app provider/model pin (#4783). Resolved through the shared
  // harness guard, so an api-typed pin falls back to the Schedule pin instead of
  // reaching the spawn as a permanent provider failure. Skipped when a
  // buildTaskInput hook already resolved the provider — its return wins anyway, so
  // re-deriving here would only duplicate the fallback log line.
  const appPin = hookOverride.providerId
    ? EMPTY_PROVIDER_PIN
    : await resolveAppProviderPin({ app, taskType, appOverride, interval });
  applyProviderModelPins(metadata, interval, appPin, hookOverride);

  const approval = await resolveConfidenceApproval(state, `app-improve:${taskType}`, `Task app-improve:${taskType} for ${app.name}`, metadata);
  stampApprovalReason(metadata, approval);

  // All gates passed — stamp the buildTaskInput hook's metadata bag, record the
  // rotation-pointer advance, and emit the generation log. Deferred from the top
  // of the function (see note there); every `return null` above this point
  // intentionally leaves all three untouched.
  //
  // The hook bag lands HERE, below the last gate, precisely so a hook can defer a
  // side effect keyed on it until the task is certain to exist. Several gates
  // below `resolveTaskInputHook` can still `return null` with no agent ever
  // spawned, so a hook that charged a spend ledger from `buildTaskInput` would
  // burn budget on a dispatch that never happened (#3179).
  //
  // Generator-computed keys always win. Stamping last would otherwise let a hook
  // silently clobber a decision made a few lines earlier — `analysisType` is the
  // dangerous one, since resolveTaskHookType reads it to dispatch the output hook,
  // so a collision would stop the very hook that asked for the bag from ever
  // running. Hooks pin provider/model and own the prompt through their own return
  // fields; the bag is for values that must SURVIVE to processTaskOutput, not an
  // override channel. Dropped collisions are logged rather than merged silently.
  for (const [key, value] of Object.entries(hookMetadata || {})) {
    if (key in metadata) {
      emitLog('warn', `Ignoring ${taskType} hookMetadata key '${key}' for ${app.name}: it would overwrite generator-owned task metadata`, { appId: app.id, analysisType: taskType });
      continue;
    }
    metadata[key] = value;
  }
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

  // Most callers return the task to a spawn engine, so keep this side effect
  // deferred until that engine admits the task. Direct callers retain the old
  // immediate behavior; queue/on-demand/idle paths opt into the handoff below.
  if (perpetualGate.spendDispatch) {
    if (deferPerpetualDispatch) {
      deferredPerpetualSignatures.set(task, {
        taskType,
        appId: app.id,
        signature: perpetualGate.signature ?? null
      });
    } else {
      await taskSchedule.recordPerpetualDispatch(taskType, app.id, perpetualGate.signature ?? null);
    }
  }

  return task;
}
// `normalizeClaimReviewers` moved to server/lib/reviewerConfig.js (#4770, #5702): the
// prompt builder needs the same copilot guard when it re-resolves reviewers off
// a persisted claim task, and a service-level definition would have meant a
// second copy there.

/**
 * Build a one-off "re-plan THIS issue" task — the Replan button beside Claim on
 * an app's Issues tab. A second model re-derives the plan from today's code and
 * leaves refinements, redirections, or adjustments on the tracker.
 *
 * Scoped to the forge the Issues tab actually listed (`resolveAppForgeTarget`,
 * the same resolver `listAppIssues` uses), so the comment lands on the repo the
 * user was reading rather than on whatever the checkout's origin happens to be.
 *
 * Not a claim and not `/do:replan`: nothing is implemented, nothing is assigned,
 * and the whole backlog is not audited. The deliverable is a tracker comment, so
 * the run is read-only and its clean worktree is the success shape — see
 * `buildIssueReplanPrompt` for the review contract itself.
 *
 * Throws a 400 ServerError when the app's tracker is not a forge issue tracker
 * (PLAN.md / JIRA have no issue to comment on) or when `target` is not a forge
 * issue number.
 *
 * @returns {Promise<{ tracker, prompt, taskMetadata, target }>}
 */
export async function buildIssueReplanTask(app, { target, issueContext, overrideContext } = {}) {
  const {
    resolveAppForgeTarget, forgeCliForTracker, workTrackerLabel: trackerLabel, trackerToClaimTaskType,
  } = await import('../lib/workTracker.js');

  const targetRef = normalizeWorkItemRef(target);
  if (!targetRef || !/^\d+$/.test(targetRef)) {
    throw new ServerError('Replan needs the number of the issue to review', { status: 400, code: 'REPLAN_TARGET_REQUIRED' });
  }

  const { tracker, target: forgeTarget } = await resolveAppForgeTarget(app);
  if (tracker !== 'github' && tracker !== 'gitlab') {
    throw new ServerError(
      `Replan needs a GitHub or GitLab issue tracker (${app.name} resolved to ${trackerLabel(tracker)})`,
      { status: 400, code: 'UNSUPPORTED_REPLAN_TRACKER' }
    );
  }
  const cli = forgeCliForTracker(tracker) || 'gh';

  const prompt = buildIssueReplanPrompt({
    appName: app.name,
    repoPath: app.repoPath,
    target: targetRef,
    cli,
    trackerName: trackerLabel(tracker),
    // gh takes a host-qualified spec; glab resolves the project from the
    // checkout, so it gets the plain path and no --repo flag it can't parse.
    repoFlag: (tracker === 'github' && forgeTarget?.repoSpec) ? forgeTarget.repoSpec : '',
  })
    // Reuses the claim flow's prefetched-issue block verbatim: the Issues tab has
    // already fetched this title/body, and the block's untrusted-data framing is
    // exactly what a prompt embedding someone else's issue text needs. Keyed on
    // the tracker's claim task type so its forge gate matches this run's forge.
    + appendPrefetchedIssueContext(trackerToClaimTaskType(tracker), targetRef, issueContext)
    + appendClaimOverrideContext(overrideContext);

  return {
    tracker,
    prompt,
    target: targetRef,
    // No worktree, no PR, and `noCodeOutput` because the deliverable is a forge
    // comment — that flag is what suppresses the commit/push/PR completion
    // contract, so the agent is never told to `/do:push` a run that changed
    // nothing. `worktreeChangesExpected: false` keeps its clean tree from being
    // scored as a missed deliverable (#3636).
    taskMetadata: { useWorktree: false, openPR: false, noCodeOutput: true, worktreeChangesExpected: false },
  };
}
