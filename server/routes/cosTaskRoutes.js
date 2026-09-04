/**
 * CoS Task CRUD, Enhancement, and Evaluation Routes
 */

import { Router } from 'express';
import { z } from 'zod';
import * as cos from '../services/cos.js';
import * as taskWatcher from '../services/taskWatcher.js';
import { enhanceTaskPrompt } from '../services/taskEnhancer.js';
import { buildClaimWorkTask, buildIssueReplanTask, buildJiraTicketTask } from '../services/cosTaskGenerator.js';
import { getAppById, getAppWorkTracker, PORTOS_APP_ID } from '../services/apps.js';
import { getAssignableInstances } from '../services/instances.js';
import { resolveManagedAppIssueTarget } from '../services/managedAppRepositories.js';
import { workTrackerLabel } from '../lib/workTracker.js';
import { getSlashdoWorkflow, slashdoWorkflowAppliesTo, SLASHDO_COMMAND_NAMES } from '../lib/slashdoCatalog.js';
import { NON_PM2_TYPES } from '../services/streamingDetect.js';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { recordUserAction } from '../services/userActions.js';
import { fileInvestigationTask } from '../services/investigationTaskProducer.js';
import { CLIENT_INVESTIGATION_DELIVERY, clientInvestigationFingerprint } from '../lib/investigationTasks.js';
import {
  createCosTaskSchema,
  slashdoTaskSchema,
  updateCosTaskSchema,
  challengeTaskSchema,
  resolveChallengeSchema,
  validateRequest,
  isPaginationRequested,
  parsePagination,
} from '../lib/validation.js';

const enhanceTaskSchema = z.object({
  description: z.string().min(1),
  context: z.string().optional(),
});

// ── Operator-action ledger (#5594) ──────────────────────────────────────────
//
// Hooked at the THREE HTTP create routes below rather than at
// `cosTaskStore.addTask`, which is ALSO the generator / autopilot / mind dispatch
// path. Only a request arriving here is a human pressing a button, and the whole
// point of the ledger is to separate those from everything PortOS queues itself.
//
// Every write is awaited before the response (same posture as `history.logAction`),
// and every hook fires only AFTER the mutation succeeded — a 409/404 is not an
// operator action that happened.
const TASK_CREATE_PAYLOAD_FIELDS = [
  'prompt', 'description', 'context', 'provider', 'model', 'effort', 'app',
  'orchestrationMode', 'orchestrationProfile',
  'useWorktree', 'openPR', 'prCompletion', 'planOnly', 'reviewLoop', 'reviewers',
  'approvalRequired', 'isInvestigation',
  // The one create field with an open shape (`cosTaskDiagnosticsSchema` is a
  // passthrough), so it is both the most informative thing to keep and the reason
  // `recordUserAction` redacts credential-shaped keys at all.
  'diagnostics',
];

const routeSource = (req) => ({ route: `${req.baseUrl}${req.route?.path ?? ''}`, method: req.method });

const pickDefined = (source, fields) => Object.fromEntries(
  fields.filter((field) => source?.[field] !== undefined).map((field) => [field, source[field]]),
);

async function logTaskCreated(req, task, taskData) {
  await recordUserAction({
    type: 'cos.task.create',
    target: task.id,
    targetName: task.description,
    summary: `Queued CoS task: ${task.description}`,
    payload: { taskId: task.id, ...pickDefined(taskData, TASK_CREATE_PAYLOAD_FIELDS) },
    source: routeSource(req),
    dedupeKey: `cos.task.create:${task.id}`,
  });
}

// One-off "implement THIS JIRA ticket" task (the per-card play button on the
// app overview's sprint board). `ticketKey` is a JIRA key like `PROJ-1234`.
const jiraTicketTaskSchema = z.object({
  app: z.string().min(1),
  ticketKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/, 'Invalid JIRA ticket key'),
});

// Reject a task pinned to an instance this install does not know (#4520). The
// picker only offers registry members, so this catches the two ways a bad pin
// still arrives: a hand-crafted request, and a peer removed between the form
// render and the submit. A pin no instance matches is worse than none — every
// peer would pass over the task and it would sit pending forever.
async function assertAssignableInstance(instanceId) {
  const assignable = await getAssignableInstances();
  if (assignable.some(i => i.instanceId === instanceId)) return;
  throw new ServerError('Unknown instance — pick one of this install\'s federated instances', { status: 400, code: 'UNKNOWN_INSTANCE' });
}

