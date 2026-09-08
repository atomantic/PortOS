/**
 * CoS task INTAKE — the pure mapping from a non-raw `addTask` request onto the
 * task record the store persists.
 *
 * `lib/cosValidation.js#createCosTaskSchema` says which top-level fields a
 * request may carry; this module says which of them reach `metadata`, and how.
 * The two used to sit in different files with nothing checking they agreed, and
 * the mapping drifted three times: `optionalReviewers` validated by the schema
 * but never persisted (the task form's `~opt` badges silently fell back to the
 * Code Review Defaults), and `discardWorktree` / `noCodeOutput` reachable only
 * through the raw path. `cosTaskIntake.test.js` now fails when a schema field
 * is added without either a mapping here or an explicit non-metadata verdict.
 *
 * Internal producers (autopilot gaps, investigations, quota burn, GSD, the
 * Brain repo-intake) pass fields the HTTP schema never sees; those are mapped
 * here too, so every non-raw producer converges on one persist contract. The
 * read-side twin is `sanitizeTaskMetadata` (`lib/cosValidation.js`), which
 * takes an already-shaped metadata object rather than request fields.
 *
 * Pure: no fs, no state, no events. Persistence, dedup, and the multi-line
 * description → `metadata.prompt` classification stay in `cosTaskStore.js`.
 */

import { hasKnownPrefix, PRIORITY_VALUES } from '../lib/taskParser.js';
import { SWARM_COUNT_MAX, SWARM_COUNT_MIN } from '../lib/cosValidation.js';
import { KEYED_REVIEWER_PINS, REVIEW_STOP_MODES, normalizeReviewers, normalizeReviewUsernames, normalizeOptionalReviewers } from '../lib/reviewerConfig.js';
import { isPlainObject } from '../lib/objects.js';
import { PR_COMPLETIONS, PR_COMPLETION_VALUES } from '../lib/prDisposition.js';
import { quotaBurnProvenance, quotaBurnTaskMetadata } from '../lib/quotaBurnOrigin.js';
import { normalizeOrchestrationMode, normalizeOrchestrationProfile } from '../lib/orchestrationProfile.js';
import { TARGET_INSTANCE_KEY, getTargetInstance } from './cosTaskClaim.js';

/**
 * Map a request's top-level fields onto the task's `metadata` object.
 *
 * @param {object} taskData - the non-raw `addTask` request
 * @param {'user'|'internal'} taskType
 * @param {{ now?: number }} [options] - injectable clock for the LWW stamp
 * @returns {object} the metadata to persist
 */
