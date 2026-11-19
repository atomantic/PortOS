/** Forge-verified human-review handoff for a claim run that stopped before merge, never agent prose.
 *
 * A claim can publish its PR, pass CI and finish its own review, then be unable to merge because branch
 * protection wants an approving review only a person can give (`awaitsRequiredHumanReview`). Reporting that
 * as a hold made PortOS retry the run until its budget ran out and then park the task for the operator: a
 * second human queue item for the PR that already waits in the reviewer's queue. This settles the attempt
 * from the run's server-bound claim branches: every one must be merged at its local head or hold a published,
 * open PR waiting only on that approval, from a checkout with no uncommitted edits and, under review-then-merge,
 * a completed local review for that PR. Read-only, so live finalization and restart recovery both repeat it.
 */
import { resolve } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { hasClaimFlowContract } from '../lib/claimFlowTaskTypes.js';
import { MAX_BOUND_CLAIM_BRANCHES } from '../lib/claimContinuation.js';
import { expandHome } from '../lib/paths.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { localReviewLifecycle } from '../lib/localReviewLifecycle.js';
import { PR_COMPLETIONS, resolvePrCompletion } from '../lib/prDisposition.js';
import { awaitsRequiredHumanReview } from '../lib/pullRequestReadiness.js';
import { githubRepoSpec } from '../lib/workTracker.js';
import { getAppDataForTask } from './agent/agentAppWorkspace.js';
import { readPullRequest } from './prProbe.js';
import { listWorktrees } from './worktreeManager.js';

const PR_FIELDS = 'number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup';
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const unverified = reason => ({ status: 'unverified', reason });
const shortBranch = ref => ref?.replace(/^refs\/heads\//, '');

// The bound checkout must hold this delivery's completed local review; a
// `review-blocked` phase is PortOS work still owed, not a human's.
async function localReviewComplete(checkout, prUrl) {
  const check = await localReviewLifecycle(checkout, { prUrl }).catch(() => null);
  return check?.reusable === true && ['clean', 'partial'].includes(check.receipt?.status);
}

async function inspectBranch({ branch, source, trees, repoSpec, forgeAccount, reviewRequired }) {
  const tip = await execGit(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], source, { ignoreExitCode: true }).catch(() => null);
  const head = tip?.exitCode === 0 ? tip.stdout.trim().toLowerCase() : null;
  if (!SHA.test(head || '')) return unverified('claim-head-unavailable');
  const view = await readPullRequest(branch, PR_FIELDS, { repoPath: source, forgeAccount, repoSpec }).catch(() => null);
  // A branch selector also matches a fork's same-named head. Unpublished local
  // commits are unfinished work the retry still owns.
  if (!view || view.isCrossRepository !== false || view.headRefName !== branch
    || String(view.headRefOid || '').toLowerCase() !== head) {
    return unverified('pull-request-head-unverified');
  }
  if (view.state === 'MERGED') return { status: 'verified', pullRequest: { branch, number: view.number, url: view.url, head, state: 'MERGED' } };
  if (!awaitsRequiredHumanReview(view)) return unverified('pull-request-not-awaiting-human-review');
  const holders = trees.filter(tree => shortBranch(tree.branch) === branch);
  if (holders.length > 1 || (reviewRequired && holders.length !== 1)) return unverified('checkout-unavailable');
  if (holders.length === 1) {
    // Tracked edits only: the consumed completion sentinel is untracked, and
    // the checkout is retained either way, so nothing here is discarded.
    const status = await execGit(['status', '--porcelain', '--untracked-files=no'], holders[0].path, { ignoreExitCode: true }).catch(() => null);
    if (status?.exitCode !== 0) return unverified('checkout-unavailable');
    if (status.stdout.trim()) return unverified('checkout-has-uncommitted-work');
    if (reviewRequired && !await localReviewComplete(holders[0].path, view.url)) return unverified('local-review-incomplete');
  }
  return { status: 'verified', pullRequest: { branch, number: view.number, url: view.url, head, state: 'OPEN', awaitingHumanReview: true } };
}

/**
 * @returns {Promise<null|{status: 'unverified', reason: string}|{status: 'verified', taskId: string, agentId: string,
 *   pullRequests: Array<{branch: string, number: number, url: string, head: string, state: 'OPEN'|'MERGED', awaitingHumanReview?: true}>}>}
 *   null when the run is not a held claim this check applies to.
 */
export async function verifyClaimReviewHandoff({ task, agent, reportedOutcome, success }) {
  if (!success || !['blocked', 'incomplete'].includes(reportedOutcome?.status) || reportedOutcome.recovery
    || !hasClaimFlowContract(task)) return null;
  if (!task?.id || agent?.taskId !== task.id) return unverified('task-binding-unverified');
  const branches = agent.metadata?.claimBranches;
  if (!Array.isArray(branches) || !branches.length || branches.length > MAX_BOUND_CLAIM_BRANCHES
    || branches.some(branch => typeof branch !== 'string' || !branch)) return unverified('claim-branches-unbound');
  const app = await getAppDataForTask(task);
  const source = agent.metadata?.sourceWorkspace || agent.metadata?.workspacePath;
  if (!app?.repoPath || typeof source !== 'string' || resolve(expandHome(app.repoPath)) !== resolve(source)) {
    return unverified('repository-binding-unverified');
  }
  // GitLab has no equivalent of GitHub's reviewDecision wired here; its held
  // claims keep the ordinary bounded retry.
  const repoSpec = githubRepoSpec(await getOriginInfo(source).catch(() => null));
  if (!repoSpec) return unverified('forge-unsupported');
  const trees = await listWorktrees(source).catch(() => null);
  if (!Array.isArray(trees)) return unverified('checkout-unavailable');
  const reviewRequired = resolvePrCompletion(task.metadata) === PR_COMPLETIONS.REVIEW_THEN_MERGE;
  const pullRequests = [];
  for (const branch of new Set(branches)) {
    const result = await inspectBranch({ branch, source, trees, repoSpec, forgeAccount: app.forgeAccount || null, reviewRequired });
    if (result.status !== 'verified') return result;
    pullRequests.push(result.pullRequest);
  }
  if (!pullRequests.some(pr => pr.awaitingHumanReview)) return unverified('no-pull-request-awaiting-human-review');
  return { status: 'verified', taskId: task.id, agentId: agent.id, pullRequests };
}
