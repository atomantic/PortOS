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

const LEGACY_MAX_COMMIT_LOG_CHARS = 100_000;

const text = (value) => (typeof value === 'string' ? value : '');

/**
 * Commit messages as one screened block. Headline and body are joined per
 * commit exactly as a reader of `git log` would see them, so an instruction
 * hidden in a commit body is scored as the text it is.
 */
function formatCommitLog(commits, maxChars = Infinity) {
  if (!Array.isArray(commits) || commits.length === 0) return '';
  const log = commits
    .map((commit) => [text(commit?.messageHeadline), text(commit?.messageBody)].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
  return log.slice(0, maxChars);
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
 * The recipe version a fresh fingerprint is stamped with.
 *
 * A fingerprint is only meaningful against the recipe that produced it, and
 * PortOS is DISTRIBUTED software that persists these across upgrades: an
 * approved PR waiting in the merge queue holds a stamp from whatever the
 * install was running when the security scan ran. Adding the commit log (#7323)
 * silently invalidated every one of them — the coordinator re-derived with the
 * new recipe, got a mismatch, and dropped the approval with a console warning
 * and no hand-back. It self-healed on the next scan, so the window was one
 * cycle, but the drop was silent for it.
 *
 * So the version rides INSIDE the stamp (`"2:<sha256>"`) rather than beside it
 * in a second field. The same lesson as the projection drift above: a field
 * that travels separately gets dropped at a hop, and this value passes through
 * a security report, a task's `metadata.issueWatcher`, and the install's
 * `approvedPullRequests` state before it is compared.
 *
 * Changing `screenedPullRequestContent` means bumping this AND adding the
 * outgoing recipe to `FINGERPRINT_RECIPES`, in the same commit.
 */
export const SCREENED_PR_FINGERPRINT_VERSION = 3;

/**
 * Every recipe PortOS has ever stamped with, by version. A stamp names its own
 * recipe, so an approval screened before an upgrade re-verifies against the
 * guarantee that was actually made when it was screened — content unchanged
 * since the scan — instead of mismatching on a definition it predates.
 *
 * This is not a weakening. The caller has already required `headRefOid` to
 * equal the approved head, which pins the diff and the commit log; what a
 * fingerprint adds is detection of the parts that CAN change at a fixed head
 * (title, description). Every version checks those.
 *
 * A recipe returns null when the input it needs is missing, so a caller can
 * never match by omission against a stamp that covered more.
 */
const FINGERPRINT_RECIPES = Object.freeze({
  // v1 (pre-#7323): title + description + diff. Commit messages went unscreened.
  1: (pr, diff) => screenedPullRequestContent(pr, diff, []),
  // v2 (#7323): + the commit log, so an instruction hidden in a commit body is
  // both screened and watched for change.
  2: (pr, diff, commits) => (Array.isArray(commits)
    ? pullRequestContent(pr, diff, formatCommitLog(commits, LEGACY_MAX_COMMIT_LOG_CHARS)) : null),
  // v3: complete commit messages; oversized evidence is refused by the screen.
  3: (pr, diff, commits) => (Array.isArray(commits) ? screenedPullRequestContent(pr, diff, commits) : null),
});

// A version with no recipe could only stamp fingerprints nothing can ever
// verify, so the bump and the outgoing recipe have to land together. Checked at
// module load, which every boot and every test run performs.
const currentRecipe = FINGERPRINT_RECIPES[SCREENED_PR_FINGERPRINT_VERSION];
if (!currentRecipe) throw new Error(`No screened-PR fingerprint recipe for version ${SCREENED_PR_FINGERPRINT_VERSION}`);

// `<version>:<sha256>` for anything stamped since versioning; a bare sha256 is
// a v1 stamp an install persisted before it.
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

/**
 * Stable identity for the exact PR content screened at a given head commit,
 * stamped with the recipe that produced it.
 *
 * Null when the commit log is missing, rather than a fingerprint standing for a
 * smaller surface than the one that was stamped: a caller comparing against a
 * stamped value must fail closed, never match by omission.
 */
export function screenedPullRequestFingerprint(pr, diff, commits = pr?.commits) {
  const hash = fingerprintHash(pr, currentRecipe(pr, diff, commits));
  return hash === null ? null : `${SCREENED_PR_FINGERPRINT_VERSION}:${hash}`;
}

/**
 * Does `stamped` still describe this PR's screened content?
 *
 * The one comparison every consumer makes — never `screenedPullRequestFingerprint(...) === stamped`,
 * which is exactly the check that fails closed on an approval stamped by the
 * previous recipe. Fails closed on a missing, malformed, or unknown-recipe
 * stamp (a state file written by a NEWER install than this one).
 */
export function screenedPullRequestFingerprintMatches(stamped, pr, diff, commits = pr?.commits) {
  const parsed = parseFingerprint(stamped);
  if (!parsed) return false;
  const recipe = FINGERPRINT_RECIPES[parsed.version];
  if (!recipe) return false;
  return fingerprintHash(pr, recipe(pr, diff, commits)) === parsed.hash;
}
