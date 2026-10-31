import { auditWorkflow, newAuditMetadata, isLegacyDeepAudit } from '../lib/auditWorkflow.js';
import { isForgeMaintenanceTask, hasCurrentForgeMaintenanceEvidence, LEGACY_FORGE_MAINTENANCE_REASON } from '../lib/forgeMaintenanceTasks.js';
import { getSkipReason } from './cosTaskClaim.js';
import { isDeepStrictEqual } from 'node:util';
import { RELEASE_SYNC_FROZEN_METADATA_KEYS } from '../lib/releaseSynchronization.js';
import { matchesSpawnBudgetProof, newSpawnBudgetEpisode, validSpawnBudgetEpisode, spawnBudgetCount, SPAWN_HISTORY_METADATA_KEYS } from './spawnBudgetProof.js';
/**
 * CoS Task Store Module
 *
 * Task CRUD + queue persistence extracted from cos.js. Owns the read/write
 * round-trip to the user and internal task queues (`cos_tasks`, through
 * `cosTaskRepository.js`): the cached working set, row-diff saves, grouping,
 * dedup, and the `tasks:changed` event emissions that drive the scheduler. The request → record mapping (ID generation, metadata
 * normalization) is `cosTaskIntake.js`, kept in parity with the request schema.
 *
 * Self-contained — it emits `tasks:changed` rather than calling the scheduler
 * directly. cos.js's `init()` listens on that event to fire `tryImmediateSpawn`
 * (user-added tasks) and `dequeueNextTask` (approved tasks), so the spawn-side
 * logic stays in cos.js while persistence lives here.
 */