const ISSUE_TRACKERS = new Set(['github', 'gitlab']);

function issueTargetInstructions(target, tracker) {
  if (!target?.fullName) {
    return '## Issue repository\n\nBefore filing, inspect whether the checkout origin is a fork. If it is, file on the canonical upstream repository rather than the origin fork. Do not rely on the working directory\'s implicit forge target.';
  }
  const role = target.role === 'upstream' ? 'canonical upstream' : 'configured origin';
  const repoFlag = tracker === 'github' ? (target.repoSpec || target.fullName) : target.fullName;
  const cli = tracker === 'github' ? 'gh' : 'glab';
  return `## Issue repository\n\nFile this issue on the ${role} repository \`${target.fullName}\`. Pass \`--repo ${repoFlag}\` to every \`${cli} issue\`, label, and related repository command; do not let \`${cli}\` infer the origin fork from the working directory.`;
}

// The bundled plan-task workflow files an issue; resolve the app's canonical
// destination before queueing so a checkout whose origin is a fork does not
// silently file project work on that fork. The form may deliberately choose the
// origin; upstream is the unattended/default posture.
async function preparePlanOnlyTask(taskData, knownApp = null) {
  if (taskData.planOnly !== true && taskData.slashdoCommand !== 'plan-task') return taskData;
  const appId = taskData.app || PORTOS_APP_ID;
  const [trackerInfo, app] = await Promise.all([
    getAppWorkTracker(appId),
    knownApp ? Promise.resolve(knownApp) : getAppById(appId),
  ]);
  if (trackerInfo && !ISSUE_TRACKERS.has(trackerInfo.resolved)) {
    throw new ServerError(
      `Plan-and-file tasks require a GitHub or GitLab issue tracker (resolved to ${trackerInfo.resolved})`,
      { status: 400, code: 'UNSUPPORTED_PLAN_ONLY_TRACKER' }
    );
  }
  if (!app || !trackerInfo) return taskData;
  const target = await resolveManagedAppIssueTarget(app, taskData.issueTarget || 'upstream').catch(() => null);
  const targetPrompt = issueTargetInstructions(target, target?.forge || trackerInfo.resolved);
  return { ...taskData, prompt: [taskData.prompt, targetPrompt].filter(Boolean).join('\n\n') };
}

const router = Router();

// GET /api/cos/tasks - Get all tasks (user + internal), grouped by source.
//
// Backward-compatible by default: with no pagination params it returns the full
// `{ user, cos }` structure every existing consumer expects (tasks + grouped
// buckets + awaiting/auto-approved derived lists). When a client passes
// `limit`/`offset`, each source is reduced to a *genuinely bounded* shape: the
// windowed `tasks` slice plus scalar metadata only. The full-set derived
// collections (`grouped`, `autoApproved`, `awaitingApproval`) are dropped from
// the paginated branch — keeping them would re-include the entire queue the
// caller asked to page through, defeating the bound. A `pagination` block with
// the true per-source totals is added so the caller can page.
router.get('/tasks', asyncHandler(async (req, res) => {
  const tasks = await cos.getAllTasks();
  if (!isPaginationRequested(req.query)) {
    return res.json(tasks);
  }
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 500 });
  const sliceSource = (src) => {
    if (!src || typeof src !== 'object') return { tasks: [] };
    // Strip the full-set derived collections so the response is actually bounded;
    // keep only scalar metadata (file/exists/type) + the windowed task slice.
    const { tasks: list, grouped, autoApproved, awaitingApproval, ...meta } = src;
    const arr = Array.isArray(list) ? list : [];
    return { ...meta, tasks: arr.slice(offset, offset + limit) };
  };
  const userTotal = Array.isArray(tasks?.user?.tasks) ? tasks.user.tasks.length : 0;
  const cosTotal = Array.isArray(tasks?.cos?.tasks) ? tasks.cos.tasks.length : 0;
  res.json({
    user: sliceSource(tasks?.user),
    cos: sliceSource(tasks?.cos),
    pagination: { limit, offset, userTotal, cosTotal, total: userTotal + cosTotal }
  });
}));

