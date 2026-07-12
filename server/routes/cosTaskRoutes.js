/**
 * CoS Task CRUD, Enhancement, and Evaluation Routes
 */

import { Router } from 'express';
import { z } from 'zod';
import * as cos from '../services/cos.js';
import * as taskWatcher from '../services/taskWatcher.js';
import { enhanceTaskPrompt } from '../services/taskEnhancer.js';
import { loadSlashdoCommand } from '../services/subAgentSpawner.js';
import { buildClaimWorkTask } from '../services/cosTaskGenerator.js';
import { getAppById } from '../services/apps.js';
import { getTaskPrompt } from '../services/taskPromptService.js';
import { getCodeReviewDefaults } from '../services/codeReview.js';
import { workTrackerLabel } from '../lib/workTracker.js';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import {
  createCosTaskSchema,
  updateCosTaskSchema,
  challengeTaskSchema,
  resolveChallengeSchema,
  validateRequest,
  normalizeReviewers,
  buildReviewersCsv,
  LOCAL_LLM_REVIEWERS,
  isPaginationRequested,
  parsePagination,
} from '../lib/validation.js';

const enhanceTaskSchema = z.object({
  description: z.string().min(1),
  context: z.string().optional(),
});

// One-off "implement THIS JIRA ticket" task (the per-card play button on the
// app overview's sprint board). `ticketKey` is a JIRA key like `PROJ-1234`.
const jiraTicketTaskSchema = z.object({
  app: z.string().min(1),
  ticketKey: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/, 'Invalid JIRA ticket key'),
});

// Resolve the reviewers CSV for the claim flow exactly as buildClaimWorkTask
// does (Code Review Defaults, minus local-LLM reviewers the claim prompt can't
// drive, falling back to the hardcoded default). Mirrors the scheduled
// claim-work resolution so the play button honors the user's reviewer choice.
async function resolveClaimReviewersCsv() {
  const codeReviewDefaults = await getCodeReviewDefaults().catch(() => null);
  const list = normalizeReviewers({}, codeReviewDefaults?.reviewers)
    .filter((r) => !LOCAL_LLM_REVIEWERS.includes(r));
  // Arbitrary GitHub reviewer usernames from the Code Review Defaults, appended
  // as `@user` tokens so the play button's claim gates the merge on them too.
  return buildReviewersCsv(list, codeReviewDefaults?.usernames);
}

// Append a "claim exactly this ticket" constraint to the claim-issue-jira body
// — the JIRA analogue of buildPlanConstraintBlock. The base prompt's Phase 1
// tells the agent to PICK the next-ready ticket; this overrides that to pin the
// user's selection while keeping every safety check (already-claimed, stale,
// too-ambiguous → exit cleanly).
function buildTargetTicketBlock(ticketKey) {
  return `

## Target Ticket Constraint

The user explicitly selected JIRA ticket \`${ticketKey}\` from the board. Override Phase 1 ("Pick the target ticket"): do NOT pick a different ticket and do NOT scan for the next-ready one — claim exactly \`${ticketKey}\`. Still honor the safety checks: if \`${ticketKey}\` is already In Progress / In Review / Done / closed, is already on a \`claim/${ticketKey}\` (or \`cos/.../${ticketKey}/...\`) branch, or its requirements are too ambiguous or too large to implement in a single PR, exit cleanly (file a Review Hub todo for ambiguous requirements) rather than forcing it. Otherwise run Phases 2–7 against \`${ticketKey}\`.`;
}

const SLASHDO_COMMANDS = {
  push:           { label: 'Push', description: 'Commit and push all work with changelog' },
  review:         { label: 'Review', description: 'Deep code review of changed files' },
  replan:         { label: 'Replan', description: 'Audit PLAN.md, archive completed items, prune stale work' },
  next:           { label: 'Next', description: 'Claim the next unclaimed work item (per the app\'s Work Tracker) and ship a PR' },
  release:        { label: 'Release', description: 'Create a release PR' },
  better:         { label: 'Better', description: 'Unified DevSecOps audit and remediation' },
  'better-swift': { label: 'Better Swift', description: 'SwiftUI DevSecOps audit and remediation' }
};

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

