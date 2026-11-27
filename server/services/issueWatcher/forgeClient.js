/** Resolve the configured GitHub identity and perform issue-watcher forge reads and writes. */
import { safeJSONParse } from '../../lib/fileUtils.js';
import { getOriginInfo } from '../../lib/gitRemote.js';
import { MAX_REVIEW_BODY_CHARS } from '../../lib/prReviewReport.js';
import { githubApiHost, githubRepoSpec } from '../../lib/workTracker.js';
import { execGh, ensureForgeReachable } from '../github.js';
import { resolveForgeForRepo } from '../forgeAuth.js';
import { trimTo } from '../../lib/textUtils.js';

const GH_TIMEOUT_MS = 60_000;

export const fullText = (value) => typeof value === 'string' ? value : '';

export const sameLogin = (a, b) => Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();

// GitHub reports issue state as `open`/`closed`; normalize once so every caller
// that gates on "still actionable" agrees, including on a missing state field.
export const isOpenIssue = (issue) => String(issue?.state || '').toLowerCase() === 'open';

function flattenPages(value) {
  if (!Array.isArray(value)) return null;
  return value.length > 0 && value.every(Array.isArray) ? value.flat() : value;
}

function ghOptions(ctx, input = null) {
  return { cwd: ctx.cwd, env: ctx.env, input };
}

export async function runGh(args, ctx, input = null) {
  return execGh(args, GH_TIMEOUT_MS, ghOptions(ctx, input));
}

export async function runJson(args, ctx) {
  const raw = await runGh(args, ctx).catch(() => null);
  return raw === null ? null : safeJSONParse(raw, null, { logError: false });
}

export function apiArgs(ctx, endpoint, { method = 'GET', fields = [], paginate = false } = {}) {
  return [
    'api', '--hostname', ctx.host, '--method', method,
    ...(paginate ? ['--paginate', '--slurp'] : []),
    endpoint,
    ...fields.flatMap(([key, value]) => ['-f', `${key}=${value}`]),
  ];
}

export async function resolveContext(app) {
  const origin = await getOriginInfo(app?.repoPath).catch(() => null);
  const repoSpec = githubRepoSpec(origin);
  const host = githubApiHost(origin?.host);
  if (!repoSpec || !host || !origin?.fullName) return null;
  const forge = await resolveForgeForRepo(app.repoPath, { forgeAccount: app.forgeAccount || null }).catch(() => null);
  if (!forge || forge.cli !== 'gh') return null;
  const reachable = await ensureForgeReachable('issue-watcher', { hostname: host, env: forge.env });
  if (!reachable.ok) return null;
  return {
    cwd: app.repoPath,
    env: forge.env,
    host,
    repoSpec,
    repoFullName: origin.fullName,
  };
}

export async function listPaginated(ctx, endpoint, fields = []) {
  const parsed = await runJson(apiArgs(ctx, endpoint, { paginate: true, fields }), ctx);
  return flattenPages(parsed);
}

export async function getRepositoryIdentity(ctx) {
  const repo = await runJson(apiArgs(ctx, `repos/${ctx.repoFullName}`), ctx);
  if (!repo?.owner?.login) return null;
  let ownerLogin = repo.owner.login;
  if (String(repo.owner.type).toLowerCase() === 'organization') {
    const viewer = await runJson(apiArgs(ctx, 'user'), ctx);
    ownerLogin = viewer?.login || null;
  }
  return ownerLogin ? { ownerLogin } : null;
}

