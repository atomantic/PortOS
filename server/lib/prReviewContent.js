/**
  * The one definition of the external pull-request content PortOS screens.
  *
  * `screenedPullRequestContent(pr, diff, commits?)` builds the contributor-authored surface (title, description, commit log, unified diff) and `screenedPullRequestFingerprint(pr, diff, commits?)` hashes it to a stable identity for one head commit, returning null when the commit log is missing rather than matching by omission. Pure.
 *
 * Two places must agree byte-for-byte: the pr-reviewer security preflight STAMPS a fingerprint and the deterministic coordinator RECOMPUTES it from a fresh forge read before it reviews, rebases or merges
 * (its only defence against content changing after screening). The check fails closed, so a divergence looks like a pipeline that completes every stage then does nothing: when commit-message screening was added (#7323)
 * the coordinator kept hashing title+body+diff and every approved review was dropped. The drift was in the two hand-written PROJECTIONS of a PR row, so these take the row itself: the next screened field is one edit
 * here. The "screened-content fingerprint contract" suite in `services/prReviewerSecurity.test.js` runs the real preflight against this consumer. Never rebuild either shape at a call site.
 */

import { modelAbuseContentFingerprint } from './modelAbuseGuard.js';

const LEGACY_MAX_COMMIT_LOG_CHARS = 100_000;

const text = (value) => (typeof value === 'string' ? value : '');

/** Commit messages as one screened block, headline and body joined per commit as `git log` shows them, so an instruction hidden in a commit body is scored as the text it is. */
function formatCommitLog(commits, maxChars = Infinity) {
  if (!Array.isArray(commits) || commits.length === 0) return '';
  const log = commits
    .map((commit) => [text(commit?.messageHeadline), text(commit?.messageBody)].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
  return log.slice(0, maxChars);
}

/**
 * The complete contributor-authored surface of a PR, in a stable order. Anything omitted is content a reviewer would read but the guard never scored and the freshness check wouldn't notice changing.
 * `commits` is separate because the preflight reads it in its own call (GitHub prices that field at a listing's LIMIT, so it can't ride the bulk listing); a row already carrying them needs only the row.
 */
export function screenedPullRequestContent(pr, diff, commits = pr?.commits) {
  return pullRequestContent(pr, diff, formatCommitLog(commits));
}

function pullRequestContent(pr, diff, commitLog) {
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
 * The recipe version a fresh fingerprint is stamped with. A fingerprint is only meaningful against the recipe that produced it, and PortOS persists these across upgrades (an approved PR in the merge queue holds
 * a stamp from whatever the install ran at scan time): adding the commit log (#7323) invalidated every one, silently dropping approvals for a cycle. So the version rides INSIDE the stamp (`"2:<sha256>"`),
 * since a separate field gets dropped at a hop (it passes through a security report, `metadata.issueWatcher` and `approvedPullRequests` before comparison).
 * Changing `screenedPullRequestContent` means bumping this AND adding the outgoing recipe to `FINGERPRINT_RECIPES`, in the same commit.
 */
export const SCREENED_PR_FINGERPRINT_VERSION = 3;

/**
 * Every recipe PortOS has ever stamped with, by version, so an approval screened before an upgrade re-verifies against the guarantee made at the time. Not a weakening: the caller already requires `headRefOid`
 * to equal the approved head (pinning diff and commit log); a fingerprint adds detection of what CAN change at a fixed head (title, description), which every version checks.
 * A recipe returns null when its needed input is missing, so a caller can't match by omission against a stamp that covered more.
 */
const FINGERPRINT_RECIPES = Object.freeze({
  // v1 (pre-#7323): title + description + diff; commit messages unscreened.
  1: (pr, diff) => screenedPullRequestContent(pr, diff, []),
  // v2 (#7323): + the commit log, so an instruction hidden in a commit body is screened and watched for change.
  2: (pr, diff, commits) => (Array.isArray(commits)
    ? pullRequestContent(pr, diff, formatCommitLog(commits, LEGACY_MAX_COMMIT_LOG_CHARS)) : null),
  // v3: complete commit messages; oversized evidence is refused by the screen.
  3: (pr, diff, commits) => (Array.isArray(commits) ? screenedPullRequestContent(pr, diff, commits) : null),
});

// A version with no recipe could only stamp fingerprints nothing can verify, so the bump and the outgoing recipe must land together. Checked at module load.
const currentRecipe = FINGERPRINT_RECIPES[SCREENED_PR_FINGERPRINT_VERSION];
if (!currentRecipe) throw new Error(`No screened-PR fingerprint recipe for version ${SCREENED_PR_FINGERPRINT_VERSION}`);

// `<version>:<sha256>` for anything stamped since versioning; a bare sha256 is a v1 stamp persisted before it.
const VERSIONED_FINGERPRINT_RE = /^(\d{1,4}):([0-9a-f]{64})$/;
const BARE_SHA256_RE = /^[0-9a-f]{64}$/;

/** Is this a value `screenedPullRequestFingerprint` could have produced? */
export function isScreenedPullRequestFingerprint(value) {
  return parseFingerprint(value) !== null;
}

function parseFingerprint(value) {
  if (typeof value !== 'string') return null;
  const versioned = value.match(VERSIONED_FINGERPRINT_RE);
  if (versioned) return { version: Number(versioned[1]), hash: versioned[2] };
  return BARE_SHA256_RE.test(value) ? { version: 1, hash: value } : null;
}

function fingerprintHash(pr, content) {
  if (typeof content !== 'string') return null;
  return modelAbuseContentFingerprint(
    'pull-request',
    { number: pr?.number, headSha: pr?.headRefOid },
    content,
  );
}

/** Stable identity for the exact PR content screened at a head commit, stamped with its recipe. Null when the commit log is missing: a caller comparing a stamped value must fail closed, never match by omission. */
export function screenedPullRequestFingerprint(pr, diff, commits = pr?.commits) {
  const hash = fingerprintHash(pr, currentRecipe(pr, diff, commits));
  return hash === null ? null : `${SCREENED_PR_FINGERPRINT_VERSION}:${hash}`;
}

/**
 * Does `stamped` still describe this PR's screened content? The one comparison every consumer makes, never `screenedPullRequestFingerprint(...) === stamped` (which fails closed on an approval stamped by the previous recipe).
 * Fails closed on a missing, malformed or unknown-recipe stamp (a state file from a NEWER install).
 */
export function screenedPullRequestFingerprintMatches(stamped, pr, diff, commits = pr?.commits) {
  const parsed = parseFingerprint(stamped);
  if (!parsed) return false;
  const recipe = FINGERPRINT_RECIPES[parsed.version];
  if (!recipe) return false;
  return fingerprintHash(pr, recipe(pr, diff, commits)) === parsed.hash;
}
