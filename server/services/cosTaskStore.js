/**
 * CoS Task Store Module
 *
 * Task CRUD + queue persistence extracted from cos.js. Owns the read/write
 * round-trip to the user (TASKS.md) and internal (COS-TASKS.md) task files:
 * parsing, grouping, dedup, ID generation, metadata normalization, and the
 * `tasks:changed` event emissions that drive the scheduler.
 *
 * Self-contained — it emits `tasks:changed` rather than calling the scheduler
 * directly. cos.js's `init()` listens on that event to fire `tryImmediateSpawn`
 * (user-added tasks) and `dequeueNextTask` (approved tasks), so the spawn-side
 * logic stays in cos.js while persistence lives here.
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { parseTasksMarkdown, groupTasksByStatus, getAutoApprovedTasks, getAwaitingApprovalTasks, generateTasksMarkdown, hasKnownPrefix } from '../lib/taskParser.js';
import { REVIEW_STOP_MODES, normalizeReviewers, normalizeReviewUsernames, normalizeOptionalReviewers, KEYED_REVIEWER_PINS } from '../lib/validation.js';
import { isPlainObject } from '../lib/objects.js';
import { PR_COMPLETIONS, PR_COMPLETION_VALUES } from '../lib/prDisposition.js';
import { RETRY_HOLD_KEY, RETRY_HOLD_SINCE_KEY } from '../lib/taskRetryHold.js';
import { AGENT_PAUSED_CATEGORY, PAUSE_METADATA_KEYS, isAgentPausedTask, resolvePausedTaskResume, retirePausedAgent } from '../lib/taskPauseHold.js';
import { REQUEUED_AT_KEY } from '../lib/taskRequeue.js';
import { isInvestigationTask } from '../lib/investigationTasks.js';
import { PAUSED_BLOCKED_CATEGORIES, USER_DECISION_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';
import { loadState, withStateLock, ROOT_DIR } from './cosState.js';
import { cosEvents } from './cosEvents.js';
import { CLAIM_METADATA_KEYS } from './cosTaskClaim.js';
import { mergeTaskLists } from './cosTaskMerge.js';
import { canChallenge, getChallengeCount, buildChallengePatch, buildChallengeResolutionPatch, classifyRecheckOutcome, MAX_CHALLENGES_PER_TASK } from './cosChallenge.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { runLocalCodeReview, getCodeReviewDefaults } from './codeReview.js';

// First non-empty line of a string. Used by addTask dedup: stored descriptions
// are flattened to a single line by generateTasksMarkdown, so the comparison
// must normalize on the first line to match multi-line inputs.
export const firstLine = (s) => (s || '').split('\n').map(l => l.trim()).find(l => l) || '';

export const PRIORITY_VALUES = {
  'CRITICAL': 4,
  'HIGH': 3,
  'MEDIUM': 2,
  'LOW': 1
};

const CLAIM_KEY_SET = new Set(CLAIM_METADATA_KEYS);


// The `blockedCategory` vocabulary lives in `lib/taskBlockCategories.js` — the
// pause logic, the failure reaper below, and the investigation auto-retry all
// have to answer "may I move this task?" from that one value, and each keeping
// its own literal set is how they drifted. Re-exported at the address callers
// already use.
export { PAUSED_BLOCKED_CATEGORIES };

// A task is terminal once it is completed or blocked — the same set cosTaskMerge's
// release-on-transition uses. Consumed by the LI cross-peer verdict consume (#2779) to
// spot a non-terminal→terminal ADOPTION (a failed hand-off blocks, a clean one completes;
// both are legitimate execution outcomes worth recording).
const isTerminalTaskStatus = (status) => status === 'completed' || status === 'blocked';

// Legacy fields an `updateTask` patch may carry directly (vs nested under
// `metadata`); they're normalized into `metadata` on write. Listed once so the
// content-edit detector and the normalizer below can't drift apart.
const LEGACY_DIRECT_FIELDS = ['context', 'model', 'provider', 'effort', 'app'];

// Equality for metadata values across a fresh markdown re-parse: primitives by
// ===, arrays/objects (reviewers[], screenshots[], …) by JSON since the two
// sides are independent parses with different references but equal content.
const metaValueEqual = (a, b) => {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
};

/**
 * Does an `updateTask` patch change a task's EDITABLE CONTENT (vs only its
 * claim/lease metadata)? Used to decide whether to bump the `updatedAt` LWW stamp
 * (#1714). A claim-only write — most importantly the periodic lease-renewal
 * heartbeat — must NOT bump the stamp: a heartbeat is not a content edit, and
 * letting it advance `updatedAt` would make a lease-renewing peer spuriously win
 * same-status content ties over the other peer's genuine edit.
 *
 * Crucially, the heartbeat does NOT pass a claim-only patch — `cos.js`
 * `processOrphanedTasks` spreads the WHOLE existing metadata plus the fresh lease
 * (`{ ...task.metadata, ...renewal }`). So presence of a non-claim key is not
 * enough to call it an edit; we must compare VALUES against the task's current
 * metadata and treat a key as content only when it actually changed. The edit
 * stamp itself is never content. Status/priority/description/approval changes and
 * legacy direct fields are always edits when present (callers only pass those
 * with intent).
 *
 * @param {object} updates           the updateTask patch
 * @param {object} existingMetadata  the task's current persisted metadata
 */
function isContentEdit(updates, existingMetadata = {}) {
  if (!updates || typeof updates !== 'object') return false;
  if (updates.status !== undefined) return true;
  if (updates.description !== undefined) return true;
  if (updates.priority !== undefined) return true;
  if (updates.approvalRequired !== undefined || updates.autoApproved !== undefined) return true;
  if (LEGACY_DIRECT_FIELDS.some(f => updates[f] !== undefined)) return true;
  if (updates.metadata && typeof updates.metadata === 'object') {
    const existing = (existingMetadata && typeof existingMetadata === 'object') ? existingMetadata : {};
    for (const [key, value] of Object.entries(updates.metadata)) {
      if (CLAIM_KEY_SET.has(key) || key === 'updatedAt') continue; // claim keys + the stamp never count
      if (!metaValueEqual(value, existing[key])) return true;      // a non-claim key counts only if it CHANGED
    }
  }
  return false;
}

// ── Parsed-task cache (issue #3497) ─────────────────────────────────────────
//
// `getUserTasks`/`getCosTasks`/`getTaskById` run on every daemon evaluation
// tick, scheduler sweep, and agent state update, and each call used to do a
// full `readFile` + regex-heavy `parseTasksMarkdown` of a `COS-TASKS.md` that
// grows to hundreds of tasks carrying prompt bodies and JSON metadata strings.
// Cache the parsed array per file so an unchanged file costs one `stat` plus a
// structured clone instead of a read + full parse.
//
// One server process, one user (CLAUDE.md trust model) — no locking, no atomic
// write dance. Correctness rests on two independent invalidation signals:
//
//   1. The stamp (`mtimeMs` + `size`) catches writes this module did NOT make —
//      a user editing `TASKS.md` in an editor, a restore, a peer's direct write.
//   2. Every write through `writeTaskFile` DROPS the entry outright. mtime can
//      be as coarse as one second on some filesystems, so a write-then-read in
//      the same tick must not depend on the stamp having moved.
const parsedTaskCache = new Map(); // filePath -> { stamp, tasks }

// `null` = could not stat (missing/unreadable) → do not cache, distinct from a
// legitimately empty file, which stamps normally and caches its empty parse.
const taskFileStamp = async (filePath) => {
  const stats = await stat(filePath).catch(() => null);
  return stats ? `${stats.mtimeMs}:${stats.size}` : null;
};

/**
 * Read + parse a task markdown file, serving the cached parse when the file is
 * unchanged on disk.
 *
 * Always returns a DEEP COPY. Callers (`addTask`, `updateTask`, `reorderTasks`,
 * the sweeps) mutate both the array and the task objects in place; handing out
 * the cached originals would let one caller's in-flight edits leak into every
 * later reader — including edits that were never persisted.
 */
