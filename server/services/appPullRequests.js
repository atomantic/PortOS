/**
 * Open pull-request / merge-request listing for a managed app's PR tab.
 *
 * This is deliberately separate from `prWatcher.js`: the watcher only needs a
 * small GitHub-shaped row to decide whether to dispatch a scheduled task, while
 * the app UI needs the review, merge, and check state the user sees before
 * asking an agent to resolve a change request.
 *
 * Read-only. The resolve action is owned by the app route and queues the shared
 * review-loop follow-up; this service never changes a forge or calls an LLM.
 */

import { execGh, ensureForgeReachable } from './github.js';
import { execGlabJson } from './gitlab.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { safeJSONParse } from '../lib/fileUtils.js';

const GH_LIST_LIMIT = 200;
const GL_PER_PAGE = 100;

const GH_PR_FIELDS = [
  'number', 'title', 'author', 'url', 'createdAt', 'updatedAt', 'isDraft',
  'headRefName', 'baseRefName', 'reviewDecision', 'mergeStateStatus',
  'mergeable', 'statusCheckRollup', 'labels'
].join(',');

const baseResult = {
  forge: null,
  tracker: null,
  fullName: null,
  pullRequests: [],
  transient: false,
  headline: null,
  remedy: null,
};

const normalizeStatus = (value, fallback = 'PENDING') => {
  const status = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return status || fallback;
};

function normalizeCheck(check, fallbackName = 'Check') {
  return {
    name: [check?.name, check?.workflowName, check?.context]
      .find(value => typeof value === 'string' && value) || fallbackName,
    status: normalizeStatus(check?.conclusion || check?.state || check?.status),
    url: [check?.detailsUrl, check?.targetUrl, check?.web_url]
      .find(value => typeof value === 'string' && value) || null,
  };
}

function normalizeGithubPullRequest(pr) {
  return {
    number: Number(pr?.number),
    title: typeof pr?.title === 'string' ? pr.title : '',
    url: typeof pr?.url === 'string' ? pr.url : '',
    state: 'open',
    author: typeof pr?.author?.login === 'string' ? pr.author.login : null,
    createdAt: typeof pr?.createdAt === 'string' ? pr.createdAt : null,
    updatedAt: typeof pr?.updatedAt === 'string' ? pr.updatedAt : null,
    isDraft: pr?.isDraft === true,
    headBranch: typeof pr?.headRefName === 'string' ? pr.headRefName : '',
    baseBranch: typeof pr?.baseRefName === 'string' ? pr.baseRefName : '',
    reviewDecision: typeof pr?.reviewDecision === 'string' ? pr.reviewDecision : null,
    mergeStateStatus: typeof pr?.mergeStateStatus === 'string' ? pr.mergeStateStatus : null,
    mergeable: typeof pr?.mergeable === 'string' ? pr.mergeable : null,
    labels: Array.isArray(pr?.labels)
      ? pr.labels.map(label => label?.name).filter(label => typeof label === 'string' && label)
      : [],
    checks: Array.isArray(pr?.statusCheckRollup)
      ? pr.statusCheckRollup.filter(Boolean).map(check => normalizeCheck(check))
      : [],
  };
}

function normalizeGitlabPipeline(mr) {
  const pipeline = mr?.head_pipeline || mr?.pipeline;
  if (!pipeline) return [];
  return [normalizeCheck(pipeline, 'Pipeline')];
}

function normalizeGitlabReviewDecision(mr) {
  if (mr?.approved === true || (Array.isArray(mr?.approved_by) && mr.approved_by.length > 0)) {
    return 'APPROVED';
  }
  if (mr?.approved === false) return 'REVIEW_REQUIRED';
  return null;
}

function normalizeGitlabPullRequest(mr) {
  return {
    number: Number(mr?.iid),
    title: typeof mr?.title === 'string' ? mr.title : '',
    url: typeof mr?.web_url === 'string' ? mr.web_url : '',
    state: 'open',
    author: typeof mr?.author?.username === 'string'
      ? mr.author.username
      : (typeof mr?.author?.name === 'string' ? mr.author.name : null),
    createdAt: typeof mr?.created_at === 'string' ? mr.created_at : null,
    updatedAt: typeof mr?.updated_at === 'string' ? mr.updated_at : null,
    isDraft: mr?.draft === true || mr?.work_in_progress === true,
    headBranch: typeof mr?.source_branch === 'string' ? mr.source_branch : '',
    baseBranch: typeof mr?.target_branch === 'string' ? mr.target_branch : '',
    reviewDecision: normalizeGitlabReviewDecision(mr),
    mergeStateStatus: typeof mr?.detailed_merge_status === 'string'
      ? mr.detailed_merge_status
      : (typeof mr?.merge_status === 'string' ? mr.merge_status : null),
    mergeable: typeof mr?.merge_status === 'string' ? mr.merge_status : null,
    labels: Array.isArray(mr?.labels)
      ? mr.labels.map(label => typeof label === 'string' ? label : label?.name)
        .filter(label => typeof label === 'string' && label)
      : [],
    checks: normalizeGitlabPipeline(mr),
  };
}