export function buildTaskMetadata(taskData, taskType, { now = Date.now() } = {}) {
  // Planning is an explicit workflow mode, not just a collection of UI
  // toggles. Keep the server-side contract authoritative for direct API
  // callers and for older clients that only send the plan-task command.
  const planOnly = taskData.planOnly === true || taskData.slashdoCommand === 'plan-task';
  // Build metadata object. Internal producers such as resume replacement and
  // GSD may provide a prebuilt metadata seed; copy it first so task-specific
  // contracts survive a normal (non-raw) queue write. The explicit top-level
  // fields below remain authoritative and overwrite any matching seed keys.
  const metadata = isPlainObject(taskData.metadata) ? { ...taskData.metadata } : {};
  if (taskData.context) metadata.context = taskData.context;
  // The full agent-facing payload, when the producer names it explicitly
  // (#4153). Producers that still pass a multi-line `context` are classified
  // by `splitTaskPromptFields` in `cosTaskStore.js#addTask`, so both call shapes converge.
  if (typeof taskData.prompt === 'string') metadata.prompt = taskData.prompt;
  if (taskData.model) metadata.model = taskData.model;
  if (taskData.provider) metadata.provider = taskData.provider;
  if (taskData.effort) metadata.effort = taskData.effort;
  // Orchestrated execution (#5992). Both keys are persisted only when they
  // survive normalization, so a mode with no usable profile — or a profile of
  // empty role objects — leaves the task in today's `direct` posture rather
  // than stamping an inert override onto it. The default mode is never written:
  // absent already means `direct`, and writing it would touch every task.
  const orchestrationProfile = normalizeOrchestrationProfile(taskData.orchestrationProfile);
  if (orchestrationProfile) metadata.orchestrationProfile = orchestrationProfile;
  if (normalizeOrchestrationMode(taskData.orchestrationMode) === 'orchestrated') {
    metadata.orchestrationMode = 'orchestrated';
  }
  if (taskData.temperature !== undefined) metadata.temperature = taskData.temperature;
  if (taskData.thinking !== undefined) metadata.thinking = taskData.thinking;
  if (taskData.app) metadata.app = taskData.app;
  if (taskData.autonomousJob === true) metadata.autonomousJob = true;
  if (typeof taskData.jobId === 'string' && taskData.jobId) metadata.jobId = taskData.jobId;
  if (taskData.noChangeSuccess === true) metadata.noChangeSuccess = true;
  else if (taskData.noChangeSuccess === false) metadata.noChangeSuccess = false;
  // Pin this task to ONE federated instance (#4520): only that instance's CoS
  // evaluator claims and runs it, every other peer passes over it. Absent —
  // the default — leaves the opportunistic first-claim-wins behavior intact.
  // Normalized through the same reader the spawn guards use, so a blank or
  // whitespace-only value stores as unpinned rather than as a target no
  // instance can ever match.
  const targetInstance = getTargetInstance(taskData);
  if (targetInstance) metadata[TARGET_INSTANCE_KEY] = targetInstance;
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
  if (taskData.whenDone === 'commit-push' || taskData.whenDone === 'leave-uncommitted') metadata.whenDone = taskData.whenDone;
  // Default a worktree-isolated USER task to opening a PR rather than
  // auto-merging straight to the default branch — an unreviewed agent commit
  // landing on main is the more dangerous default (see the local-model eval
  // that auto-merged). Fires only when openPR wasn't explicitly set AND a
  // worktree was explicitly requested; an explicit `openPR: false` above
  // always wins, and internal/system tasks (autopilot, self-improvement) keep
  // their existing auto-merge behavior so automation isn't silently gated on a
  // human merging a PR.
  else if (taskData.openPR === undefined && taskData.useWorktree === true && taskType === 'user') metadata.openPR = true;
  // Claim prompts own their forge lifecycle in a separately-created
  // claim/<item> worktree. Keep this marker independent from openPR: false is
  // still required to stop CoS from provisioning a second worktree.
  if (taskData.claimFlow === true) metadata.claimFlow = true;
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
  // Manual `/do:next` claim swarms are non-raw tasks. Their prompt already
  // names the fan-out, and agentLifecycle needs this count after the markdown
  // round-trip to lift a cloud Codex session to root + configured workers.
  const swarmCount = Number(taskData.swarmCount);
  if (Number.isSafeInteger(swarmCount) && swarmCount >= SWARM_COUNT_MIN && swarmCount <= SWARM_COUNT_MAX) {
    metadata.swarmCount = swarmCount;
  }
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
  // A manually pinned /do:next issue needs a durable target so realtime
  // consumers can associate lifecycle events with the row that launched it.
  // The route has already normalized this value, and unpinned runs omit it.
  if (typeof taskData.claimTarget === 'string' && taskData.claimTarget) metadata.claimTarget = taskData.claimTarget;
  // Same durability need as claimTarget, for the Issues tab's Replan button:
  // the row that launched a replan associates the run's lifecycle events with
  // itself by this value. Separate key so a replan can never light up the
  // Claim button (or vice versa) on the same issue.
  if (typeof taskData.replanTarget === 'string' && taskData.replanTarget) metadata.replanTarget = taskData.replanTarget;
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
  // Quota-burn provenance — which family's window this task spends, which
  // window will refuse first, which burn step asked, and which on-demand
  // request (if any) it was generated for. The built-in lane stamps these onto
  // the generated task's metadata via `lib/quotaBurnOrigin.js` and reaches disk
  // through the RAW path in `cosTaskStore.js#addTask`; a custom-job burn reaches disk through this
  // non-raw path instead. Both spread the SAME block so the two lanes cannot
  // carry different provenance for the same feature — mapping the keys one at
  // a time here is how `quotaBurnStepId` came to reach disk without ever
  // reaching the agent (#6406). `quotaBurnOrigin.js` owns the why of each field.
  Object.assign(metadata, quotaBurnTaskMetadata(quotaBurnProvenance(taskData)));
  if (planOnly) {
    // Plan-and-file is a single bounded CoS action. The bundled plan-task
    // command is already issue-only, so pass its supported `--yes` flag to
    // make this toggle's issue-filing action unattended.
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
    delete metadata.reviewers;
    delete metadata.usernames;
    delete metadata.optionalReviewers;
    delete metadata.reviewerMaxRounds;
    delete metadata.reviewerModels;
    delete metadata.reviewerEfforts;
    delete metadata.reviewStopMode;
    delete metadata.reviewerApplies;
  }
  // Content-edit timestamp for cross-peer newest-edit-wins LWW (#1714). Stamped
  // at creation so a freshly-added task always carries a stamp; the merge treats
  // an absent stamp as oldest, so this also keeps a stamped task from losing a
  // same-status tie to a legacy peer's un-stamped copy. `now` is injectable so
  // the markdown output stays deterministic under test. Raw tasks (pre-built by
  // the caller) keep whatever stamp they arrive with.
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
  return {
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
