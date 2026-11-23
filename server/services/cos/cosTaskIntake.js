/**
 * CoS task INTAKE — the pure mapping from a non-raw `addTask` request onto the task
 * record the store persists.
 *
 * `lib/cos/cosValidation.js#createCosTaskSchema` says which top-level fields a request may
 * carry; this module says which reach `metadata`, and how. `cosTaskIntake.test.js` fails
 * when a schema field is added without a mapping here or an explicit non-metadata verdict.
 *
 * Internal producers (autopilot gaps, investigations, quota burn, GSD, Brain repo-intake)
 * pass fields the HTTP schema never sees; they are mapped here too so every non-raw
 * producer converges on one persist contract. The read-side twin is
 * `sanitizeTaskMetadata` (`lib/cos/cosValidation.js`).
 *
 * Pure: no fs, state or events. Persistence, dedup and the multi-line description →
 * `metadata.prompt` classification stay in `cosTaskStore.js`.
 */

import { hasKnownPrefix, PRIORITY_VALUES, toRepresentableTask } from '../../lib/taskParser.js';
import { SWARM_COUNT_MAX, SWARM_COUNT_MIN } from '../../lib/cos/cosTaskMetadata.js';
import { KEYED_REVIEWER_PINS, REVIEWER_OVERRIDE_KEYS, REVIEW_STOP_MODES, normalizeReviewers, normalizeReviewUsernames, normalizeOptionalReviewers } from '../../lib/reviewerConfig.js';
import { isPlainObject } from '../../lib/objects.js';
import { PR_COMPLETIONS, PR_COMPLETION_VALUES } from '../../lib/prDisposition.js';
import { quotaBurnProvenance, quotaBurnTaskMetadata } from '../../lib/quotaBurnOrigin.js';
import { normalizeOrchestrationMode, normalizeOrchestrationProfile } from '../../lib/orchestrationProfile.js';
import { TARGET_INSTANCE_KEY, getTargetInstance } from './cosTaskClaim.js';

// Declarative field-copy tables for `buildTaskMetadata`; each says what makes a top-level
// request field worth persisting. Fields with bespoke rules stay explicit in the function.
// Truthy value copied as-is.
const TRUTHY_KEYS = ['context', 'model', 'provider', 'effort', 'app', 'autopilotGapSeriesId', 'autopilotGapKind',
  'investigationFingerprint', 'approvalReason', 'slashdoCommand', 'slashdoArgs', 'workTracker', 'jiraTicketId', 'jiraTicketUrl'];
// Persist only `true`; `false` is not written because absent already means the default.
const TRUE_ONLY_KEYS = ['autonomousJob', 'voiceDispatch', 'isRecovery', 'isInvestigation', 'claimFlow',
  'discardWorktree', 'noCodeOutput', 'claimServerCheckout'];
// Persist both `true` and `false` so users can explicitly override defaults. The string forms
// ('false' on rows stored before #16407 and peers on older versions) are handled by
// isTruthyMeta/isFalsyMeta; undefined means "use app defaults".
const BOOLEAN_KEYS = ['noChangeSuccess', 'useWorktree', 'openPR', 'simplify', 'worktreeChangesExpected',
  'reviewLoop', 'reviewerApplies', 'useAutoMerge', 'autoApprovePR', 'adminMerge'];
const DEFINED_KEYS = ['executionOptions', 'temperature', 'thinking'];
const NON_EMPTY_STRING_KEYS = ['jobId', 'claimTarget', 'replanTarget'];
// Structured records (diagnostics, LI hand-off provenance, malware scan, repo-study link); a
// non-object / array is ignored.
const PLAIN_OBJECT_KEYS = ['malwareScan', 'repoStudy', 'diagnostics', 'liProposal'];
const NON_EMPTY_ARRAY_KEYS = ['affectedTasks', 'screenshots', 'attachments'];

/**
 * Map a request's top-level fields onto the task's `metadata` object.
 *
 * @param {object} taskData - the non-raw `addTask` request
 * @param {'user'|'internal'} taskType
 * @param {{ now?: number }} [options] - injectable clock for the LWW stamp
 * @returns {object} the metadata to persist
 */
