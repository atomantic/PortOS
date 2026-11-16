/**
 * Who owns a public PR after the pr-reviewer coordinator has finished with it.
 *
 * Stage 3 posts the review and, when everything lines up, merges. What was
 * missing is the OTHER half: a PR that came back with blockers, or that is
 * approved but not merge-ready (red CI, conflict, a rebase the forge refused),
 * used to be left with nobody holding it. The contributor got a review
 * notification and PortOS kept re-polling, but the PR appeared in no one's
 * assigned queue and no one was tasked with landing it.
 *
 * This module answers "whose turn is it?" for that PR, and nothing else — it is
 * pure, so the same answer can be asserted in a unit test and reached from both
 * the post-review pass and the pending-approval poller without either of them
 * re-deriving it.
 *
 * The pivot is whether the maintainer can push to the PR's head branch. A
 * same-repo branch is ours by construction; a fork branch is ours only when the
 * contributor left "Allow edits by maintainers" on. With write access, PortOS
 * can implement its own review feedback and land the PR itself instead of
 * handing a work order to someone who may never come back. Without it, the only
 * useful action is to put the PR in the opener's queue.
 *
 * Fails closed on both axes: an unknown head-repository relationship is treated
 * as "no write access", and an unactionable review (deferred verdict, or
 * findings the coordinator could not anchor to a diff line) never becomes an
 * agent work order — an agent told to "implement the feedback" needs feedback
 * concrete enough to implement.
 */

/**
 * How many remediation agents one PR may consume before the work goes back to
 * its opener regardless of write access. Three runs that each failed to land it
 * is evidence the obstacle is not one an agent will clear.
 */
export const MAX_PR_REMEDIATION_ATTEMPTS = 3;

/** Why a PR's head branch is (or is not) writable by the maintainer. */
export const PR_WRITE_ACCESS = Object.freeze({
  OWN_REPO: 'own-repo',
  FORK_MAINTAINER_MODIFIABLE: 'fork-maintainer-modifiable',
  FORK_LOCKED: 'fork-locked',
  UNKNOWN: 'unknown',
});

/**
 * The reviewer's verdict, as it bears on ownership. `request-changes` is a
 * concrete work order; `defer` is no verdict at all but still strands the PR,
 * because the COMMENT review it posts counts as a review on that head and the
 * coordinator will not revisit the revision. Absent means the review cleared
 * the content and only merge mechanics are left.
 */
export const PR_REVIEW_OUTCOME = Object.freeze({
  REQUEST_CHANGES: 'request-changes',
  DEFER: 'defer',
});

/** What happens to a PR the coordinator did not merge. */
export const PR_HANDBACK = Object.freeze({
  /** PortOS pushes the fixes and lands the PR itself. */
  REMEDIATE: 'remediate',
  /** The opener is assigned; the next move is theirs. */
  ASSIGN_OPENER: 'assign-opener',
  /** Nothing to hand back — the PR merged, or is still progressing normally. */
  NONE: 'none',
});

/**
 * Can PortOS push commits to this PR's head branch?
 *
 * `isCrossRepository` and `maintainerCanModify` come straight from
 * `gh pr view --json`. Both are read as strict booleans: a field the forge did
 * not return (an older `gh`, a partial read, a non-GitHub shape) leaves the
 * relationship unknown, and an unknown relationship must not be optimistically
 * treated as writable — a remediation agent that cannot push would burn a full
 * run to discover that at `git push` time.
 */
export function resolvePullRequestWriteAccess(pullRequest) {
  if (!pullRequest || typeof pullRequest !== 'object') {
    return { canEdit: false, reason: PR_WRITE_ACCESS.UNKNOWN };
  }
  if (pullRequest.isCrossRepository === false) {
    return { canEdit: true, reason: PR_WRITE_ACCESS.OWN_REPO };
  }
  if (pullRequest.isCrossRepository === true) {
    return pullRequest.maintainerCanModify === true
      ? { canEdit: true, reason: PR_WRITE_ACCESS.FORK_MAINTAINER_MODIFIABLE }
      : { canEdit: false, reason: PR_WRITE_ACCESS.FORK_LOCKED };
  }
  return { canEdit: false, reason: PR_WRITE_ACCESS.UNKNOWN };
}

/**
 * Whose turn is it?
 *
 * @param {object} input
 * @param {string|null} input.reviewOutcome - A `PR_REVIEW_OUTCOME` value, or
 *   null when the review cleared the content.
 * @param {boolean} input.notMergeReady - The PR is reviewed but cannot land as
 *   it stands: failing CI, a conflict, or a rebase the forge would not apply.
 * @param {boolean} input.downgraded - The coordinator could not anchor one or
 *   more reported findings to the diff. The posted review says so and asks the
 *   contributor to restate them; there is no reliable work order in it.
 * @param {boolean} input.canEdit - `resolvePullRequestWriteAccess().canEdit`.
 * @param {boolean} input.remediationExhausted - Remediation already ran its
 *   attempt budget on this PR without landing it. Retrying would spend another
 *   agent on the same wall; hand it to the opener instead.
 */
export function resolveHandbackDisposition({
  reviewOutcome = null,
  notMergeReady = false,
  downgraded = false,
  canEdit = false,
  remediationExhausted = false,
} = {}) {
  if (!reviewOutcome && !notMergeReady) return PR_HANDBACK.NONE;
  // A deferred review is a hand-back but never a work order: it bars the AGENT
  // path (there is no verdict to implement) without suppressing the assignment.
  const actionable = !downgraded && reviewOutcome !== PR_REVIEW_OUTCOME.DEFER;
  if (canEdit && actionable && !remediationExhausted) return PR_HANDBACK.REMEDIATE;
  return PR_HANDBACK.ASSIGN_OPENER;
}