async function readTaskFile(filePath) {
  const stamp = await taskFileStamp(filePath);
  const cached = parsedTaskCache.get(filePath);
  if (stamp && cached?.stamp === stamp) return structuredClone(cached.tasks);

  const tasks = parseTasksMarkdown(await readFile(filePath, 'utf-8'));
  if (stamp) parsedTaskCache.set(filePath, { stamp, tasks });
  else parsedTaskCache.delete(filePath);
  return structuredClone(tasks);
}

/**
 * Write task markdown, dropping the now-stale parse for that file. Every write
 * path in this module goes through here — see invalidation signal 2 above.
 */
async function writeTaskFile(filePath, markdown) {
  parsedTaskCache.delete(filePath);
  await writeFile(filePath, markdown);
}

/** Test hook: forget every cached parse. */
export function __resetTaskCache() {
  parsedTaskCache.clear();
}

/**
 * Get user tasks from TASKS.md
 */
export async function getUserTasks(tasksFilePath = null) {
  const state = await loadState();
  const filePath = tasksFilePath || join(ROOT_DIR, state.config.userTasksFile);

  if (!existsSync(filePath)) {
    return { tasks: [], grouped: groupTasksByStatus([]), file: filePath, exists: false, type: 'user' };
  }

  const tasks = await readTaskFile(filePath);
  const grouped = groupTasksByStatus(tasks);

  return { tasks, grouped, file: filePath, exists: true, type: 'user' };
}

/**
 * Get CoS internal tasks from COS-TASKS.md
 */
export async function getCosTasks(tasksFilePath = null) {
  const state = await loadState();
  const filePath = tasksFilePath || join(ROOT_DIR, state.config.cosTasksFile);

  if (!existsSync(filePath)) {
    return { tasks: [], grouped: groupTasksByStatus([]), file: filePath, exists: false, type: 'internal' };
  }

  const tasks = await readTaskFile(filePath);
  const grouped = groupTasksByStatus(tasks);
  const autoApproved = getAutoApprovedTasks(tasks);
  const awaitingApproval = getAwaitingApprovalTasks(tasks);

  return { tasks, grouped, file: filePath, exists: true, type: 'internal', autoApproved, awaitingApproval };
}

/**
 * Get all tasks (user + internal)
 */
export async function getAllTasks() {
  const [userTasks, cosTasks] = await Promise.all([getUserTasks(), getCosTasks()]);
  return { user: userTasks, cos: cosTasks };
}

/**
 * Alias for backward compatibility
 */
export const getTasks = getUserTasks;

/**
 * Get a specific task by ID from any task source
 */
export async function getTaskById(taskId) {
  const { user: userTasks, cos: cosTasks } = await getAllTasks();

  // Search user tasks
  const userTask = userTasks.tasks?.find(t => t.id === taskId);
  if (userTask) {
    return { ...userTask, taskType: 'user' };
  }

  // Search CoS internal tasks
  const cosTask = cosTasks.tasks?.find(t => t.id === taskId);
  if (cosTask) {
    return { ...cosTask, taskType: 'internal' };
  }

  return null;
}

/**
 * Add a new task to the user or internal queue.
 *
 * Emits `tasks:changed` with `action: 'added'` on success; cos.js's init
 * listener turns that into a `tryImmediateSpawn` for user tasks so a newly
 * submitted task starts instantly instead of waiting for the next evaluation
 * interval.
 */