// GET /api/cos/tasks/user - Get user tasks
router.get('/tasks/user', asyncHandler(async (req, res) => {
  const tasks = await cos.getUserTasks();
  res.json(tasks);
}));

// GET /api/cos/tasks/internal - Get CoS internal tasks
router.get('/tasks/internal', asyncHandler(async (req, res) => {
  const tasks = await cos.getCosTasks();
  res.json(tasks);
}));

// POST /api/cos/tasks/refresh - Force refresh tasks
router.post('/tasks/refresh', asyncHandler(async (req, res) => {
  const tasks = await taskWatcher.refreshTasks();
  res.json(tasks);
}));

// POST /api/cos/tasks/reorder - Reorder tasks
router.post('/tasks/reorder', asyncHandler(async (req, res) => {
  const { taskIds } = req.body;

  if (!taskIds || !Array.isArray(taskIds)) {
    throw new ServerError('taskIds array is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await cos.reorderTasks(taskIds);
  res.json(result);
}));

// POST /api/cos/tasks/enhance - Enhance a task prompt with AI
router.post('/tasks/enhance', asyncHandler(async (req, res) => {
  const { description, context } = validateRequest(enhanceTaskSchema, req.body);
  const result = await enhanceTaskPrompt(description, context);
  res.json(result);
}));

// POST /api/cos/tasks/slashdo - Create a task from a slashdo command.
//
// The body carries the run settings the app-overview drawer collects: the
// provider/model/effort pin and `simplify` apply to every command; `target`,
// `issueAuthorFilter`, and the reviewer choices are `/do:next`-only (they shape
// the claim prompt, which self-manages its own PR + review loop). `issueContext`
// is the selected issue's content already fetched by the managed-app Issues tab;
// it avoids making the agent retrieve the same title/body again. The optional
// `overrideContext` is user guidance appended to that claim prompt.
//
// The launchable-command allowlist is the shared catalog in
// `server/lib/slashdoCatalog.js` (#3114) — the CoS quick templates read the same
// source, so the two surfaces can't drift.
router.post('/tasks/slashdo', asyncHandler(async (req, res) => {
  const {
    command, app, provider, model, effort, simplify, issueTarget,
    target, issueContext, overrideContext, issueAuthorFilter, reviewers, usernames, optionalReviewers,
    reviewerMaxRounds, reviewerModels, reviewerEfforts
  } = validateRequest(slashdoTaskSchema, req.body);

  const workflow = getSlashdoWorkflow(command);
  if (!workflow) {
    throw new ServerError(`Invalid slashdo command. Allowed: ${SLASHDO_COMMAND_NAMES.join(', ')}`, { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Resolved for EVERY command, not just `next` — so the queue row names the app
  // the way the user does, and an unknown app 404s uniformly instead of only on
  // the `next` branch.
  const appObj = await getAppById(app);
  if (!appObj) {
    throw new ServerError(`App not found: ${app}`, { status: 404, code: 'APP_NOT_FOUND' });
  }

  // `plan-task` is also a plan-only quick action, so resolve its forge target
  // before it reaches the store through this separate route.
  const planTask = command === 'plan-task'
    ? await preparePlanOnlyTask({ app, slashdoCommand: command, issueTarget }, appObj)
    : null;

  // Enforce the catalog's stack gate server-side. The Agent Operations panel only
  // offers the applicable one of `better` / `better-swift`, but the API must not
  // trust that — queuing a SwiftUI audit against a web app (or vice versa) burns
  // an agent run on a workflow that can't apply.
  if (!slashdoWorkflowAppliesTo(workflow, NON_PM2_TYPES.has(appObj.type))) {
    throw new ServerError(
      `${workflow.label} does not apply to ${appObj.name} (app type: ${appObj.type || 'unknown'})`,
      { status: 400, code: 'WORKFLOW_APP_TYPE_MISMATCH' }
    );
  }

  // Three task shapes, produced whole so the either/or is visible rather than
  // assembled from separately-mutated locals. The first two are the TARGETED
  // shapes: a command pinned to one work item, where PortOS assembles the whole
  // prompt itself and therefore must NOT also set `slashdoCommand` (that would
  // append the bundled `/do:<cmd>` body on top of the assembled prompt and
  // re-point the agent at the command's unpinned behavior).
  //
  // - `/do:next` is the work-claim consumer and is genuinely special: it routes
  //   through the same workTracker-aware logic the scheduled `claim-work` flow
  //   uses, so the manual button honors the app's per-app Work Tracker (PLAN.md /
  //   GitHub / GitLab / JIRA) instead of always draining PLAN.md.
  // - `replan` + a `target` is the Issues tab's Replan button: a second model
  //   reviews ONE already-planned issue. Untargeted, it stays the bundled
  //   backlog audit and falls through to the generic shape below.
  // - Every other command carries only the bare `slashdoCommand` and lets the
  //   prompt builder render the invocation + inline the body once the provider is
  //   known (`applySlashdoInvocation`). Eagerly inlining the body here — and
  //   hardcoding `Run /do:<cmd>` into the description — assumed a Claude host that
  //   can type slash commands; a codex/grok agent gets Agent Skills instead, so
  //   the rendered string was wrong for it (#3089's whole point).
  //
  // `workflow.settings` is the catalog's run-shape posture (see
  // WORKFLOW_OWNS_ITS_OWN_GIT / WORKFLOW_REPORTS_NO_CODE) — read from it rather
  // than restating false/false, so a future entry that genuinely wants a
  // PortOS-managed worktree gets one. `worktreeChangesExpected` declares the
  // workflow's deliverable: false for the report-shaped four (plan-task /
  // replan / review / scan), whose output is a filed issue or a printed report,
  // so downstream task bookkeeping does not score their clean tree as missing
  // code work (#3636). `simplify` comes from the request (the run drawer's toggle), not
  // the catalog.
  const { useWorktree, openPR, worktreeChangesExpected } = workflow.settings;
  let shape;
  if (command === 'replan' && target) {
    // `replan` + a pinned issue is the Issues tab's Replan button, the same
    // command/target pairing `next` uses for a pinned claim: a SECOND model
    // reviews ONE already-planned issue and comments its refinements. Without a
    // target the command stays the bundled `/do:replan` backlog audit below, so
    // the Agent Operations button is unaffected. Like the claim branch, its
    // assembled prompt IS the task prompt and carries no `slashdoCommand` —
    // appending the whole `/do:replan` body would re-point it at the backlog.
    const replan = await buildIssueReplanTask(appObj, { target, issueContext, overrideContext });
    shape = {
      description: `${workflow.label} for ${appObj.name} — review the plan on ${workTrackerLabel(replan.tracker)} issue ${replan.target}`,
      prompt: replan.prompt,
      taskMetadata: { ...replan.taskMetadata, replanTarget: replan.target },
    };
  } else if (command === 'next') {
    const claim = await buildClaimWorkTask(appObj, {
      target,
      issueContext,
      ...(overrideContext !== undefined ? { overrideContext } : {}),
      issueAuthorFilter,
      reviewers,
      usernames,
      optionalReviewers,
      reviewerMaxRounds,
      reviewerModels,
      reviewerEfforts
    });
    const scope = claim.target
      ? `claim ${workTrackerLabel(claim.tracker)} item ${claim.target}`
      : `claim next ${workTrackerLabel(claim.tracker)} item`;
    shape = {
      description: `${workflow.label} for ${appObj.name} — ${scope} and ship a PR`,
      // The claim body is the agent's PROMPT, not a human note (#4153) — see
      // server/lib/cosTaskPrompt.js for the field split.
      prompt: claim.prompt,
      // claim.taskMetadata overrides the catalog posture only where it carries a
      // key. All current claim flows (plan-task / claim-issue / claim-issue-gitlab
      // / claim-issue-jira) self-manage their worktree + MR/PR, so false/false
      // remains the CoS provisioning posture. `claimFlow` is a separate
      // lifecycle marker so the prompt builder cannot mistake false/false for a
      // commit-only handoff. The spread stays for a future delegated type that
      // needs CoS-managed isolation. `worktreeChangesExpected` is one such key: the
      // claim flow derives it from the app's RESOLVED work tracker (a file
      // tracker commits its checklist, a forge tracker doesn't), which is more
      // specific than the catalog's commit-shaped default, so the spread wins.
      taskMetadata: {
        useWorktree,
        openPR,
        worktreeChangesExpected,
        ...(claim.target ? { claimTarget: claim.target } : {}),
        ...claim.taskMetadata,
        claimFlow: true
      },
    };
  } else {
    shape = {
      description: `${workflow.label} for ${appObj.name} — ${workflow.description}`,
      slashdoCommand: command,
      taskMetadata: { useWorktree, openPR, worktreeChangesExpected },
    };
  }

  // `reviewLoop` stays off for every slashdo task: each `/do:*` body owns its own
  // review/PR sequence, so a CoS-managed loop on top would double-review.
  const taskData = {
    description: shape.description,
    app,
    prompt: shape.prompt,
    slashdoCommand: shape.slashdoCommand,
    ...shape.taskMetadata,
    provider, model, effort,
    simplify: simplify === true,
    reviewLoop: false
  };
  const result = await cos.addTask(planTask ? { ...taskData, prompt: planTask.prompt } : taskData, 'user');

  if (result?.duplicate) {
    throw new ServerError(`A task with this description is already ${result.status}`, { status: 409, code: 'DUPLICATE_TASK' });
  }

  await logTaskCreated(req, result, taskData);
  res.json(result);
}));

// POST /api/cos/tasks/jira-ticket - Queue a CoS task to implement one specific
// JIRA ticket (the per-card "play" button on the app overview sprint board).
// Reuses the claim-issue-jira prompt and appends a target-ticket constraint, so
// it stays in lockstep with the scheduled JIRA claim flow without duplicating
// the 7-phase body. Queue-only: the daemon picks it up on the next evaluation.
router.post('/tasks/jira-ticket', asyncHandler(async (req, res) => {
  const { app, ticketKey } = validateRequest(jiraTicketTaskSchema, req.body);

  const appObj = await getAppById(app);
  if (!appObj) {
    throw new ServerError(`App not found: ${app}`, { status: 404, code: 'APP_NOT_FOUND' });
  }
  if (!appObj.jira?.enabled) {
    throw new ServerError(`JIRA is not enabled for ${appObj.name}`, { status: 400, code: 'JIRA_NOT_ENABLED' });
  }

  // Assemble the claim-issue-jira prompt + target-ticket constraint in the
  // generator service (shared with the scheduled JIRA claim flow). The route
  // stays thin: validate → gate → assemble → queue.
  const { ticketKey: key, prompt, taskMetadata } = await buildJiraTicketTask(appObj, ticketKey);

  const taskData = {
    description: `Claim JIRA ticket ${key} for ${appObj.name} — implement and ship a PR`,
    app,
    prompt,
    ...taskMetadata,
    simplify: false,
    reviewLoop: false,
  };
  const result = await cos.addTask(taskData, 'user');

  if (result?.duplicate) {
    throw new ServerError(`A task for ${key} is already ${result.status}`, { status: 409, code: 'DUPLICATE_TASK' });
  }

  await logTaskCreated(req, result, taskData);
  res.json(result);
}));

// POST /api/cos/tasks - Add a new task
router.post('/tasks', asyncHandler(async (req, res) => {
  const parsed = createCosTaskSchema.safeParse(req.body);
  if (!parsed.success) failValidation(parsed);
  const { type, isInvestigation, ...taskData } = parsed.data;
  if (taskData.targetInstanceId) await assertAssignableInstance(taskData.targetInstanceId);
  const preparedTask = await preparePlanOnlyTask(taskData);
  // A UI-queued investigation (#6043) goes through the SAME producer as an
  // auto-filed one, so it lands with the markers the shared machinery reads —
  // `metadata.isInvestigation` (recognized by `isInvestigationTask`, which is
  // also the meta-cascade guard, so its own failure can't spawn an
  // investigation of itself) and a server-derived fingerprint (dedup + the loop
  // policy) — and contributes to the shared storm counter. The client supplies
  // only the flag: it never names the fingerprint or the delivery posture.
  const delivery = isInvestigation ? CLIENT_INVESTIGATION_DELIVERY : null;
  const result = delivery
    ? (await fileInvestigationTask(
      { ...preparedTask, fingerprint: clientInvestigationFingerprint(preparedTask) },
      { taskType: type, delivery }
    )).task
    : await cos.addTask(preparedTask, type);

  if (result?.duplicate) {
    throw new ServerError(`A task with this description is already ${result.status}`, { status: 409, code: 'DUPLICATE_TASK' });
  }

  // Log the posture the task actually FILED with, not just the submitted fields:
  // the delivery and the investigation marker are applied here, so a ledger row
  // built from `preparedTask` alone would omit them for a UI-queued repair.
  await logTaskCreated(req, result, { ...preparedTask, ...delivery, isInvestigation });
  res.json(result);
}));

// PUT /api/cos/tasks/:id - Update a task
router.put('/tasks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const parsedUpdate = updateCosTaskSchema.safeParse(req.body);
  if (!parsedUpdate.success) failValidation(parsedUpdate);
  const { type, blockedReason, ...fields } = parsedUpdate.data;

  const updates = {};
  if (fields.description !== undefined) updates.description = fields.description;
  if (fields.priority !== undefined) updates.priority = fields.priority;
  if (fields.status !== undefined) updates.status = fields.status;
  if (fields.context !== undefined) updates.context = fields.context;
  if (fields.prompt !== undefined) updates.prompt = fields.prompt;
  if (fields.model !== undefined) updates.model = fields.model;
  if (fields.provider !== undefined) updates.provider = fields.provider;
  if (fields.effort !== undefined) updates.effort = fields.effort;
  // Orchestrated execution (#5992). `null` is the explicit clear the schema
  // preserves — the store re-normalizes and drops the key (absent-vs-cleared).
  if (fields.orchestrationMode !== undefined) updates.orchestrationMode = fields.orchestrationMode;
  if (fields.orchestrationProfile !== undefined) updates.orchestrationProfile = fields.orchestrationProfile;
  if (fields.temperature !== undefined) updates.temperature = fields.temperature;
  if (fields.thinking !== undefined) updates.thinking = fields.thinking;
  if (fields.app !== undefined) updates.app = fields.app;

  // Re-pin (or unpin) the federated instance this task runs on (#4520). `null`
  // is the explicit clear the schema preserves — it lands as `undefined` in the
  // metadata patch, which the store's undefined-stripping turns into a real key
  // removal, restoring opportunistic first-claim-wins. Absent leaves the pin
  // untouched (absent-vs-cleared, AGENTS.md).
  if (fields.targetInstanceId !== undefined) {
    if (fields.targetInstanceId !== null) await assertAssignableInstance(fields.targetInstanceId);
    updates.metadata = { ...updates.metadata, targetInstanceId: fields.targetInstanceId ?? undefined };
  }

  // Set blocker metadata when marking as blocked
  if (fields.status === 'blocked' && blockedReason) {
    updates.metadata = { ...updates.metadata, blocker: blockedReason };
  }

  const result = await cos.updateTask(id, updates, type);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }

  // An edit is not an idempotent retry — two saves of the same field are two
  // distinct operator actions — so the timestamp is part of the dedupe key.
  const happenedAt = new Date().toISOString();
  await recordUserAction({
    type: 'cos.task.update',
    target: id,
    targetName: result?.description,
    summary: `Edited CoS task ${id}: ${Object.keys(updates).join(', ') || 'no fields'}`,
    payload: { taskId: id, ...updates },
    source: routeSource(req),
    happenedAt,
    dedupeKey: `cos.task.update:${id}:${happenedAt}`,
  });
  res.json(result);
}));

// DELETE /api/cos/tasks/:id - Delete a task
router.delete('/tasks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { type = 'user' } = req.query;

  // Read the description BEFORE the delete: once the row is gone the ledger's
  // only handle on what was thrown away would be an opaque task id.
  // `.catch` because this read only supplies a LABEL — a task file that will not
  // parse must not turn a working delete into a 500.
  const doomed = await cos.getTaskById(id).catch(() => null);
  const result = await cos.deleteTask(id, type);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }

  await recordUserAction({
    type: 'cos.task.delete',
    target: id,
    targetName: doomed?.description,
    summary: `Deleted CoS task ${id}${doomed?.description ? `: ${doomed.description}` : ''}`,
    payload: { taskId: id, description: doomed?.description ?? null },
    source: routeSource(req),
    dedupeKey: `cos.task.delete:${id}`,
  });
  res.json(result);
}));

