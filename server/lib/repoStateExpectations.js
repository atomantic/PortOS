/**
 * Post-completion repo-state expectations for CoS worktree agents — the pure half.
 *
 * Cleanup (`services/agentWorktreeCleanup.js`) reports only the steps it TRIED
 * and failed. A run whose steps were never attempted finishes with zero warnings
 * and still leaves debris: an agent that owns its own PR workflow merges the PR
 * itself, so cleanup stands down (`skipMerge`, `PR_CREATION.NEVER`) and nothing
 * checks whether the branch and worktree actually went away.
 *
 * This module answers "what should the repo look like now" and "which observed
 * facts contradict that". No I/O — the probing and remediation live in
 * `services/agentRepoStateVerification.js`.
 *
 * Deliberately narrow: ONE agent's branch, right after that agent completed. The
 * periodic whole-repo sweep is `services/branchReconcile.js`.
 */

import { PR_COMPLETIONS } from './prDisposition.js';

/**
 * Divergences worth reporting, in the order they are reported.
 *
 * There is deliberately no "the agent never opened a PR" code: `verifyPrClaim`
 * (services/agentFinalization.js) already owns that question on every completion
 * path, is forge-agnostic, and carries the `noChangesToShip` carve-out (#3358) —
 * a run that found the work already done ships nothing and must not be told to
 * open a PR for an empty branch.
 */
export const REPO_STATE_ISSUES = Object.freeze({
  WORKTREE_PRESENT: 'worktree-present',
  LOCAL_BRANCH_PRESENT: 'local-branch-present',
  REMOTE_BRANCH_PRESENT: 'remote-branch-present',
  BRANCH_UNMERGED: 'branch-unmerged',
  PR_UNMERGED: 'pr-unmerged',
});

/**
 * Why a run was not audited. Returned rather than logged, so "nothing happened"
 * is never ambiguous between "checked and clean" and "never checked".
 */
export const REPO_STATE_SKIPS = Object.freeze({
  DISABLED: 'verification-disabled',
  NOT_WORKTREE: 'not-a-worktree-run',
  PERSISTENT_WORKTREE: 'persistent-worktree',
  DISCARDED_WORKTREE: 'discarded-worktree',
  FAILED_RUN: 'failed-run',
  CLEANUP_WARNED: 'cleanup-already-warned',
  FOLLOW_UP_PENDING: 'follow-up-pending',
  MISSING_CONTEXT: 'missing-branch-or-workspace',
  // Both set by the service half. A gate this audit depends on could not be read
  // (the app record, the task queue) — fail CLOSED, because reading "we could not
  // ask" as "nobody owns this branch" or as "the app left the audit on" is how a
  // transient file-read failure files recovery work against a branch a follow-up
  // owns, or against an app that opted out.
  GATE_UNREADABLE: 'gate-unreadable',
  // At least one probe that could have produced a finding was unreadable, and
  // nothing diverged in what WAS readable. Not the same as clean: a firewalled
  // host must not be logged as a verified repo.
  PROBE_INCOMPLETE: 'probe-incomplete',
});

/**
 * Should this run be audited, and under which of the two end-state shapes?
 *
 * Returns two facts rather than one flag per check: `staysOpen` (the PR is a
 * human's to land, so its branch must survive) and `prExpected`. Every check is
 * derived from those in `classifyRepoStateIssues` — an earlier version carried
 * six `expect*` booleans, three of which were the same expression.
 *
 * The two skips worth spelling out:
 *
 * - **A failed run is never audited.** Its branch and worktree are PRESERVED on
 *   purpose (`preserveBranchWithCommits`, `resolveResumePointer`) so the task's
 *   retry resumes rather than restarts. Auditing it would report the resume
 *   pointer as a leak.
 * - **A pending owner defers the audit.** A review-loop follow-up or a pr-watcher
 *   pending merge lands this branch next, so it is *supposed* to still exist.
 *   `FOLLOW_UP_PENDING` is tested last because answering it costs two file reads;
 *   every free gate above it runs first.
 *
 * @param {object} params
 * @param {boolean} params.enabled - the app's `verifyRepoStateOnCompletion` setting
 * @param {boolean} params.success - the run's effective success
 * @param {boolean} params.isWorktree
 * @param {boolean} [params.isPersistentWorktree] - long-lived feature worktree
 * @param {boolean} [params.discardWorktree] - reasoning agent whose tree is thrown away
 * @param {boolean} [params.followUpPending] - something is already queued to land this branch
 * @param {number} [params.cleanupWarningCount] - cleanup spawns its own recovery when it warned
 * @param {string} [params.prCompletion] - resolved `PR_COMPLETIONS` policy
 * @param {boolean} [params.leaveOpen] - the PR is a human's to land (JIRA hand-off)
 * @param {boolean} [params.prExpected] - the task asked for a PR
 * @param {string|null} [params.branchName]
 * @param {string|null} [params.sourceWorkspace]
 * @returns {{verify: boolean, skipReason: string|null, staysOpen: boolean, prExpected: boolean}}
 */
