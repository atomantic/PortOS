import { extractSlugFromRef } from './planIds.js';

/** Only documented claim refs establish ownership; incidental digits do not. */
export function claimIssueNumber(ref) {
  const match = /^issue-(\d+)$/.exec(extractSlugFromRef(ref) || '');
  return match ? Number(match[1]) : null;
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

/** Collect complete PR evidence, expanding only full nested commit pages. */
export async function collectGithubPrIssueNumbers(rows, readCommitPages, limit = 500) {
  if (!Array.isArray(rows) || rows.length >= limit) return null;
  const numbers = new Set();
  for (const pr of rows) {
    if (typeof pr?.headRefName !== 'string' || typeof pr.body !== 'string'
      || !Array.isArray(pr.commits)
      || pr.commits.some(commit => typeof commit?.messageHeadline !== 'string')) return null;
    let commits = pr.commits;
    // gh caps its nested connection at 100; ask the paginated REST endpoint
    // only when the first response cannot establish exhaustion.
    if (commits.length >= 100) {
      if (!Number.isSafeInteger(pr.number) || pr.number < 1) return null;
      const pages = await readCommitPages(pr.number);
      if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page))) return null;
      const full = pages.flat();
      if (full.length < commits.length || full.some(row => typeof row?.commit?.message !== 'string')) return null;
      commits = full.map(row => ({ messageHeadline: row.commit.message }));
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