// POST /api/cos/tasks/:id/approve - Approve a task
router.post('/tasks/:id/approve', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await cos.approveTask(id);
  if (result?.error) {
    throw new ServerError(result.error, { status: 400, code: 'BAD_REQUEST' });
  }

  await recordUserAction({
    type: 'cos.task.approve',
    target: id,
    targetName: result?.description,
    summary: `Approved CoS task ${id}${result?.description ? `: ${result.description}` : ''}`,
    payload: { taskId: id },
    source: routeSource(req),
    dedupeKey: `cos.task.approve:${id}`,
  });
  res.json(result);
}));

// POST /api/cos/tasks/:id/challenge - A sub-agent disputes a reviewer rejection
// (#2441). Parks the task in `challenged` and consumes one bounded challenge slot;
// a second dispute on the same task is refused (409 CHALLENGE_EXHAUSTED).
router.post('/tasks/:id/challenge', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason, evidence, reviewer } = validateRequest(challengeTaskSchema, req.body);
  const result = await cos.challengeTask(id, { reason, evidence, reviewer });
  if (result?.error) {
    const status = (result.code === 'CHALLENGE_EXHAUSTED' || result.code === 'CHALLENGE_BUDGET_EXHAUSTED' || result.code === 'CANNOT_CHALLENGE_COMPLETED') ? 409
      : result.code === 'NOT_FOUND' ? 404 : 400;
    throw new ServerError(result.error, { status, code: result.code || 'CHALLENGE_FAILED' });
  }
  res.json(result);
}));