export async function readPullRequest(ctx, number) {
  return runJson([
    'pr', 'view', String(number), '--repo', ctx.repoSpec,
    // `isCrossRepository`/`maintainerCanModify` decide who owns a PR the
    // coordinator did not merge: with write access on the head branch PortOS
    // lands it itself, without it the PR goes to the opener's queue
    // (`prHandbackPolicy.js`). `headRepository`/`headRepositoryOwner` are where
    // a fork's head branch actually lives, which is what lets the remediation
    // agent's worktree attach to it at all (#6064). `assignees` keeps that
    // assignment idempotent across scheduled sweeps. `commits` is part of the
    // screened content, so `screenedPullRequestFingerprintMatches` cannot verify
    // a current-recipe stamp on a PR read without it — safe to ask for on a
    // single PR, unlike the bulk listing the preflight has to keep it out of
    // (GraphQL node budget).
    '--json', 'id,number,title,body,url,state,isDraft,author,assignees,labels,commits,files,additions,deletions,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository,maintainerCanModify,headRepository,headRepositoryOwner,mergeable,mergeStateStatus,statusCheckRollup',
  ], ctx);
}

export async function readBehindBy(ctx, pr) {
  if (!pr?.baseRefOid || !pr?.headRefOid) return null;
  const compare = await runJson(apiArgs(ctx, `repos/${ctx.repoFullName}/compare/${pr.baseRefOid}...${pr.headRefOid}`), ctx);
  return Number.isInteger(compare?.behind_by) ? compare.behind_by : null;
}

export async function postIssueReply(ctx, decision) {
  return runGh([
    'issue', 'comment', String(decision.issueNumber), '--repo', ctx.repoSpec, '--body', trimTo(decision.body, 5_000),
  ], ctx).then(() => true).catch((err) => {
    console.error(`❌ issue-watcher: issue reply failed for #${decision.issueNumber}: ${err.message}`);
    return false;
  });
}

export async function readCurrentIssueComment(ctx, item) {
  const [issue, comment] = await Promise.all([
    runJson(apiArgs(ctx, `repos/${ctx.repoFullName}/issues/${item.issueNumber}`), ctx),
    item.commentId === 0 ? null : runJson(apiArgs(ctx, `repos/${ctx.repoFullName}/issues/comments/${item.commentId}`), ctx),
  ]);
  if (!isOpenIssue(issue)) return null;
  if (item.commentId === 0) return {
    ...item, issueTitle: fullText(issue.title), issueBody: fullText(issue.body),
    issueAssignees: Array.isArray(issue.assignees) ? issue.assignees : [],
    commentAuthor: issue.user?.login || item.commentAuthor, commentBody: '',
  };
  if (!comment || comment.id !== item.commentId) return null;
  return {
    ...item,
    issueTitle: fullText(issue.title),
    issueBody: fullText(issue.body),
    issueAssignees: Array.isArray(issue.assignees) ? issue.assignees : [],
    commentBody: fullText(comment.body),
    commentAuthor: comment.user?.login || item.commentAuthor,
    commentUrl: comment.html_url || item.commentUrl || null,
  };
}

export async function submitReview(ctx, number, headSha, { body, event, comments = [] }) {
  const input = JSON.stringify({ commit_id: headSha, body: trimTo(body, MAX_REVIEW_BODY_CHARS), event, comments });
  return runGh([...apiArgs(ctx, `repos/${ctx.repoFullName}/pulls/${number}/reviews`, { method: 'POST' }), '--input', '-'], ctx, input)
    .then(() => true)
    .catch((err) => {
      console.error(`❌ issue-watcher: review submit failed for PR #${number} (${event}): ${err.message}`);
      return false;
    });
}

export async function postReviewFallback(ctx, number, body) {
  return runGh(['pr', 'comment', String(number), '--repo', ctx.repoSpec, '--body', trimTo(body, MAX_REVIEW_BODY_CHARS)], ctx)
    .then(() => true)
    .catch((err) => {
      console.error(`❌ issue-watcher: review comment failed for PR #${number}: ${err.message}`);
      return false;
    });
}

export async function updatePullRequestBranch(ctx, number, headSha) {
  const input = JSON.stringify({ expected_head_sha: headSha, update_method: 'rebase' });
  return runGh([...apiArgs(ctx, `repos/${ctx.repoFullName}/pulls/${number}/update-branch`, { method: 'PUT' }), '--input', '-'], ctx, input)
    .then(() => true)
    .catch((err) => {
      console.error(`❌ issue-watcher: update-branch failed for PR #${number}: ${err.message}`);
      return false;
    });
}
