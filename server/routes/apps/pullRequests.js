/**
 * App pull-request / merge-request routes.
 *
 *   GET  /:id/pull-requests                         → open forge requests
 *   POST /:id/pull-requests/:number/resolve         → queue a review-loop agent
 *   POST /:id/pull-requests/:number/review          → queue pr-reviewer for ONE PR
 *
 * Neither POST route merges a user's PR directly. `/resolve` queues PortOS's
 * existing review-loop follow-up, which owns fetching feedback, fixing the
 * branch, waiting for checks, and merging — and starts it immediately, because
 * pressing the button is the approval. `/review` queues the `pr-reviewer`
 * scheduled task narrowed to a single request, so the security-scan → review
 * pipeline that normally sweeps every external PR can be pointed at one.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { claimSafeReviewers, normalizeReviewers, validateRequest } from '../../lib/validation.js';
import { PR_COMPLETIONS } from '../../lib/prDisposition.js';
import { isTruthyMeta } from '../../services/agentState.js';
import { resolveReviewLoopOptions } from '../../services/codeReview.js';
import { getAllTasks } from '../../services/cos.js';
import { spawnReviewLoopFollowUp } from '../../services/agentWorktreeCleanup.js';
import { listAppPullRequests } from '../../services/appPullRequests.js';
import {
  isReviewablePullRequest,
  listExternalOpenPullRequests,
  resolvePrReviewerTargetScope,
} from '../../services/prReviewerSecurity.js';
import { getOnDemandRequests, triggerOnDemandTask } from '../../services/taskSchedule.js';
import { loadApp } from './shared.js';

const router = Router();

const pullRequestParamsSchema = z.object({
  number: z.coerce.number().int().positive(),
});

const ACTIVE_TASK_STATUSES = new Set(['pending', 'in_progress', 'blocked']);
const PR_REVIEWER_TASK_TYPE = 'pr-reviewer';

const flattenTasks = (taskData) => [
  ...(Array.isArray(taskData?.user?.tasks) ? taskData.user.tasks : []),
  ...(Array.isArray(taskData?.cos?.tasks) ? taskData.cos.tasks : []),
];

const isResolveTaskFor = (task, appId, pullRequest) => {
  const metadata = task?.metadata;
  return ACTIVE_TASK_STATUSES.has(task?.status)
    && isTruthyMeta(metadata?.reviewLoopFollowUp)
    && metadata?.app === appId
    && Number(metadata.reviewLoopPRNumber) === pullRequest.number;
};

// A pr-reviewer run narrowed to this one request (`targetPullRequest` is stamped
// by the generator's security preflight). The unnarrowed sweep is deliberately
// NOT matched: it covers every external PR, so reporting it as this row's action
// would hide the per-row trigger behind an unrelated run.
const isReviewTaskFor = (task, appId, pullRequest) => {
  const metadata = task?.metadata;
  return ACTIVE_TASK_STATUSES.has(task?.status)
    && metadata?.analysisType === PR_REVIEWER_TASK_TYPE
    && metadata?.app === appId
    && Number(metadata.targetPullRequest) === pullRequest.number;
};

const isReviewRequestFor = (request, appId, pullRequest) => (
  request?.taskType === PR_REVIEWER_TASK_TYPE
  && request?.appId === appId
  && Number(request?.targetPullRequest) === pullRequest.number
);

async function readActiveTasks() {
  const taskData = await getAllTasks().catch(err => {
    console.error(`❌ app-pull-requests: could not read CoS tasks: ${err.message}`);
    return null;
  });
  if (!Array.isArray(taskData?.user?.tasks) || !Array.isArray(taskData?.cos?.tasks)) {
    if (taskData) console.error('❌ app-pull-requests: CoS task response had an invalid shape');
    return null;
  }
  return flattenTasks(taskData);
}

// Queued on-demand requests that have not yet become tasks. A pr-reviewer run
// is queued through the on-demand lane, so without these a row would show no
// action at all between the click and the generator's next cycle — and a page
// refresh in that window would offer the button again.
//
// `null` means UNREADABLE, which is not the same as "nothing queued": collapsing
// the two would let the review route miss an existing request and queue a
// duplicate scan of the same public PR. The POST fails closed on it; the GET,
// which only paints a button, degrades to showing no queued action.
async function readPendingOnDemandRequests() {
  const requests = await getOnDemandRequests().catch(err => {
    console.error(`❌ app-pull-requests: could not read on-demand requests: ${err.message}`);
    return null;
  });
  return Array.isArray(requests) ? requests : null;
}

// Per-row pr-reviewer eligibility, resolved from the SAME facts the security
// preflight filters on. Without it the tab would paint a Review button on every
// GitHub row, including the ones the route answers with 409 — an action that is
// guaranteed to fail. Only worth the extra `gh repo view` when the forge is
// GitHub; every other forge is ineligible by construction.
async function resolveReviewEligibility(app, result) {
  if (result.forge !== 'github') return () => false;
  const scope = await resolvePrReviewerTargetScope(app).catch(err => {
    console.error(`❌ app-pull-requests: could not resolve pr-reviewer scope: ${err.message}`);
    return null;
  });
  return pullRequest => isReviewablePullRequest(scope, pullRequest);
}

function actionFor(pullRequest, tasks, appId) {
  if (!tasks) return null;
  const task = tasks.find(candidate => isResolveTaskFor(candidate, appId, pullRequest));
  return task ? { taskId: task.id, status: task.status } : null;
}

function reviewActionFor(pullRequest, tasks, requests, appId) {
  const task = tasks?.find(candidate => isReviewTaskFor(candidate, appId, pullRequest));
  if (task) return { taskId: task.id, status: task.status };
  const queued = requests?.find(request => isReviewRequestFor(request, appId, pullRequest));
  return queued ? { taskId: null, status: 'pending' } : null;
}

const taskResponse = task => task ? {
  id: task.id,
  status: task.status,
  description: task.description,
} : null;

async function listWithActionState(app) {
  const result = await listAppPullRequests(app);
  const pullRequests = Array.isArray(result?.pullRequests) ? result.pullRequests : [];
  if (!pullRequests.length || result.transient) return { result, tasks: null };

  const [tasks, requests, reviewEligible] = await Promise.all([
    readActiveTasks(),
    readPendingOnDemandRequests(),
    resolveReviewEligibility(app, result),
  ]);
  return {
    result: {
      ...result,
      pullRequests: pullRequests.map(pullRequest => ({
        ...pullRequest,
        agentAction: actionFor(pullRequest, tasks, app.id),
        reviewAction: reviewActionFor(pullRequest, tasks, requests, app.id),
        reviewEligible: reviewEligible(pullRequest),
      })),
    },
    tasks,
  };
}

function throwForgeReadError(result) {
  if (!result.transient) return;
  throw new ServerError(
    result.headline || 'Could not read open pull requests',
    {
      status: 503,
      code: 'FORGE_UNAVAILABLE',
      context: {
        reason: result.reason,
        remedy: result.remedy || undefined,
      },
    },
  );
}

// GET /api/apps/:id/pull-requests — list every open PR/MR on the app's forge.
// This intentionally does not gate on the app's Work Tracker: a PLAN.md or
// JIRA app can still have a forge change request that needs attention.
router.get('/:id/pull-requests', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { result } = await listWithActionState(app);
  res.json({ appId: app.id, appName: app.name, ...result });
}));

// POST /api/apps/:id/pull-requests/:number/resolve — queue the existing review
// loop against a freshly-read open PR/MR and start it now. Re-reading before
// queueing prevents a closed or replaced request from being attached to an agent
// by stale UI data.
router.post('/:id/pull-requests/:number/resolve', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { number } = validateRequest(pullRequestParamsSchema, req.params);
  const { result, tasks } = await listWithActionState(app);
  throwForgeReadError(result);

  if (tasks === null && result.pullRequests.length > 0) {
    throw new ServerError('Could not inspect existing CoS actions before queueing this request', {
      status: 503,
      code: 'AGENT_ACTION_UNAVAILABLE',
    });
  }

  const pullRequest = result.pullRequests.find(candidate => candidate.number === number);
  if (!pullRequest) {
    throw new ServerError(`Open pull request or merge request #${number} was not found`, {
      status: 404,
      code: 'PULL_REQUEST_NOT_OPEN',
    });
  }
  if (!pullRequest.url || !pullRequest.headBranch) {
    throw new ServerError(`Pull request or merge request #${number} has no usable forge URL or source branch`, {
      status: 502,
      code: 'PULL_REQUEST_CONTEXT_UNAVAILABLE',
    });
  }

  const existing = tasks?.find(task => isResolveTaskFor(task, app.id, pullRequest));
  if (existing) {
    res.json({
      appId: app.id,
      appName: app.name,
      pullRequest,
      task: taskResponse(existing),
      duplicate: true,
    });
    return;
  }

  // Code Review Defaults are the one source for the installed review roster.
  // `claimSafeReviewers` removes forge-side Copilot and supplies PortOS's
  // unattended coding-review fallback when the defaults contain only Copilot.
  const reviewOptions = await resolveReviewLoopOptions({}, {
    normalize: normalizeReviewers,
    isTruthyMeta,
  });
  const reviewers = claimSafeReviewers(reviewOptions.reviewers);
  const optionalReviewers = (reviewOptions.optionalReviewers || [])
    .filter(reviewer => reviewer !== 'copilot');
  const appLabel = String(app.name || app.id).replace(/\s+/g, ' ').trim();
  const title = String(pullRequest.title || '(untitled)').replace(/\s+/g, ' ').trim();
  const originalTask = {
    id: `app-pr-${app.id}-${number}`,
    status: 'pending',
    priority: 'HIGH',
    // Keep forge-controlled text out of the task instructions. The title is
    // retained as explicitly delimited data for UI/audit consumers, but the
    // autonomous follow-up receives only this static objective.
    description: `Resolve and merge ${result.forge === 'gitlab' ? 'MR' : 'PR'} #${number} for ${appLabel}`,
    metadata: {
      app: app.id,
      reviewLoopPRTitle: `--- BEGIN UNTRUSTED FORGE PR TITLE ---\n${title}\n--- END UNTRUSTED FORGE PR TITLE ---`,
    },
  };

  const task = await spawnReviewLoopFollowUp({
    originalAgentId: null,
    originalTask,
    prUrl: pullRequest.url,
    prBranch: pullRequest.headBranch,
    sourceWorkspace: app.repoPath,
    prCompletion: PR_COMPLETIONS.REVIEW_THEN_MERGE,
    ...reviewOptions,
    reviewers,
    optionalReviewers,
    // This button IS the user's approval — start the agent now instead of leaving
    // the follow-up as a pending system task the autonomous dequeue only picks up
    // while CoS auto-run is in `execute` and under its daily budget (which is why
    // it had to be started by hand from the task page).
    dispatch: 'immediate',
  });
  if (!task) {
    throw new ServerError('Could not queue the pull-request resolve agent', {
      status: 503,
      code: 'AGENT_ACTION_UNAVAILABLE',
    });
  }

  // `started` false means the task is persisted and queued but nothing is running
  // it yet (no agent slots, daemon stopped/paused, runner unreachable) — report the
  // reason rather than letting the UI claim an agent is on it. A duplicate has no
  // dispatch of its own: whatever is already queued owns the run.
  const started = task.dispatch?.started === true;
  const queueReason = task.dispatch?.reason ?? null;
  console.log(started
    ? `🚀 Started PR resolve agent for task ${task.id} (app ${app.id} request #${number})`
    : `⏳ Queued PR resolve task ${task.id} for app ${app.id} request #${number}${queueReason ? ` — ${queueReason}` : ''}`);
  res.status(task.duplicate ? 200 : 202).json({
    appId: app.id,
    appName: app.name,
    pullRequest: { ...pullRequest, agentAction: { taskId: task.id, status: task.status } },
    task: taskResponse(task),
    duplicate: task.duplicate === true,
    started,
    queueReason,
  });
}));

// POST /api/apps/:id/pull-requests/:number/review — queue the `pr-reviewer`
// scheduled task narrowed to ONE request. The scheduled task normally decides
// for itself which of the app's external PRs to sweep; a targeted request pins
// it to the row the user pressed.
//
// Eligibility is answered by the same reader the generator's security preflight
// uses, so the answer here is the answer there: GitHub only, open against the
// default branch, and opened by someone other than the signed-in gh account.
// Checking now turns "the run silently produced nothing an hour later" into an
// immediate, explained refusal.
router.post('/:id/pull-requests/:number/review', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { number } = validateRequest(pullRequestParamsSchema, req.params);

  const target = await listExternalOpenPullRequests(app);
  if (!target.ok) {
    throw new ServerError('Could not read the reviewable pull requests for this app', {
      status: 503,
      code: 'FORGE_UNAVAILABLE',
      context: { reason: target.code || 'security-scan-target-unavailable' },
    });
  }
  const pullRequest = target.prs.find(candidate => candidate.number === number);
  if (!pullRequest) {
    throw new ServerError(
      `Pull request #${number} is not reviewable — PR review covers open GitHub pull requests against the default branch that were opened by someone else`,
      { status: 409, code: 'PULL_REQUEST_NOT_REVIEWABLE' },
    );
  }
  // The security scan fingerprints the PR set by head commit, and the reader
  // normalizes an unusable `headRefOid` to null. Accepting one anyway would
  // return 202 for a run the preflight then drops on a null fingerprint — the UI
  // would show a queued review that can never start.
  if (!pullRequest.headRefOid) {
    throw new ServerError(
      `Pull request #${number} has no resolvable head commit, so its content cannot be safety-screened`,
      { status: 502, code: 'PULL_REQUEST_CONTEXT_UNAVAILABLE' },
    );
  }

  const [tasks, requests] = await Promise.all([readActiveTasks(), readPendingOnDemandRequests()]);
  // Fail CLOSED on unreadable task or on-demand state, matching /resolve:
  // `reviewActionFor` reads either as "no run in flight", so queueing anyway would
  // spend a second model-abuse scan and code review on a public PR already being
  // reviewed.
  if (tasks === null || requests === null) {
    throw new ServerError('Could not inspect existing CoS actions before queueing this review', {
      status: 503,
      code: 'AGENT_ACTION_UNAVAILABLE',
    });
  }
  const existing = reviewActionFor({ number }, tasks, requests, app.id);
  if (existing) {
    res.json({ appId: app.id, appName: app.name, number, reviewAction: existing, duplicate: true });
    return;
  }

  const request = await triggerOnDemandTask(PR_REVIEWER_TASK_TYPE, app.id, { targetPullRequest: number });
  if (request?.error) {
    throw new ServerError(request.error, { status: 409, code: 'PR_REVIEWER_UNAVAILABLE' });
  }

  console.log(`🔍 Queued pr-reviewer request ${request.id} for app ${app.id} request #${number}`);
  res.status(202).json({
    appId: app.id,
    appName: app.name,
    number,
    requestId: request.id,
    reviewAction: { taskId: null, status: 'pending' },
    duplicate: false,
  });
}));

export default router;