// POST /api/cos/tasks/:id/challenge/resolve - Resolve a parked challenge (#2441,
// #2471). Provide EITHER an explicit `outcome` (manual verdict) OR a `recheck`
// object (auto re-run a local reviewer against the current diff and derive the
// verdict). `upheld` overturns the rejection (→ pending); `escalated` surfaces the
// unresolved dispute to the user (→ blocked + arbitration task).
router.post('/tasks/:id/challenge/resolve', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { outcome, recheck, note, resolvedBy } = validateRequest(resolveChallengeSchema, req.body);
  const result = recheck
    ? await cos.resolveTaskChallengeWithRecheck(id, { recheck, resolvedBy })
    : await cos.resolveTaskChallenge(id, { outcome, note, resolvedBy });
  if (result?.error) {
    const status = result.code === 'NOT_FOUND' ? 404
      : result.code === 'NOT_CHALLENGED' ? 409
      : result.code === 'RECHECK_FAILED' ? 502 : 400;
    throw new ServerError(result.error, { status, code: result.code || 'RESOLVE_FAILED' });
  }
  res.json(result);
}));

// POST /api/cos/evaluate - Force task evaluation
router.post('/evaluate', asyncHandler(async (req, res) => {
  await cos.evaluateTasks();
  res.json({ success: true, message: 'Evaluation triggered' });
}));

// POST /api/cos/tasks/:id/spawn - Force-spawn a pending task
router.post('/tasks/:id/spawn', asyncHandler(async (req, res) => {
  const result = await cos.forceSpawnTask(req.params.id);
  if (result.error) {
    const message = String(result.error);
    let status = 400;
    let code = 'SPAWN_FAILED';
    if (/not found/i.test(message)) {
      status = 404;
      code = 'NOT_FOUND';
    } else if (/not pending/i.test(message)) {
      status = 409;
      code = 'TASK_NOT_PENDING';
    } else if (/no available agent slots/i.test(message)) {
      status = 429;
      code = 'NO_CAPACITY';
    }
    throw new ServerError(result.error, { status, code });
  }

  // Force-spawn is repeatable (spawn, it fails, spawn again), so each press is
  // its own row — hence the timestamp in the dedupe key.
  const happenedAt = new Date().toISOString();
  await recordUserAction({
    type: 'cos.task.spawn',
    target: req.params.id,
    summary: `Force-spawned CoS task ${req.params.id}`,
    payload: { taskId: req.params.id },
    source: routeSource(req),
    happenedAt,
    dedupeKey: `cos.task.spawn:${req.params.id}:${happenedAt}`,
  });
  res.json(result);
}));

export default router;