import { DEVELOPMENT_ACTIVE_STATUSES, developmentWorkIdentity, sameDevelopmentWork } from '../lib/developmentWorkIdentity.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { reviewerModelsFromDefaults } from '../lib/reviewerConfig.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import { groupTasksByStatus, getAutoApprovedTasks, getAwaitingApprovalTasks, hasKnownPrefix, toRepresentableTask, PRIORITY_VALUES } from '../lib/taskParser.js';
import { MAX_TOTAL_SPAWNS, cosTaskTypeSchema, validateRequest } from '../lib/validation.js';
import { RETRY_HOLD_KEY, RETRY_HOLD_SINCE_KEY, isRetryHeld } from '../lib/taskRetryHold.js';
import { resolveTaskTargetBranch, shouldStripTaskTargetBranch } from '../lib/taskTargetBranch.js';
import { AGENT_PAUSED_CATEGORY, PAUSE_METADATA_KEYS, isAgentPausedTask, resolvePausedTaskResume, retirePausedAgent } from '../lib/taskPauseHold.js';
import { REQUEUED_AT_KEY } from '../lib/taskRequeue.js';
import { resolveTaskStatusTransition, isTerminalTaskStatus } from '../lib/taskStatusTransition.js';
import { isInvestigationTask } from '../lib/investigationTasks.js';
import { PAUSED_BLOCKED_CATEGORIES, USER_DECISION_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';
import { splitTaskPromptFields, TASK_PROMPT_KEY, TASK_CONTEXT_KEY } from '../lib/cosTaskPrompt.js';
import { normalizeOrchestrationMode, normalizeOrchestrationProfile } from '../lib/orchestrationProfile.js';
import { loadState, withStateLock, readAgentsStateForSafetyCheck } from './cosState.js';
import { activeAgents, runnerAgents, hasActiveTaskOwner } from './agentState.js';
import { cosEvents } from './cosEvents.js';
import { CLAIM_METADATA_KEYS, isLeaseLive } from './cosTaskClaim.js';
import { mergeTaskLists } from './cosTaskMerge.js';
import { applyTaskListSave, countCompletedTasks, deleteStoredTask, getCompletedTaskIds, getStoredTask, loadTaskWorkingSet, pageCompletedTasks, readTaskListVersion } from './cosTaskRepository.js';
import { planListSave, selectWorkingSet, storedForm } from '../lib/cosTaskRows.js';
import { buildQueuedTask } from './cosTaskIntake.js';
import { canChallenge, getChallengeCount, buildChallengePatch, buildChallengeResolutionPatch, classifyRecheckOutcome, MAX_CHALLENGES_PER_TASK } from './cosChallenge.js';
import { runLocalCodeReview, getCodeReviewDefaults } from './codeReview.js';

// First non-empty line of a string — used by addTask's dedup, since stored
// descriptions are flattened to a single line by generateTasksMarkdown. Declared
// in the dependency-free text leaf and re-exported here at the address this
// module's callers already import it from.
import { firstLine } from '../lib/textUtils.js';
export { firstLine };

const CLAIM_KEY_SET = new Set(CLAIM_METADATA_KEYS);

// Heading the update path stamps on text it lifts out of a multi-line description
// edit and into the newline-safe note, so the provenance survives a later read.
const DESCRIPTION_OVERFLOW_HEADING = '(from description)';

/**
 * Normalize a multi-line `description` on the UPDATE path, preserving the body.
 *
 * Markdown task rows are ONE-LINE records: `generateTasksMarkdown` emits the
 * description into `- [ ] #id | PRIORITY | <description>` and
 * `parseTasksMarkdown` reads only that first line. `addTask` has collapsed a
 * multi-line description for exactly that reason since #4153 — `writeTaskUpdate`
 * did not, so saving a multi-line edit from the task editor's textarea wrote the
 * extra lines into the file as free text. Reparsing then silently truncated the
 * description, scraped any `  - key: value` line into the task's OWN metadata
 * (re-targeting its app/provider/prompt), and minted a phantom auto-approved
 * task out of any pasted `- [ ] #id | …` row that the spawner would then run
 * (#7240).
 *
 * Unlike `addTask` this never DROPS the remainder. The full submitted text goes
 * to `metadata.prompt` when the task has none; when it already has one, the text
 * is appended to `metadata.context` instead, because `updateTask` must not
 * overwrite a real prompt (the contract in `server/lib/cosTaskPrompt.js`). Both
 * fields round-trip newlines through the JSON sentinel, and `taskContextBlock`
 * already renders prompt + note together — nothing is lost and nothing is
 * silently replaced. An explicitly-cleared prompt (`''`) counts as present, the
 * same absent-vs-cleared rule the rest of the store follows.
 *
 * Returns `null` when there is nothing to normalize; never mutates its input.
 */
function normalizeUpdatedDescription(description, metadata) {
  if (typeof description !== 'string' || !description.includes('\n')) return null;
  const nextMetadata = { ...metadata };
  if (typeof nextMetadata[TASK_PROMPT_KEY] === 'string') {
    const block = `${DESCRIPTION_OVERFLOW_HEADING}\n${description}`;
    const existing = typeof nextMetadata[TASK_CONTEXT_KEY] === 'string' ? nextMetadata[TASK_CONTEXT_KEY] : '';
    // Re-saving the same edit must not grow the note without bound.
    if (!existing.includes(block)) {
      nextMetadata[TASK_CONTEXT_KEY] = existing ? `${existing}\n\n${block}` : block;
    }
  } else {
    nextMetadata[TASK_PROMPT_KEY] = description;
  }
  return { description: firstLine(description), metadata: nextMetadata };
}

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
const LEGACY_DIRECT_FIELDS = ['context', 'prompt', 'model', 'provider', 'effort', 'executionOptions', 'temperature', 'thinking', 'app', 'orchestrationMode', 'orchestrationProfile'];

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

// ── Working-set cache ───────────────────────────────────────────────────────
//
// `getUserTasks`/`getCosTasks`/`getTaskById` run on every daemon evaluation
// tick, scheduler sweep, and agent state update. A queue's WORKING SET (every
// open task plus recently completed ones, see lib/cosTaskRows.js) is loaded once
// per queue version and shared: an unchanged queue costs one single-row version
// read plus a structured clone instead of a query over the rows.
//
// Concurrent readers share the load for a version (#12225), so a cold cache does
// not multiply the working set by the number of readers. Correctness rests on:
//
//   1. The queue version, bumped by every write in the same transaction, so a
//      write this process did NOT make is noticed on the next read.
//   2. Our own writes replace the cached entry only when the version moved by
//      exactly one (nobody else wrote in between); otherwise they drop it.
const snapshotCache = new Map(); // source -> { version, snapshot }
const snapshotLoads = createSingleFlight();
// A list may be mutated or transformed before saving. Keep its ORIGINAL read
// snapshot, never a fresh read whose omissions could turn into accidental deletes.
const listSnapshots = new WeakMap();

// Private snapshots never leave this module: list readers clone the array,
// while ID lookups clone only the matching task. Both share invalidation.
// `rows` keeps each task's stored position for the next save's diff.
async function readTaskSnapshot(source) {
  const version = await readTaskListVersion(source);
  const cached = snapshotCache.get(source);
  if (cached?.version === version) return cached.snapshot;
  return snapshotLoads.run(`${source}:${version}`, async () => {
    const loaded = await loadTaskWorkingSet(source);
    const snapshot = { version: loaded.version, rows: loaded.rows, tasks: loaded.rows.map((row) => row.task) };
    if (!snapshotCache.get(source) || snapshotCache.get(source).version <= loaded.version) {
      snapshotCache.set(source, { version: loaded.version, snapshot });
    }
    return snapshot;
  });
}

async function readTaskFile(source) {
  const snapshot = await readTaskSnapshot(source);
  const tasks = structuredClone(snapshot.tasks);
  listSnapshots.set(tasks, snapshot);
  return tasks;
}

async function findTaskInFile(source, taskId) {
  const snapshot = await readTaskSnapshot(source);
  if (!snapshot.byId) {
    snapshot.byId = new Map();
    for (const task of snapshot.tasks) {
      // Preserve Array.find's first-match behavior for duplicate IDs.
      if (!snapshot.byId.has(task.id)) snapshot.byId.set(task.id, task);
    }
  }
  const task = snapshot.byId.get(taskId);
  return task ? structuredClone(task) : null;
}

/**
 * Persist the queue as `tasks`: diff against the stored working set and write
 * only the rows that changed, in one transaction. Every write path in this
 * module goes through here. Resolves to whether anything was written.
 */
async function writeTaskList(source, tasks, original = tasks, dependencies = {}) {
  const snapshot = listSnapshots.get(original);
  if (!snapshot) throw new Error('Task saves require their original read snapshot');
  const cached = snapshotCache.get(source);
  const plan = planListSave({ previous: snapshot.rows, next: tasks, source });
  if (plan.upserts.length === 0 && plan.deletes.length === 0) return false;
  const version = await applyTaskListSave(source, {
    ...plan, expectedVersions: { ...dependencies, [source]: snapshot.version },
  });

  const positions = new Map(snapshot.rows.map((row) => [row.task.id, row.position]));
  for (const { task, position } of plan.upserts) positions.set(task.id, position);
  if (cached?.snapshot === snapshot && version === cached.version + 1) {
    // Same bound as a reload, so completions never accumulate in the cache.
    const rows = selectWorkingSet(plan.saved.map((task) => ({ task, position: positions.get(task.id) })));
    snapshotCache.set(source, { version, snapshot: { version, rows, tasks: rows.map((row) => row.task) } });
  } else {
    snapshotCache.delete(source);
  }
  return true;
}

/** Test hook: forget every cached working set. */
export function __resetTaskCache() {
  snapshotCache.clear();
}

/**
 * Get user tasks
 */
export async function getUserTasks() {
  const tasks = await readTaskFile('user');
  return { tasks, grouped: groupTasksByStatus(tasks), type: 'user' };
}

/**
 * Get CoS internal tasks
 */
export async function getCosTasks() {
  const tasks = await readTaskFile('internal');
  const grouped = groupTasksByStatus(tasks);
  const autoApproved = getAutoApprovedTasks(tasks);
  const awaitingApproval = getAwaitingApprovalTasks(tasks);

  return { tasks, grouped, type: 'internal', autoApproved, awaitingApproval };
}

/**
 * Get all tasks (user + internal)
 */
export async function getAllTasks() {
  const [userTasks, cosTasks] = await Promise.all([getUserTasks(), getCosTasks()]);
  return { user: userTasks, cos: cosTasks };
}

// ── Bounded task views (#9677) ──────────────────────────────────────────────
//
// `GET /api/cos/tasks` returns the open queue plus at most one page of completed
// history, yet `getAllTasks()` structured-clones the whole working set (recent
// completed prompt bodies included) from BOTH queues first. These readers select
// from the private snapshot, or page completed history straight from the table,
// and clone only what the response carries. Nothing returned here aliases the cache.
const COMPLETED_FIRST_PAGE = 25;
const SOURCES = ['user', 'internal'];
const isCompleted = (task) => task.status === 'completed';

// Per-snapshot derivations, dropped with the snapshot on any version change.
function snapshotPartitions(snapshot) {
  if (!snapshot.partitions) {
    const open = [];
    const completed = [];
    for (const task of snapshot.tasks) (isCompleted(task) ? completed : open).push(task);
    snapshot.partitions = { open, completed };
  }
  return snapshot.partitions;
}

// Shape of getUserTasks()/getCosTasks() over an already-selected task subset.
// Callers pass CLONED tasks; grouped/derived lists share those clones.
function sourceShape(type, tasks) {
  const shape = { tasks, grouped: groupTasksByStatus(tasks), type };
  if (type === 'internal') {
    shape.autoApproved = getAutoApprovedTasks(tasks);
    shape.awaitingApproval = getAwaitingApprovalTasks(tasks);
  }
  return shape;
}

/**
 * One page of completed history from ONE queue, newest id first, straight from
 * the table. `nextCursor` is the last id of a full page when more remain.
 */
async function pageCompleted(type, { cursor = null, limit }) {
  const rows = await pageCompletedTasks(type, { before: cursor, limit: limit + 1 });
  const items = rows.slice(0, limit);
  return { items, total: await countCompletedTasks(type), nextCursor: rows.length > limit ? items[limit - 1].id : null };
}

/**
 * Open queue (every non-completed task, plus the `selected` historical task)
 * for both queues. `completedCount` carries the completed total.
 */
async function readQueueView(selected) {
  const read = async (type) => {
    const snapshot = await readTaskSnapshot(type);
    const { open } = snapshotPartitions(snapshot);
    const refs = selected === undefined ? open : snapshot.tasks.filter((task) => !isCompleted(task) || task.id === selected);
    const tasks = structuredClone(refs);
    // A selected historical task older than the working set is fetched by id.
    if (selected !== undefined && !refs.some((task) => task.id === selected)) {
      const stored = await getStoredTask(selected, type);
      if (stored) tasks.push(stored.task);
    }
    return { ...sourceShape(type, tasks), completedCount: await countCompletedTasks(type) };
  };
  const [user, cos] = await Promise.all([read('user'), read('internal')]);
  return { user, cos };
}

/** Open queue plus the first completed page; the rest of the history stays in the table. */
async function readBareView() {
  const read = async (type) => {
    const { open } = snapshotPartitions(await readTaskSnapshot(type));
    const page = await pageCompleted(type, { limit: COMPLETED_FIRST_PAGE });
    const shape = sourceShape(type, [...structuredClone(open), ...page.items]);
    // Completed rows leave `grouped`; only the page inside `tasks` carries them.
    return { ...shape, grouped: { ...shape.grouped, completed: [] }, completedCount: page.total, completedNextCursor: page.nextCursor };
  };
  const [user, cos] = await Promise.all([read('user'), read('internal')]);
  return { user, cos };
}

/** One page of completed history from ONE source, newest id first. */
async function readCompletedView({ source, cursor, limit }) {
  return pageCompleted(source === 'internal' ? 'internal' : 'user', { cursor, limit });
}

/**
 * Legacy limit/offset window over each queue's working set, in queue order. The
 * slice and scalar metadata only; completed history older than the working set
 * pages through the `completed` view.
 */
async function readWindowView({ offset, limit }) {
  const read = async (type) => {
    const { tasks } = await readTaskSnapshot(type);
    return { meta: { type }, tasks: structuredClone(tasks.slice(offset, offset + limit)), total: tasks.length };
  };
  const [user, cos] = await Promise.all([read('user'), read('internal')]);
  return {
    user: { ...user.meta, tasks: user.tasks },
    cos: { ...cos.meta, tasks: cos.tasks },
    totals: { user: user.total, cos: cos.total },
  };
}

/**
 * Read-only, bounded task view for the HTTP layer. `kind`:
 *   - 'queue'     { selected? } open tasks (+ the selected historical one) + completedCount
 *   - 'bare'      open tasks + first completed page (+ completedCount/completedNextCursor)
 *   - 'completed' { source, cursor?, limit } one source's page → { items, total, nextCursor }
 *   - 'window'    { offset, limit } legacy slice of the working set → { user, cos, totals }
 * Sources come back unsettled for the spawn window; `getAllTasks()` stays the raw
 * truth (the working set) for scheduler readers and `view=full`.
 */
export async function getTaskView({ kind, ...options }) {
  if (kind === 'queue') return readQueueView(options.selected);
  if (kind === 'bare') return readBareView();
  if (kind === 'completed') return readCompletedView(options);
  if (kind === 'window') return readWindowView(options);
  throw new Error(`Unknown task view: ${kind}`);
}

/**
 * Lightweight live-activity input. Derive once per queue version, so a
 * three-second poll never clones prompts or groups completed history.
 * Keep duplicates and source order, matching getAllTasks() counting semantics.
 */
export async function getPendingTaskIds() {
  const sources = await Promise.all(SOURCES.map(async (source) => {
    const snapshot = await readTaskSnapshot(source);
    snapshot.pendingIds ??= snapshot.tasks.filter(task => task.status === 'pending').map(task => task.id);
    return snapshot.pendingIds;
  }));
  // Never expose the cached arrays to callers.
  return sources.flat();
}

/**
 * Telemetry reads only diagnostics-bearing records, never full prompts or
 * grouped history. Derive per snapshot and reuse the cache's write invalidation;
 * clone the projection to keep it private.
 */
export async function getTaskDiagnostics() {
  const sources = await Promise.all(SOURCES.map(async (source) => {
    const snapshot = await readTaskSnapshot(source);
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
 * Approval-state view of the internal queue for pollers that need the awaiting
 * list or the auto-approved count, not the whole queue. `getCosTasks()` clones
 * every working-set prompt body to answer the same question. Derived once per
 * snapshot; only the first `limit` awaiting tasks are cloned.
 */
export async function getCosApprovalView({ limit = Infinity } = {}) {
  const snapshot = await readTaskSnapshot('internal');
  snapshot.approval ??= {
    awaiting: getAwaitingApprovalTasks(snapshot.tasks),
    autoApprovedCount: getAutoApprovedTasks(snapshot.tasks).length,
  };
  const { awaiting, autoApprovedCount } = snapshot.approval;
  return { awaitingApproval: structuredClone(awaiting.slice(0, limit)), autoApprovedCount };
}

/**
 * Alias for backward compatibility
 */
export const getTasks = getUserTasks;

/**
 * Get a specific task by ID from any task source
 */
/**
 * One task and the queue it lives in: `{ task, source: 'user' | 'internal' }`,
 * or null. The record is returned as stored (its own `taskType` intact), which
 * is what a client merging it into a list it already holds needs.
 */
export async function findTaskWithSource(taskId) {
  // Keep user-first precedence, including legacy/custom IDs. Do not infer the
  // source from a prefix or prepare grouped copies of both queues for one ID.
  const userTask = await findTaskInFile('user', taskId);
  if (userTask) return { task: userTask, source: 'user' };

  const cosTask = await findTaskInFile('internal', taskId);
  if (cosTask) return { task: cosTask, source: 'internal' };

  // Completed history older than the working set is fetched by id.
  const stored = await getStoredTask(taskId);
  return stored ? { task: stored.task, source: stored.source } : null;
}

// Legacy shape: the source overwrites the record's `taskType`. Callers that
// need the record as stored use findTaskWithSource.
export async function getTaskById(taskId) {
  const found = await findTaskWithSource(taskId);
  return found ? { ...found.task, taskType: found.source } : null;
}

async function uniqueTaskId(source, id, tasks) {
  const taken = async (candidate) => tasks.some((task) => task.id === candidate) || Boolean(await getStoredTask(candidate, source));
  if (!await taken(id)) return id;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${id}-dup${suffix}`;
    if (!await taken(candidate)) return candidate;
  }
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
export async function addTask(taskData, taskType = 'user', options = {}) {
  // Only addition is replayed: it has no effects before persistence. Re-read
  // both queues and recompute dedup/IDs on conflict; never retry a stale plan.
  // Other mutations surface 409 so decisions or side effects are not replayed.
  for (let attempt = 0; ; attempt++) {
    const result = await addTaskAttempt(taskData, taskType, options).catch(error => {
      if (error.code !== 'COS_TASK_LIST_CONFLICT' || attempt >= 3) throw error;
      return null;
    });
    if (result !== null) return result;
  }
}

async function addTaskAttempt(taskData, taskType, { raw = false, ignoreTaskId = null, now = Date.now(), suppressDequeue = false, idempotencyKey = null }) {
  validateRequest(cosTaskTypeSchema, taskType);
  if (!raw && taskData.metadata) taskData = { ...taskData, metadata: newAuditMetadata(taskData.metadata) };
  return withStateLock(async () => {
  // Durable dispatchers replay the same row, including old completed history.
  // Ordinary clock-generated tasks retain uniqueTaskId's suffix behavior.
  if (idempotencyKey !== null) {
    if (!raw || !taskData.id || typeof idempotencyKey !== 'string' || !idempotencyKey) throw new Error('Idempotent task dispatch requires a raw task id and nonempty key');
    const stored = await getStoredTask(taskData.id, taskType);
    if (stored) {
      if (stored.task.metadata?.idempotencyKey !== idempotencyKey) throw new Error('Idempotent task id belongs to a different dispatch');
      return { ...stored.task, duplicate: true };
    }
    taskData = { ...taskData, metadata: { ...taskData.metadata, idempotencyKey } };
  }
  const tasks = await readTaskFile(taskType);

  if (taskData.metadata?.cleanupRefillSource) {
    const valid = await (await import('./swarmCleanupDelivery.js')).validCleanupRefillSource(
      taskData.metadata.cleanupRefillSource, taskData.metadata.analysisType, taskData.metadata.app,
    ).catch(() => false);
    if (!valid) return { error: 'The swarm cleanup continuation source changed before admission' };
  }

  // A verified, delivered swarm may still own retained checkouts. Its cleanup
  // task stays in progress, but it no longer owns the unpinned drain slot.
  // Resolve the server's agent receipt under the same lock as admission.
  const cleanupOnlyIds = isTruthyMeta(taskData.metadata?.perpetual)
    && isTruthyMeta(taskData.metadata?.claimFlow) && !taskData.metadata?.claimTarget
    ? await (await import('./swarmCleanupDelivery.js')).verifiedCleanupSwarmTaskIds(tasks,
      { allowSourceAgentId: taskData.metadata?.cleanupRefillSource }).catch(() => new Set())
    : new Set();

  // One state lock covers BOTH queues: manual and autonomous producers
  // must acquire the same durable work identity even with different titles.
  const newWorkIdentity = developmentWorkIdentity(taskData);
  const dependencies = {};
  if (newWorkIdentity) {
    const other = await readTaskFile(taskType === 'user' ? 'internal' : 'user');
    dependencies[taskType === 'user' ? 'internal' : 'user'] = listSnapshots.get(other).version;
    const owner = [...tasks, ...other].find(task => task.id !== ignoreTaskId && !cleanupOnlyIds.has(task.id)
      && DEVELOPMENT_ACTIVE_STATUSES.has(task.status) && sameDevelopmentWork(task, taskData)
      // Targeted claims and the backlog drain coexist in either admission order.
      // Otherwise a completed drain cannot refill while a targeted claim runs:
      // the on-demand request is consumed as a duplicate with nothing queued.
      // Two claims of the same issue, or two unpinned drains, still deduplicate.
      && !(newWorkIdentity.kind === 'issue'
        && (newWorkIdentity.key === '*') !== (developmentWorkIdentity(task)?.key === '*')));
    if (owner) return { ...owner, duplicate: true };
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
    t.id !== ignoreTaskId && !cleanupOnlyIds.has(t.id) &&
    (t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked') &&
    firstLine(t.description).toLowerCase() === normalizedDesc &&
    (t.metadata?.app || null) === targetApp &&
    auditWorkflow(t.metadata) === auditWorkflow(taskData.metadata)
  );
  if (duplicate) {
    console.log(`⚠️ Duplicate task rejected: "${normalizedDesc.substring(0, 60)}" matches ${duplicate.id}${duplicate.status === 'blocked' ? ` (blocked: ${duplicate.metadata?.blockedCategory || 'unknown'})` : ''}`);
    return { ...duplicate, duplicate: true };
  }

  // When raw=true, use the pre-built task object directly (for on-demand/generated tasks)
  let newTask = raw ? taskData : buildQueuedTask(taskData, taskType, { now });

  // A raw producer mints its own id and this path writes it verbatim, but the
  // next READ rewrites an unregistered prefix to `task-<id>` — so a producer
  // that re-derives its id instead of keeping the one returned here misses on
  // every later read and write, silently (those call sites are best-effort).
  // The preflight card lost a whole pr-reviewer run that way. The fix is to
  // register the prefix in lib/taskParser.js, not to rename the producer.
  if (raw && newTask?.id && !hasKnownPrefix(newTask.id)) {
    console.error(`❌ Task id ${newTask.id} uses an unregistered prefix — it will be read back as task-${newTask.id}. Register the prefix in lib/taskParser.js`);
  }

  // Ids are the row key and are minted from the clock, so two tasks created in the
  // same millisecond collide. Suffix `-dup2`, `-dup3`, ... as the Markdown reader
  // always did, but checked against every stored task, not just the working set.
  if (newTask?.id) {
    const id = await uniqueTaskId(taskType, newTask.id, tasks);
    if (id !== newTask.id) newTask = { ...newTask, id };
  }

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

  // Never accept proof supplied by an intake caller. A record with prior run
  // accounting is not a new episode merely because it was inserted here.
  const initialMetadata = { ...(newTask.metadata || {}) };
  delete initialMetadata.spawnBudgetProof;
  delete initialMetadata.spawnBudgetReconciledHold;
  const pristine = newTask.status === 'pending' && SPAWN_HISTORY_METADATA_KEYS.every(key => initialMetadata[key] == null);
  newTask = { ...newTask, metadata: { ...initialMetadata, ...(pristine ? { spawnBudgetProof: newSpawnBudgetEpisode() } : {}) } };

  // Add task to top or bottom based on position parameter
  if (taskData.position === 'top') {
    tasks.unshift(newTask);
  } else {
    tasks.push(newTask);
  }

  await writeTaskList(taskType, tasks, tasks, dependencies);

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
 *
 * `expectedStatus`, when supplied, is checked under the task-file lock. A mismatch
 * returns `{ statusChanged: true }` without writing or retiring pause state.
 */
export async function updateTask(taskId, updates, taskType = 'user', { now = Date.now(), suppressDequeue = false, suppressCompletionWake = false, expectedStatus = null, expectedMetadata = null, expectedTask = null, recoveryOwner = null, preserveRetryBudget = false, spawnBudgetOperation = null } = {}) {
  validateRequest(cosTaskTypeSchema, taskType);
  const release = await preparePauseRelease(taskId, updates);
  const result = await writeTaskUpdate(taskId, release ? { ...updates, metadata: release.metadata } : updates, taskType, { now, suppressDequeue, suppressCompletionWake, expectedStatus, expectedMetadata, expectedTask, recoveryOwner, preserveRetryBudget, spawnBudgetOperation });
  if (release && !result?.error && !result?.statusChanged) {
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

// The charged failure budget: cleared on leaving `blocked` unless a verified
// release or a preserving recovery keeps it.
const RETRY_BUDGET_KEYS = Object.freeze(['failureCount', 'lastErrorCategory', 'lastFailureAt']);

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
  // An explicit retry or new cycle cancels the old cleanup coordinator.
  ['isRequeue', ['deliveryRecovery', 'deliveryRecoveryAgentId']],
  ['isRevive', ['deliveryRecovery', 'deliveryRecoveryAgentId']],
  // Leaving `blocked` by any door — a dedupe revive, an autopilot re-dispatch, an
  // orphan-cooldown expiry, or a human unblocking it from the task list. Clearing
  // only in `resumeAgent` left every one of those paths running a task that still
  // advertised a live pause: the UI kept showing it parked, and `resumeAgent` on the
  // still-paused agent record then read its own pause as spent and spawned a SECOND
  // agent on a fresh task. The failure counters go too, or the revived task
  // re-blocks on the budget it blocked with.
  ['leavesBlocked', ['blocker', 'blockedReason', 'blockedCategory', 'blockedAt', 'deliveryDecisionAgentId', ...RETRY_BUDGET_KEYS, ...PAUSE_METADATA_KEYS]],
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

async function writeTaskUpdate(taskId, updates, taskType, options) {
  return withStateLock(() => writeTaskUpdateLocked(taskId, updates, taskType, options));
}

const LIVE_OWNER_STATUSES = ['running', 'paused'];
const DEPENDENCY_RELEASE_BINDING_KEYS = ['sourceAgentId', 'sourceStartedAt', 'ownerAgentId', 'ownerStartedAt', 'ownerTaskId', 'instanceId', 'repoPath', 'prUrl'];
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

// A live registered agent or an in-memory agent other than `exceptAgentId` holds the task.
function hasCompetingTaskOwner({ owners, taskId, exceptAgentId = null }) {
  return Object.values(owners.agents || {}).some(agent => agent.id !== exceptAgentId
    && agent.taskId === taskId && LIVE_OWNER_STATUSES.includes(agent.status))
    || [activeAgents, runnerAgents].some(entries => [...entries].some(([id, agent]) => id !== exceptAgentId
      && (agent.taskId || agent.task?.id) === taskId));
}

const trustedAgent = (owners, agentId) => (owners.trusted ? owners.agents?.[agentId] : null);

async function isStaleRecoveryOwner({ taskId, recoveryOwner }) {
  const owners = await readAgentsStateForSafetyCheck();
  if (!owners.trusted) return true;
  if (recoveryOwner.requireInactive && hasCompetingTaskOwner({ owners, taskId })) return true;
  const registered = owners.agents?.[recoveryOwner.id];
  if (recoveryOwner.requireRegistered && (!registered || registered.taskId !== taskId || registered.status !== 'completed'
    || registered.startedAt !== recoveryOwner.startedAt
    || !isDeepStrictEqual(registered.metadata, recoveryOwner.expectedOwnerMetadata))) return true;
  return hasCompetingTaskOwner({ owners, taskId, exceptAgentId: recoveryOwner.id })
    || (!!registered && registered.startedAt !== recoveryOwner.startedAt);
}

function acceptsCompletionProof({ owners, current, taskId, taskType, priorProof, nextCount, spawnBudgetOperation }) {
  const agent = trustedAgent(owners, spawnBudgetOperation.agentId);
  return validSpawnBudgetEpisode(priorProof) && spawnBudgetOperation.epoch === priorProof.epoch
    && !!agent && ['running', 'completed'].includes(agent.status) && !!agent.startedAt
    && !hasCompetingTaskOwner({ owners, taskId, exceptAgentId: agent.id })
    && matchesSpawnBudgetProof({ ...current, taskType }, agent)
    && nextCount !== null && !(nextCount > spawnBudgetCount(priorProof.dispatch.totalSpawnCount));
}

function acceptsDispatchProof({ owners, agent, current, taskId, updatedMetadata, spawnBudgetOperation }) {
  const count = spawnBudgetCount(updatedMetadata.totalSpawnCount);
  const before = spawnBudgetCount(current.metadata?.totalSpawnCount ?? 0);
  return !!agent && agent.id === spawnBudgetOperation.agentId && agent.taskId === taskId && agent.status === 'running'
    && !!agent.startedAt && agent.startedAt === spawnBudgetOperation.startedAt
    && !hasCompetingTaskOwner({ owners, taskId, exceptAgentId: agent.id })
    && count !== null && before !== null && count === before + 1
    && !!updatedMetadata.claimedBy && !!updatedMetadata.claimedAt && !!updatedMetadata.lastSpawnedAt;
}

// Store-owned spawn-budget provenance. Mutates `updatedMetadata`; returns a
// refusal for the caller to return, or null to continue the write.
async function applySpawnBudgetOperation({ current, taskId, taskType, updatedMetadata, spawnBudgetOperation }) {
  // Provenance is owned by the store, not by callers carrying task snapshots.
  delete updatedMetadata.spawnBudgetProof;
  const priorProof = current.metadata?.spawnBudgetProof;
  if (validSpawnBudgetEpisode(priorProof)) updatedMetadata.spawnBudgetProof = priorProof;
  // A reconciliation never grants a retry. Keep the hold until an explicit
  // reset, including when a stale completion supplies its older metadata.
  delete updatedMetadata.spawnBudgetReconciledHold;
  if (current.metadata?.spawnBudgetReconciledHold === 'true') updatedMetadata.spawnBudgetReconciledHold = 'true';
  const kind = spawnBudgetOperation?.kind;
  if (kind === 'reconcile') updatedMetadata.spawnBudgetReconciledHold = 'true';
  const oldCount = spawnBudgetCount(current.metadata?.totalSpawnCount ?? 0);
  const nextCount = spawnBudgetCount(updatedMetadata.totalSpawnCount ?? 0);
  if (kind === 'completion') {
    const owners = await readAgentsStateForSafetyCheck();
    if (!acceptsCompletionProof({ owners, current, taskId, taskType, priorProof, nextCount, spawnBudgetOperation })) {
      return { statusChanged: true, task: current };
    }
  }
  // A generic counter edit may be an operator decision. It cannot be evidence
  // that the current episode survived unchanged.
  if (!spawnBudgetOperation && oldCount !== nextCount) delete updatedMetadata.spawnBudgetProof;
  if (kind === 'reset') {
    if (nextCount === null) delete updatedMetadata.spawnBudgetProof;
    else updatedMetadata.spawnBudgetProof = newSpawnBudgetEpisode(nextCount);
    delete updatedMetadata.spawnBudgetReconciledHold;
  }
  if (kind === 'dispatch' && validSpawnBudgetEpisode(priorProof)) {
    const owners = await readAgentsStateForSafetyCheck();
    const agent = trustedAgent(owners, spawnBudgetOperation.agentId);
    if (!acceptsDispatchProof({ owners, agent, current, taskId, updatedMetadata, spawnBudgetOperation })) {
      return { error: 'Cannot establish spawn budget dispatch proof' };
    }
    const history = [...(priorProof.history || []), ...(priorProof.dispatch ? [priorProof.dispatch] : [])];
    updatedMetadata.spawnBudgetProof = { ...priorProof, history, dispatch: { agentId: spawnBudgetOperation.agentId, startedAt: agent.startedAt,
      claimedBy: updatedMetadata.claimedBy, claimedAt: updatedMetadata.claimedAt,
      lastSpawnedAt: updatedMetadata.lastSpawnedAt, totalSpawnCount: spawnBudgetCount(updatedMetadata.totalSpawnCount) } };
  }
  return null;
}

function isVerifiedDependencyRelease({ current, updates, expectedStatus, expectedTask, recoveryOwner, preserveRetryBudget }) {
  const dependencyWait = current.metadata?.investigationDependencyWait;
  const dependencyReady = updates.metadata?.investigationDependencyWait;
  return !!(preserveRetryBudget && expectedStatus === 'blocked' && expectedTask && recoveryOwner
    && current.metadata?.blockedCategory === 'internal-dependency' && updates.status === 'pending'
    && dependencyWait?.version === 1 && dependencyWait.phase === 'waiting' && dependencyReady?.phase === 'ready'
    && dependencyWait.sourceAgentId === recoveryOwner.id && dependencyWait.sourceStartedAt === recoveryOwner.startedAt
    && DEPENDENCY_RELEASE_BINDING_KEYS.every(key => dependencyWait[key] === dependencyReady[key])
    && COMMIT_SHA_PATTERN.test(dependencyReady.proof?.head || '')
    && COMMIT_SHA_PATTERN.test(dependencyReady.proof?.mergeCommit || ''));
}

// The metadata a preserved retry budget is copied from, or null. The three
// rules require different target statuses, so at most one applies.
function retainedRetryBudgetSource({ current, updates, transition, expectedStatus, expectedTask, recoveryOwner, preserveRetryBudget, spawnBudgetOperation }) {
  if (!preserveRetryBudget || expectedStatus !== 'blocked' || !expectedTask) return null;
  if (spawnBudgetOperation?.kind === 'reset' && spawnBudgetOperation.requireInactive
    && recoveryOwner?.requireInactive && updates.status === 'pending') return current.metadata || {};
  // Automatic delivery recovery continues the charged attempt, unlike an
  // explicit human revive. Persist its budget in the same write as its hold.
  if (transition.leavesBlocked && updates.status === 'in_progress'
    && typeof updates.metadata?.retryPendingCleanup === 'string') return updates.metadata;
  // Receipt-only completion is not a human revive. Keep the charged failure
  // history when the original cleanup owner settles an exhausted dispatch.
  if (recoveryOwner && updates.status === 'completed' && current.metadata?.blockedCategory === 'task-recovery-exhausted'
    && current.metadata.deliveryRecovery === 'cleanup' && current.metadata.deliveryRecoveryAgentId === recoveryOwner.id) return current.metadata;
  return null;
}

function deepAuditRequeueError({ current, updates, expectedStatus, expectedMetadata }) {
  if (updates.status !== 'pending') return null;
  if (isLegacyDeepAudit(current.metadata)) return 'Historical Deep certification tasks are read-only; start a new Deep audit';
  if (current.metadata?.auditDepth !== 'deep' || !isRetryHeld(current.metadata)) return null;
  // Extended audits retry normally after cleanup. Only the guarded release of
  // this exact persisted hold may make one spawnable; a bare Resume/Run must
  // still wait, and legacy certification records remain read-only above.
  const releasesCurrentHold = expectedStatus === 'in_progress'
    && expectedMetadata?.[RETRY_HOLD_KEY] === current.metadata[RETRY_HOLD_KEY]
    && Object.hasOwn(updates.metadata || {}, RETRY_HOLD_KEY)
    && updates.metadata[RETRY_HOLD_KEY] === undefined;
  return releasesCurrentHold ? null : 'Deep checkpoint cleanup is still pending; resume after cleanup finishes';
}

const isRuntimeVerificationHeld = (task) => task.status === 'blocked' && task.metadata?.blockedCategory === 'runtime-verification';

function isRuntimeVerificationRelease({ current, updates, expectedStatus, expectedMetadata }) {
  return isRuntimeVerificationHeld(current) && updates.status === 'pending'
    && expectedStatus === 'blocked' && expectedMetadata?.runtimeVerificationId === current.metadata.runtimeVerificationId
    && updates.metadata?.runtimeVerification?.status === 'resumed';
}

// Caller holds withStateLock, including its status and ownership decision.
async function writeTaskUpdateLocked(taskId, updates, taskType, { now, suppressDequeue = false, suppressCompletionWake = false, expectedStatus = null, expectedMetadata = null, expectedTask = null, recoveryOwner = null, preserveRetryBudget = false, spawnBudgetOperation = null }) {
  const tasks = await readTaskFile(taskType);

  let taskIndex = tasks.findIndex(t => t.id === taskId);
  // A history item older than the working set can still be edited or reopened:
  // fetch it by id into the list being saved; the save upserts its row in place.
  if (taskIndex === -1) {
    const stored = await getStoredTask(taskId, taskType);
    if (stored) {
      tasks.push(stored.task);
      taskIndex = tasks.length - 1;
    }
  }
  if (taskIndex === -1) {
    console.log(`⚠️ updateTask: task ${taskId} not found in the ${taskType} queue (working set of ${tasks.length} tasks, status update: ${updates.status || 'none'})`);
    return { error: 'Task not found' };
  }

  // Deterministic sweepers can retire a queued task only while it is still
  // pending. Check under the same lock as the write so a concurrent dequeue or
  // user action cannot be overwritten by a stale queue snapshot.
  if (expectedStatus && tasks[taskIndex].status !== expectedStatus) {
    return { statusChanged: true, task: tasks[taskIndex] };
  }

  const current = tasks[taskIndex];
  if (spawnBudgetOperation?.kind === 'reset' && spawnBudgetOperation.requireInactive && isLeaseLive(current.metadata)) {
    return { statusChanged: true, task: current };
  }
  // These fields bind an immutable publication dispatch. Ordinary edits,
  // retries and stale completion patches cannot revoke its durable owner.
  if (current.metadata?.releaseSynchronization && updates.metadata) {
    const nextMetadata = storedForm({ ...current, metadata: { ...current.metadata, ...updates.metadata } }, taskType).metadata;
    if (RELEASE_SYNC_FROZEN_METADATA_KEYS.some(key => !isDeepStrictEqual(current.metadata[key], nextMetadata[key]))) {
      return { error: 'Release synchronization dispatch ownership is immutable' };
    }
  }
  if (expectedTask && Object.entries(expectedTask).some(([key, value]) => !isDeepStrictEqual(current[key], value))) {
    return { statusChanged: true, task: current };
  }
  if (recoveryOwner && await isStaleRecoveryOwner({ taskId, recoveryOwner })) return { statusChanged: true, task: current };
  if (expectedMetadata && Object.entries(expectedMetadata).some(([key, value]) => current.metadata?.[key] !== value)) {
    return { statusChanged: true, task: current };
  }

  const deepAuditError = deepAuditRequeueError({ current, updates, expectedStatus, expectedMetadata });
  if (deepAuditError) return { error: deepAuditError };

  const runtimeRelease = isRuntimeVerificationRelease({ current, updates, expectedStatus, expectedMetadata });
  if (isRuntimeVerificationHeld(current) && updates.status && updates.status !== 'blocked' && !runtimeRelease) {
    return { error: 'Runtime verification prerequisite must be released by its server coordinator' };
  }
  const updatedMetadata = mergeUpdateMetadata(tasks[taskIndex].metadata, updates);

  const spawnBudgetRefusal = await applySpawnBudgetOperation({ current, taskId, taskType, updatedMetadata, spawnBudgetOperation });
  if (spawnBudgetRefusal) return spawnBudgetRefusal;

  // Ask "what status transition is this?" ONCE. Every lifecycle rule below reads a
  // field off this descriptor instead of re-deriving an answer from
  // `(previousStatus, updates.status)` at its own site — which is how the retry-hold
  // clear and the claim release ended up as the same predicate written twice, and
  // how the requeue stamp and the emitted action came to key on the same edge from
  // 52 lines apart while having to agree (#6620).
  const previousStatus = tasks[taskIndex].status;
  const transition = resolveTaskStatusTransition(previousStatus, updates.status);

  const dependencyRelease = isVerifiedDependencyRelease({ current, updates, expectedStatus, expectedTask, recoveryOwner, preserveRetryBudget });

  // Retire the metadata this transition releases. Ordered — see the table's note on
  // the `blockedCategory` clear feeding the resume-pointer check below.
  for (const [field, keys] of TRANSITION_METADATA_CLEARS) {
    if (!transition[field]) continue;
    for (const key of keys) {
      if ((runtimeRelease || dependencyRelease) && RETRY_BUDGET_KEYS.includes(key)) continue;
      delete updatedMetadata[key];
    }
  }
  const retainedBudget = retainedRetryBudgetSource({ current, updates, transition, expectedStatus, expectedTask, recoveryOwner, preserveRetryBudget, spawnBudgetOperation });
  for (const key of retainedBudget ? RETRY_BUDGET_KEYS : []) {
    if (Object.hasOwn(retainedBudget, key)) updatedMetadata[key] = retainedBudget[key];
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
    delete updatedMetadata.claimResumeInPlace;
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

  // Collapse a multi-line description to the one-line record the markdown row can
  // hold, re-homing the body into prompt/context rather than dropping it (#7240).
  const normalizedDescription = normalizeUpdatedDescription(updates.description, updatedMetadata);
  const nextMetadata = normalizedDescription ? normalizedDescription.metadata : updatedMetadata;
  const nextDescription = normalizedDescription ? normalizedDescription.description : updates.description;

  // Update the task. Through `toRepresentableTask` so the object we return and
  // emit on `tasks:changed` is the one the file will hold — repairing only inside
  // generateTasksMarkdown would leave every consumer reading the pre-repair status
  // until something re-read the file (#7239).
  const updatedTask = toRepresentableTask({
    ...tasks[taskIndex],
    ...(updates.description && { description: nextDescription }),
    ...(updates.priority && {
      priority: updates.priority.toUpperCase(),
      priorityValue: PRIORITY_VALUES[updates.priority.toUpperCase()] || 2
    }),
    ...(updates.status && { status: updates.status }),
    metadata: nextMetadata
  });

  tasks[taskIndex] = updatedTask;

  await writeTaskList(taskType, tasks);

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
  // An explicit cleanup-only action must not itself launch dependent work.
  if (suppressCompletionWake) change.suppressCompletionWake = true;
  cosEvents.emit('tasks:changed', change);
  return updatedTask;
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
export async function reviveBlockedTask(taskId, { priority, metadata } = {}, taskType = 'internal', { suppressDequeue = false, expectedStatus = null, expectedTask = null, recoveryOwner = null } = {}) {
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
  }, taskType, { suppressDequeue, expectedStatus, expectedTask, recoveryOwner, spawnBudgetOperation: { kind: 'reset' } });
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
export async function mergePeerTasks(taskType, remoteTasks, { now = Date.now(), legacySpawnBudget = false } = {}) {
  validateRequest(cosTaskTypeSchema, taskType);
  const { changed, count, merged } = await withStateLock(async () => {
    const localTasks = await readTaskFile(taskType);

    // A peer still advertises completed tasks this machine already holds in
    // history; merging them in would pull them back into the working set.
    const remoteCompletedIds = remoteTasks.filter((task) => task?.status === 'completed').map((task) => task.id);
    const knownCompleted = await getCompletedTaskIds(taskType, remoteCompletedIds);
    const incoming = knownCompleted.size === 0
      ? remoteTasks
      : remoteTasks.filter((task) => !(task?.status === 'completed' && knownCompleted.has(task.id)));

    const merged = mergeTaskLists(localTasks, incoming, { now });
    const localById = new Map(localTasks.map(task => [task.id, task]));
    const remoteById = new Map(incoming.map(task => [task.id, task]));
    for (const task of merged) {
      const remote = remoteById.get(task.id);
      if (!remote) continue;
      const local = localById.get(task.id);
      const localEpoch = local?.metadata?.spawnBudgetProof?.epoch;
      const remoteEpoch = remote.metadata?.spawnBudgetProof?.epoch;
      const localProof = local?.metadata?.spawnBudgetProof;
      const remoteProof = remote.metadata?.spawnBudgetProof;
      const differentProof = local && !isDeepStrictEqual(localProof, remoteProof);
      if ((!local || localEpoch === remoteEpoch) && (local?.metadata?.spawnBudgetReconciledHold === 'true'
        || remote.metadata?.spawnBudgetReconciledHold === 'true')) {
        task.metadata.spawnBudgetReconciledHold = 'true';
      }
      // Only an explicit chain of prior dispatch tuples establishes ancestry;
      // a higher counter alone cannot order concurrent peer dispatches.
      if (!legacySpawnBudget && differentProof && validSpawnBudgetEpisode(localProof)
        && validSpawnBudgetEpisode(remoteProof) && localEpoch === remoteEpoch) {
        const chain = proof => [...(proof.history || []), ...(proof.dispatch ? [proof.dispatch] : [])];
        const left = chain(localProof); const right = chain(remoteProof);
        const prefix = (shorter, longer) => shorter.length < longer.length
          && shorter.every((dispatch, position) => isDeepStrictEqual(dispatch, longer[position]));
        if (prefix(left, right)) task.metadata.spawnBudgetProof = remoteProof;
        else if (prefix(right, left)) task.metadata.spawnBudgetProof = localProof;
        else delete task.metadata.spawnBudgetProof;
      } else if (legacySpawnBudget || differentProof) {
        delete task.metadata.spawnBudgetProof;
      }
    }

    // Nothing the peer sent changed our state — skip the write (and the event that would
    // wake the scheduler). `merged` is still returned so the post-lock LI-verdict consume
    // (#2779) can run even on a no-op sweep — durability requires it (an old peer that
    // stored a terminal verdict before upgrading, or a crash before a prior consume, leaves
    // the task terminal with the merge producing no change, so a changed-only consume would
    // never catch up). Re-offering is cheap: the consumer is a durable no-op after the first.
    if (!await writeTaskList(taskType, merged, localTasks)) return { changed: false, merged };

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
  validateRequest(cosTaskTypeSchema, taskType);
  return withStateLock(async () => {
    const stored = await getStoredTask(taskId, taskType);
    if (stored?.task.metadata?.releaseSynchronization) return { error: 'Release synchronization owns a durable publication obligation; retain its task history' };
    // One row delete, whether the task is in the working set or old history. It
    // bumps the queue version, which is what makes the next read reload.
    if (await deleteStoredTask(taskId, taskType) === 0) return { error: 'Task not found' };
    cosEvents.emit('tasks:changed', { type: taskType, action: 'deleted', taskId });
    return { success: true, taskId };
  });
}

/**
 * Recover the scalar-version mismatch and retire genuinely unscreened system
 * tasks before they can occupy the scheduler's dedup slots. History remains;
 * a retired prompt is never upgraded by stamping it with a screening marker.
 * Ownership and fresh queue state are checked under the same lock as writes.
 */
export async function reconcileLegacyForgeMaintenanceTasks({ instanceId, now = Date.now() } = {}) {
  return withStateLock(async () => {
    const state = await loadState();
    const tasks = await readTaskFile('internal');
    let recovered = 0;
    let retired = 0;
    const resetApps = new Set();
    for (const task of tasks) {
      if (!isForgeMaintenanceTask(task) || getSkipReason(task.metadata, instanceId, now)
        || hasActiveTaskOwner(task.id, state.agents)) continue;
      const erroneousBlock = task.status === 'blocked'
        && task.metadata?.blockedCategory === 'provider-config'
        && task.metadata?.blockedReason === LEGACY_FORGE_MAINTENANCE_REASON;
      if (task.status !== 'pending' && !erroneousBlock) continue;
      const screened = hasCurrentForgeMaintenanceEvidence(task);
      if (screened && !erroneousBlock) continue;
      // Unknown future versions belong to their own compatibility contract.
      if (!screened && task.metadata?.forgeMaintenanceVersion != null) continue;
      if (!screened && task.metadata.analysisType === 'pr-watcher' && task.metadata.app
        && !resetApps.has(task.metadata.app)) {
        const { persistPrWatcherState } = await import('./prWatcher.js');
        // Old discovery may have acknowledged the PRs before screening existed.
        // Keep the baseline; empty activity makes current open PRs retryable.
        await persistPrWatcherState(task.metadata.app, { activityByPr: {} });
        resetApps.add(task.metadata.app);
      }
      await writeTaskUpdateLocked(task.id, {
        status: screened ? 'pending' : 'completed',
        metadata: screened
          ? { maintenanceRecoveredAt: new Date(now).toISOString() }
          : { resolution: 'superseded', supersededReason: 'unscreened-forge-maintenance', supersededAt: new Date(now).toISOString() }
      }, 'internal', { now, suppressDequeue: true });
      if (screened) recovered++; else retired++;
    }
    return { recovered, retired };
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
  // An in-progress investigation has a live agent diagnosing it; reaping it
  // would let a later finalize regress the status or spawn a second run (#12059).
  if (task.status === 'in_progress') return false;
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
    // Re-read BOTH queues and re-evaluate the reason under the same lock as the
    // write. Status/metadata pins protect a target from its own stale snapshot,
    // but an investigation also depends on its origins: one can be resumed after
    // this sweep's snapshot while the investigation itself stays pending (#12059).
    const updated = await withStateLock(async () => {
      const current = await getAllTasks();
      const currentTask = (type === 'user' ? current.user.tasks : current.cos.tasks)
        .find((candidate) => candidate.id === task.id);
      if (!currentTask) return { statusChanged: true };
      const currentById = new Map([...current.user.tasks, ...current.cos.tasks].map((candidate) => [candidate.id, candidate]));
      const currentReason = isReapableBlockedFailure(currentTask, { now, maxAgeMs })
        ? 'stale-failure-block'
        : (isReapableInvestigation(currentTask, currentById) ? 'investigation-resolved' : null);
      if (currentReason !== reason) return { statusChanged: true, task: currentTask };

      return writeTaskUpdateLocked(task.id, {
        status: 'completed',
        metadata: { resolution: 'auto-expired', autoExpiredReason: reason, autoExpiredAt: new Date(now).toISOString() }
      }, type, {
        now,
        expectedStatus: task.status,
        // A revived task can fail again before this write and return to blocked.
        // Preserve the category and every age fallback that justified this sweep.
        expectedMetadata: reason === 'stale-failure-block' ? {
          blockedCategory: task.metadata?.blockedCategory,
          blockedAt: task.metadata?.blockedAt,
          lastFailureAt: task.metadata?.lastFailureAt,
          updatedAt: task.metadata?.updatedAt,
        } : null,
      });
    });
    if (updated?.error || updated?.statusChanged) continue;
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
  const tasks = await readTaskFile('user');

  // Create a map of tasks by ID for quick lookup. Ids are the row key, so this
  // Map can't silently collapse colliding tasks and drop them on write-back.
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

  await writeTaskList('user', reorderedTasks, tasks);

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
  // Both queues, internal first. A USER row can hold too: a row the parser had
  // to RECOVER is withheld from the unattended spawn and now persists that hold
  // as `| APPROVAL |` (#7300, #7367). Without a release path here that row is a
  // zombie — pending forever, with nothing in the product able to clear it —
  // which is a worse outcome than the evaporating hold it replaced.
  let found = null;
  for (const taskType of ['internal', 'user']) {
    const tasks = await readTaskFile(taskType);
    const taskIndex = tasks.findIndex(t => t.id === taskId);
    if (taskIndex !== -1) {
      found = { taskType, tasks, taskIndex };
      break;
    }
  }

  if (!found) {
    return { error: 'Task not found' };
  }

  const { taskType, tasks, taskIndex } = found;

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

  await writeTaskList(taskType, tasks);

  cosEvents.emit('tasks:changed', { type: taskType, action: 'approved', task: tasks[taskIndex] });

  const { removeByMetadata } = await import('./notifications.js');
  await removeByMetadata('taskId', taskId).catch(() => {});

  return tasks[taskIndex];
  });
}

/**
 * Record a sub-agent's challenge of a reviewer rejection (#2441).
 *
 * Parks the task in the `challenged` status with the worker's case attached and
 * consumes one of its bounded challenge slots (MAX_CHALLENGES_PER_TASK). A second
 * dispute on the same task is refused — the acceptance contract is "exactly one
 * per task." Read, budget check, and write share the completion/state lock.
 *
 * @returns the updated task, or `{ error, code }` on not-found / budget-exhausted.
 */
export async function challengeTask(taskId, { reason, evidence, reviewer } = {}, taskType = 'user', { now = Date.now() } = {}) {
  return withStateLock(async () => {
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
    const updated = await writeTaskUpdateLocked(taskId, { status: 'challenged', metadata: patch }, resolvedType, { now });
    if (updated?.error) return updated;
    console.log(`⚖️ Task ${taskId} challenged (${patch.challengeCount}/${MAX_CHALLENGES_PER_TASK})${patch.challenge.reviewer ? ` — disputing ${patch.challenge.reviewer}` : ''}`);
    cosEvents.emit('task:challenged', { taskId, taskType: resolvedType, reviewer: patch.challenge.reviewer || null });
    return updated;
  });
}

/**
 * Resolve a parked challenge (#2441). `upheld` overturns the rejection and
 * preserves its active owner (→ in_progress), or requeues an unowned task
 * (→ pending); `escalated` hands the unresolved dispute to
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
  const resolution = await withStateLock(async () => {
    const task = await getTaskById(taskId);
    if (!task) return { error: 'Task not found', code: 'NOT_FOUND' };
    if (task.status !== 'challenged') {
      return { error: 'Task is not under challenge', code: 'NOT_CHALLENGED' };
    }
    const resolvedType = task.taskType || taskType;
    const resolutionPatch = buildChallengeResolutionPatch({ outcome, note, resolvedBy, now });
    if (!resolutionPatch) return { error: `Invalid challenge outcome: ${outcome}`, code: 'INVALID_OUTCOME' };

    const state = await loadState();
    const nextStatus = outcome === 'upheld'
      ? (hasActiveTaskOwner(taskId, state.agents) ? 'in_progress' : 'pending')
      : 'blocked';
    const metadataPatch = { ...resolutionPatch };
    if (outcome === 'escalated') {
      metadataPatch.blockedReason = 'Challenge unresolved — escalated to user for arbitration';
      metadataPatch.blockedCategory = 'challenge-escalation';
    }
    const updated = await writeTaskUpdateLocked(taskId, { status: nextStatus, metadata: metadataPatch }, resolvedType, { now });
    if (updated?.error) return updated;
    return { task, updated, nextStatus, resolvedType };
  });
  if (resolution.error) return resolution;
  const { task, updated, nextStatus, resolvedType } = resolution;

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