export async function addTask(taskData, taskType = 'user', { raw = false, ignoreTaskId = null, now = Date.now() } = {}) {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = taskType === 'user'
    ? join(ROOT_DIR, state.config.userTasksFile)
    : join(ROOT_DIR, state.config.cosTasksFile);

  // Read existing tasks or start fresh
  let tasks = [];
  if (existsSync(filePath)) {
    tasks = await readTaskFile(filePath);
  }

  // Reject duplicate: same first-line description AND same target app already
  // pending, in_progress, or blocked. The `metadata.app` scope matters — the same
  // description against two different apps is two different pieces of work
  // (e.g. "fix the failing test" in PortOS vs in BookLoom), and collapsing
  // them silently drops the second dispatch.
  //
  // `ignoreTaskId` excludes one specific task from the dedup scan. The perpetual
  // drain-on-completion refill needs this: `agent:completed` fires from
  // completeAgent BEFORE the completion flow's updateTask marks the just-finished
  // task done, so that task is still `in_progress` on disk here. A perpetual
  // schedule (claim-issue/claim-work) regenerates an identical first-line for the
  // same app, so without excluding the completing task the refill is rejected as a
  // duplicate of it and the back-to-back drain stalls until the next scheduler
  // tick. The completing task is about to become `completed`, so ignoring it is
  // correct, not a dedup hole.
  const normalizedDesc = firstLine(taskData.description).toLowerCase();
  // The candidate's app can arrive two ways: non-raw tasks pass it top-level as
  // `taskData.app` (used below to build `metadata.app`); raw tasks — the queue-path
  // improvement tasks and on-demand generated tasks — arrive pre-built with the app
  // already in `metadata.app` and NO top-level `app`. Read both, or the app-scoped
  // dedup silently no-ops for raw managed-app tasks: `targetApp` would be `null` and
  // never equal the existing task's `metadata.app`, so two concurrent
  // `queueEligibleImprovementTasks` snapshots (the periodic evaluation + the
  // improvement-check timer firing close together) each add an identical
  // `[Improvement: PortOS] …` task, producing the overlapping duplicate runs.
  const targetApp = taskData.app ?? taskData.metadata?.app ?? null;
  // Blocked tasks count as duplicates too (#2614): a task blocked by repeated
  // failures (max-retries, max-spawns, provider-config, …) still occupies its
  // slot — the retry path is unblocking the existing task, not minting a new
  // identical one. Before this, a persistently-failing scheduled type piled up
  // one blocked duplicate per cadence tick, forever (nothing reaps blocked
  // tasks automatically).
  const duplicate = tasks.find(t =>
    t.id !== ignoreTaskId &&
    (t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked') &&
    firstLine(t.description).toLowerCase() === normalizedDesc &&
    (t.metadata?.app || null) === targetApp
  );
  if (duplicate) {
    console.log(`⚠️ Duplicate task rejected: "${normalizedDesc.substring(0, 60)}" matches ${duplicate.id}${duplicate.status === 'blocked' ? ` (blocked: ${duplicate.metadata?.blockedCategory || 'unknown'})` : ''}`);
    return { ...duplicate, duplicate: true };
  }

  // When raw=true, use the pre-built task object directly (for on-demand/generated tasks)
  let newTask;
  if (raw) {
    newTask = taskData;
  } else {
    // Generate a unique ID if not provided
    const id = taskData.id || `${taskType === 'user' ? 'task' : 'sys'}-${Date.now().toString(36)}`;

    // Build metadata object
    const metadata = {};
    if (taskData.context) metadata.context = taskData.context;
    if (taskData.model) metadata.model = taskData.model;
    if (taskData.provider) metadata.provider = taskData.provider;
    if (taskData.effort) metadata.effort = taskData.effort;
    if (taskData.app) metadata.app = taskData.app;
    // Tags a task dispatched by the voice code-agent tool so the proactive
    // speech layer can announce its completion (see voice/proactiveTriggers.js).
    if (taskData.voiceDispatch === true) metadata.voiceDispatch = true;
    if (taskData.isRecovery === true) metadata.isRecovery = true;
    // Series Autopilot gap tasks (seriesAutopilot/session.js `fileGap`) carry the
    // series they were filed for so a later run can retire the ones it has moved
    // past. Without this the only handle is the description prefix, which is
    // stable by construction but a fragile thing to key a status flip on.
    if (taskData.autopilotGapSeriesId) metadata.autopilotGapSeriesId = taskData.autopilotGapSeriesId;
    if (taskData.autopilotGapKind) metadata.autopilotGapKind = taskData.autopilotGapKind;
    // Investigation-task guards (#2615): the durable fingerprint dedupes repeat
    // failures of the same cause; the marker blocks investigations-of-investigations;
    // affectedTasks names every task blocked on the cause (later dedup hits union in).
    if (taskData.isInvestigation === true) metadata.isInvestigation = true;
    if (taskData.investigationFingerprint) metadata.investigationFingerprint = taskData.investigationFingerprint;
    // Why an approval-required task is waiting on the user, as a namespaced token
    // (e.g. `investigation-loop:repeat-fingerprint`). Producer-agnostic on purpose
    // — any producer that holds a task can write it and the UI explains the hold
    // without a per-producer key. Absent on auto-approved tasks.
    if (taskData.approvalReason) metadata.approvalReason = taskData.approvalReason;
    if (Array.isArray(taskData.affectedTasks) && taskData.affectedTasks.length > 0) metadata.affectedTasks = taskData.affectedTasks;
    if (taskData.createJiraTicket) metadata.createJiraTicket = true;
    // Boolean flags: persist both true and false so users can explicitly override defaults.
    // The string round-trip ('false' from TASKS.md) is handled by isTruthyMeta/isFalsyMeta.
    // undefined means "use app defaults".
    if (taskData.useWorktree === true) metadata.useWorktree = true;
    else if (taskData.useWorktree === false) metadata.useWorktree = false;
    if (taskData.openPR === true) metadata.openPR = true;
    else if (taskData.openPR === false) metadata.openPR = false;
    // Default a worktree-isolated USER task to opening a PR rather than
    // auto-merging straight to the default branch — an unreviewed agent commit
    // landing on main is the more dangerous default (see the local-model eval
    // that auto-merged). Fires only when openPR wasn't explicitly set AND a
    // worktree was explicitly requested; an explicit `openPR: false` above
    // always wins, and internal/system tasks (autopilot, self-improvement) keep
    // their existing auto-merge behavior so automation isn't silently gated on a
    // human merging a PR.
    else if (taskData.useWorktree === true && taskType === 'user') metadata.openPR = true;
    if (PR_COMPLETION_VALUES.includes(taskData.prCompletion)) {
      metadata.prCompletion = taskData.prCompletion;
    } else if (metadata.openPR === true && taskType === 'user') {
      // New user tasks should persist their explicit default; legacy records
      // remain untouched and resolve from reviewLoop at read time.
      metadata.prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE;
    }
    if (taskData.simplify === true) metadata.simplify = true;
    else if (taskData.simplify === false) metadata.simplify = false;
    // Throwaway-worktree posture. Only the raw path could set this before, so a
    // non-raw caller that wanted "reason/report, never land code" had no way to
    // ask for it and silently got the auto-merge default instead. `false` is not
    // persisted — absent already means "normal posture", and writing it would
    // stamp the key onto every task that never opted in.
    if (taskData.discardWorktree === true) metadata.discardWorktree = true;
    // Whether a clean tree at the end is success (issue-filing, reasoning) or a
    // failure (code work). Both booleans are meaningful, so persist either.
    if (taskData.worktreeChangesExpected === true) metadata.worktreeChangesExpected = true;
    else if (taskData.worktreeChangesExpected === false) metadata.worktreeChangesExpected = false;
    // Deliverable is an API call or CLI action performed DURING the run, not a
    // commit and not the sentinel. Previously only the raw path could set it
    // (creativeDirector/agentBridge.js builds its task object by hand).
    if (taskData.noCodeOutput === true) metadata.noCodeOutput = true;
    if (taskData.reviewLoop === true) metadata.reviewLoop = true;
    else if (taskData.reviewLoop === false) metadata.reviewLoop = false;
    // Ordered multi-reviewer list (normalizes legacy single `reviewer` too).
    if (Array.isArray(taskData.reviewers) || (typeof taskData.reviewer === 'string' && taskData.reviewer)) {
      metadata.reviewers = normalizeReviewers(taskData);
    }
    // Arbitrary GitHub reviewer usernames (gate-only PR reviewers). Persist the
    // normalized list when present, or an explicit empty array so a per-task
    // "no username reviewers" choice overrides the Code Review Defaults instead
    // of silently inheriting them.
    if (Array.isArray(taskData.usernames)) {
      metadata.usernames = normalizeReviewUsernames(taskData.usernames);
    }
    // Non-blocking (`~opt`) reviewer set. Same explicit-empty semantics as
    // `usernames`: an empty array is a real "none optional for this task" choice
    // that must override the Code Review Defaults. Previously validated by
    // createCosTaskSchema but never persisted here, so the task form's `~opt`
    // badges silently fell back to the defaults on every task.
    if (Array.isArray(taskData.optionalReviewers)) {
      metadata.optionalReviewers = normalizeOptionalReviewers(taskData.optionalReviewers) || [];
    }
    // The token-keyed per-reviewer pins (caps / model / effort), keyed by the
    // emitted `--review-with` token. An explicitly empty MAP is a real "use each
    // reviewer's own default for this task" choice that overrides the Code Review
    // Defaults; unvalidatable entries are dropped rather than coerced. Iterates
    // the shared table so this persist path can't drift from
    // `sanitizeTaskMetadata`'s — see KEYED_REVIEWER_PINS.
    for (const [key, normalizeMap] of KEYED_REVIEWER_PINS) {
      if (!isPlainObject(taskData[key])) continue;
      metadata[key] = normalizeMap(taskData[key]) || {};
    }
    if (REVIEW_STOP_MODES.includes(taskData.reviewStopMode)) metadata.reviewStopMode = taskData.reviewStopMode;
    if (taskData.reviewerApplies === true) metadata.reviewerApplies = true;
    else if (taskData.reviewerApplies === false) metadata.reviewerApplies = false;
    // Bundled slashdo workflow this task runs (#3089), as the BARE command name
    // — the prompt builder renders the invocation shape once the provider is
    // known (see server/lib/slashdoInvocation.js).
    if (taskData.slashdoCommand) metadata.slashdoCommand = taskData.slashdoCommand;
    if (taskData.slashdoArgs) metadata.slashdoArgs = taskData.slashdoArgs;
    if (taskData.malwareScan && typeof taskData.malwareScan === 'object' && !Array.isArray(taskData.malwareScan)) {
      metadata.malwareScan = taskData.malwareScan;
    }
    // Brain link a `repo-study` run was queued from, so the completed task can be
    // traced back to the captured repo it studied.
    if (isPlainObject(taskData.repoStudy)) metadata.repoStudy = taskData.repoStudy;
    // Which tracker the prompt told the agent to file into (PLAN.md / GitHub /
    // GitLab / JIRA), mirroring the raw reference-watch dispatch in
    // referenceRepos.js#triggerReferenceAnalysis. Beyond traceability this is
    // what marks a ONE-OFF tracker-filing run as such, so it reaches the
    // no-commit gate without having to masquerade as a scheduled task type —
    // see taskTypeHooks.js#isTrackerFilingDispatch.
    if (taskData.workTracker) metadata.workTracker = taskData.workTracker;
    if (taskData.jiraTicketId) metadata.jiraTicketId = taskData.jiraTicketId;
    if (taskData.jiraTicketUrl) metadata.jiraTicketUrl = taskData.jiraTicketUrl;
    if (taskData.screenshots?.length > 0) metadata.screenshots = taskData.screenshots;
    if (taskData.attachments?.length > 0) metadata.attachments = taskData.attachments;
    // Structured auto-fix diagnostics (#2328): the fallback classifier builds a
    // { triggerEvent, target, errorType, category, tier, fixStrategy, failureReason }
    // record for every error-driven task, but until now addTask only ever embedded
    // it into the free-text context string and the log line — the structured object
    // was silently dropped. Persist it as first-class metadata so downstream
    // telemetry can aggregate auto-fix outcomes by tier / category / failure reason.
    // It round-trips through the markdown store via the JSON sentinel (see
    // taskParser.js escapeNewlines). A non-object / array (defensive) is ignored.
    if (taskData.diagnostics && typeof taskData.diagnostics === 'object' && !Array.isArray(taskData.diagnostics)) {
      metadata.diagnostics = taskData.diagnostics;
    }
    // Layered-Intelligence hand-off provenance (#2765): the proposal's identity +
    // domain, carried from buildHandoffTask so recordTaskCompletion can attribute this
    // agent run's success/failure back to the proposal's DOMAIN (per-proposal execution
    // record). A non-object / array (defensive) is ignored. Round-trips through the
    // markdown store via the same JSON sentinel as `diagnostics` above.
    if (taskData.liProposal && typeof taskData.liProposal === 'object' && !Array.isArray(taskData.liProposal)) {
      metadata.liProposal = taskData.liProposal;
    }
    // Which provider family's window this burn task is spending. Read by
    // `isCooldownExemptTask` (cosTaskGenerator.js, which owns the why) and by
    // quotaBurnRunner's completion continuation.
    if (taskData.quotaBurnFamily) metadata.quotaBurnFamily = taskData.quotaBurnFamily;
    // The reset of the SHORT rolling window that will refuse first, so a run the
    // provider refuses can block that family until the window rolls rather than
    // letting the continuation re-dispatch into the same wall (the weekly card
    // it gates on still reads healthy). See quotaBurnDenials.js.
    if (Number.isFinite(taskData.quotaBurnLimitingResetAt)) {
      metadata.quotaBurnLimitingResetAt = taskData.quotaBurnLimitingResetAt;
    }
    // Content-edit timestamp for cross-peer newest-edit-wins LWW (#1714). Stamped
    // at creation so a freshly-added task always carries a stamp; the merge treats
    // an absent stamp as oldest, so this also keeps a stamped task from losing a
    // same-status tie to a legacy peer's un-stamped copy. `now` is injectable so
    // the markdown output stays deterministic under test. Raw tasks (pre-built by
    // the caller) keep whatever stamp they arrive with.
    metadata.updatedAt = new Date(now).toISOString();

    // Create the new task
    newTask = {
      id: hasKnownPrefix(id) ? id : `${taskType === 'user' ? 'task' : 'sys'}-${id}`,
      status: 'pending',
      priority: (taskData.priority || 'MEDIUM').toUpperCase(),
      priorityValue: PRIORITY_VALUES[taskData.priority?.toUpperCase()] || 2,
      description: taskData.description,
      metadata,
      approvalRequired: taskType === 'internal' && taskData.approvalRequired,
      autoApproved: taskType === 'internal' && !taskData.approvalRequired,
      section: 'pending'
    };
  }

  // Add task to top or bottom based on position parameter
  if (taskData.position === 'top') {
    tasks.unshift(newTask);
  } else {
    tasks.push(newTask);
  }

  // Write back to file
  const includeApprovalFlags = taskType === 'internal';
  const markdown = generateTasksMarkdown(tasks, includeApprovalFlags);
  await writeTaskFile(filePath, markdown);

  // cos.js init listens for this event. For user tasks it fires
  // tryImmediateSpawn so the task starts instantly if slots are available,
  // bypassing the evaluation interval (which is meant for system task generation).
  cosEvents.emit('tasks:changed', { type: taskType, action: 'added', task: newTask });

  return newTask;
  });
}

