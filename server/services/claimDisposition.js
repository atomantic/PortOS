/** Read-only completion evidence for a selected claim, never agent prose. */
import { resolve } from 'node:path';
import { hasClaimFlowContract } from '../lib/claimFlowTaskTypes.js';
import { expandHome, safeJSONParse } from '../lib/fileUtils.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { getAppDataForTask } from './agentAppWorkspace.js';

const unverified = reason => ({ status: 'unverified', reason });
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const positiveIssue = value => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

async function trustedGithubClosure(closed, target, run) {
  const { createGithubActorTrust } = await import('./forgeActorTrust.js');
  const trust = await createGithubActorTrust({ runGh: run, host: target.apiHost, repoFullName: target.fullName });
  return trust.isTrusted(closed.actor?.login);
}

function selectedIssues(task, agent) {
  const branches = agent?.metadata?.claimBranches;
  if (Array.isArray(branches) && branches.length) {
    // Every bound child must be accounted for; never settle an entire swarm by
    // presenting one convenient closed issue. Unknown branch formats refuse.
    const numbers = branches.map(branch => typeof branch === 'string'
      ? positiveIssue(branch.match(/^claim\/issue-([1-9]\d*)$/)?.[1]) : null);
    return numbers.every(Boolean) ? [...new Set(numbers)] : null;
  }
  const number = positiveIssue(task.metadata?.claimTarget);
  return number ? [number] : null;
}

const PR_FIELDS = `number merged mergedAt baseRefName baseRepository { nameWithOwner }
  mergeCommit { oid } closingIssuesReferences(first:100) { nodes { number repository { nameWithOwner } } }`;
const CLAIM_QUERY = `query($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { nameWithOwner defaultBranchRef { name }
    issue(number:$number) { number state stateReason repository { nameWithOwner }
      timelineItems(last:100,itemTypes:[CLOSED_EVENT,CROSS_REFERENCED_EVENT]) { nodes {
        ... on ClosedEvent { actor { login } createdAt closer { __typename ... on PullRequest { ${PR_FIELDS} } } }
        ... on CrossReferencedEvent { source { __typename ... on PullRequest { ${PR_FIELDS} } } }
      } }
    }
  }
}`;

function deliveredPr(pr, number, target, defaultBranch, closedAt) {
  return pr?.__typename === 'PullRequest' && pr.merged === true
    && Number.isSafeInteger(pr.number) && pr.number > 0
    && /^[a-f0-9]{40,64}$/i.test(pr.mergeCommit?.oid || '')
    && sameRepo(pr.baseRepository?.nameWithOwner, target.fullName) && pr.baseRefName === defaultBranch
    && Number.isFinite(Date.parse(pr.mergedAt)) && Date.parse(pr.mergedAt) <= Date.parse(closedAt)
    && pr.closingIssuesReferences?.nodes?.some(issue => issue.number === number
      && sameRepo(issue.repository?.nameWithOwner, target.fullName));
}

