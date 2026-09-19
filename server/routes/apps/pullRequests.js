/**
 * App pull-request / merge-request routes.
 *
 *   GET  /:id/pull-requests                         → open forge requests
 *   POST /:id/pull-requests/:number/resolve         → queue a review-loop agent
 *   POST /:id/pull-requests/:number/review          → queue pr-reviewer for ONE PR
 *   POST /:id/pull-requests/:number/do-review       → queue /do:review for ONE PR
 *   POST /:id/pull-requests/:number/merge           → merge it now, no agent
 *
 * Three of the four queue an agent. `/resolve` queues PortOS's existing
 * review-loop follow-up, which owns fetching feedback, fixing the branch,
 * waiting for checks, and merging — and starts it immediately, because pressing
 * the button is the approval. `/review` queues the `pr-reviewer` scheduled task
 * narrowed to a single request, so the security-scan → review pipeline that
 * normally sweeps every external PR can be pointed at one. `/do-review` runs the
 * bundled `/do:review` workflow against one request with the install's Code
 * Review Defaults and publishes an inline review — the only one of the three
 * that offers a review on EVERY open GitHub PR, whoever opened it, because
 * `pr-reviewer` covers untrusted contributors alone. `/merge` is the one that
 * queues nothing and spends nothing: the forge's own merge button, for a change
 * the user has already read.
 *
 * That split is why the two agent routes PortOS composes itself (`/resolve`,
 * `/do-review`) take `pullRequestRunSettingsSchema` — the provider pin PLUS this
 * run's review settings — while `/review` takes the provider pin alone: its run
 * is a `pr-reviewer` task whose reviewers come from that scheduled task's own
 * stages, so a review setting sent there would be one the server accepts and
 * nothing applies.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { pullRequestProviderOverrideSchema, pullRequestRunSettingsSchema, reviewerConfigMetadata } from '../../lib/cosValidation.js';
import { claimSafeReviewers, normalizeReviewers, validateRequest } from '../../lib/validation.js';
import { PR_COMPLETIONS, isSelfReviewMode } from '../../lib/prDisposition.js';
import { isTruthyMeta } from '../../services/agentState.js';
import { resolveReviewLoopOptions } from '../../services/codeReview.js';
import { getAllTasks } from '../../services/cos.js';
import { spawnReviewLoopFollowUp } from '../../services/agentWorktreeCleanup.js';
import { listAppPullRequests } from '../../services/appPullRequests.js';
import {
  MERGE_METHODS,
  DEFAULT_MERGE_METHOD,
  isDirectlyMergeablePullRequest,
  mergeAppPullRequest,
} from '../../services/appPullRequestMerge.js';
import { isDoReviewTask, spawnPrDoReviewTask } from '../../services/prDoReviewTask.js';
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

// The direct merge's only inputs; the tab always sends both. A caller that omits
// `deleteBranch` gets the conservative answer — the flag is irreversible on the
// forge, and the merge service refuses it outright for a long-lived head.
const pullRequestMergeSchema = z.object({
  method: z.enum(MERGE_METHODS).optional(),
  deleteBranch: z.boolean().optional(),
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

// A `/do:review` run pinned to this request. It shares `targetPullRequest` with
// the pr-reviewer match above — one vocabulary for "this task targets PR #N" —
// and `isDoReviewTask` is what tells the two apart.
const isDoReviewTaskFor = (task, appId, pullRequest) => {
  const metadata = task?.metadata;
  return ACTIVE_TASK_STATUSES.has(task?.status)
    && isDoReviewTask(metadata)
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
  const eligible = new Set();
  await Promise.all((result.pullRequests || []).map(async pullRequest => {
    if (await isReviewablePullRequest(scope, pullRequest)) eligible.add(pullRequest.number);
  }));
  return pullRequest => eligible.has(pullRequest.number);
}

// Per-row Do:Review eligibility. Deliberately NOT an authorship test — that is
// the whole point of the action: pr-reviewer covers untrusted contributors only,
// so every other row had no review-only action. What it does gate is what
// slashdo's PR mode actually needs — a GitHub request with a URL to read it by.
// Pure, unlike `resolveReviewEligibility` beside it, so it costs no forge call.
//
// Server-side rather than re-derived in the tab, for the same reason
// `reviewEligible` is: two copies of one rule drift, and the client's copy was
// missing the URL half — painting a button whose only outcome is a 502.
const isDoReviewablePullRequest = (result, pullRequest) =>
  result.forge === 'github' && !!pullRequest.url;

// The find-and-project contract shared by the two single-task actions, with the
// matcher passed in. Written once so the "unreadable tasks is not the same as no
// action" rule (`!tasks` → null, never a cheerful empty answer) cannot be
// restated differently per kind.
function actionFor(pullRequest, tasks, appId, matches) {
  if (!tasks) return null;
  const task = tasks.find(candidate => matches(candidate, appId, pullRequest));
  return task ? { taskId: task.id, status: task.status } : null;
}

function reviewActionFor(pullRequest, tasks, requests, appId) {
  const task = tasks?.find(candidate => isReviewTaskFor(candidate, appId, pullRequest));
  if (task) return { taskId: task.id, status: task.status };
  const queued = requests?.find(request => isReviewRequestFor(request, appId, pullRequest));
  if (queued) return { taskId: null, status: 'pending' };
  const failure = tasks?.findLast(candidate => candidate.status === 'completed'
    && candidate.metadata?.analysisType === PR_REVIEWER_TASK_TYPE
    && candidate.metadata?.app === appId
    && Number(candidate.metadata?.targetPullRequest) === pullRequest.number);
  return failure?.metadata?.preflightFailure ? { taskId: failure.id, status: 'failed', error: failure.metadata.note } : null;
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
        agentAction: actionFor(pullRequest, tasks, app.id, isResolveTaskFor),
        reviewAction: reviewActionFor(pullRequest, tasks, requests, app.id),
        doReviewAction: actionFor(pullRequest, tasks, app.id, isDoReviewTaskFor),
        reviewEligible: reviewEligible(pullRequest),
        doReviewEligible: isDoReviewablePullRequest(result, pullRequest),
        mergeEligible: isDirectlyMergeablePullRequest(pullRequest),
      })),
    },
    tasks,
  };
}

// The one spelling of "this row is still open", shared by every route that
// re-reads the open set before acting on a single request — the message and
// code would otherwise drift across three doors with nothing catching it.
function findOpenPullRequest(result, number) {
  const pullRequest = (result.pullRequests || []).find(candidate => candidate.number === number);
  if (!pullRequest) {
    throw new ServerError(`Open pull request or merge request #${number} was not found`, {
      status: 404,
      code: 'PULL_REQUEST_NOT_OPEN',
    });
  }
  return pullRequest;
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
  // Optional provider/model/effort pin from the tab's "Run with" picker — left
  // blank, the follow-up resolves the install's active provider exactly as it
  // always did — plus this run's review settings (mode, and any reviewer
  // override layered over the install's Code Review Defaults).
  const runSettings = validateRequest(pullRequestRunSettingsSchema, req.body || {});
  const { provider, model, effort } = runSettings;
  const selfReview = isSelfReviewMode(runSettings.reviewMode);
  const { result, tasks } = await listWithActionState(app);
  throwForgeReadError(result);

  if (tasks === null && result.pullRequests.length > 0) {
    throw new ServerError('Could not inspect existing CoS actions before queueing this request', {
      status: 503,
      code: 'AGENT_ACTION_UNAVAILABLE',
    });
  }

  const pullRequest = findOpenPullRequest(result, number);
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

  // Code Review Defaults are the one source for the installed review roster, and
  // this run's own reviewer override (when the panel supplied one) layers over
  // them with the same task-over-default precedence every other dispatch surface
  // uses — `resolveReviewLoopOptions` takes the override in the metadata slot.
  // `claimSafeReviewers` removes forge-side Copilot and supplies PortOS's
  // unattended coding-review fallback when the defaults contain only Copilot.
  //
  // Resolved even under self-review, and handed over intact: emptying the roster
  // is `spawnReviewLoopFollowUp`'s job, not this route's (see its `selfReview`
  // contract), and the stop-mode / applies fields alongside it are not roster
  // fields at all.
  const reviewOptions = await resolveReviewLoopOptions(reviewerConfigMetadata(runSettings), {
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
      // Read by spawnReviewLoopFollowUp below as the source task's pin — the
      // same `providerPins` inheritance every other follow-up gets, just seeded
      // from this request instead of the original task that opened the PR.
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    },
  };

  const task = await spawnReviewLoopFollowUp({
    originalAgentId: null,
    originalTask,
    prUrl: pullRequest.url,
    prBranch: pullRequest.headBranch,
    // Null for a same-repo head. A FORK PR's head branch has no
    // `origin/<branch>`, so without this the follow-up is queued and then
    // blocked at workspace prep — which is every external contribution (#6064).
    forkHead: pullRequest.forkHead,
    sourceWorkspace: app.repoPath,
    prCompletion: PR_COMPLETIONS.REVIEW_THEN_MERGE,
    ...reviewOptions,
    reviewers,
    optionalReviewers,
    selfReview,
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

// POST /api/apps/:id/pull-requests/:number/merge — merge one open request NOW,
// with no agent and no model spend. The open set is re-read first, exactly as
// `/resolve` does: a tab left open for an hour must not merge a request that has
// since been closed, replaced, or turned into a draft.
router.post('/:id/pull-requests/:number/merge', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { number } = validateRequest(pullRequestParamsSchema, req.params);
  const { method = DEFAULT_MERGE_METHOD, deleteBranch = false } =
    validateRequest(pullRequestMergeSchema, req.body || {});

  const result = await listAppPullRequests(app);
  throwForgeReadError(result);

  const pullRequest = findOpenPullRequest(result, number);
  if (!isDirectlyMergeablePullRequest(pullRequest)) {
    throw new ServerError(`${result.forge === 'gitlab' ? 'Merge' : 'Pull'} request #${number} is a draft — mark it ready for review before merging`, {
      status: 409,
      code: 'PULL_REQUEST_IS_DRAFT',
    });
  }

  const merge = await mergeAppPullRequest(app, pullRequest, { method, deleteBranch });
  if (!merge.ok) {
    const refused = merge.code === 'method-not-allowed';
    throw new ServerError(merge.error, {
      // Only the forge failing the merge itself is a bad gateway; everything
      // else is this request asking for something the project does not allow.
      status: merge.code === 'merge-failed' ? 502 : 409,
      code: refused ? 'MERGE_METHOD_NOT_ALLOWED' : 'PULL_REQUEST_MERGE_FAILED',
      context: { method, reason: merge.code },
    });
  }

  res.json({
    appId: app.id,
    appName: app.name,
    number,
    merged: true,
    method: merge.method,
    // The ANSWER, not the request: a long-lived head (a `main → release`
    // request) merges without its branch being deleted.
    deletedBranch: merge.deletedBranch,
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
  // Optional provider/model/effort pin from the tab's "Run with" picker. A
  // public-review posture (see resolveAgentProviderAndModel) still gates the
  // provider to its own eligible set — an ineligible pin is dropped with a
  // warning rather than honored, same as any other pr-reviewer pin.
  const { provider, model, effort } = validateRequest(pullRequestProviderOverrideSchema, req.body || {});

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
      `Pull request #${number} is not reviewable — PR review covers open GitHub pull requests against the default branch from an untrusted contributor`,
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
  if (existing && existing.status !== 'failed') {
    res.json({ appId: app.id, appName: app.name, number, reviewAction: existing, duplicate: true });
    return;
  }

  const request = await triggerOnDemandTask(PR_REVIEWER_TASK_TYPE, app.id, {
    targetPullRequest: number,
    provider,
    model,
    effort,
  });
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

// POST /api/apps/:id/pull-requests/:number/do-review — run the bundled
// `/do:review` workflow against ONE open request and publish its findings as an
// inline review.
//
// Deliberately NOT gated on authorship. `/review` above covers untrusted
// contributors only, and `/resolve` is the fix-and-land lifecycle, so a PR from
// a known code contributor, a teammate, or PortOS's own agents had no
// review-only action at all. Eligibility here is just "an open PR slashdo's PR
// mode can read": GitHub, with a URL.
router.post('/:id/pull-requests/:number/do-review', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;
  const { number } = validateRequest(pullRequestParamsSchema, req.params);
  // Optional provider/model/effort pin from the tab's "Run with" picker, applied
  // exactly as /resolve applies it: this is a directly user-triggered agent run,
  // not a scheduled task with saved stage providers. The review settings ride
  // along the same way — `/do:review` resolves its own roster at prompt-build
  // time, so both the mode and any reviewer override are handed to the task
  // rather than rendered into a flag here.
  const runSettings = validateRequest(pullRequestRunSettingsSchema, req.body || {});
  const { provider, model, effort } = runSettings;
  // Deliberately NOT `listWithActionState`: that annotates every row with all
  // four action fields, and its `resolveReviewEligibility` spends a `gh repo
  // view`, a `gh api user`, and one collaborator-permission call per distinct PR
  // author — for `reviewEligible`, which this route never reads. `/review` skips
  // it for the same reason. The two reads are independent, so they overlap.
  const [result, tasks] = await Promise.all([listAppPullRequests(app), readActiveTasks()]);
  throwForgeReadError(result);

  // Before any row lookup: on a non-GitHub forge every row is a guaranteed 409,
  // so say so rather than searching a list that cannot produce a match.
  // slashdo's PR mode aborts on a GitLab merge-request URL rather than falling
  // back to a local diff, so there is nothing to burn an agent run on.
  if (result.forge !== 'github') {
    throw new ServerError(
      `Do:Review covers GitHub pull requests only (this app's forge is ${result.forge || 'unknown'})`,
      { status: 409, code: 'PULL_REQUEST_NOT_REVIEWABLE' },
    );
  }

  const pullRequest = findOpenPullRequest(result, number);
  if (!isDoReviewablePullRequest(result, pullRequest)) {
    throw new ServerError(`Pull request #${number} has no usable forge URL`, {
      status: 502,
      code: 'PULL_REQUEST_CONTEXT_UNAVAILABLE',
    });
  }

  // Fail CLOSED on unreadable task state, matching /resolve and /review: reading
  // it as "nothing in flight" would spend a second full review roster on a
  // request an agent is already reviewing.
  if (tasks === null) {
    throw new ServerError('Could not inspect existing CoS actions before queueing this review', {
      status: 503,
      code: 'AGENT_ACTION_UNAVAILABLE',
    });
  }

  const existing = tasks.find(task => isDoReviewTaskFor(task, app.id, pullRequest));
  if (existing) {
    res.json({
      appId: app.id,
      appName: app.name,
      number,
      doReviewAction: { taskId: existing.id, status: existing.status },
      duplicate: true,
    });
    return;
  }

  const queued = await spawnPrDoReviewTask({
    app,
    pullRequest,
    repoFullName: result.fullName,
    provider,
    model,
    effort,
    selfReview: isSelfReviewMode(runSettings.reviewMode),
    reviewerConfig: reviewerConfigMetadata(runSettings),
  });
  if (!queued.task) {
    throw new ServerError('Could not queue the pull-request review agent', {
      status: 503,
      code: 'AGENT_ACTION_UNAVAILABLE',
    });
  }

  res.status(queued.duplicate ? 200 : 202).json({
    appId: app.id,
    appName: app.name,
    number,
    doReviewAction: { taskId: queued.task.id, status: queued.task.status },
    duplicate: queued.duplicate,
    // Same `started` / `queueReason` pair /resolve returns, so the tab's one
    // toast builder reads both actions the same way.
    started: queued.dispatch.started,
    queueReason: queued.dispatch.reason,
  });
}));

export default router;