/**
 * Update an existing task.
 *
 * Wraps the persisted write with the rest of the pause release (#3730). Dropping
 * `PAUSE_METADATA_KEYS` on the blocked transition (below) stops a revived task from
 * advertising a pause it no longer has, but a pause is not only bookkeeping: the run
 * that paused left a branch — usually a whole worktree — behind, and the resumed run
 * has to be POINTED at it or it starts clean and redoes that work. Resolving that
 * pointer lived in `resumeAgent`, so the Resume dialog resumed properly while every
 * other door into `blocked(agent-paused) → pending` (the Tasks-tab status toggle's
 * bare `{ status: 'pending' }`, and `reviveBlockedTask` on behalf of on-demand Run /
 * pipeline advance / Creative Director / manual job trigger / voice dispatch) still
 * spawned a second agent on a clean workspace. Owning it at the transition fixes
 * them all, and future callers by construction.
 *
 * The resolve runs BEFORE the lock and the retire AFTER it. Both reach the agent
 * layer through the registered adapter, and `retirePausedAgent` writes agent state
 * via `completeAgent` — which takes the same non-reentrant `withStateLock`, so
 * running either inside would deadlock. Resolving first is also what keeps the task
 * from ever being `pending` (spawnable) without its pointer.
 */
export async function updateTask(taskId, updates, taskType = 'user', { now = Date.now() } = {}) {
  const release = await preparePauseRelease(taskId, updates);
  const result = await writeTaskUpdate(taskId, release ? { ...updates, metadata: release.metadata } : updates, taskType, { now });
  if (release && !result?.error) {
    await retirePausedAgent(release.agentId, taskId, result?.metadata?.existingBranch || null);
  }
  return result;
}

/**
 * Is this update releasing a user pause, and if so what does the resumed run need?
 *
 * `null` for every other update — including a paused task moving to any status but
 * `pending` (terminating a paused task is not a resume; nothing to point at, and the
 * record's retirement belongs to whatever terminated it), and a pending flip on a
 * task nobody paused. `pausedAgentId` is required: without it there is no record to
 * resolve a pointer from or retire, so the flip is an ordinary unblock.
 */
async function preparePauseRelease(taskId, updates) {
  if (updates?.status !== 'pending') return null;
  const task = await getTaskById(taskId).catch(() => null);
  if (!isAgentPausedTask(task)) return null;
  const agentId = task.metadata?.pausedAgentId;
  if (!agentId) return null;

  // Fails open to "start clean" the way every other resume-pointer caller does:
  // un-blocking the task matters more than resuming it in place, and the worktree
  // stays on disk for a human either way.
  const pointer = await resolvePausedTaskResume(task).catch(err => {
    console.error(`❌ Resume pointer for task ${taskId} could not be resolved: ${err.message}`);
    return {};
  });
  // The caller's own metadata still wins — the Resume dialog's provider/model/context
  // overrides, and a caller that resolved a pointer itself.
  return { agentId, metadata: { ...pointer, ...(updates.metadata || {}) } };
}

