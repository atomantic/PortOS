/**
 * Pure readers of a GitHub `gh pr view --json` view: the status-check verdict and whether a required human approval is its only merge blocker.
 *
 * Check entries are CheckRuns (`conclusion`, empty while running) or StatusContexts (`state`). An empty rollup is
 * `pending`, never `green`: a PR whose checks have not attached yet looks the same as a repository with none.
 *
 * `awaitsRequiredHumanReview` is the forge fact behind a human-review handoff: GitHub's `reviewDecision` says branch
 * protection still wants an approving review (code owners, required reviewers) on an open, same-repository,
 * conflict-free, green PR. Only a person can give that approval, so retrying the agent or dispatching another one
 * cannot advance it; the open PR is already the human's queue item. `CHANGES_REQUESTED` is excluded on purpose:
 * requested changes are code work an agent can do.
 */

const GREEN_CHECKS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_CHECKS = new Set(['ACTION_REQUIRED', 'CANCELLED', 'ERROR', 'FAILURE', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT']);
const checkResult = check => String(check?.conclusion || check?.state || '').toUpperCase();

/**
 * @param {Array<{conclusion?: string, state?: string}>|null|undefined} statusCheckRollup
 * @returns {'failed'|'green'|'pending'}
 */
export function classifyChecks(statusCheckRollup) {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  if (checks.some(check => FAILED_CHECKS.has(checkResult(check)))) return 'failed';
  if (checks.length > 0 && checks.every(check => GREEN_CHECKS.has(checkResult(check)))) return 'green';
  return 'pending';
}

export const checkName = check => check?.name || check?.context || null;

/**
 * @param {{state?: string, isDraft?: boolean, isCrossRepository?: boolean, reviewDecision?: string|null,
 *   mergeable?: string, statusCheckRollup?: Array<object>}|null|undefined} view - needs every listed field
 * @param {Iterable<string>|null} [requiredCheckNames] - names branch protection requires; when given, advisory
 *   checks are ignored. null/omitted judges every check in the rollup, the fail-closed default when the forge's
 *   required set could not be read. An empty set leaves nothing to classify, so it stays `pending`, never `green`.
 * @returns {boolean}
 */
export function awaitsRequiredHumanReview(view, requiredCheckNames = null) {
  if (requiredCheckNames) {
    const required = new Set(requiredCheckNames);
    const rollup = (Array.isArray(view?.statusCheckRollup) ? view.statusCheckRollup : []).filter(check => required.has(checkName(check)));
    return awaitsRequiredHumanReview({ ...view, statusCheckRollup: rollup });
  }
  return view?.state === 'OPEN' && view.isDraft === false && view.isCrossRepository === false
    && view.reviewDecision === 'REVIEW_REQUIRED' && view.mergeable !== 'CONFLICTING'
    && classifyChecks(view.statusCheckRollup) === 'green';
}