export function buildTaskMetadata(taskData, taskType, { now = Date.now() } = {}) {
  // Planning is an explicit workflow mode, not just UI toggles; the server-side contract
  // stays authoritative for direct API callers and older clients sending only plan-task.
  const planOnly = taskData.planOnly === true || taskData.slashdoCommand === 'plan-task';
  // Internal producers (resume replacement, GSD) may provide a prebuilt metadata seed; copy
  // it first so task-specific contracts survive a non-raw write. Explicit top-level fields
  // below stay authoritative over matching seed keys.
  const metadata = isPlainObject(taskData.metadata) ? { ...taskData.metadata } : {};
  for (const key of TRUTHY_KEYS) if (taskData[key]) metadata[key] = taskData[key];
  for (const key of TRUE_ONLY_KEYS) if (taskData[key] === true) metadata[key] = true;
  for (const key of BOOLEAN_KEYS) if (typeof taskData[key] === 'boolean') metadata[key] = taskData[key];
  for (const key of DEFINED_KEYS) if (taskData[key] !== undefined) metadata[key] = taskData[key];
  for (const key of NON_EMPTY_STRING_KEYS) if (typeof taskData[key] === 'string' && taskData[key]) metadata[key] = taskData[key];
  for (const key of PLAIN_OBJECT_KEYS) if (isPlainObject(taskData[key])) metadata[key] = taskData[key];
  for (const key of NON_EMPTY_ARRAY_KEYS) if (Array.isArray(taskData[key]) && taskData[key].length > 0) metadata[key] = taskData[key];
  // The full agent-facing payload when the producer names it. Producers passing a multi-line
  // `context` are classified by `splitTaskPromptFields` in `cosTaskStore.js#addTask`.
  if (typeof taskData.prompt === 'string') metadata.prompt = taskData.prompt;
  // Orchestrated execution. Both keys persist only when they survive normalization, so a
  // mode with no usable profile leaves the task `direct` rather than stamping an inert
  // override. The default mode is never written (absent already means `direct`).
  const orchestrationProfile = normalizeOrchestrationProfile(taskData.orchestrationProfile);
  if (orchestrationProfile) metadata.orchestrationProfile = orchestrationProfile;
  if (normalizeOrchestrationMode(taskData.orchestrationMode) === 'orchestrated') {
    metadata.orchestrationMode = 'orchestrated';
  }
  // Pin this task to ONE federated instance: only that instance's CoS evaluator claims it.
  // Absent keeps opportunistic first-claim-wins. Normalized through the spawn guards' reader,
  // so a blank value stores as unpinned, not as a target no instance can match.
  const targetInstance = getTargetInstance(taskData);
  if (targetInstance) metadata[TARGET_INSTANCE_KEY] = targetInstance;
  if (taskData.createJiraTicket) metadata.createJiraTicket = true;
  if (taskData.whenDone === 'commit-push' || taskData.whenDone === 'leave-uncommitted') metadata.whenDone = taskData.whenDone;
  // Default a worktree-isolated USER task to opening a PR rather than auto-merging: an
  // unreviewed agent commit landing on main is the more dangerous default. Fires only when
  // openPR wasn't set AND a worktree was requested; an explicit `openPR: false` wins, and
  // internal/system tasks keep auto-merge so automation isn't gated on a human merging a PR.
  if (taskData.openPR === undefined && taskData.useWorktree === true && taskType === 'user') metadata.openPR = true;
  if (PR_COMPLETION_VALUES.includes(taskData.prCompletion)) {
    metadata.prCompletion = taskData.prCompletion;
  } else if (metadata.openPR === true && taskType === 'user') {
    // New user tasks should persist their explicit default; legacy records
    // remain untouched and resolve from reviewLoop at read time.
    metadata.prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE;
  }
  // Ordered multi-reviewer list (normalizes legacy single `reviewer` too).
  if (Array.isArray(taskData.reviewers) || (typeof taskData.reviewer === 'string' && taskData.reviewer)) {
    metadata.reviewers = normalizeReviewers(taskData);
  }
  // Arbitrary GitHub reviewer usernames (gate-only PR reviewers). Persist the normalized
  // list, or an explicit empty array so a per-task "none" overrides the Code Review Defaults.
  if (Array.isArray(taskData.usernames)) {
    metadata.usernames = normalizeReviewUsernames(taskData.usernames);
  }
  // Non-blocking (`~opt`) reviewer set. Same explicit-empty semantics as `usernames`: an
  // empty array is a real "none optional for this task" choice overriding the defaults.
  if (Array.isArray(taskData.optionalReviewers)) {
    metadata.optionalReviewers = normalizeOptionalReviewers(taskData.optionalReviewers) || [];
  }
  // Token-keyed per-reviewer pins (caps / model / effort), keyed by the emitted
  // `--review-with` token. An explicitly empty MAP means "use each reviewer's default" and
  // overrides the Code Review Defaults; unvalidatable entries are dropped, not coerced.
  // Iterates the shared KEYED_REVIEWER_PINS so this path can't drift from `sanitizeTaskMetadata`.
  for (const [key, normalizeMap] of KEYED_REVIEWER_PINS) {
    if (!isPlainObject(taskData[key])) continue;
    metadata[key] = normalizeMap(taskData[key]) || {};
  }
  if (REVIEW_STOP_MODES.includes(taskData.reviewStopMode)) metadata.reviewStopMode = taskData.reviewStopMode;
  // Manual `/do:next` claim swarms are non-raw tasks; agentLifecycle needs this count after
  // the markdown round-trip to lift a cloud Codex session to root + configured workers.
  const swarmCount = Number(taskData.swarmCount);
  if (Number.isSafeInteger(swarmCount) && swarmCount >= SWARM_COUNT_MIN && swarmCount <= SWARM_COUNT_MAX) {
    metadata.swarmCount = swarmCount;
  }
  // Quota-burn provenance: which family's window this task spends, which window refuses
  // first, which burn step and on-demand request asked. The built-in lane stamps these via
  // `lib/quotaBurnOrigin.js` through the RAW path in `cosTaskStore.js#addTask`; a
  // custom-job burn arrives here. Both spread the SAME block so the lanes cannot carry
  // different provenance (mapping keys one at a time let `quotaBurnStepId` reach disk but
  // not the agent). `quotaBurnOrigin.js` owns the why of each field.
  Object.assign(metadata, quotaBurnTaskMetadata(quotaBurnProvenance(taskData)));
  if (planOnly) {
    // Plan-and-file is a single bounded CoS action; the bundled plan-task command is
    // issue-only, so pass its `--yes` to make issue-filing unattended.
    metadata.planOnly = true;
    metadata.slashdoCommand = 'plan-task';
    metadata.slashdoArgs = '--yes';
    metadata.readOnly = true;
    metadata.noCodeOutput = true;
    metadata.useWorktree = false;
    metadata.openPR = false;
    metadata.simplify = false;
    metadata.reviewLoop = false;
    metadata.worktreeChangesExpected = false;
    delete metadata.createJiraTicket;
    delete metadata.prCompletion;
    // Includes legacy singular `reviewer`, which a seeded metadata object may carry.
    for (const key of REVIEWER_OVERRIDE_KEYS) delete metadata[key];
  }
  // Recovery owns the actual checkout and every preservation PR. Do not let
  // generic delivery defaults create a coordinator worktree or publish it.
  if (taskData.workflow === 'app-checkout-recovery' && !planOnly) {
    metadata.analysisType = taskData.workflow;
    metadata.useWorktree = false;
    metadata.openPR = false;
    metadata.simplify = false;
    metadata.reviewLoop = false;
    delete metadata.whenDone;
  }
  // Content-edit timestamp for cross-peer newest-edit-wins LWW. Stamped at creation so a new
  // task always carries one (the merge treats absent as oldest, so this also stops it
  // losing a same-status tie to a legacy un-stamped copy). `now` is injectable for
  // deterministic markdown under test. Raw tasks keep whatever stamp they arrive with.
  metadata.updatedAt = new Date(now).toISOString();
  return metadata;
}