// POST /api/cos/tasks/slashdo - Create a task from a slashdo command
router.post('/tasks/slashdo', asyncHandler(async (req, res) => {
  const { command, app } = req.body;

  if (!command || !SLASHDO_COMMANDS[command]) {
    throw new ServerError(`Invalid slashdo command. Allowed: ${Object.keys(SLASHDO_COMMANDS).join(', ')}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!app) {
    throw new ServerError('App ID is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const meta = SLASHDO_COMMANDS[command];

  // `/do:next` is the work-claim consumer: route it through the same
  // workTracker-aware logic the scheduled `claim-work` flow uses, so the manual
  // button honors the app's per-app Work Tracker (PLAN.md / GitHub / GitLab /
  // JIRA) instead of always draining PLAN.md. Every other command inlines its
  // raw slashdo body verbatim.
  let context;
  let taskMetadata = { useWorktree: false, openPR: false };
  let description;
  if (command === 'next') {
    const appObj = await getAppById(app);
    if (!appObj) {
      throw new ServerError(`App not found: ${app}`, { status: 404, code: 'APP_NOT_FOUND' });
    }
    const claim = await buildClaimWorkTask(appObj);
    context = claim.prompt;
    // claim.taskMetadata overrides the false/false default only where it carries
    // a key. All current claim flows (plan-task / claim-issue / claim-issue-gitlab
    // / claim-issue-jira) self-manage their worktree + MR/PR, so false/false
    // stands; the spread stays for a future delegated type that needs CoS-managed
    // isolation.
    taskMetadata = { ...taskMetadata, ...claim.taskMetadata };
    description = `Run /do:next for ${appObj.name} — claim next ${workTrackerLabel(claim.tracker)} item and ship a PR`;
  } else {
    context = await loadSlashdoCommand(command);
    if (!context) {
      throw new ServerError(`Failed to load slashdo command: ${command}`, { status: 500, code: 'COMMAND_LOAD_FAILED' });
    }
    description = `Run /do:${command} for ${app} — ${meta.description}`;
  }

  const taskData = { description, app, context, ...taskMetadata, simplify: false, reviewLoop: false };
  const result = await cos.addTask(taskData, 'user');

  if (result?.duplicate) {
    throw new ServerError(`A task with this description is already ${result.status}`, { status: 409, code: 'DUPLICATE_TASK' });
  }

  res.json(result);
}));

// POST /api/cos/tasks/jira-ticket - Queue a CoS task to implement one specific
// JIRA ticket (the per-card "play" button on the app overview sprint board).
// Reuses the claim-issue-jira prompt and appends a target-ticket constraint, so
// it stays in lockstep with the scheduled JIRA claim flow without duplicating
// the 7-phase body. Queue-only: the daemon picks it up on the next evaluation.
router.post('/tasks/jira-ticket', asyncHandler(async (req, res) => {
  const { app, ticketKey } = validateRequest(jiraTicketTaskSchema, req.body);
  const key = ticketKey.toUpperCase();

  const appObj = await getAppById(app);
  if (!appObj) {
    throw new ServerError(`App not found: ${app}`, { status: 404, code: 'APP_NOT_FOUND' });
  }
  if (!appObj.jira?.enabled) {
    throw new ServerError(`JIRA is not enabled for ${appObj.name}`, { status: 400, code: 'JIRA_NOT_ENABLED' });
  }

  // Resolve the claim-issue-jira body directly (not via buildClaimWorkTask) —
  // an app can show a JIRA board while its general Work Tracker resolves to
  // GitHub/PLAN, so route the click to the JIRA flow regardless of that setting.
  // Independent reads (prompt body + Code Review Defaults) — fetch concurrently.
  const [template, reviewersCsv] = await Promise.all([
    getTaskPrompt('claim-issue-jira'),
    resolveClaimReviewersCsv(),
  ]);
  const context = template
    .replace(/\{appName\}/g, appObj.name)
    .replace(/\{repoPath\}/g, appObj.repoPath)
    .replace(/\{appId\}/g, appObj.id)
    // Function-form replacer so a literal `$` in the reviewers CSV isn't read as
    // a backreference.
    .replace(/\{reviewers\}/g, () => reviewersCsv)
    + buildTargetTicketBlock(key);

  // claim-issue-jira self-manages its worktree + MR/PR, so leave both false
  // (matching the /do:next slashdo default for the JIRA tracker).
  const taskData = {
    description: `Claim JIRA ticket ${key} for ${appObj.name} — implement and ship a PR`,
    app,
    context,
    useWorktree: false,
    openPR: false,
    simplify: false,
    reviewLoop: false,
  };
  const result = await cos.addTask(taskData, 'user');

  if (result?.duplicate) {
    throw new ServerError(`A task for ${key} is already ${result.status}`, { status: 409, code: 'DUPLICATE_TASK' });
  }

  res.json(result);
}));

// POST /api/cos/tasks - Add a new task
router.post('/tasks', asyncHandler(async (req, res) => {
  const parsed = createCosTaskSchema.safeParse(req.body);
  if (!parsed.success) failValidation(parsed);
  const { type, ...taskData } = parsed.data;
  const result = await cos.addTask(taskData, type);

  if (result?.duplicate) {
    throw new ServerError(`A task with this description is already ${result.status}`, { status: 409, code: 'DUPLICATE_TASK' });
  }

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
  if (fields.model !== undefined) updates.model = fields.model;
  if (fields.provider !== undefined) updates.provider = fields.provider;
  if (fields.app !== undefined) updates.app = fields.app;

  // Set blocker metadata when marking as blocked
  if (fields.status === 'blocked' && blockedReason) {
    updates.metadata = { blocker: blockedReason };
  }

  const result = await cos.updateTask(id, updates, type);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// DELETE /api/cos/tasks/:id - Delete a task
router.delete('/tasks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { type = 'user' } = req.query;

  const result = await cos.deleteTask(id, type);
  if (result?.error) {
    throw new ServerError(result.error, { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

// POST /api/cos/tasks/:id/approve - Approve a task
router.post('/tasks/:id/approve', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const result = await cos.approveTask(id);
  if (result?.error) {
    throw new ServerError(result.error, { status: 400, code: 'BAD_REQUEST' });
  }
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
  res.json(result);
}));

export default router;
