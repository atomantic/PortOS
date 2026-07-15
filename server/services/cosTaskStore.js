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

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { parseTasksMarkdown, groupTasksByStatus, getAutoApprovedTasks, getAwaitingApprovalTasks, generateTasksMarkdown, hasKnownPrefix } from '../lib/taskParser.js';
import { REVIEW_STOP_MODES, normalizeReviewers, normalizeReviewUsernames } from '../lib/validation.js';
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

/**
 * Get user tasks from TASKS.md
 */
export async function getUserTasks(tasksFilePath = null) {
  const state = await loadState();
  const filePath = tasksFilePath || join(ROOT_DIR, state.config.userTasksFile);

  if (!existsSync(filePath)) {
    return { tasks: [], grouped: groupTasksByStatus([]), file: filePath, exists: false, type: 'user' };
  }

  const content = await readFile(filePath, 'utf-8');
  const tasks = parseTasksMarkdown(content);
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

  const content = await readFile(filePath, 'utf-8');
  const tasks = parseTasksMarkdown(content);
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
    const content = await readFile(filePath, 'utf-8');
    tasks = parseTasksMarkdown(content);
  }

  // Reject duplicate: same first-line description AND same target app already
  // pending or in_progress. The `metadata.app` scope matters — the same
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
  const duplicate = tasks.find(t =>
    t.id !== ignoreTaskId &&
    (t.status === 'pending' || t.status === 'in_progress') &&
    firstLine(t.description).toLowerCase() === normalizedDesc &&
    (t.metadata?.app || null) === targetApp
  );
  if (duplicate) {
    console.log(`⚠️ Duplicate task rejected: "${normalizedDesc.substring(0, 60)}" matches ${duplicate.id}`);
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
    // Investigation-task guards (#2615): the durable fingerprint dedupes repeat
    // failures of the same cause; the marker blocks investigations-of-investigations;
    // affectedTasks names every task blocked on the cause (later dedup hits union in).
    if (taskData.isInvestigation === true) metadata.isInvestigation = true;
    if (taskData.investigationFingerprint) metadata.investigationFingerprint = taskData.investigationFingerprint;
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
    if (taskData.simplify === true) metadata.simplify = true;
    else if (taskData.simplify === false) metadata.simplify = false;
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
    if (REVIEW_STOP_MODES.includes(taskData.reviewStopMode)) metadata.reviewStopMode = taskData.reviewStopMode;
    if (taskData.reviewerApplies === true) metadata.reviewerApplies = true;
    else if (taskData.reviewerApplies === false) metadata.reviewerApplies = false;
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
  await writeFile(filePath, markdown);

  // cos.js init listens for this event. For user tasks it fires
  // tryImmediateSpawn so the task starts instantly if slots are available,
  // bypassing the evaluation interval (which is meant for system task generation).
  cosEvents.emit('tasks:changed', { type: taskType, action: 'added', task: newTask });

  return newTask;
  });
}

/**
 * Update an existing task
 */
export async function updateTask(taskId, updates, taskType = 'user', { now = Date.now() } = {}) {
  return withStateLock(async () => {
  const state = await loadState();
  const filePath = taskType === 'user'
    ? join(ROOT_DIR, state.config.userTasksFile)
    : join(ROOT_DIR, state.config.cosTasksFile);

  if (!existsSync(filePath)) {
    console.log(`⚠️ updateTask: file not found for ${taskId} (taskType=${taskType}, path=${filePath})`);
    return { error: 'Task file not found' };
  }

  const content = await readFile(filePath, 'utf-8');
  let tasks = parseTasksMarkdown(content);

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

  // Clear blocked/failure metadata when transitioning out of blocked status
  if (updates.status && updates.status !== 'blocked' && tasks[taskIndex].status === 'blocked') {
    for (const key of ['blocker', 'blockedReason', 'blockedCategory', 'blockedAt', 'failureCount', 'lastErrorCategory', 'lastFailureAt']) {
      delete updatedMetadata[key];
    }
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
  await writeFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: taskType, action: 'updated', task: updatedTask });
  return updatedTask;
  });
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
  return withStateLock(async () => {
    const state = await loadState();
    const filePath = taskType === 'user'
      ? join(ROOT_DIR, state.config.userTasksFile)
      : join(ROOT_DIR, state.config.cosTasksFile);

    const localTasks = existsSync(filePath)
      ? parseTasksMarkdown(await readFile(filePath, 'utf-8'))
      : [];

    const merged = mergeTaskLists(localTasks, remoteTasks, { now });

    const includeApprovalFlags = taskType === 'internal';
    const localMarkdown = generateTasksMarkdown(localTasks, includeApprovalFlags);
    const mergedMarkdown = generateTasksMarkdown(merged, includeApprovalFlags);
    // Nothing the peer sent changed our state — skip the write (and the event
    // that would wake the scheduler) so a steady-state sweep is a pure no-op.
    if (mergedMarkdown === localMarkdown) return { changed: false };

    await writeFile(filePath, mergedMarkdown);
    cosEvents.emit('tasks:changed', { type: taskType, action: 'peer-merged' });
    return { changed: true, count: merged.length };
  });
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

  const content = await readFile(filePath, 'utf-8');
  let tasks = parseTasksMarkdown(content);

  const taskToDelete = tasks.find(t => t.id === taskId);
  if (!taskToDelete) {
    return { error: 'Task not found' };
  }

  tasks = tasks.filter(t => t.id !== taskId);

  // Write back to file
  const includeApprovalFlags = taskType === 'internal';
  const markdown = generateTasksMarkdown(tasks, includeApprovalFlags);
  await writeFile(filePath, markdown);

  cosEvents.emit('tasks:changed', { type: taskType, action: 'deleted', taskId });
  return { success: true, taskId };
  });
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

  const content = await readFile(filePath, 'utf-8');
  const tasks = parseTasksMarkdown(content);

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
  await writeFile(filePath, markdown);

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

  const content = await readFile(filePath, 'utf-8');
  let tasks = parseTasksMarkdown(content);

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
  await writeFile(filePath, markdown);

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
  let model = recheck?.model;
  if (!model) {
    const defaults = await getCodeReviewDefaults().catch(() => null);
    model = backend === 'ollama' ? defaults?.ollamaModel : defaults?.lmstudioModel;
  }
  // A missing model is a config problem (no Code Review Defaults set), not an
  // upstream-reviewer failure — surface it as a 4xx (RECHECK_NO_MODEL → 400), not
  // the 502 bucket reserved for a reviewer that's actually unreachable.
  if (!model) {
    return { error: `No model configured for the ${backend} reviewer — set one on the AI Providers → Code Review Defaults panel.`, code: 'RECHECK_NO_MODEL' };
  }
  console.log(`⚖️ Re-checking challenge on ${taskId} via ${backend} (${model})`);
  const review = await runLocalCodeReview({ backend, model, diff: recheck?.diff });
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
