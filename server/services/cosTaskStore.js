/**
 * CoS Task Store Module
 *
 * Task CRUD + queue persistence extracted from cos.js. Owns the read/write
 * round-trip to the user (TASKS.md) and internal (COS-TASKS.md) task files:
 * parsing, grouping, dedup, and the `tasks:changed` event emissions that drive
 * the scheduler. The request → record mapping (ID generation, metadata
 * normalization) is `cosTaskIntake.js`, kept in parity with the request schema.
 *
 * Self-contained — it emits `tasks:changed` rather than calling the scheduler
 * directly. cos.js's `init()` listens on that event to fire `tryImmediateSpawn`
 * (user-added tasks) and `dequeueNextTask` (approved tasks), so the spawn-side
 * logic stays in cos.js while persistence lives here.
 */

import { reviewerModelsFromDefaults } from '../lib/reviewerConfig.js';
import { readFile, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { parseTasksMarkdown, groupTasksByStatus, getAutoApprovedTasks, getAwaitingApprovalTasks, generateTasksMarkdown, PRIORITY_VALUES } from '../lib/taskParser.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';
import { RETRY_HOLD_KEY, RETRY_HOLD_SINCE_KEY } from '../lib/taskRetryHold.js';
import { resolveTaskTargetBranch, shouldStripTaskTargetBranch } from '../lib/taskTargetBranch.js';
import { AGENT_PAUSED_CATEGORY, PAUSE_METADATA_KEYS, isAgentPausedTask, resolvePausedTaskResume, retirePausedAgent } from '../lib/taskPauseHold.js';
import { REQUEUED_AT_KEY } from '../lib/taskRequeue.js';
import { resolveTaskStatusTransition, isTerminalTaskStatus } from '../lib/taskStatusTransition.js';
import { isInvestigationTask } from '../lib/investigationTasks.js';
import { PAUSED_BLOCKED_CATEGORIES, USER_DECISION_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';
import { splitTaskPromptFields } from '../lib/cosTaskPrompt.js';
import { normalizeOrchestrationMode, normalizeOrchestrationProfile } from '../lib/orchestrationProfile.js';
import { loadState, withStateLock, ROOT_DIR } from './cosState.js';
import { cosEvents } from './cosEvents.js';
import { CLAIM_METADATA_KEYS } from './cosTaskClaim.js';
import { mergeTaskLists } from './cosTaskMerge.js';
import { buildQueuedTask } from './cosTaskIntake.js';
import { canChallenge, getChallengeCount, buildChallengePatch, buildChallengeResolutionPatch, classifyRecheckOutcome, MAX_CHALLENGES_PER_TASK } from './cosChallenge.js';
import { runLocalCodeReview, getCodeReviewDefaults } from './codeReview.js';

// First non-empty line of a string. Used by addTask dedup: stored descriptions
// are flattened to a single line by generateTasksMarkdown, so the comparison
// must normalize on the first line to match multi-line inputs.
export const firstLine = (s) => (s || '').split('\n').map(l => l.trim()).find(l => l) || '';

const CLAIM_KEY_SET = new Set(CLAIM_METADATA_KEYS);


// The `blockedCategory` vocabulary lives in `lib/taskBlockCategories.js` — the
// pause logic, the failure reaper below, and the investigation auto-retry all
// have to answer "may I move this task?" from that one value, and each keeping
// its own literal set is how they drifted. Re-exported at the address callers
// already use.
export { PAUSED_BLOCKED_CATEGORIES };

// Fields an `updateTask` patch may carry directly (vs nested under `metadata`);
// they're normalized into `metadata` on write. Listed once so the content-edit
// detector and the normalizer below can't drift apart. `prompt` joined the list
// with the #4153 split so the task editor can edit the agent-facing payload the
// same way it edits the human note — deliberately WITHOUT re-classification, so
// a multi-line note edit can't overwrite the payload (see `splitTaskPromptFields`).
const LEGACY_DIRECT_FIELDS = ['context', 'prompt', 'model', 'provider', 'effort', 'temperature', 'thinking', 'app', 'orchestrationMode', 'orchestrationProfile'];

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
// One server process, one user (AGENTS.md trust model) — no locking, no atomic
// write dance. Correctness rests on two independent invalidation signals:
//
//   1. The stamp (`mtimeMs` + `size`) catches writes this module did NOT make —
//      a user editing `TASKS.md` in an editor, a restore, a peer's direct write.
//   2. Every write through `writeTaskFile` DROPS the entry outright. mtime can
//      be as coarse as one second on some filesystems, so a write-then-read in
//      the same tick must not depend on the stamp having moved.
const parsedTaskCache = new Map(); // filePath -> { stamp, tasks, byId? }

// `null` = could not stat (missing/unreadable) → do not cache, distinct from a
// legitimately empty file, which stamps normally and caches its empty parse.
const taskFileStamp = async (filePath) => {
  const stats = await stat(filePath).catch(() => null);
  return stats ? `${stats.mtimeMs}:${stats.size}` : null;
};

// Private snapshots never leave this module: list readers clone the array,
// while ID lookups clone only the matching task. Both share invalidation.
async function readTaskSnapshot(filePath) {
  const stamp = await taskFileStamp(filePath);
  const cached = parsedTaskCache.get(filePath);
  if (stamp && cached?.stamp === stamp) return cached;

  const snapshot = { stamp, tasks: parseTasksMarkdown(await readFile(filePath, 'utf-8')) };
  if (stamp) parsedTaskCache.set(filePath, snapshot);
  else parsedTaskCache.delete(filePath);
  return snapshot;
}

async function readTaskFile(filePath) {
  return structuredClone((await readTaskSnapshot(filePath)).tasks);
}

async function findTaskInFile(filePath, taskId) {
  if (!existsSync(filePath)) return null;
  const snapshot = await readTaskSnapshot(filePath);
  if (!snapshot.byId) {
    snapshot.byId = new Map();
    for (const task of snapshot.tasks) {
      // Preserve Array.find's first-match behavior for hand-edited duplicate IDs.
      if (!snapshot.byId.has(task.id)) snapshot.byId.set(task.id, task);
    }
  }
  const task = snapshot.byId.get(taskId);
  return task ? structuredClone(task) : null;
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
 * Lightweight live-activity input. Derive once per task-file snapshot, so a
 * three-second poll never clones prompts or groups completed history.
 * Keep duplicates and source order, matching getAllTasks() counting semantics.
 */
export async function getPendingTaskIds() {
  const { config } = await loadState();
  const sources = await Promise.all([config.userTasksFile, config.cosTasksFile].map(async (file) => {
    const filePath = join(ROOT_DIR, file);
    if (!existsSync(filePath)) return [];
    const snapshot = await readTaskSnapshot(filePath);
    snapshot.pendingIds ??= snapshot.tasks.filter(task => task.status === 'pending').map(task => task.id);
    return snapshot.pendingIds;
  }));
  // Never expose the cached arrays to callers.
  return sources.flat();
}

/**
 * Telemetry reads only diagnostics-bearing records, never full prompts or
 * grouped history. Derive per snapshot and reuse the task cache's internal-write
 * and external-edit invalidation; clone the projection to keep it private.
 */
export async function getTaskDiagnostics() {
  const { config } = await loadState();
  const sources = await Promise.all([config.userTasksFile, config.cosTasksFile].map(async (file) => {
    const filePath = join(ROOT_DIR, file);
    if (!existsSync(filePath)) return [];
    const snapshot = await readTaskSnapshot(filePath);
    snapshot.diagnosticTasks ??= snapshot.tasks.filter(task => {
      const diagnostics = task.metadata?.diagnostics;
      return diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics);
    }).map(task => ({
      status: task.status,
      metadata: { diagnostics: task.metadata.diagnostics, updatedAt: task.metadata.updatedAt }
    }));
    return snapshot.diagnosticTasks;
  }));
  return structuredClone(sources.flat());
}

/**
 * Alias for backward compatibility
 */
export const getTasks = getUserTasks;

/**
 * Get a specific task by ID from any task source
 */
export async function getTaskById(taskId) {
  const { config } = await loadState();
  // Keep user-first precedence, including legacy/custom IDs. Do not infer the
  // source from a prefix or prepare grouped copies of both queues for one ID.
  const userTask = await findTaskInFile(join(ROOT_DIR, config.userTasksFile), taskId);
  if (userTask) return { ...userTask, taskType: 'user' };

  const cosTask = await findTaskInFile(join(ROOT_DIR, config.cosTasksFile), taskId);
  if (cosTask) return { ...cosTask, taskType: 'internal' };

  return null;
}

/**
 * Add a new task to the user or internal queue.
 *
 * Emits `tasks:changed` with `action: 'added'` on success; cos.js's init
 * listener turns that into a `tryImmediateSpawn` for user tasks so a newly
 * submitted task starts instantly instead of waiting for the next evaluation
 * interval. `suppressDequeue` is reserved for an explicit dispatcher that will
 * force-spawn the returned task itself; the change event still reaches socket
 * consumers, but the normal scheduler must not race that dispatch.
 */
export async function addTask(taskData, taskType = 'user', { raw = false, ignoreTaskId = null, now = Date.now(), suppressDequeue = false } = {}) {
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
  let newTask = raw ? taskData : buildQueuedTask(taskData, taskType, { now });

  // Route a multi-line context payload to `metadata.prompt` (#4153). Applied to
  // BOTH branches — the raw path is how the generator, the reference-watch
  // analysis, and the repo-study filer queue their pre-built tasks, and they
  // carry the same kind of multi-thousand-character body the direct-write path
  // does. One classification, at CREATE only: `updateTask` deliberately leaves
  // both fields alone, because the task editor's textarea is seeded from the
  // NOTE and re-classifying a multi-line edit of it would overwrite the task's
  // real prompt. A producer that already wrote `metadata.prompt` wins over the
  // inference. See `server/lib/cosTaskPrompt.js` for the full contract.
  // Markdown task rows are one-line records. Preserve every generated prompt
  // in the newline-safe metadata field before persistence, including raw
  // on-demand tasks that bypass the queue generator's normalization pass.
  //
  // This runs BEFORE the context reclassification below on purpose: a producer
  // that hands over a multi-line description AND a multi-line context note (the
  // pr-reviewer generator's security-scan summary) means the description is the
  // prompt and the note is the note. Reclassifying first promoted the note to
  // `prompt`, which then counted as an explicit producer prompt and silently
  // discarded the stage instructions — Stage 2 ran with no gate rules and no
  // output contract.
  if (typeof newTask.description === 'string' && newTask.description.includes('\n')) {
    newTask = {
      ...newTask,
      description: firstLine(newTask.description),
      metadata: {
        ...(newTask.metadata || {}),
        prompt: typeof newTask.metadata?.prompt === 'string'
          ? newTask.metadata.prompt
          : newTask.description,
      },
    };
  }
  const splitMetadata = splitTaskPromptFields(newTask.metadata);
  if (splitMetadata !== newTask.metadata) newTask = { ...newTask, metadata: splitMetadata };

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
  const change = { type: taskType, action: 'added', task: newTask };
  if (suppressDequeue) change.suppressDequeue = true;
  cosEvents.emit('tasks:changed', change);

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
export async function updateTask(taskId, updates, taskType = 'user', { now = Date.now(), suppressDequeue = false } = {}) {
  const release = await preparePauseRelease(taskId, updates);
  const result = await writeTaskUpdate(taskId, release ? { ...updates, metadata: release.metadata } : updates, taskType, { now, suppressDequeue });
  if (release && !result?.error) {
    await retirePausedAgent(release.agentId, taskId, resolveTaskTargetBranch(result?.metadata));
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

/**
 * Metadata a status transition RETIRES, as `[transition field, keys]` rows applied
 * in order by `writeTaskUpdate`. One row per subsystem the transition releases —
 * adding a lifecycle clear is a row here, not another hand-written predicate in the
 * middle of the write.
 *
 * ORDER IS BEHAVIOR: the `leavesBlocked` row clears `blockedCategory`, and the
 * resume-pointer drop below the loop reads that same key to decide whether the
 * block was a PAUSE. A paused task flipped straight to `completed` is therefore no
 * longer pause-categorized by the time the pointer is evaluated, and its spent
 * pointer drops — pinned by cosTaskStore.test.js.
 *
 * The retry hold and the federation claim are two rows even though both key on
 * `leavesInProgress`: they release different subsystems (#3373's cleanup handshake
 * and #1563's cross-peer lease) and are separately documented at their sites. What
 * they must never do again is drift, so they read the ONE descriptor field rather
 * than each re-testing `updates.status !== 'in_progress'`.
 */
const TRANSITION_METADATA_CLEARS = Object.freeze([
  // Leaving `blocked` by any door — a dedupe revive, an autopilot re-dispatch, an
  // orphan-cooldown expiry, or a human unblocking it from the task list. Clearing
  // only in `resumeAgent` left every one of those paths running a task that still
  // advertised a live pause: the UI kept showing it parked, and `resumeAgent` on the
  // still-paused agent record then read its own pause as spent and spawned a SECOND
  // agent on a fresh task. The failure counters go too, or the revived task
  // re-blocks on the budget it blocked with.
  ['leavesBlocked', ['blocker', 'blockedReason', 'blockedCategory', 'blockedAt', 'failureCount', 'lastErrorCategory', 'lastFailureAt', ...PAUSE_METADATA_KEYS]],
  // A retry hold (#3373) only means anything while the task is `in_progress` waiting
  // on a cleanup to resolve its resume pointer. Any other status the task reaches —
  // terminal, or a requeue some other path performed — retires it, so drop the marker
  // rather than leave a stale one for a late cleanup (or the orphan sweep) to act on.
  ['leavesInProgress', [RETRY_HOLD_KEY, RETRY_HOLD_SINCE_KEY]],
  // Release the federation claim/lease (#1563). A claim only protects in-flight work;
  // once the task completes, fails back to pending, or is blocked, it must become
  // freely claimable by either peer — a stale lease blocks a legitimate retry (by this
  // instance or its peer) for a full lease window.
  ['leavesInProgress', CLAIM_METADATA_KEYS]
]);

/**
 * Merge an `updateTask` patch's metadata onto the task's existing metadata, in the
 * shape the store persists. Purely about the PATCH's shape — it answers nothing
 * about the status transition, which `resolveTaskStatusTransition` owns.
 *
 * Legacy direct fields use ?? not ||, so an intentional clear to "" is preserved
 * as "" rather than dropped: || maps every falsy value (incl. "") to undefined,
 * which `writeTaskUpdate`'s cleanup pass then deletes, conflating "cleared" with
 * "absent" (absent-vs-cleared, AGENTS.md). Only null becomes undefined (→ deleted);
 * absent fields never enter the loop.
 *
 * The orchestration pins are re-normalized after that verbatim copy (#5992) so an
 * update lands the same persisted shape `addTask` writes: a profile of empty role
 * objects, or the default `direct` mode, is stored as absent rather than as an
 * inert override. A null from the route still arrives here as `undefined` and is
 * deleted by the cleanup pass — an explicit clear.
 */
function mergeUpdateMetadata(existingMetadata, updates) {
  const merged = { ...existingMetadata, ...(updates.metadata || {}) };
  for (const f of LEGACY_DIRECT_FIELDS) {
    if (updates[f] !== undefined) merged[f] = updates[f] ?? undefined;
  }
  if (merged.orchestrationProfile !== undefined) {
    merged.orchestrationProfile = normalizeOrchestrationProfile(merged.orchestrationProfile) ?? undefined;
  }
  if (merged.orchestrationMode !== undefined) {
    merged.orchestrationMode = normalizeOrchestrationMode(merged.orchestrationMode) === 'orchestrated' ? 'orchestrated' : undefined;
  }
  return merged;
}

async function writeTaskUpdate(taskId, updates, taskType, { now, suppressDequeue = false }) {
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

  const updatedMetadata = mergeUpdateMetadata(tasks[taskIndex].metadata, updates);

  // Ask "what status transition is this?" ONCE. Every lifecycle rule below reads a
  // field off this descriptor instead of re-deriving an answer from
  // `(previousStatus, updates.status)` at its own site — which is how the retry-hold
  // clear and the claim release ended up as the same predicate written twice, and
  // how the requeue stamp and the emitted action came to key on the same edge from
  // 52 lines apart while having to agree (#6620).
  const previousStatus = tasks[taskIndex].status;
  const transition = resolveTaskStatusTransition(previousStatus, updates.status);

  // Retire the metadata this transition releases. Ordered — see the table's note on
  // the `blockedCategory` clear feeding the resume-pointer check below.
  for (const [field, keys] of TRANSITION_METADATA_CLEARS) {
    if (!transition[field]) continue;
    for (const key of keys) delete updatedMetadata[key];
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
  if (transition.isTerminal && !PAUSED_BLOCKED_CATEGORIES.has(updatedMetadata.blockedCategory)) {
    // The shared predicate identifies only retry-owned `existingBranch` pointers.
    // Review-loop follow-ups own `reviewLoopPRBranch`, so their canonical target
    // remains intact even when a legacy duplicate is removed here.
    if (shouldStripTaskTargetBranch(updatedMetadata)) delete updatedMetadata.existingBranch;
    delete updatedMetadata.resumedFromAgentId;
    delete updatedMetadata.resumeWorktreePath;
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
  if (transition.isRequeue) {
    updatedMetadata[REQUEUED_AT_KEY] = new Date(now).toISOString();
  }
  // A fresh spawn retires the marker — from here on THIS run's `lastSpawnedAt` is
  // what a future requeue must beat, and a leftover stamp from the previous cycle
  // would let a peer's pre-spawn `pending` copy win on a stale requeue.
  if (transition.entersInProgress) delete updatedMetadata[REQUEUED_AT_KEY];

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

  tasks[taskIndex] = updatedTask;

  // Write back to file
  const includeApprovalFlags = taskType === 'internal';
  const markdown = generateTasksMarkdown(tasks, includeApprovalFlags);
  await writeTaskFile(filePath, markdown);

  // `transition.action` distinguishes the two flips that must WAKE the scheduler
  // from an ordinary edit. A blocked → pending flip is a revive: the task is newly
  // spawnable, exactly like an approval, and cos.init's listener re-runs the dequeue
  // on it (#2614) — the generic 'updated' action doesn't, which left revived tasks
  // stranded until an unrelated event or timer fired. An in_progress → pending flip
  // is a requeue and needs the same wake (#3373): a failed run's retry is released
  // from its hold by exactly this transition, and by then the `agent:completed`
  // dequeue has long since run — without a signal the retry would idle until the
  // next timer. Same for the orphan sweep's requeue, which previously depended on
  // its caller remembering to evaluate.
  // `previousStatus` rides along so consumers can key on the TRANSITION rather
  // than re-deriving one from the level. `updateTask` on an already-terminal task
  // re-emits `updated` with the same status — an edit to a completed task's
  // description is enough — so a consumer that reacts to "reached completed"
  // (the investigation auto-retry; the voice completion line) needs the edge, not
  // `status === 'completed'`, which is true on every later write too.
  const change = { type: taskType, action: transition.action, task: updatedTask, previousStatus };
  if (suppressDequeue) change.suppressDequeue = true;
  cosEvents.emit('tasks:changed', change);
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
export async function reviveBlockedTask(taskId, { priority, metadata } = {}, taskType = 'internal', { suppressDequeue = false } = {}) {
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
  }, taskType, { suppressDequeue });
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
 * Only the in-process local reviewers (`LOCAL_LLM_REVIEWERS`) are re-run here; CLI
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
  // Keyed off the roster's `<reviewer>Model` scalar rather than a per-backend
  // branch (matching `POST /api/code-review/local`): the old ollama-or-lmstudio
  // ternary read LM STUDIO's model for any third local backend, so an `mtplx`
  // re-check ran against a model id from the wrong daemon.
  //
  // An unset scalar is no longer fatal here: `runLocalCodeReview` falls back to the
  // model the backend is actually serving when that answer is unambiguous, so a
  // single-model daemon re-checks without one. It reports `code: 'NO_MODEL'` when it
  // could not resolve one either, which stays a config problem (4xx) rather than the
  // 502 bucket reserved for a reviewer that's actually unreachable.
  const model = recheck?.model || reviewerModelsFromDefaults(recheckDefaults)[backend] || null;
  console.log(`⚖️ Re-checking challenge on ${taskId} via ${backend} (${model || 'model from the backend'}${effort ? `, ${effort} effort` : ''})`);
  const review = await runLocalCodeReview({ backend, model, effort, diff: recheck?.diff });
  if (!review?.ok) {
    if (review?.code === 'NO_MODEL') return { error: review.error, code: 'RECHECK_NO_MODEL' };
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
  // `review.model` rather than `model`: the reviewer resolves an unpinned id from
  // what the backend is serving, and the record has to name the model that actually
  // produced this verdict, not `null`.
  const note = `Auto re-check by ${backend} (${review.model || model}): ${verdict}.`;
  return resolveTaskChallenge(taskId, { outcome, note, resolvedBy: resolvedBy || `recheck:${backend}` }, taskType, { now });
}
