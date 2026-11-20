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
import { KEYED_REVIEWER_PINS, REVIEW_STOP_MODES, normalizeReviewers, normalizeReviewUsernames, normalizeOptionalReviewers } from '../../lib/reviewerConfig.js';
import { isPlainObject } from '../../lib/objects.js';
import { PR_COMPLETIONS, PR_COMPLETION_VALUES } from '../../lib/prDisposition.js';
import { quotaBurnProvenance, quotaBurnTaskMetadata } from '../../lib/quotaBurnOrigin.js';
import { normalizeOrchestrationMode, normalizeOrchestrationProfile } from '../../lib/orchestrationProfile.js';
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
    // Planning is an explicit workflow mode, not just UI toggles; the server-side contract
    // stays authoritative for direct API callers and older clients sending only plan-task.
  const planOnly = taskData.planOnly === true || taskData.slashdoCommand === 'plan-task';
    // Internal producers (resume replacement, GSD) may provide a prebuilt metadata seed; copy
    // it first so task-specific contracts survive a non-raw write. Explicit top-level fields
    // below stay authoritative over matching seed keys.
  const metadata = isPlainObject(taskData.metadata) ? { ...taskData.metadata } : {};
  if (taskData.context) metadata.context = taskData.context;
    // The full agent-facing payload when the producer names it. Producers passing a multi-line
    // `context` are classified by `splitTaskPromptFields` in `cosTaskStore.js#addTask`.
  if (typeof taskData.prompt === 'string') metadata.prompt = taskData.prompt;
  if (taskData.model) metadata.model = taskData.model;
  if (taskData.provider) metadata.provider = taskData.provider;
  if (taskData.effort) metadata.effort = taskData.effort;
  if (taskData.executionOptions !== undefined) metadata.executionOptions = taskData.executionOptions;
    // Orchestrated execution. Both keys persist only when they survive normalization, so a
    // mode with no usable profile leaves the task `direct` rather than stamping an inert
    // override. The default mode is never written (absent already means `direct`).
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
    // Pin this task to ONE federated instance: only that instance's CoS evaluator claims it.
    // Absent keeps opportunistic first-claim-wins. Normalized through the spawn guards' reader,
    // so a blank value stores as unpinned, not as a target no instance can match.
  const targetInstance = getTargetInstance(taskData);
  if (targetInstance) metadata[TARGET_INSTANCE_KEY] = targetInstance;
  // Tags a task dispatched by the voice code-agent tool so the proactive
  // speech layer can announce its completion (see voice/proactiveTriggers.js).
  if (taskData.voiceDispatch === true) metadata.voiceDispatch = true;
  if (taskData.isRecovery === true) metadata.isRecovery = true;
    // Series Autopilot gap tasks (seriesAutopilot/session.js `fileGap`) carry their series so a
    // later run can retire superseded ones; the description prefix is too fragile a key.
  if (taskData.autopilotGapSeriesId) metadata.autopilotGapSeriesId = taskData.autopilotGapSeriesId;
  if (taskData.autopilotGapKind) metadata.autopilotGapKind = taskData.autopilotGapKind;
    // Investigation-task guards: the durable fingerprint dedupes repeat failures of one cause;
    // the marker blocks investigations-of-investigations; affectedTasks names every task
    // blocked on the cause (later dedup hits union in).
  if (taskData.isInvestigation === true) metadata.isInvestigation = true;
  if (taskData.investigationFingerprint) metadata.investigationFingerprint = taskData.investigationFingerprint;
    // Why an approval-required task is waiting, as a namespaced token (e.g.
    // `investigation-loop:repeat-fingerprint`). Producer-agnostic so the UI explains the hold
    // without a per-producer key. Absent on auto-approved tasks.
  if (taskData.approvalReason) metadata.approvalReason = taskData.approvalReason;
  if (Array.isArray(taskData.affectedTasks) && taskData.affectedTasks.length > 0) metadata.affectedTasks = taskData.affectedTasks;
  if (taskData.createJiraTicket) metadata.createJiraTicket = true;
    // Boolean flags: persist both true and false so users can explicitly override defaults.
    // The string forms ('false' on rows stored before #16407 and peers on older versions) are handled by isTruthyMeta/isFalsyMeta;
    // undefined means "use app defaults".
  if (taskData.useWorktree === true) metadata.useWorktree = true;
  else if (taskData.useWorktree === false) metadata.useWorktree = false;
  if (taskData.openPR === true) metadata.openPR = true;
  else if (taskData.openPR === false) metadata.openPR = false;
  if (taskData.whenDone === 'commit-push' || taskData.whenDone === 'leave-uncommitted') metadata.whenDone = taskData.whenDone;
    // Default a worktree-isolated USER task to opening a PR rather than auto-merging: an
    // unreviewed agent commit landing on main is the more dangerous default. Fires only when
    // openPR wasn't set AND a worktree was requested; an explicit `openPR: false` wins, and
    // internal/system tasks keep auto-merge so automation isn't gated on a human merging a PR.
  if (taskData.openPR === undefined && taskData.useWorktree === true && taskType === 'user') metadata.openPR = true;
    // Claim prompts own their forge lifecycle in a separate claim/<item> worktree. Independent
    // of openPR: false is still required to stop CoS provisioning a second worktree.
  if (taskData.claimFlow === true) metadata.claimFlow = true;
  if (PR_COMPLETION_VALUES.includes(taskData.prCompletion)) {
    metadata.prCompletion = taskData.prCompletion;
  } else if (metadata.openPR === true && taskType === 'user') {
    // New user tasks should persist their explicit default; legacy records
    // remain untouched and resolve from reviewLoop at read time.
    metadata.prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE;
  }
  if (typeof taskData.useAutoMerge === 'boolean') metadata.useAutoMerge = taskData.useAutoMerge;
  if (typeof taskData.autoApprovePR === 'boolean') metadata.autoApprovePR = taskData.autoApprovePR;
  if (typeof taskData.adminMerge === 'boolean') metadata.adminMerge = taskData.adminMerge;
  if (taskData.simplify === true) metadata.simplify = true;
  else if (taskData.simplify === false) metadata.simplify = false;
    // Throwaway-worktree posture ("reason/report, never land code"). `false` is not persisted:
    // absent already means the normal posture.
  if (taskData.discardWorktree === true) metadata.discardWorktree = true;
  // Whether a clean tree at the end is success (issue-filing, reasoning) or a
  // failure (code work). Both booleans are meaningful, so persist either.
  if (taskData.worktreeChangesExpected === true) metadata.worktreeChangesExpected = true;
  else if (taskData.worktreeChangesExpected === false) metadata.worktreeChangesExpected = false;
    // Deliverable is an API call or CLI action performed DURING the run, not a commit and not
    // the sentinel.
  if (taskData.noCodeOutput === true) metadata.noCodeOutput = true;
  if (taskData.reviewLoop === true) metadata.reviewLoop = true;
  else if (taskData.reviewLoop === false) metadata.reviewLoop = false;
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
  if (taskData.reviewerApplies === true) metadata.reviewerApplies = true;
  else if (taskData.reviewerApplies === false) metadata.reviewerApplies = false;
    // Bundled slashdo workflow this task runs, as the BARE command name; the prompt builder
    // renders the invocation shape once the provider is known (server/lib/slashdoInvocation.js).
  if (taskData.slashdoCommand) metadata.slashdoCommand = taskData.slashdoCommand;
  if (taskData.slashdoArgs) metadata.slashdoArgs = taskData.slashdoArgs;
    // Manual `/do:next` claim swarms are non-raw tasks; agentLifecycle needs this count after
    // the markdown round-trip to lift a cloud Codex session to root + configured workers.
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
    // Which tracker the prompt told the agent to file into (PLAN.md / GitHub / GitLab / JIRA),
    // mirroring referenceRepos.js#triggerReferenceAnalysis. It also marks a ONE-OFF
    // tracker-filing run so it reaches the no-commit gate without masquerading as a scheduled
    // task type (see taskTypeHooks.js#isTrackerFilingDispatch).
  if (taskData.workTracker) metadata.workTracker = taskData.workTracker;
    // A manually pinned /do:next issue needs a durable target so realtime consumers can
    // associate lifecycle events with the launching row. Already normalized by the route.
  if (typeof taskData.claimTarget === 'string' && taskData.claimTarget) metadata.claimTarget = taskData.claimTarget;
  // The pinned claim's prompt omits its checkout phase; spawn must cut it (#15517).
  if (taskData.claimServerCheckout === true) metadata.claimServerCheckout = true;
    // Same durability need as claimTarget, for the Issues tab's Replan button. A separate key
    // so a replan can never light up the Claim button (or vice versa) on the same issue.
  if (typeof taskData.replanTarget === 'string' && taskData.replanTarget) metadata.replanTarget = taskData.replanTarget;
  if (taskData.jiraTicketId) metadata.jiraTicketId = taskData.jiraTicketId;
  if (taskData.jiraTicketUrl) metadata.jiraTicketUrl = taskData.jiraTicketUrl;
  if (taskData.screenshots?.length > 0) metadata.screenshots = taskData.screenshots;
  if (taskData.attachments?.length > 0) metadata.attachments = taskData.attachments;
    // Structured auto-fix diagnostics: the fallback classifier's { triggerEvent, target,
    // errorType, category, tier, fixStrategy, failureReason } record, persisted so telemetry
    // can aggregate outcomes by tier / category / failure reason. Stored as an object
    // (`cosTaskRows.storedForm` keeps nested metadata). A non-object /
    // array is ignored.
  if (taskData.diagnostics && typeof taskData.diagnostics === 'object' && !Array.isArray(taskData.diagnostics)) {
    metadata.diagnostics = taskData.diagnostics;
  }
    // Layered-Intelligence hand-off provenance: the proposal's identity + domain, from
    // buildHandoffTask, so recordTaskCompletion can attribute the run's outcome to the
    // proposal's DOMAIN. A non-object / array is ignored. Round-trips via the same JSON
    // sentinel as `diagnostics`.
  if (taskData.liProposal && typeof taskData.liProposal === 'object' && !Array.isArray(taskData.liProposal)) {
    metadata.liProposal = taskData.liProposal;
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
    delete metadata.reviewers;
    delete metadata.usernames;
    delete metadata.optionalReviewers;
    delete metadata.reviewerMaxRounds;
    delete metadata.reviewerModels;
    delete metadata.reviewerEfforts;
    delete metadata.reviewStopMode;
    delete metadata.reviewerApplies;
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