async function writeTaskUpdate(taskId, updates, taskType, { now }) {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = taskType === 'user'
    ? join(ROOT_DIR, state.config.userTasksFile)
    : join(ROOT_DIR, state.config.cosTasksFile);

  if (!existsSync(filePath)) {
    console.log(`⚠️ updateTask: file not found for ${taskId} (taskType=${taskType}, path=${filePath})`);
    return { error: 'Task file not found' };
  }

  let tasks = await readTaskFile(filePath);

  const taskIndex = tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
    console.log(`⚠️ updateTask: task ${taskId} not found in ${filePath} (taskType=${taskType}, parsed ${tasks.length} tasks, status update: ${updates.status || 'none'})`);
    return { error: 'Task not found' };
  }

  // Build updated metadata - merge existing with any new metadata
  const updatedMetadata = {
    ...tasks[taskIndex].metadata,
    ...(updates.metadata || {})
  };
  // Handle legacy fields that may be passed directly in updates. Use ?? not ||
  // so an intentional clear to "" is preserved as "" rather than dropped: || maps
  // every falsy value (incl. "") to undefined, which the cleanup pass below then
  // deletes, conflating "cleared" with "absent" (absent-vs-cleared, CLAUDE.md).
  // Only null becomes undefined (→ deleted); absent fields never enter this loop.
  for (const f of LEGACY_DIRECT_FIELDS) {
    if (updates[f] !== undefined) updatedMetadata[f] = updates[f] ?? undefined;
  }

  // Clear blocked/failure metadata when transitioning out of blocked status.
  //
  // The PAUSE keys go with them (`PAUSE_METADATA_KEYS`, lib/taskPauseHold.js).
  // `resumeAgent` is not the only way a paused task runs again — a dedupe revive, an
  // autopilot re-dispatch, an orphan-cooldown expiry, or a human unblocking it from
  // the task list all flip it back to `pending` through here. Clearing only in
  // `resumeAgent` left every one of those paths running a task that still advertised
  // a live pause: the UI kept showing it parked, and `resumeAgent` on the still-paused
  // agent record then read its own pause as spent and spawned a SECOND agent on a
  // fresh task. The clear belongs at the transition, not at one caller.
  if (updates.status && updates.status !== 'blocked' && tasks[taskIndex].status === 'blocked') {
    for (const key of ['blocker', 'blockedReason', 'blockedCategory', 'blockedAt', 'failureCount', 'lastErrorCategory', 'lastFailureAt', ...PAUSE_METADATA_KEYS]) {
      delete updatedMetadata[key];
    }
  }

  // Drop the resume pointer once the task reaches a terminal state. `existingBranch`
  // + `resumeWorktreePath` + `resumedFromAgentId` are stamped by
  // `resolveTaskResumePatch` so a FAILED or ORPHANED task's retry picks up the
  // branch (and worktree) its dead agent left behind and resumes instead of
  // restarting. Once the task is done (or blocked for a human), that pointer is
  // spent: a PERPETUAL task type re-queues the same task id for unrelated future
  // work, and a stale `existingBranch` would silently attach that fresh run to a
  // long-merged branch. Only cleared on terminal statuses — a `pending` retry is
  // exactly who needs the pointer intact.
  //
  // PAUSE-shaped blocks are the exception (`PAUSED_BLOCKED_CATEGORIES`): the task
  // is waiting on something outside itself and is expected to run again, so its
  // pointer is not spent. `orphan-cooldown` is a TIMED pause —
  // `unblockExpiredCooldowns` (cosTaskGenerator.js) flips it back to
  // `pending` once `cooldownUntil` passes. The workspace blocks are a CONFIG pause:
  // the app's Repository Path is missing/unreachable, and the user fixes it and
  // revives the task. Stripping the pointer in either case means the revived task
  // starts clean and abandons the worktree its dead agent left behind — which is
  // exactly the recovery this mechanism exists for.
  if (isTerminalTaskStatus(updates.status) && !PAUSED_BLOCKED_CATEGORIES.has(updatedMetadata.blockedCategory)) {
    // ...but only the RESUME mechanism's `existingBranch`, which is keyed by the
    // `resumedFromAgentId` it is always written with — the same discriminator
    // `resumePointerMetadata` (agentWorktreeCleanup.js) uses to avoid clearing a
    // pointer it didn't write. A review-loop / merge follow-up sets
    // `existingBranch` as its own CONFIGURATION: it exists to land the PR on that
    // branch. Stripping that copy meant re-running a blocked merge follow-up got
    // a worktree cut fresh off the default branch — the merge still targets the
    // right PR by url, but any fix-and-push lands on a branch the PR has never
    // heard of. Keyed on the mechanism rather than on the task kind so the next
    // producer of a self-configured `existingBranch` doesn't re-hit this.
    if (updatedMetadata.resumedFromAgentId) delete updatedMetadata.existingBranch;
    delete updatedMetadata.resumedFromAgentId;
    delete updatedMetadata.resumeWorktreePath;
  }

  // A retry hold (#3373) only means anything while the task is `in_progress`
  // waiting on a cleanup to resolve its resume pointer. Any other status the task
  // reaches — terminal, or a requeue that some other path performed — retires it,
  // so drop the marker rather than leave a stale one for a late cleanup (or the
  // orphan sweep) to act on. The release's own write passes these as undefined,
  // which lands in the same place.
  if (updates.status && updates.status !== 'in_progress') {
    delete updatedMetadata[RETRY_HOLD_KEY];
    delete updatedMetadata[RETRY_HOLD_SINCE_KEY];
  }

  // Release the federation claim/lease when a task leaves `in_progress` (issue
  // #1563). A claim only protects in-flight work; once the task completes, fails
  // back to pending, or is blocked, it must become freely claimable by either
  // peer — leaving a stale lease behind would block a legitimate retry (by this
  // instance or its peer) for a full lease window. The spawn's own
  // in_progress update carries `status: 'in_progress'` and is exempt, and a
  // lease-renewal heartbeat passes no `status` at all, so neither is stripped.
  if (updates.status && updates.status !== 'in_progress') {
    for (const key of CLAIM_METADATA_KEYS) {
      delete updatedMetadata[key];
    }
  }

  // Stamp the moment a RUNNING task is requeued (#3376). `in_progress → pending`
  // is the one backward transition in the lifecycle (the orphan sweep and the
  // retry-hold release both perform it), and the federated merge has to be able to
  // tell that requeue apart from an ordinary content edit that merely happens to
  // land on a peer's stale `pending` copy — the first must beat a stale
  // `in_progress` snapshot, the second must NOT revert a genuinely running task.
  // `updatedAt` alone can't distinguish them; this stamp, compared against the
  // other side's `lastSpawnedAt`, says the requeue came AFTER that spawn. Only the
  // real transition sets it, so a later edit carries it forward untouched, and the
  // next spawn clears it below.
  if (updates.status === 'pending' && tasks[taskIndex].status === 'in_progress') {
    updatedMetadata[REQUEUED_AT_KEY] = new Date(now).toISOString();
  }
  // A fresh spawn retires the marker — from here on THIS run's `lastSpawnedAt` is
  // what a future requeue must beat, and a leftover stamp from the previous cycle
  // would let a peer's pre-spawn `pending` copy win on a stale requeue.
  if (updates.status === 'in_progress') delete updatedMetadata[REQUEUED_AT_KEY];

  // Bump the content-edit stamp (#1714) on a genuine content change so the peer's
  // claim-aware merge can resolve a same-status edit by newest-edit-wins. Compared
  // against the task's CURRENT metadata so a lease-renewal heartbeat that re-includes
  // unchanged metadata doesn't read as an edit (see isContentEdit). `now` is
  // injectable for deterministic test output.
  if (isContentEdit(updates, tasks[taskIndex].metadata)) {
    updatedMetadata.updatedAt = new Date(now).toISOString();
  }

  // Clean undefined values from metadata
  Object.keys(updatedMetadata).forEach(key => {
    if (updatedMetadata[key] === undefined) delete updatedMetadata[key];
  });

  // Update the task
  const updatedTask = {
    ...tasks[taskIndex],
    ...(updates.description && { description: updates.description }),
    ...(updates.priority && {
      priority: updates.priority.toUpperCase(),
      priorityValue: PRIORITY_VALUES[updates.priority.toUpperCase()] || 2
    }),
    ...(updates.status && { status: updates.status }),
    metadata: updatedMetadata
  };

  const previousStatus = tasks[taskIndex].status;
  tasks[taskIndex] = updatedTask;

  // Write back to file
  const includeApprovalFlags = taskType === 'internal';
  const markdown = generateTasksMarkdown(tasks, includeApprovalFlags);
  await writeTaskFile(filePath, markdown);

  // A blocked → pending flip is a revive: the task is newly spawnable, exactly
  // like an approval. Emit a distinct action so cos.init's listener re-runs the
  // dequeue (#2614) — the generic 'updated' action doesn't wake the scheduler,
  // which left revived tasks stranded until an unrelated event or timer fired.
  //
  // An in_progress → pending flip is a requeue and needs the same wake (#3373):
  // a failed run's retry is released from its hold by exactly this transition,
  // and by then the `agent:completed` dequeue has long since run — without a
  // signal the retry would idle until the next timer. Same for the orphan sweep's
  // requeue, which previously depended on its caller remembering to evaluate.
  const action = updatedTask.status === 'pending' && previousStatus === 'blocked'
    ? 'unblocked'
    : (updatedTask.status === 'pending' && previousStatus === 'in_progress' ? 'requeued' : 'updated');
  // `previousStatus` rides along so consumers can key on the TRANSITION rather
  // than re-deriving one from the level. `updateTask` on an already-terminal task
  // re-emits `updated` with the same status — an edit to a completed task's
  // description is enough — so a consumer that reacts to "reached completed"
  // (the investigation auto-retry; the voice completion line) needs the edge, not
  // `status === 'completed'`, which is true on every later write too.
  cosEvents.emit('tasks:changed', { type: taskType, action, task: updatedTask, previousStatus });
  return updatedTask;
  });
}

