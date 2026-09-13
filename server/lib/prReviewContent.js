/**
 * The one definition of "the external pull-request content PortOS screened".
 *
 * Two independent places have to agree on this byte-for-byte: the pr-reviewer
 * security preflight STAMPS a fingerprint over the content it screened, and the
 * deterministic coordinator RECOMPUTES it from a fresh forge read immediately
 * before it reviews, rebases, or merges. A mismatch is the coordinator's only
 * defence against acting on content that changed after screening — and, because
 * that check fails closed and silently, a divergence between the two builders
 * does not look like a bug. It looks like the pipeline completing every stage
 * and then doing nothing at all.
 *
 * That is exactly what happened when commit-message screening was added to the
 * preflight's content (#7323): the coordinator kept hashing title+body+diff, so
 * every stamped fingerprint was unreachable and every approved review was
 * dropped without a log line. Both sides now build the content here, and the
 * "screened-content fingerprint contract" suite in
 * `services/prReviewerSecurity.test.js` runs the real producer against the real
 * consumer, rather than re-deriving the expected value from one of them.
 *
 * Pure.
 */

import { modelAbuseContentFingerprint } from './modelAbuseGuard.js';

export const MAX_COMMIT_LOG_CHARS = 100_000;

const text = (value) => (typeof value === 'string' ? value : '');

/**
 * Commit messages as one screened block. Headline and body are joined per
 * commit exactly as a reader of `git log` would see them, so an instruction
 * hidden in a commit body is scored as the text it is.
 */
export function formatPullRequestCommitLog(commits) {
  if (!Array.isArray(commits) || commits.length === 0) return '';
  const log = commits
    .map((commit) => [text(commit?.messageHeadline), text(commit?.messageBody)].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
  return log.length > MAX_COMMIT_LOG_CHARS ? log.slice(0, MAX_COMMIT_LOG_CHARS) : log;
}

/**
 * The complete contributor-authored surface of a PR, in a stable order. Every
 * section a contributor controls belongs here: anything omitted is content a
 * reviewer would read but the guard never scored, and content the freshness
 * check would not notice changing.
 */
export function pullRequestReviewContent({ title, body, commits, diff } = {}) {
  const commitLog = formatPullRequestCommitLog(commits);
  return [
    'Pull request title:',
    text(title),
    'Pull request description:',
    text(body),
    ...(commitLog ? ['Commit messages:', commitLog] : []),
    'Complete unified diff:',
    text(diff),
  ].join('\n\n');
}

/**
 * Stable identity for the exact PR content screened at a given head commit.
 * Returns null when the identity is unusable, so a caller can never compare
 * against a fingerprint that silently stands for "nothing".
 */
export function pullRequestReviewFingerprint({ number, headSha, title, body, commits, diff } = {}) {
  return modelAbuseContentFingerprint(
    'pull-request',
    { number, headSha },
    pullRequestReviewContent({ title, body, commits, diff }),
  );
}