/**
 * Build the pending task record a non-raw `addTask` request persists.
 *
 * @param {object} taskData
 * @param {'user'|'internal'} taskType
 * @param {{ now?: number }} [options]
 */
export function buildQueuedTask(taskData, taskType, { now = Date.now() } = {}) {
  // Generate a unique ID if not provided
  const id = taskData.id || `${taskType === 'user' ? 'task' : 'sys'}-${Date.now().toString(36)}`;
  const metadata = buildTaskMetadata(taskData, taskType, { now });
    // Through `toRepresentableTask` so the returned object is the one TASKS.md will hold: an
    // internal producer bypassing the HTTP schema can hand us a priority the format cannot
    // write, and repairing only at write time would make the return disagree with the file.
  return toRepresentableTask({
    id: hasKnownPrefix(id) ? id : `${taskType === 'user' ? 'task' : 'sys'}-${id}`,
    status: 'pending',
    priority: (taskData.priority || 'MEDIUM').toUpperCase(),
    priorityValue: PRIORITY_VALUES[taskData.priority?.toUpperCase()] || 2,
    description: taskData.description,
    metadata,
    approvalRequired: taskType === 'internal' && taskData.approvalRequired,
    autoApproved: taskType === 'internal' && !taskData.approvalRequired,
    section: 'pending'
  });
}
