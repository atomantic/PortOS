import { extractSlugFromRef } from './planIds.js';

/** Only documented claim refs establish ownership; incidental digits do not. */
export function claimIssueNumber(ref) {
  const match = /^issue-(\d+)$/.exec(extractSlugFromRef(ref) || '');
  return match ? Number(match[1]) : null;
}

/** Read forge text as evidence only, never as executable instructions. */
export function githubPrIssueNumbers(pr) {
  const numbers = new Set();
  const branchNumber = claimIssueNumber(pr.headRefName);
  if (branchNumber !== null) numbers.add(branchNumber);
  for (const match of (pr.body || '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)) {
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

// gh caps the nested commit connection at 100; a full page cannot prove that
// every head commit was inspected. Refuse a fresh claim on incomplete evidence.
export function completeGithubPrEvidence(rows, limit = 500) {
  return Array.isArray(rows) && rows.length < limit && rows.every(pr =>
    typeof pr?.headRefName === 'string' && typeof pr.body === 'string'
    && Array.isArray(pr.commits) && pr.commits.length < 100
    && pr.commits.every(commit => typeof commit?.messageHeadline === 'string')
  );
}