function answeredResult(rows, normalize) {
  const pullRequests = rows.map(normalize).filter(pr => Number.isInteger(pr.number) && pr.number > 0);
  if (rows.length > 0 && pullRequests.length === 0) {
    return {
      pullRequests: [],
      reason: 'unreadable-response',
      transient: true,
      headline: "The forge returned an unreadable pull-request list",
      remedy: 'retry the request after checking the forge CLI version',
    };
  }
  return {
    pullRequests,
    reason: rows.length ? 'ok' : 'no-open-pull-requests',
    transient: false,
  };
}

async function fetchGithubPullRequests(repoSpec, apiHost) {
  const forge = await ensureForgeReachable('app-pull-requests', { hostname: apiHost });
  if (!forge.ok) {
    return {
      pullRequests: [],
      reason: `gh-${forge.status}`,
      transient: true,
      remedy: forge.remedy || null,
    };
  }

  const raw = await execGh([
    'pr', 'list', '--repo', repoSpec, '--state', 'open',
    '--limit', String(GH_LIST_LIMIT), '--json', GH_PR_FIELDS,
  ]).catch(err => {
    console.error(`❌ app-pull-requests: gh pr list failed for ${repoSpec}: ${err.message}`);
    return null;
  });
  const rows = safeJSONParse(raw, null);
  if (!Array.isArray(rows)) {
    return {
      pullRequests: [],
      reason: 'fetch-failed',
      transient: true,
      headline: "Couldn't read GitHub's pull-request list",
      remedy: 'run `gh pr list` in the repo to see what gh reports',
    };
  }
  return answeredResult(rows, normalizeGithubPullRequest);
}

async function fetchGitlabPullRequests(repoPath) {
  const { rows, reason } = await execGlabJson(['mr', 'list', '--per-page', String(GL_PER_PAGE)], repoPath);
  if (rows) return answeredResult(rows, normalizeGitlabPullRequest);
  if (reason === 'not-json') {
    return {
      pullRequests: [],
      reason: 'glab-output-not-json',
      transient: true,
      headline: "Reached GitLab, but couldn't read its answer",
      remedy: 'update `glab` — its JSON output flag moved (check `glab mr list --help`)',
    };
  }
  return {
    pullRequests: [],
    reason: 'fetch-failed',
    transient: true,
    headline: "Couldn't reach GitLab",
    remedy: 'check `glab auth status` and that `glab` is installed and can reach the host',
  };
}

/**
 * List open PRs/MRs for the repository behind a managed app.
 *
 * Unlike the Issues tab, this is not gated on the app's work tracker: an app
 * can use PLAN.md or JIRA for work and still have a GitHub/GitLab change
 * request that needs attention. `resolveAppForgeTarget` is still used so an
 * explicit forge pin can identify self-hosted installations.
 *
 * @param {object} app - managed app record (needs `repoPath`)
 * @returns {Promise<{forge:string|null, tracker:string|null, fullName:string|null, pullRequests:object[], reason:string, transient:boolean, headline:string|null, remedy:string|null}>}
 */
export async function listAppPullRequests(app) {
  if (!app?.repoPath) return { ...baseResult, reason: 'no-repo-path' };

  const { tracker, target } = await resolveAppForgeTarget(app);
  if (!target) return { ...baseResult, tracker, reason: 'unsupported-forge' };

  const result = target.forge === 'github'
    ? await fetchGithubPullRequests(target.repoSpec, target.apiHost)
    : await fetchGitlabPullRequests(app.repoPath);

  return {
    ...baseResult,
    forge: target.forge,
    tracker,
    fullName: target.fullName,
    pullRequests: result.pullRequests,
    reason: result.reason,
    transient: result.transient,
    headline: result.headline || null,
    remedy: result.remedy || null,
  };
}