/**
 * Explicitly revive a blocked task back to pending (#2614).
 *
 * The retry path for a failure-blocked duplicate is unblocking the existing
 * task, not minting a new one — every explicit dispatch path (on-demand Run,
 * pipeline advance, Creative Director re-trigger, manual job trigger, voice
 * dispatch) that collides with a blocked twin routes through here. On top of
 * updateTask's blocked-transition clear (blocker/blockedReason/blockedCategory/
 * blockedAt/failureCount/lastErrorCategory/lastFailureAt), this also resets the
 * spawn/orphan retry budgets — a revived task must behave like a fresh one, not
 * immediately re-block on the exhausted budget it blocked with. The reset keys
 * are spread AFTER the caller's fresh metadata so a carried-forward budget
 * (e.g. a pipeline hand-off spreading the prior stage's metadata) can't win.
 * updateTask emits `tasks:changed` action 'unblocked', which re-runs the
 * dequeue, so callers don't need a separate wake signal.
 */
export async function reviveBlockedTask(taskId, { priority, metadata } = {}, taskType = 'internal') {
  return updateTask(taskId, {
    status: 'pending',
    ...(priority ? { priority } : {}),
    metadata: {
      ...(metadata || {}),
      totalSpawnCount: undefined,
      orphanRetryCount: undefined,
      lastOrphanedAt: undefined,
      // Same reasoning: the branch-busy patience budget is spent by the time a
      // follow-up hard-blocks, so a revived one would hard-block again on the
      // first busy race instead of waiting the other worktree out. NOT cleared on
      // the cooldown revive (updateTask's blocked→pending path) — that runs on
      // every wait and would defeat the cap.
      worktreeBusyAttempts: undefined
    }
  }, taskType);
}

/**
 * Merge a full-sync peer's task list into one local task file (#1712).
 *
 * The receiver side of CoS task federation: `syncCosTasksFromPeer` fetches the
 * peer's live backlog and hands the tasks for ONE file (user vs internal) here.
 * The read-merge-write runs under `withStateLock` so it serializes against the
 * spawn path's claim writes (agentLifecycle → updateTask, also lock-held) — the
 * merge always sees, and merges against, the freshest persisted claim metadata.
 *
 * Idempotent + write-skipping: the claim-aware merge (cosTaskMerge) is pure and
 * deterministic, so we compare the GENERATED markdown before/after (not the raw
 * file bytes — pre-existing formatting drift shouldn't force a write) and only
 * persist + emit `tasks:changed` when the merge actually changed something.
 *
 * @param {'user'|'internal'} taskType  which file to merge into
 * @param {Array} remoteTasks           peer tasks for this file (wire-validated)
 * @param {{ now?: number }} [opts]     injectable clock for deterministic tests
 * @returns {Promise<{ changed: boolean, count?: number }>}
 */
export async function mergePeerTasks(taskType, remoteTasks, { now = Date.now() } = {}) {
  const { changed, count, merged } = await withStateLock(async () => {
    const state = await loadState();
    const filePath = taskType === 'user'
      ? join(ROOT_DIR, state.config.userTasksFile)
      : join(ROOT_DIR, state.config.cosTasksFile);

    const localTasks = existsSync(filePath)
      ? await readTaskFile(filePath)
      : [];

    const merged = mergeTaskLists(localTasks, remoteTasks, { now });

    const includeApprovalFlags = taskType === 'internal';
    const localMarkdown = generateTasksMarkdown(localTasks, includeApprovalFlags);
    const mergedMarkdown = generateTasksMarkdown(merged, includeApprovalFlags);
    // Nothing the peer sent changed our state — skip the write (and the event that would
    // wake the scheduler). `merged` is still returned so the post-lock LI-verdict consume
    // (#2779) can run even on a no-op sweep — durability requires it (an old peer that
    // stored a terminal verdict before upgrading, or a crash before a prior consume, leaves
    // the task terminal with the merge producing no change, so a changed-only consume would
    // never catch up). Re-offering is cheap: the consumer is a durable no-op after the first.
    if (mergedMarkdown === localMarkdown) return { changed: false, merged };

    await writeTaskFile(filePath, mergedMarkdown);
    cosEvents.emit('tasks:changed', { type: taskType, action: 'peer-merged' });
    return { changed: true, count: merged.length, merged };
  });

  // Post-lock, best-effort: derive recordProposalExecution from every terminal hand-off task
  // carrying an LI execution verdict (#2779) — a task filed here but executed on a peer, whose
  // terminal state (with the stamped LI_EXECUTION_VERDICT_KEY) has synced back. Runs on EVERY
  // sweep (changed or not); idempotency + retry-correctness are durable and record-level in the
  // consumer (skips a verdict no newer than the stored execution), so re-offering the same
  // verdict is a no-op while a genuinely re-executed hand-off overwrites. `requireExisting`
  // there scopes the write to a proposal THIS peer filed, so a non-originating peer is a no-op.
  // Kept out of the lock — recordProposalExecution touches a different store (li-outcomes) — and
  // the LI import graph stays off cosTaskStore's static chain (lazy import).
  const { LI_EXECUTION_VERDICT_KEY, recordProposalExecutionFromVerdict } = await import('./layeredIntelligenceOutcomes.js');
  for (const task of merged || []) {
    if (!isTerminalTaskStatus(task?.status)) continue;
    const verdict = task?.metadata?.[LI_EXECUTION_VERDICT_KEY];
    if (!verdict) continue;
    await recordProposalExecutionFromVerdict(verdict)
      .catch(err => console.error(`❌ 📚 cosTaskStore: failed to consume LI execution verdict: ${err.message}`));
  }

  return changed ? { changed, count } : { changed: false };
}

/**
 * Delete a task
 */
export async function deleteTask(taskId, taskType = 'user') {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = taskType === 'user'
    ? join(ROOT_DIR, state.config.userTasksFile)
    : join(ROOT_DIR, state.config.cosTasksFile);

  if (!existsSync(filePath)) {
    return { error: 'Task file not found' };
  }

  let tasks = await readTaskFile(filePath);

  const taskToDelete = tasks.find(t => t.id === taskId);
  if (!taskToDelete) {
    return { error: 'Task not found' };
  }

  tasks = tasks.filter(t => t.id !== taskId);

  // Write back to file
  const includeApprovalFlags = taskType === 'internal';
  const markdown = generateTasksMarkdown(tasks, includeApprovalFlags);
  await writeTaskFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: taskType, action: 'deleted', taskId });
  return { success: true, taskId };
  });
}

// ── Stale failure-artifact reaper (issue #2619) ──────────────────────────────
//
// After a failure storm is fixed, nothing retired what it left behind: tasks
// parked in `blocked` by a failure category, and the `[Auto] Investigate agent
// failure` tasks filed against them. They persisted indefinitely and stayed
// input to every generator/learning read. The sweep below runs on the CoS
// health tick and resolves them via STATUS FLIP (→ completed + a `resolution:
// 'auto-expired'` marker), NEVER deletion: LWW federation sync does not
// propagate deletions, so a delete just resurrects from any peer still holding
// the row.

// Default age a failure-blocked task must exceed before it is auto-expired.
export const DEFAULT_FAILURE_TASK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Max tasks the reaper flips in a single sweep — bounded so one tick can't fan
// out an unbounded burst of writes/`tasks:changed` events after a large storm.
export const DEFAULT_REAP_LIMIT = 50;

// Blocks that encode USER INTENT or an OPEN user decision are the reaper's
// exemption (`USER_DECISION_BLOCKED_CATEGORIES`, lib/taskBlockCategories.js).
// Everything else with a `blockedCategory` is a failure-path block and therefore
// reapable — including `orphan-cooldown`, which revives itself in ~30 minutes, so
// one still sitting there after 14 days IS stale.

/**
 * Age (ms) of a failure-blocked task, read from the most specific timestamp it
 * carries. Returns null when the task is not a reapable failure block, or when
 * it has no parseable timestamp — an undated block is never reaped (we can't
 * prove it is old, so leaving it is the safe default). Pure.
 */
