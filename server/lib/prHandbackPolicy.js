/**
 * Who owns a public PR after the pr-reviewer coordinator has finished with it.
 *
 * The post-review pass and pending-approval poller share this decision. A normal
 * coding agent has host privileges. The install/validate container confines
 * individual commands, but cannot enforce that agent's execution boundary.
 * Forks therefore use the contributor handback, even with maintainer edits.
 */

/** How many remediation agents one PR may consume before it goes back to its opener regardless of write access (three failed runs show an obstacle no agent will clear). */
export const MAX_PR_REMEDIATION_ATTEMPTS = 3;

/** Why a PR's head branch is (or is not) writable by the maintainer. */
export const PR_WRITE_ACCESS = Object.freeze({
  OWN_REPO: 'own-repo',
  FORK_MAINTAINER_MODIFIABLE: 'fork-maintainer-modifiable',
  FORK_LOCKED: 'fork-locked',
  UNKNOWN: 'unknown',
});

/** The reviewer's verdict as it bears on ownership: `request-changes` is a concrete work order; `defer` is no verdict yet still strands the PR (its COMMENT review counts as a review on that head, so the coordinator won't revisit); absent means the content cleared and only merge mechanics remain. */
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

/** Can PortOS push commits to this PR's head branch? `isCrossRepository` and `maintainerCanModify` come from `gh pr view --json` and are read as strict booleans: a field the forge didn't return leaves the relationship unknown, which must not be treated as writable (a remediation agent that can't push burns a full run to learn it at `git push`). */
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

/** Only an explicitly same-repository head may enter the host coding workflow. */
export function canRunHostPrRemediation(writeAccess, forkHead) {
  return writeAccess === PR_WRITE_ACCESS.OWN_REPO && forkHead == null;
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
 * @param {string} input.writeAccess - The verified head relationship from the forge.
 * @param {boolean} input.remediationExhausted - Remediation already ran its
 *   attempt budget on this PR without landing it. Retrying would spend another
 *   agent on the same wall; hand it to the opener instead.
 */
export function resolveHandbackDisposition({
  reviewOutcome = null,
  notMergeReady = false,
  downgraded = false,
  writeAccess,
  remediationExhausted = false,
} = {}) {
  if (!reviewOutcome && !notMergeReady) return PR_HANDBACK.NONE;
  // A deferred review is a hand-back but never a work order: it bars the AGENT path (no verdict to implement) without suppressing the assignment.
  const actionable = !downgraded && reviewOutcome !== PR_REVIEW_OUTCOME.DEFER;
  if (canRunHostPrRemediation(writeAccess) && actionable && !remediationExhausted) return PR_HANDBACK.REMEDIATE;
  return PR_HANDBACK.ASSIGN_OPENER;
}
