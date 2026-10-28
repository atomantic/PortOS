/** Read-only completion evidence for a selected claim, never agent prose. */
import { resolve } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { hasClaimFlowContract } from '../lib/claimFlowTaskTypes.js';
import { expandHome, safeJSONParse } from '../lib/fileUtils.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { getAppDataForTask } from './agentAppWorkspace.js';

const unverified = reason => ({ status: 'unverified', reason });
const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const positiveIssue = value => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

async function trustedGithubEvent(event, target, run) {
  const { createGithubActorTrust } = await import('./forgeActorTrust.js');
  const trust = await createGithubActorTrust({ runGh: run, host: target.apiHost, repoFullName: target.fullName });
  return trust.isTrusted(event.actor?.login);
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
  repository(owner:$owner,name:$name) { nameWithOwner defaultBranchRef { name target { oid } }
    issue(number:$number) { number state stateReason repository { nameWithOwner }
      labels(first:100) { nodes { name } }
      timelineItems(last:100,itemTypes:[CLOSED_EVENT,CROSS_REFERENCED_EVENT,LABELED_EVENT,UNLABELED_EVENT]) { nodes {
        ... on ClosedEvent { __typename actor { login } createdAt closer { __typename ... on PullRequest { ${PR_FIELDS} } } }
        ... on CrossReferencedEvent { source { __typename ... on PullRequest { ${PR_FIELDS} } } }
        ... on LabeledEvent { __typename actor { login } createdAt label { name } }
        ... on UnlabeledEvent { __typename actor { login } createdAt label { name } }
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
    || issue?.number !== number || !sameRepo(issue.repository?.nameWithOwner, target.fullName)) {
    return unverified('issue-not-closed-or-mismatched');
  }
  const events = issue.timelineItems?.nodes;
  if (issue.state === 'OPEN' && issue.labels?.nodes?.some(label => label.name === 'blocked')) {
    const blocked = Array.isArray(events) ? events.filter(event => event?.label?.name === 'blocked').at(-1) : null;
    if (blocked?.__typename !== 'LabeledEvent' || !Number.isFinite(Date.parse(blocked.createdAt))
      || !await trustedGithubEvent(blocked, target, run)) return unverified('block-authority-unverified');
    return { status: 'verified', disposition: 'operator-blocked', issue: number,
      blockedAt: blocked.createdAt, blockedBy: blocked.actor.login,
      defaultBranch: repository.defaultBranchRef?.name, defaultCommit: repository.defaultBranchRef?.target?.oid };
  }
  if (issue.state !== 'CLOSED') return unverified('issue-not-closed-or-mismatched');
  if (!Array.isArray(events)) return unverified('closure-unavailable');
  const closed = events.filter(event => event?.__typename === 'ClosedEvent').at(-1);
  if (!closed || !Number.isFinite(Date.parse(closed.createdAt))) return unverified('closure-unavailable');
  if (issue.stateReason === 'NOT_PLANNED') {
    // A typed stand-down is distinct from delivery. Only a repository operator
    // may invalidate work: arbitrary contributor labels/comments grant nothing.
    if (!await trustedGithubEvent(closed, target, run)) return unverified('closure-authority-unverified');
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
  if (!await trustedGithubEvent(closed, target, run)) return unverified('closure-authority-unverified');
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
  // GitLab's issue response does not distinguish automatic MR closure. Related
  // MRs with unproven delivery must not fall through to operator authority.
  if (requests.length) return unverified('merged-delivery-unverified');
  // Without a related MR, verify the actual closer's project write authority
  // rather than treating labels or agent prose as a disposition.
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
  if (!success || !['no-action-needed', 'blocked'].includes(reportedOutcome?.status)
    || reportedOutcome.recovery || !hasClaimFlowContract(task)) return null;
  return inspectClaimDisposition(task, agent);
}

/** Read the same tracker evidence during a cleanup hold without settling the
 * task or authorizing retirement. The completed swarm remains the owner of its
 * captured checkouts while the service retains any no-PR stand-down. */
export async function verifyCleanupClaimDisposition({ task, agent }) {
  const result = agent?.result;
  if (agent?.status !== 'completed' || agent.metadata?.isWorktree !== false
    || agent.metadata?.configClaimFlow !== true || result?.executionSuccess !== true
    || result.validationPassed === false || result.cleanupPending !== true || result.deliveryRecoveryOwned !== true
    || result.executionInterruption || agent.metadata?.executionInterruption
    || !['incomplete', 'blocked'].includes(result.taskOutcome?.status)
    || result.taskOutcome?.recovery?.mode !== 'cleanup' || !hasClaimFlowContract(task)) return null;
  return inspectClaimDisposition(task, agent);
}

async function inspectClaimDisposition(task, agent) {
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
  // Parking an issue settles this attempt, not unfinished code. Require the
  // checkout to be clean and fully present in the live default-branch head.
  for (const issue of issues.filter(issue => issue.disposition === 'operator-blocked')) {
    if (!/^[a-f0-9]{40,64}$/i.test(issue.defaultCommit || '')) return unverified('default-branch-unavailable');
    // Swarm coordinators run outside their selected children's checkouts.
    // Only server-captured seeds bind each child to the path we must inspect.
    const workspace = Array.isArray(agent.metadata?.claimBranches)
      ? agent.metadata.checkoutSeeds?.find(seed => seed.agentId === agent.id && seed.branch === `claim/issue-${issue.issue}`
        && typeof seed.repoPath === 'string' && resolve(seed.repoPath) === resolve(source))?.path
      : agent.metadata?.workspacePath;
    if (typeof workspace !== 'string' || !workspace) return unverified('checkout-unavailable');
    const status = await execGit(['status', '--porcelain', '--untracked-files=all'], workspace);
    if (status.stdout.trim()) return unverified('checkout-has-undelivered-work');
    const ancestry = await execGit(['merge-base', '--is-ancestor', 'HEAD', issue.defaultCommit], workspace, { ignoreExitCode: true });
    if (ancestry.exitCode === 0) continue;
    if (ancestry.exitCode === 1) return unverified('checkout-has-undelivered-work');
    // A just-merged default head may not exist locally yet. Ask the forge about
    // these exact commits instead of fetching or retrying a correct stand-down.
    const head = (await execGit(['rev-parse', '--verify', 'HEAD'], workspace)).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(head)) return unverified('checkout-has-undelivered-work');
    const comparison = safeJSONParse(await run(['api', '--hostname', target.apiHost, '--method', 'GET',
      `repos/${target.fullName}/compare/${head}...${issue.defaultCommit}`]), null, { logError: false });
    if (!['ahead', 'identical'].includes(comparison?.status) || comparison.base_commit?.sha !== head
      || comparison.merge_base_commit?.sha !== head) return unverified('checkout-has-undelivered-work');
  }
  return { status: 'verified', tracker, repository: `${target.webHost}/${target.fullName}`, taskId: task.id, issues };
}