export function blockedFailureAgeMs(task, now = Date.now()) {
  if (task?.status !== 'blocked') return null;
  const category = task.metadata?.blockedCategory;
  if (!category || USER_DECISION_BLOCKED_CATEGORIES.has(category)) return null;
  const stampedAt = task.metadata?.blockedAt
    || task.metadata?.lastFailureAt
    || task.metadata?.updatedAt;
  const t = Date.parse(stampedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
}

/** True when a failure-blocked task is old enough to auto-expire. Pure. */
export function isReapableBlockedFailure(task, { now = Date.now(), maxAgeMs = DEFAULT_FAILURE_TASK_MAX_AGE_MS } = {}) {
  const age = blockedFailureAgeMs(task, now);
  return age !== null && age >= maxAgeMs;
}

/**
 * True when an investigation task's originating task(s) are all resolved —
 * absent (already reaped/deleted) or in a terminal `completed` status — so the
 * investigation no longer tracks any live failure. Requires a known originating
 * link (`metadata.affectedTasks`); a legacy investigation with no link is left
 * alone (we can't prove its cause is resolved). Pure.
 *
 * @param {object} task       the candidate investigation task
 * @param {Map}    tasksById  id → task across BOTH queues
 */
export function isReapableInvestigation(task, tasksById) {
  if (!isInvestigationTask(task)) return false;
  if (task.status === 'completed') return false; // already terminal
  const affected = Array.isArray(task.metadata?.affectedTasks) ? task.metadata.affectedTasks : [];
  if (affected.length === 0) return false;
  return affected.every((id) => {
    const origin = tasksById?.get(id);
    return !origin || origin.status === 'completed';
  });
}

/**
 * Sweep resolved failure artifacts and auto-expire them via status flip (#2619).
 *
 * Two categories, both resolved to `completed` with a `resolution: 'auto-expired'`
 * marker (never deleted — federation-safe): (1) tasks parked in `blocked` by a
 * failure `blockedCategory` older than `maxAgeMs`, and (2) `[Auto] Investigate
 * agent failure` tasks whose originating task(s) are gone/completed. Bounded to
 * `limit` flips per call and single-line-logged. Runs off the health tick.
 *
 * @param {{ now?:number, maxAgeMs?:number, limit?:number }} [opts]
 * @returns {Promise<{ reaped:number, staleBlocks:number, investigations:number }>}
 */
export async function sweepResolvedFailureTasks({
  now = Date.now(),
  maxAgeMs = DEFAULT_FAILURE_TASK_MAX_AGE_MS,
  limit = DEFAULT_REAP_LIMIT
} = {}) {
  const { user, cos } = await getAllTasks();
  const userTasks = user?.tasks || [];
  const cosTasks = cos?.tasks || [];
  const tasksById = new Map([...userTasks, ...cosTasks].map((t) => [t.id, t]));

  // Collect targets across both queues, tagging each with its file type so the
  // flip writes back to the right markdown store. Bounded by `limit`.
  const targets = [];
  for (const [type, list] of [['user', userTasks], ['internal', cosTasks]]) {
    for (const task of list) {
      const reason = isReapableBlockedFailure(task, { now, maxAgeMs })
        ? 'stale-failure-block'
        : (isReapableInvestigation(task, tasksById) ? 'investigation-resolved' : null);
      if (reason) targets.push({ task, type, reason });
      if (targets.length >= limit) break;
    }
    if (targets.length >= limit) break;
  }

  if (targets.length === 0) return { reaped: 0, staleBlocks: 0, investigations: 0 };

  let staleBlocks = 0;
  let investigations = 0;
  for (const { task, type, reason } of targets) {
    const updated = await updateTask(task.id, {
      status: 'completed',
      metadata: { resolution: 'auto-expired', autoExpiredReason: reason, autoExpiredAt: new Date(now).toISOString() }
    }, type, { now });
    if (updated?.error) continue;
    if (reason === 'stale-failure-block') staleBlocks++; else investigations++;
  }

  const reaped = staleBlocks + investigations;
  if (reaped > 0) {
    console.log(`🧹 Reaped ${reaped} resolved failure task(s): ${staleBlocks} stale block(s), ${investigations} investigation(s)`);
  }
  return { reaped, staleBlocks, investigations };
}

/**
 * Reorder user tasks based on an array of task IDs
 */
export async function reorderTasks(taskIds) {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = join(ROOT_DIR, state.config.userTasksFile);

  if (!existsSync(filePath)) {
    return { error: 'Task file not found' };
  }

  const tasks = await readTaskFile(filePath);

  // Create a map of tasks by ID for quick lookup. parseTasksMarkdown guarantees
  // unique ids (it suffixes any duplicate it encounters), so this Map can't
  // silently collapse colliding tasks and drop them on write-back.
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // Reorder based on the provided order
  const reorderedTasks = [];
  for (const id of taskIds) {
    const task = taskMap.get(id);
    if (task) {
      reorderedTasks.push(task);
      taskMap.delete(id);
    }
  }

  // Append any tasks not in the provided order (shouldn't happen, but safe)
  for (const task of taskMap.values()) {
    reorderedTasks.push(task);
  }

  // Write back to file
  const markdown = generateTasksMarkdown(reorderedTasks, false);
  await writeTaskFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: 'user', action: 'reordered' });
  return { success: true, order: reorderedTasks.map(t => t.id) };
  });
}

/**
 * Approve a task that requires approval (marks it as auto-approved).
 *
 * Emits `tasks:changed` with `action: 'approved'`; cos.js's init listener
 * fires `dequeueNextTask` off that so the newly approved task can spawn
 * immediately.
 */
export async function approveTask(taskId, { now = Date.now() } = {}) {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = join(ROOT_DIR, state.config.cosTasksFile);

  if (!existsSync(filePath)) {
    return { error: 'CoS task file not found' };
  }

  let tasks = await readTaskFile(filePath);

  const taskIndex = tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) {
    return { error: 'Task not found' };
  }

  if (!tasks[taskIndex].approvalRequired) {
    return { error: 'Task does not require approval' };
  }

  // Update approval flags. Approval is editable content (the merge's
  // contentSignature counts the approval flags), so bump the `updatedAt` LWW
  // stamp (#1714) too — otherwise an approval on one peer would lose a same-status
  // tie to a stale edit on the other instead of winning as the newest edit.
  tasks[taskIndex] = {
    ...tasks[taskIndex],
    approvalRequired: false,
    autoApproved: true,
    metadata: { ...tasks[taskIndex].metadata, updatedAt: new Date(now).toISOString() }
  };

  // Write back to file
  const markdown = generateTasksMarkdown(tasks, true);
  await writeTaskFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: 'internal', action: 'approved', task: tasks[taskIndex] });

  return tasks[taskIndex];
  });
}

/**
 * Record a sub-agent's challenge of a reviewer rejection (#2441).
 *
 * Parks the task in the `challenged` status with the worker's case attached and
 * consumes one of its bounded challenge slots (MAX_CHALLENGES_PER_TASK). A second
 * dispute on the same task is refused — the acceptance contract is "exactly one
 * per task." The read (getTaskById, lock-free) precedes the write (updateTask,
 * lock-held): single-user trust model, no competing writer to race.
 *
 * @returns the updated task, or `{ error, code }` on not-found / budget-exhausted.
 */
export async function challengeTask(taskId, { reason, evidence, reviewer } = {}, taskType = 'user', { now = Date.now() } = {}) {
  const task = await getTaskById(taskId);
  if (!task) return { error: 'Task not found', code: 'NOT_FOUND' };
  const resolvedType = task.taskType || taskType;
  // A challenge disputes a REJECTION of in-flight work — never a finished task.
  // Parking a `completed` task in `challenged` would also regress it out of a
  // terminal state (a completed task never re-completes), so refuse it outright.
  if (task.status === 'completed') {
    return { error: 'Cannot challenge a completed task', code: 'CANNOT_CHALLENGE_COMPLETED' };
  }
  // Bounded by BOTH the one-shot dispute cap AND the shared retry budget (#2471) —
  // a challenge that overturns re-queues the task, so refuse one that's already out
  // of total spawns (it would only get re-blocked by agentLifecycle's spawn gate).
  if (!canChallenge(task.metadata, { maxTotalSpawns: MAX_TOTAL_SPAWNS })) {
    const spawns = Number(task.metadata?.totalSpawnCount) || 0;
    const budgetExhausted = spawns >= MAX_TOTAL_SPAWNS;
    return {
      error: budgetExhausted
        ? `Retry budget exhausted (${spawns}/${MAX_TOTAL_SPAWNS} spawns) — cannot challenge a task out of retries`
        : `Challenge budget exhausted (${getChallengeCount(task.metadata)}/${MAX_CHALLENGES_PER_TASK} used)`,
      code: budgetExhausted ? 'CHALLENGE_BUDGET_EXHAUSTED' : 'CHALLENGE_EXHAUSTED',
    };
  }
  const patch = buildChallengePatch(task.metadata, { reason, evidence, reviewer, now });
  const updated = await updateTask(taskId, { status: 'challenged', metadata: patch }, resolvedType, { now });
  if (updated?.error) return updated;
  console.log(`⚖️ Task ${taskId} challenged (${patch.challengeCount}/${MAX_CHALLENGES_PER_TASK})${patch.challenge.reviewer ? ` — disputing ${patch.challenge.reviewer}` : ''}`);
  cosEvents.emit('task:challenged', { taskId, taskType: resolvedType, reviewer: patch.challenge.reviewer || null });
  return updated;
}