export function resolveRepoStateExpectation({
  enabled,
  success,
  isWorktree,
  isPersistentWorktree = false,
  discardWorktree = false,
  followUpPending = false,
  cleanupWarningCount = 0,
  prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN,
  leaveOpen = false,
  prExpected = false,
  branchName = null,
  sourceWorkspace = null,
} = {}) {
  const skip = (skipReason) => ({ verify: false, skipReason, staysOpen: false, prExpected: false });

  if (enabled === false) return skip(REPO_STATE_SKIPS.DISABLED);
  if (!isWorktree) return skip(REPO_STATE_SKIPS.NOT_WORKTREE);
  if (isPersistentWorktree) return skip(REPO_STATE_SKIPS.PERSISTENT_WORKTREE);
  if (discardWorktree) return skip(REPO_STATE_SKIPS.DISCARDED_WORKTREE);
  if (!success) return skip(REPO_STATE_SKIPS.FAILED_RUN);
  if (cleanupWarningCount > 0) return skip(REPO_STATE_SKIPS.CLEANUP_WARNED);
  if (!branchName || !sourceWorkspace) return skip(REPO_STATE_SKIPS.MISSING_CONTEXT);
  if (followUpPending) return skip(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);

  return {
    verify: true,
    skipReason: null,
    // `leave-open` is a deliberate hand-off: the PR stays open and its branch must
    // stay with it, local and remote. The worktree is still expected to be gone —
    // nothing about handing a PR to a human needs a checkout.
    staysOpen: leaveOpen || prCompletion === PR_COMPLETIONS.LEAVE_OPEN,
    prExpected,
  };
}

/**
 * Which observed facts contradict the expectation.
 *
 * Every observation is tri-state (`true` / `false` / `null`): `null` means "could
 * not determine" — git unreachable, `gh` firewalled, a non-GitHub forge. A `null`
 * NEVER produces an issue, because reading "we could not ask" as "it's still
 * there" would file a recovery task on every network hiccup.
 *
 * @param {ReturnType<typeof resolveRepoStateExpectation>} expectation
 * @param {object} observed
 * @param {boolean|null} [observed.worktreePresent]
 * @param {boolean|null} [observed.localBranchPresent]
 * @param {boolean|null} [observed.remoteBranchPresent]
 * @param {boolean|null} [observed.branchMerged]
 * @param {string|null} [observed.prState] - upper-cased `MERGED` / `OPEN` / `CLOSED`
 * @param {string|null} [observed.branchName]
 * @returns {Array<{code: string, message: string}>}
 */
export function classifyRepoStateIssues(expectation, observed = {}) {
  if (!expectation?.verify) return [];
  const branch = observed.branchName || 'the agent branch';
  const branchShouldBeGone = !expectation.staysOpen;
  const issues = [];

  if (observed.worktreePresent === true) {
    issues.push({
      code: REPO_STATE_ISSUES.WORKTREE_PRESENT,
      message: `Worktree for ${branch} still exists after cleanup reported success`,
    });
  }
  if (branchShouldBeGone && observed.localBranchPresent === true) {
    issues.push({
      code: REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
      message: `Local branch ${branch} still exists after the run completed`,
    });
  }
  if (branchShouldBeGone && observed.remoteBranchPresent === true) {
    issues.push({
      code: REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT,
      message: `Remote branch origin/${branch} was never deleted`,
    });
  }
  if (branchShouldBeGone && observed.branchMerged === false) {
    issues.push({
      code: REPO_STATE_ISSUES.BRANCH_UNMERGED,
      message: `Branch ${branch} carries commits that are not on the default branch`,
    });
  }
  if (branchShouldBeGone && expectation.prExpected && observed.prState && observed.prState !== 'MERGED') {
    issues.push({
      code: REPO_STATE_ISSUES.PR_UNMERGED,
      message: `Pull request for ${branch} is ${observed.prState}, not MERGED`,
    });
  }

  return issues;
}

/**
 * True when the app's per-app setting leaves the audit on. Unset means ON: the
 * audit only reports on a run the completion path already believed was finished,
 * and an install that never hears about a leaked branch accumulates them silently.
 *
 * @param {object|null} app - managed app record (null for a task with no app)
 * @returns {boolean}
 */
export function repoStateVerificationEnabled(app) {
  return app?.verifyRepoStateOnCompletion !== false;
}
