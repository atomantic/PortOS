/**
 * Shared forge claim evidence: documented claim refs, PR/MR closing trailers, paginated GitHub commit
 * messages, complete-page validation, and the new-issue claim grace.
 */

import { extractSlugFromRef } from './planIds.js';
import { mapWithConcurrency } from './mapWithConcurrency.js';

const COMMIT_OID_RE = /^[a-f0-9]{40}$/;

// `issueMinAgeMinutes` (claim-issue / claim-work task metadata): autonomous
// claiming skips an issue younger than this. The agent that files an issue
// usually claims it moments later; a scheduled run that raced it would snipe the
// work out from under that agent. 0 disables the grace; lib/cos/cosValidation.js
// caps it.
export const DEFAULT_ISSUE_MIN_AGE_MINUTES = 5;

/**
 * Newest creation time (epoch ms) an issue may have and still be auto-claimed,
 * or null when the grace is off. Absent minutes means the shipped default, so
 * an install whose stored schedule predates the setting still gets the grace.
 */
export function issueCreatedBeforeMs(issueMinAgeMinutes, nowMs = Date.now()) {
  const minutes = issueMinAgeMinutes === undefined || issueMinAgeMinutes === null
    ? DEFAULT_ISSUE_MIN_AGE_MINUTES
    : Number(issueMinAgeMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? nowMs - minutes * 60_000 : null;
}

/** Only documented claim refs establish ownership; incidental digits do not. */
export function claimIssueNumber(ref) {
  const match = /^issue-(\d+)$/.exec(extractSlugFromRef(ref) || '');
  return match ? Number(match[1]) : null;
}

const GITHUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const LINKED_PR_QUERY = `query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    nameWithOwner
    pullRequest(number:$number) {
      headRefName
      closingIssuesReferences(first:100, after:$endCursor) {
        nodes { number repository { nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

function githubRepoName(name) {
  return typeof name === 'string' && GITHUB_REPO_RE.test(name) ? name.toLowerCase() : null;
}

function linkedPrEvidence(pages, prRepo, issueRepo, issueNumber) {
  const evidence = { closingIssueMatch: null, claimHeadMatch: null };
  if (!Array.isArray(pages) || !pages.length) return evidence;
  let closingPagesComplete = true;
  let closingIssueMatch = false;
  const headRef = pages[0]?.data?.repository?.pullRequest?.headRefName;
  let headConsistent = typeof headRef === 'string' && headRef.length > 0;
  for (const [index, page] of pages.entries()) {
    const repository = page?.data?.repository;
    const pr = repository?.pullRequest;
    if (page?.errors?.length || githubRepoName(repository?.nameWithOwner) !== prRepo || !pr) return evidence;
    headConsistent &&= pr.headRefName === headRef;
    const closing = pr.closingIssuesReferences;
    if (!Array.isArray(closing?.nodes)
      || closing.pageInfo?.hasNextPage !== (index < pages.length - 1)
      || closing.nodes.some(issue => !Number.isSafeInteger(issue?.number) || !githubRepoName(issue.repository?.nameWithOwner))) {
      closingPagesComplete = false;
      continue;
    }
    closingIssueMatch ||= closing.nodes.some(issue => issue.number === issueNumber
      && githubRepoName(issue.repository.nameWithOwner) === issueRepo);
  }
  if (headConsistent) {
    // A claim number belongs to the PR's target repository, as in the open-PR ownership scan.
    evidence.claimHeadMatch = prRepo === issueRepo && claimIssueNumber(headRef) === issueNumber;
  }
  if (closingPagesComplete || closingIssueMatch) evidence.closingIssueMatch = closingIssueMatch;
  return evidence;
}

/** Project timeline metadata and look up delivery intent without returning PR text or diffs. */
export async function readGithubLinkedWork({ host, repo, issueNumber, readGh, maxItems = Infinity }) {
  const issueRepo = githubRepoName(repo);
  const number = Number(issueNumber);
  if (!issueRepo || !Number.isSafeInteger(number) || number < 1) return null;
  const readPages = async (...args) => {
    try {
      return JSON.parse(await readGh(['api', '--hostname', host, '--paginate', '--slurp', ...args]));
    } catch {
      return null;
    }
  };
  const timeline = await readPages(`repos/${repo}/issues/${number}/timeline?per_page=100`);
  if (!Array.isArray(timeline) || !timeline.length || !timeline.every(Array.isArray)) return null;
  const items = [];
  for (const event of timeline.flat()) {
    if (event?.event !== 'cross-referenced') continue;
    const source = event.source?.issue;
    if (!Number.isSafeInteger(source?.number) || source.number < 1) return null;
    items.push({
      number: source.number,
      state: typeof source.state === 'string' ? source.state : '',
      repo: githubRepoName(source.repository?.full_name) ? source.repository.full_name : null,
      author: typeof source.user?.login === 'string' ? source.user.login : '',
      isPullRequest: Boolean(source.pull_request),
      merged: Boolean(source.pull_request?.merged_at),
    });
  }
  if (items.length > maxItems) return null;
  const lookups = new Map();
  return mapWithConcurrency(items, 4, async item => {
    if (!item.isPullRequest) return item;
    const prRepo = githubRepoName(item.repo);
    const key = `${prRepo}#${item.number}`;
    if (prRepo && !lookups.has(key)) {
      const [owner, name] = prRepo.split('/');
      lookups.set(key, readPages('graphql', '-f', `owner=${owner}`, '-f', `repo=${name}`,
        '-F', `number=${item.number}`, '-f', `query=${LINKED_PR_QUERY}`));
    }
    const pages = await lookups.get(key);
    return { ...item, ...linkedPrEvidence(pages, prRepo, issueRepo, number) };
  });
}