/**
 * Resolve a parked challenge (#2441). `upheld` overturns the rejection and
 * re-queues the task (→ pending); `escalated` hands the unresolved dispute to
 * the user — the task is blocked with a challenge-escalation reason AND an
 * approval-required arbitration task is filed into COS-TASKS.md (reusing the same
 * investigation/escalation surface `createInvestigationTask` writes to), so a
 * sustained disagreement surfaces to the user rather than silently fixing or
 * quietly blocking.
 *
 * @returns the updated task, or `{ error, code }` on not-found / not-challenged /
 *          invalid-outcome.
 */
export async function resolveTaskChallenge(taskId, { outcome, note, resolvedBy } = {}, taskType = 'user', { now = Date.now() } = {}) {
  const task = await getTaskById(taskId);
  if (!task) return { error: 'Task not found', code: 'NOT_FOUND' };
  if (task.status !== 'challenged') {
    return { error: 'Task is not under challenge', code: 'NOT_CHALLENGED' };
  }
  const resolvedType = task.taskType || taskType;
  const resolutionPatch = buildChallengeResolutionPatch({ outcome, note, resolvedBy, now });
  if (!resolutionPatch) return { error: `Invalid challenge outcome: ${outcome}`, code: 'INVALID_OUTCOME' };

  const nextStatus = outcome === 'upheld' ? 'pending' : 'blocked';
  const metadataPatch = { ...resolutionPatch };
  if (outcome === 'escalated') {
    metadataPatch.blockedReason = 'Challenge unresolved — escalated to user for arbitration';
    metadataPatch.blockedCategory = 'challenge-escalation';
  }
  const updated = await updateTask(taskId, { status: nextStatus, metadata: metadataPatch }, resolvedType, { now });
  if (updated?.error) return updated;

  if (outcome === 'escalated') {
    // Surface the dispute to the single PortOS user as an approval-required
    // arbitration task (mirrors createInvestigationTask's escalation surface).
    // Best-effort: a failed escalation-task write must not fail the resolution
    // itself (the original task is already blocked with the reason attached).
    const caseReason = task.metadata?.challenge?.reason || '(no reason recorded)';
    const disputedReviewer = task.metadata?.challenge?.reviewer;
    const escalationDescription = `[Challenge] Arbitrate disputed rejection on ${taskId}`;
    const escalationContext = [
      `A sub-agent challenged a reviewer rejection on task ${taskId} and the dispute is unresolved.`,
      disputedReviewer ? `Disputed reviewer: ${disputedReviewer}` : null,
      `Worker's case: ${caseReason}`,
      note ? `Resolver note: ${note}` : null,
      'Decide: approve to overturn the rejection, or delete to let the rejection stand.',
    ].filter(Boolean).join('\n');
    await addTask({
      description: escalationDescription,
      priority: 'HIGH',
      context: escalationContext,
      approvalRequired: true,
    }, 'internal', { now }).catch((err) => {
      console.error(`❌ Failed to file challenge-escalation task for ${taskId}: ${err.message}`);
    });
  }

  console.log(`⚖️ Task ${taskId} challenge resolved: ${outcome} → ${nextStatus}`);
  cosEvents.emit('task:challenge-resolved', { taskId, taskType: resolvedType, outcome });
  return updated;
}

/**
 * Resolve a parked challenge by AUTOMATIC reviewer re-check (#2471). Instead of a
 * human verdict, re-run the disputed (or a second) local-LLM reviewer against the
 * current diff and derive the outcome from its fresh findings — a blocking finding
 * that survives sustains the rejection (→ escalated); nothing blocking overturns it
 * (→ upheld). This is the cheap confirm/overturn pass that runs BEFORE falling back
 * to user escalation, closing the gap #2470 left ("this slice resolves manually").
 *
 * Only the in-process local reviewers (`lmstudio`/`ollama`) are re-run here; CLI
 * reviewers are re-run by the follow-up agent itself, which then calls the manual
 * `resolveTaskChallenge` path with an explicit outcome.
 *
 * @returns the updated task, or `{ error, code }` on not-found / not-challenged /
 *          RECHECK_FAILED (reviewer unreachable or no usable findings).
 */
export async function resolveTaskChallengeWithRecheck(taskId, { recheck, resolvedBy } = {}, taskType = 'user', { now = Date.now() } = {}) {
  const task = await getTaskById(taskId);
  if (!task) return { error: 'Task not found', code: 'NOT_FOUND' };
  if (task.status !== 'challenged') {
    return { error: 'Task is not under challenge', code: 'NOT_CHALLENGED' };
  }
  const backend = recheck?.backend;
  // Model: explicit override wins, else the Code Review Defaults for this backend.
  // Effort has no per-request override (a re-check re-runs the SAME reviewer
  // configuration, it doesn't reconfigure it), so it always comes from the
  // defaults — but it must come from somewhere: this verdict decides whether a
  // disputed rejection is upheld or escalated to the user, and deriving it from a
  // pass run at a weaker effort than the user configured is the same silent
  // downgrade the pin exists to prevent.
  // Read straight off the picked defaults: `pickCodeReviewDefaults` already ran
  // every `<reviewer>Effort` scalar through `reviewerEffortsFromDefaults`, so a
  // stale level is null by the time it reaches here — same as the model read below.
  const recheckDefaults = await getCodeReviewDefaults().catch(() => null);
  const effort = recheckDefaults?.[`${backend}Effort`] || null;
  let model = recheck?.model;
  if (!model) {
    model = backend === 'ollama' ? recheckDefaults?.ollamaModel : recheckDefaults?.lmstudioModel;
  }
  // A missing model is a config problem (no Code Review Defaults set), not an
  // upstream-reviewer failure — surface it as a 4xx (RECHECK_NO_MODEL → 400), not
  // the 502 bucket reserved for a reviewer that's actually unreachable.
  if (!model) {
    return { error: `No model configured for the ${backend} reviewer — set one on the AI Providers → Code Review Defaults panel.`, code: 'RECHECK_NO_MODEL' };
  }
  console.log(`⚖️ Re-checking challenge on ${taskId} via ${backend} (${model}${effort ? `, ${effort} effort` : ''})`);
  const review = await runLocalCodeReview({ backend, model, effort, diff: recheck?.diff });
  if (!review?.ok) {
    return { error: `Re-check failed: ${review?.error || 'unknown reviewer error'}`, code: 'RECHECK_FAILED' };
  }
  const outcome = classifyRecheckOutcome(review.findings);
  if (!outcome) {
    return { error: 'Re-check returned no usable findings', code: 'RECHECK_FAILED' };
  }
  const verdict = outcome === 'upheld'
    ? `no blocking findings survived (${backend})`
    : `a blocking finding still stands (${backend})`;
  // The resolution note is auto-generated from the re-check verdict (any caller
  // `note` is intentionally not threaded here — the machine verdict is the record).
  const note = `Auto re-check by ${backend} (${model}): ${verdict}.`;
  return resolveTaskChallenge(taskId, { outcome, note, resolvedBy: resolvedBy || `recheck:${backend}` }, taskType, { now });
}