async function githubDisposition({ number, target, run }) {
  const [owner, name] = target.fullName.split('/');
  const raw = await run(['api', 'graphql', '--hostname', target.apiHost, '-f', `query=${CLAIM_QUERY}`,
    '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]);
  const response = safeJSONParse(raw, null, { logError: false });
  const repository = response?.data?.repository;
  const issue = repository?.issue;
  if (response?.errors || !sameRepo(repository?.nameWithOwner, target.fullName)
    || issue?.number !== number || !sameRepo(issue.repository?.nameWithOwner, target.fullName)
    || issue.state !== 'CLOSED') return unverified('issue-not-closed-or-mismatched');
  const events = issue.timelineItems?.nodes;
  if (!Array.isArray(events)) return unverified('closure-unavailable');
  const closed = events.filter(event => event?.createdAt).at(-1);
  if (!closed || !Number.isFinite(Date.parse(closed.createdAt))) return unverified('closure-unavailable');
  if (issue.stateReason === 'NOT_PLANNED') {
    // A typed stand-down is distinct from delivery. Only a repository operator
    // may invalidate work: arbitrary contributor labels/comments grant nothing.
    if (!await trustedGithubClosure(closed, target, run)) return unverified('closure-authority-unverified');
    return { status: 'verified', disposition: 'not-planned', issue: number, closedAt: closed.createdAt };
  }
  if (issue.stateReason !== 'COMPLETED') return unverified('closure-reason-unverified');
  const defaultBranch = repository.defaultBranchRef?.name;
  if (typeof defaultBranch !== 'string' || !defaultBranch) return unverified('default-branch-unavailable');
  const candidates = [closed.closer, ...events.map(event => event?.source)];
  const pr = candidates.find(candidate => deliveredPr(candidate, number, target, defaultBranch, closed.createdAt));
  if (pr) return { status: 'verified', disposition: 'delivered', issue: number, closedAt: closed.createdAt,
    changeRequest: pr.number, mergeCommit: pr.mergeCommit.oid, defaultBranch };
  // Revalidation can find a fix shipped without a closing-keyword link, or
  // superseding work. A trusted manual closure settles the selected task; it
  // does not prove a particular PR delivered code. An automatic PR closure
  // still needs the exact merged/default-branch evidence above.
  if (closed.closer != null) return unverified('merged-delivery-unverified');
  if (!await trustedGithubClosure(closed, target, run)) return unverified('closure-authority-unverified');
  return { status: 'verified', disposition: 'operator-closed', issue: number,
    closedAt: closed.createdAt, closedBy: closed.actor.login };
}

async function gitlabDisposition({ number, target, run }) {
  const project = `projects/${encodeURIComponent(target.fullName)}`;
  const read = async endpoint => safeJSONParse(await run(['api', '--hostname', target.webHost,
    '--method', 'GET', endpoint]), null, { logError: false });
  const repository = await read(project);
  const issue = await read(`${project}/issues/${number}`);
  if (!sameRepo(repository?.path_with_namespace, target.fullName) || !Number.isSafeInteger(repository?.id)
    || issue?.iid !== number || issue.project_id !== repository.id || issue.state !== 'closed'
    || !Number.isFinite(Date.parse(issue.closed_at))) return unverified('issue-not-closed-or-mismatched');
  const requests = await read(`${project}/issues/${number}/related_merge_requests?per_page=100`);
  if (!Array.isArray(requests)) return unverified('merged-delivery-unavailable');
  for (const mr of requests) {
    if (!Number.isSafeInteger(mr?.iid) || mr.iid < 1 || mr.project_id !== repository.id
      || mr.target_project_id !== repository.id || mr.state !== 'merged'
      || !repository.default_branch || mr.target_branch !== repository.default_branch
      || !/^[a-f0-9]{40,64}$/i.test(mr.merge_commit_sha || '')
      || !Number.isFinite(Date.parse(mr.merged_at)) || Date.parse(mr.merged_at) > Date.parse(issue.closed_at)) continue;
    const closes = await read(`${project}/merge_requests/${mr.iid}/closes_issues?per_page=100`);
    if (Array.isArray(closes) && closes.some(row => row.iid === number && row.project_id === repository.id)) {
      return { status: 'verified', disposition: 'delivered', issue: number, closedAt: issue.closed_at,
        changeRequest: mr.iid, mergeCommit: mr.merge_commit_sha, defaultBranch: repository.default_branch };
    }
  }
  // GitLab has no typed NOT_PLANNED reason. Verify the actual closer's project
  // write authority rather than treating labels or agent prose as a disposition.
  const closerId = issue.closed_by?.id;
  if (!Number.isSafeInteger(closerId) || closerId < 1) return unverified('closure-authority-unverified');
  const member = await read(`${project}/members/all/${closerId}`);
  if (member?.id !== closerId || !Number.isInteger(member.access_level) || member.access_level < 30) {
    return unverified('closure-authority-unverified');
  }
  return { status: 'verified', disposition: 'operator-closed', issue: number, closedAt: issue.closed_at };
}

/**
 * Uses the persisted task and agent, not supplied issue URLs or the sentinel's
 * reason. The app registry owns tracker/remote resolution. Reads only, so both
 * live finalization and restart recovery can safely repeat the same check.
 */
export async function verifyClaimDisposition({ task, agent, reportedOutcome, success }) {
  if (!success || reportedOutcome?.status !== 'no-action-needed' || !hasClaimFlowContract(task)) return null;
  if (!task?.id || agent?.taskId !== task.id) return unverified('task-binding-unverified');
  const app = await getAppDataForTask(task);
  const source = agent.metadata?.sourceWorkspace || agent.metadata?.workspacePath;
  if (!app?.repoPath || typeof source !== 'string'
    || resolve(expandHome(app.repoPath)) !== resolve(source)) return unverified('repository-binding-unverified');
  const numbers = selectedIssues(task, agent);
  if (!numbers?.length || numbers.length > 50) return unverified('selected-issue-unverified');
  const { tracker, target } = await resolveAppForgeTarget(app);
  if (!['github', 'gitlab'].includes(tracker) || target?.forge !== tracker || !target?.fullName?.includes('/')) {
    return unverified('tracker-unsupported');
  }
  const { resolveForgeForRepo } = await import('./forgeAuth.js');
  const forge = await resolveForgeForRepo(source, { forgeAccount: app.forgeAccount || null });
  if (forge?.cli !== (tracker === 'github' ? 'gh' : 'glab')) return unverified('forge-mismatched');
  const run = tracker === 'github'
    ? async args => (await import('./github.js')).execGh(args, undefined, { cwd: source, env: forge.env || null, backoffKey: target.repoSpec })
    : async args => (await import('./gitlab.js')).execGlab(args, source, undefined, { env: forge.env || null });
  const issues = [];
  for (const number of numbers) {
    const result = await (tracker === 'github' ? githubDisposition : gitlabDisposition)({ number, target, run });
    if (result.status !== 'verified') return result;
    issues.push(result);
  }
  return { status: 'verified', tracker, repository: `${target.webHost}/${target.fullName}`, taskId: task.id, issues };
}