/** Read forge text as evidence only, never as executable instructions. */
function githubPrIssueNumbers(pr) {
  const numbers = new Set();
  const branchNumber = claimIssueNumber(pr.headRefName);
  if (branchNumber !== null) numbers.add(branchNumber);
  for (const match of (pr.body || '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)) {
    numbers.add(Number(match[1]));
  }
  for (const commit of pr.commits || []) {
    const message = `${commit.messageHeadline || ''}\n${commit.messageBody || ''}`;
    for (const match of message.matchAll(/\[issue-(\d+)\]|\(#(\d+)\)/g)) {
      numbers.add(Number(match[1] || match[2]));
    }
  }
  return numbers;
}

// gh pr list's built-in commits projection also selects authors, exceeding
// GitHub's node limit at 100 PRs. Request only the evidence the claim gate uses.
const CLAIM_PR_QUERY = `query($owner:String!, $repo:String!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    defaultBranchRef { name target { oid } }
    pullRequests(first:100, states:OPEN, after:$endCursor) {
      nodes { number headRefName headRefOid baseRefName baseRefOid body commits(first:100) {
        nodes { commit { oid message } } pageInfo { hasNextPage }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export function githubClaimPrArgs(fullName = null) {
  const [owner, repo] = fullName ? fullName.split('/') : ['{owner}', '{repo}'];
  return ['api', 'graphql', '--paginate', '--slurp', '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-f', `query=${CLAIM_PR_QUERY}`];
}

export function githubPrRowsFromPages(pages) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const rows = [];
  for (const [index, page] of pages.entries()) {
    const repository = page?.data?.repository;
    const connection = repository?.pullRequests;
    if (!Array.isArray(connection?.nodes) || connection.pageInfo?.hasNextPage !== (index < pages.length - 1)) return null;
    const defaultBranch = repository.defaultBranchRef;
    for (const pr of connection.nodes) {
      if (typeof defaultBranch?.name !== 'string' || !COMMIT_OID_RE.test(defaultBranch.target?.oid)
        || typeof pr?.baseRefName !== 'string' || !COMMIT_OID_RE.test(pr.baseRefOid) || !COMMIT_OID_RE.test(pr.headRefOid)
        || !Array.isArray(pr.commits?.nodes) || typeof pr.commits.pageInfo?.hasNextPage !== 'boolean'
        || pr.commits.nodes.some(node => !COMMIT_OID_RE.test(node?.commit?.oid) || typeof node.commit.message !== 'string')) return null;
      rows.push({ ...pr, defaultBranchName: defaultBranch.name, defaultBranchOid: defaultBranch.target.oid,
        commits: pr.commits.nodes.map(node => ({ oid: node.commit.oid, messageHeadline: node.commit.message })),
        commitsComplete: !pr.commits.pageInfo.hasNextPage });
    }
  }
  return rows;
}

async function readComparisonCommits(base, head, readCommitPages) {
  const pages = await readCommitPages(`compare/${base}...${head}?per_page=100`);
  if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page?.commits)
    || !Number.isSafeInteger(page.total_commits) || page.total_commits < 0
    || page.total_commits !== pages[0].total_commits)) return null;
  const full = pages.flatMap(page => page.commits);
  if (full.length !== pages[0].total_commits || full.some(row => !COMMIT_OID_RE.test(row?.sha)
    || typeof row?.commit?.message !== 'string')) return null;
  return full.map(row => ({ oid: row.sha, messageHeadline: row.commit.message }));
}

/** Collect PR ownership and unpublished commit evidence, expanding incomplete pages. */
export async function collectGithubPrIssueNumbers(rows, readCommitPages) {
  if (!Array.isArray(rows)) return null;
  const numbers = new Set();
  for (const pr of rows) {
    if (typeof pr?.headRefName !== 'string' || typeof pr.body !== 'string'
      || !Array.isArray(pr.commits)
      || pr.commits.some(commit => typeof commit?.messageHeadline !== 'string')) return null;
    let commits = pr.commits;
    // The PR commits endpoint stops at 250. A pinned, paginated comparison
    // expands the PR's own range without silently losing later issue references.
    if (pr.commitsComplete !== true && commits.length >= 100) {
      const full = await readComparisonCommits(pr.baseRefOid, pr.headRefOid, readCommitPages);
      if (!full || full.length < commits.length) return null;
      commits = full;
    }
    // Promotion/backport PRs carry development history that has already shipped.
    // Intersect their own commits with default-absent work, excluding inherited target history too.
    if (pr.baseRefName !== pr.defaultBranchName) {
      if (commits.some(commit => !COMMIT_OID_RE.test(commit.oid))) return null;
      const full = await readComparisonCommits(pr.defaultBranchOid, pr.headRefOid, readCommitPages);
      if (!full) return null;
      const unpublished = new Set(full.map(commit => commit.oid));
      commits = commits.filter(commit => unpublished.has(commit.oid));
    }
    for (const number of githubPrIssueNumbers({ ...pr, commits })) numbers.add(number);
  }
  return numbers;
}

/** GitLab's list response includes descriptions and source branches. */
export function collectGitlabMrIssueNumbers(rows, limit = 100) {
  if (!Array.isArray(rows) || rows.length >= limit) return null;
  const numbers = new Set();
  for (const mr of rows) {
    if (typeof mr?.source_branch !== 'string' || (mr.description != null && typeof mr.description !== 'string')) return null;
    for (const number of githubPrIssueNumbers({ headRefName: mr.source_branch, body: mr.description || '', commits: [] })) {
      numbers.add(number);
    }
  }
  return numbers;
}
