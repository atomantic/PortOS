/**
 * The one definition of "the external pull-request content PortOS screened".
 *
 * Two independent places have to agree on this byte-for-byte: the pr-reviewer
 * security preflight STAMPS a fingerprint over the content it screened, and the
 * deterministic coordinator RECOMPUTES it from a fresh forge read immediately
 * before it reviews, rebases, or merges. A mismatch is the coordinator's only
 * defence against acting on content that changed after screening — and, because
 * that check fails closed, a divergence between the two builders does not look
 * like a bug. It looks like the pipeline completing every stage and then doing
 * nothing at all.
 *
 * That is what happened when commit-message screening was added to the
 * preflight's content (#7323): the coordinator kept hashing title+body+diff, so
 * every stamped fingerprint was unreachable and every approved review was
 * dropped. Note where the drift actually was — not in the hash, but in the two
 * hand-written PROJECTIONS of a PR row into the hashed fields. So these take
 * the row itself: adding the next screened field is one edit here, and no call
 * site can hold a different idea of what "the content" is.
 *
 * The "screened-content fingerprint contract" suite in
 * `services/prReviewerSecurity.test.js` runs the real preflight against this
 * consumer, rather than re-deriving the expected value from one of them.
 *
 * Pure.
 */

import { modelAbuseContentFingerprint } from './modelAbuseGuard.js';

const MAX_COMMIT_LOG_CHARS = 100_000;

const text = (value) => (typeof value === 'string' ? value : '');

/**
 * Commit messages as one screened block. Headline and body are joined per
 * commit exactly as a reader of `git log` would see them, so an instruction
 * hidden in a commit body is scored as the text it is.
 */
function formatCommitLog(commits) {
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
 *
 * `commits` is separate only because the preflight reads it in its own call —
 * GitHub prices that field at a listing's LIMIT, so it cannot ride the bulk PR
 * listing. A row that already carries them (a single `gh pr view`) needs only
 * the row.
 */
export function screenedPullRequestContent(pr, diff, commits = pr?.commits) {
  const commitLog = formatCommitLog(commits);
  return [
    'Pull request title:',
    text(pr?.title),
    'Pull request description:',
    text(pr?.body),
    ...(commitLog ? ['Commit messages:', commitLog] : []),
    'Complete unified diff:',
    text(diff),
  ].join('\n\n');
}

/**
 * Stable identity for the exact PR content screened at a given head commit.
 *
 * Null when the commit log is missing, rather than a fingerprint standing for a
 * smaller surface than the one that was stamped: a caller comparing against a
 * stamped value must fail closed, never match by omission.
 */
export function screenedPullRequestFingerprint(pr, diff, commits = pr?.commits) {
  if (!Array.isArray(commits)) return null;
  return modelAbuseContentFingerprint(
    'pull-request',
    { number: pr?.number, headSha: pr?.headRefOid },
    screenedPullRequestContent(pr, diff, commits),
  );
}
