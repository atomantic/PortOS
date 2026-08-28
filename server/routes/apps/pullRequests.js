/**
 * App pull-request / merge-request routes.
 *
 *   GET  /:id/pull-requests                         → open forge requests
 *   POST /:id/pull-requests/:number/resolve         → queue a review-loop agent
 *
 * The POST route only queues PortOS's existing review-loop follow-up. The
 * follow-up owns fetching feedback, fixing the branch, waiting for checks, and
 * merging; this route never merges a user's PR directly.
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
import { loadApp } from './shared.js';

const router = Router();

const pullRequestParamsSchema = z.object({
  number: z.coerce.number().int().positive(),
});

const ACTIVE_TASK_STATUSES = new Set(['pending', 'in_progress', 'blocked']);

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

async function readActiveResolveTasks() {
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

function actionFor(pullRequest, tasks, appId) {
  if (!tasks) return null;
  const task = tasks.find(candidate => isResolveTaskFor(candidate, appId, pullRequest));
  return task ? { taskId: task.id, status: task.status } : null;
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

  const tasks = await readActiveResolveTasks();
  return {
    result: {
      ...result,
      pullRequests: pullRequests.map(pullRequest => ({
        ...pullRequest,
        agentAction: actionFor(pullRequest, tasks, app.id),
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
// loop against a freshly-read open PR/MR. Re-reading before queueing prevents a
// closed or replaced request from being attached to an agent by stale UI data.
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
  });
  if (!task) {
    throw new ServerError('Could not queue the pull-request resolve agent', {
      status: 503,
      code: 'AGENT_ACTION_UNAVAILABLE',
    });
  }

  console.log(`🚀 Queued PR resolve agent ${task.id} for app ${app.id} request #${number}`);
  res.status(task.duplicate ? 200 : 202).json({
    appId: app.id,
    appName: app.name,
    pullRequest: { ...pullRequest, agentAction: { taskId: task.id, status: task.status } },
    task: taskResponse(task),
    duplicate: task.duplicate === true,
  });
}));

export default router;
