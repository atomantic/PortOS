/**
 * Queue the `pr-reviewer` scheduled task narrowed to ONE pull request. Shared by
 * the app Pull Requests tab's Untrusted:Review button and the GitHub
 * notifications Autopilot hand-off (#12874), so both reach the reviewer through
 * the same eligibility check, duplicate check and on-demand lane; neither starts
 * an agent from the request's content directly.
 */
import { ServerError } from '../lib/errorHandler.js';
import { getAllTasks } from './cos.js';
import { listExternalOpenPullRequests } from './prReviewerSecurity.js';
import { getOnDemandRequests, triggerOnDemandTask } from './taskSchedule.js';

export const ACTIVE_TASK_STATUSES = new Set(['pending', 'in_progress', 'blocked']);
const PR_REVIEWER_TASK_TYPE = 'pr-reviewer';

const flattenTasks = (taskData) => [
  ...(Array.isArray(taskData?.user?.tasks) ? taskData.user.tasks : []),
  ...(Array.isArray(taskData?.cos?.tasks) ? taskData.cos.tasks : []),
];

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

/** Every CoS task, or null when the task store could not be read. */
export async function readActiveTasks() {
  const taskData = await getAllTasks().catch(err => {
    console.error(`❌ pr-reviewer targeting: could not read CoS tasks: ${err.message}`);
    return null;
  });
  if (!Array.isArray(taskData?.user?.tasks) || !Array.isArray(taskData?.cos?.tasks)) {
    if (taskData) console.error('❌ pr-reviewer targeting: CoS task response had an invalid shape');
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
// the two would let a caller miss an existing request and queue a duplicate
// scan of the same public PR. Queueing fails closed on it; a listing, which only
// paints a button, degrades to showing no queued action.
export async function readPendingOnDemandRequests() {
  const requests = await getOnDemandRequests().catch(err => {
    console.error(`❌ pr-reviewer targeting: could not read on-demand requests: ${err.message}`);
    return null;
  });
  return Array.isArray(requests) ? requests : null;
}

export function reviewActionFor(pullRequest, tasks, requests, appId) {
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

/**
 * Eligibility is answered by the same reader the generator's security preflight
 * uses: GitHub only, open against the default branch, and opened by someone
 * other than the signed-in gh account. `origin` defaults to a human Run
 * (see ON_DEMAND_ORIGINS); an automation passes its own. Returns `{ duplicate: true, reviewAction }`
 * when a run for this request is already in flight, else `{ duplicate: false,
 * request }`. Throws a ServerError with a status the route returns as is.
 */
export async function queueTargetedPrReview(app, number, { provider, model, effort, origin } = {}) {
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
  // queue a run the preflight then drops on a null fingerprint.
  if (!pullRequest.headRefOid) {
    throw new ServerError(
      `Pull request #${number} has no resolvable head commit, so its content cannot be safety-screened`,
      { status: 502, code: 'PULL_REQUEST_CONTEXT_UNAVAILABLE' },
    );
  }

  const [tasks, requests] = await Promise.all([readActiveTasks(), readPendingOnDemandRequests()]);
  // Fail CLOSED on unreadable task or on-demand state: `reviewActionFor` reads
  // either as "no run in flight", so queueing anyway would spend a second
  // model-abuse scan and code review on a public PR already being reviewed.
  if (tasks === null || requests === null) {
    throw new ServerError('Could not inspect existing CoS actions before queueing this review', {
      status: 503,
      code: 'AGENT_ACTION_UNAVAILABLE',
    });
  }
  const existing = reviewActionFor({ number }, tasks, requests, app.id);
  if (existing && existing.status !== 'failed') return { duplicate: true, reviewAction: existing };

  const request = await triggerOnDemandTask(PR_REVIEWER_TASK_TYPE, app.id, {
    targetPullRequest: number,
    provider,
    model,
    effort,
    origin,
  });
  if (request?.error) {
    throw new ServerError(request.error, { status: 409, code: 'PR_REVIEWER_UNAVAILABLE' });
  }
  console.log(`🔍 Queued pr-reviewer request ${request.id} for app ${app.id} request #${number}`);
  return { duplicate: false, request };
}
